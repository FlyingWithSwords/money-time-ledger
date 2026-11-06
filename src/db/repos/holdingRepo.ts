import { db } from '../db';
import { asCents } from '../../domain/money';
import type { Cents, FundQuote, Holding, HoldingPlatform } from '../../types';

/**
 * 持仓读写。多笔加仓合并为加权成本；清仓保留记录（closed_at），计入历史收益。
 *
 * v4 起「同一标的」的身份是 (platform, fund_code) 而不是 fund_code：
 * 同一只基金在支付宝和天天基金是两行独立持仓，各自的份额、成本互不污染。
 * 这也是用户点名要的语义——「同平台下次导入覆盖不冲突，跨平台区分开打标签」。
 */

export function list(): Promise<Holding[]> {
  return db.holdings.toArray();
}

export function listActive(): Promise<Holding[]> {
  return db.holdings.filter((row) => !row.closed_at).toArray();
}

/** 同平台同代码的现有持仓（导入幂等与加仓都靠它查重）。 */
export async function byPlatformCode(platform: HoldingPlatform, code: string): Promise<Holding | undefined> {
  return db.holdings.where('[platform+fund_code]').equals([platform, code]).first();
}

/** 兼容旧调用：忽略平台维度，返回该代码的任意一条。新代码不要用它查重。 */
export async function byCode(code: string): Promise<Holding | undefined> {
  return db.holdings.where('fund_code').equals(code).first();
}

export async function upsert(holding: Holding): Promise<void> {
  await db.holdings.put(holding);
}

/** 加仓：同平台同代码合并为加权成本；不同平台互不相干。 */
export async function addPosition(input: {
  id: string;
  platform: HoldingPlatform;
  fund_code: string;
  fund_name: string;
  shares: number;
  cost_cents: number;
  date: string;
}): Promise<Holding> {
  const existing = await byPlatformCode(input.platform, input.fund_code);
  if (!existing) {
    const holding: Holding = {
      id: input.id,
      fund_code: input.fund_code,
      fund_name: input.fund_name,
      platform: input.platform,
      shares: round4(input.shares),
      total_cost_cents: (input.cost_cents as Holding['total_cost_cents']),
      avg_cost_nav: input.shares > 0 ? input.cost_cents / 100 / input.shares : 0,
      first_buy_date: input.date,
    };
    await db.holdings.put(holding);
    return holding;
  }
  const shares = round4(existing.shares + input.shares);
  const totalCost = existing.total_cost_cents + input.cost_cents;
  const merged: Holding = {
    ...existing,
    fund_name: input.fund_name || existing.fund_name,
    shares,
    total_cost_cents: totalCost as Holding['total_cost_cents'],
    avg_cost_nav: shares > 0 ? totalCost / 100 / shares : 0,
  };
  await db.holdings.put(merged);
  return merged;
}

export interface ImportHoldingRow {
  platform: HoldingPlatform;
  fund_code: string;
  fund_name: string;
  /** 克重/份额，4 位小数 */
  shares: number;
  /** 总成本（分）。截图里通常没有成本只有市值——见 snapshot 导入的取舍。 */
  total_cost_cents?: Cents;
  /** 有市值无成本时的替代：用当前净值反推成本（近似，导入 UI 必须标注）。 */
  market_value_cents?: Cents;
  current_nav?: number;
  date: string;
}

export interface ImportHoldingOutcome {
  created: number;
  updated: number;
  /** (platform, code) 重复出现的行数——同一次导入里截图含多页持仓时的正常现象 */
  mergedInBatch: number;
}

/**
 * 截图/文件导入持仓：按 (platform, fund_code) 幂等 upsert。
 *
 * 覆盖语义（用户要求「下次导入覆盖不冲突」）：
 * - 已有持仓且本次给出份额+成本 → **整行覆盖**（不是加仓合并）：平台截图是
 *   「当前持有」的快照，快照与本地累计相加会翻倍。旧的 addPosition 加仓语义
 *   仅保留给手动「又买了一笔」场景。
 * - 只有市值没有成本 → 用市值/份额反推成本并标注近似（avg_cost_nav == 当前净值，
 *   收益恒为 0，直到用户补录真实成本——比假装知道成本诚实）。
 * - 同一批内同一 (platform, code) 出现多次（多页截图）→ 后面的并进前面，计 mergedInBatch。
 */
export async function importHoldings(rows: readonly ImportHoldingRow[]): Promise<ImportHoldingOutcome> {
  const outcome: ImportHoldingOutcome = { created: 0, updated: 0, mergedInBatch: 0 };
  const batch = new Map<string, ImportHoldingRow>();
  for (const row of rows) {
    const key = `${row.platform}::${row.fund_code}`;
    if (batch.has(key)) {
      outcome.mergedInBatch += 1;
      continue;
    }
    batch.set(key, row);
  }
  for (const row of batch.values()) {
    const existing = await byPlatformCode(row.platform, row.fund_code);
    const costCents = resolveCostCents(row);
    const shares = round4(row.shares);
    const record: Holding = {
      id: existing?.id ?? `hold_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      fund_code: row.fund_code,
      fund_name: row.fund_name,
      platform: row.platform,
      shares,
      total_cost_cents: costCents as Holding['total_cost_cents'],
      avg_cost_nav: shares > 0 ? costCents / 100 / shares : 0,
      first_buy_date: existing?.first_buy_date ?? row.date,
      closed_at: existing?.closed_at,
    };
    if (existing) outcome.updated += 1;
    else outcome.created += 1;
    await db.holdings.put(record);
  }
  return outcome;
}

/**
 * 补全「仅市值」持仓：补上份额（可选同时补真实成本）后，市值与收益才能计算。
 *
 * 只改份额与成本，不动 platform / fund_code / first_buy_date：
 * 改代码会与 (platform, fund_code) 唯一键打架，那属于「换一只基金」而不是补全。
 * 成本留空则沿用当前记录的成本（= 截图里的市值，收益仍为 0，但不造假）。
 */
export async function updatePosition(
  id: string,
  input: { shares: number; total_cost_cents?: number },
): Promise<void> {
  const existing = await db.holdings.get(id);
  if (!existing) return;
  const shares = round4(input.shares);
  if (!Number.isFinite(shares) || shares <= 0) return;
  const cost = input.total_cost_cents ?? existing.total_cost_cents;
  await db.holdings.put({
    ...existing,
    shares,
    total_cost_cents: asCents(cost),
    avg_cost_nav: cost / 100 / shares,
  });
}

/** 市值反推成本：截图没有成本栏时的诚实降级（见 importHoldings 注释）。 */
function resolveCostCents(row: ImportHoldingRow): number {
  if (row.total_cost_cents !== undefined) return row.total_cost_cents;
  if (row.market_value_cents !== undefined) return row.market_value_cents;
  if (row.current_nav !== undefined && row.shares > 0) {
    return Math.round(row.shares * row.current_nav * 100);
  }
  return 0;
}

export async function close(id: string, date: string): Promise<void> {
  await db.holdings.update(id, { closed_at: date });
}

export async function remove(id: string): Promise<void> {
  await db.holdings.delete(id);
}

export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** 最新行情：quote_at 最大者。断网时仍可读出上次价格，绝不显示 0。 */
export async function latestQuotes(codes: readonly string[]): Promise<Map<string, FundQuote>> {
  const result = new Map<string, FundQuote>();
  for (const code of codes) {
    const rows = await db.quotes.where('fund_code').equals(code).toArray();
    if (rows.length === 0) continue;
    const latest = rows.reduce((best, row) => (row.quote_at > best.quote_at ? row : best), rows[0]);
    result.set(code, latest);
  }
  return result;
}

export async function putQuotes(quotes: FundQuote[]): Promise<void> {
  if (quotes.length === 0) return;
  await db.quotes.bulkPut(quotes);
}

/**
 * 全库净值历史（只要 kind='nav'）。
 *
 * 为什么不按代码逐个查：趋势页要算「每个月末的持仓浮盈」，一次拿全比 N 次往返快，
 * 且 kind 没有索引，逐个查同样要扫。行数上限是「每只基金 120 点 × 持仓数」，
 * 个人账本量级下完全可接受。
 */
export async function listNavQuotes(): Promise<FundQuote[]> {
  const rows = await db.quotes.toArray();
  return rows.filter((row) => row.kind === 'nav');
}

export async function series(code: string, limit = 400): Promise<FundQuote[]> {
  const rows = await db.quotes.where('fund_code').equals(code).toArray();
  return rows
    .filter((row) => row.kind === 'nav')
    .sort((a, b) => a.nav_date.localeCompare(b.nav_date))
    .slice(-limit);
}
