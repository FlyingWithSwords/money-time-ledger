import type { Transaction } from '../types';
import { daysInMonth, hourOfIso } from './date';
import { isActiveTx } from './txUtils';

/**
 * M2 冲动 / 后悔度标记。
 *
 * 架构结论（02-arch.md §3.5）：4 条自动规则**查询时派生**，只有主观「最不值」落库。
 * 理由：这些规则都是"相对于当月其他数据"的函数，任何补录/编辑/删除都会让写入时的结论失效。
 * 性能用按月 memo：任一次写操作递增 Setting.data_version 使其失效。
 */

export type FlagKind = 'late_night' | 'small_change' | 'large_amount' | 'habitual' | 'most_worthless';

export const FLAG_LABEL: Record<FlagKind, string> = {
  late_night: '深夜',
  small_change: '碎钞',
  large_amount: '大额',
  habitual: '习惯性',
  most_worthless: '后悔',
};

export const FLAG_ORDER: FlagKind[] = ['most_worthless', 'late_night', 'large_amount', 'small_change', 'habitual'];

export interface FlagHit {
  kind: FlagKind;
  label: string;
  detail?: string;
}

const SMALL_CHANGE_MAX_CENTS = 1000;
const SMALL_CHANGE_WINDOW_MS = 30 * 60 * 1000;
const SMALL_CHANGE_DAY_COUNT = 5;
const HABITUAL_DAYS = 7;

function isActive(tx: Transaction): boolean {
  return isActiveTx(tx);
}

function monthOf(txs: Transaction[]): string {
  const first = txs.find(isActive);
  return first ? first.month_key : '';
}

/** 纯函数：给定一个月的全部交易（可含邻月），返回 id → 命中标签。 */
export function computeMonthFlags(txs: Transaction[], monthKey?: string): Map<string, FlagHit[]> {
  const result = new Map<string, FlagHit[]>();
  const push = (id: string, hit: FlagHit): void => {
    const list = result.get(id);
    if (list) {
      if (!list.some((item) => item.kind === hit.kind)) list.push(hit);
    } else {
      result.set(id, [hit]);
    }
  };

  const active = txs.filter(isActive);
  const expenses = active.filter((tx) => tx.direction === 'expense');
  const key = monthKey ?? monthOf(active);

  // 主观标记：落库的 flags
  for (const tx of active) {
    if (tx.flags?.includes('most_worthless')) {
      push(tx.id, { kind: 'most_worthless', label: FLAG_LABEL.most_worthless, detail: '你标记过最不值' });
    }
  }

  // 规则 1：深夜消费 23:00–05:00
  for (const tx of expenses) {
    const hour = hourOfIso(tx.occurred_at);
    if (hour >= 23 || hour < 5) {
      push(tx.id, { kind: 'late_night', label: FLAG_LABEL.late_night, detail: `${String(hour).padStart(2, '0')} 点后消费` });
    }
  }

  // 规则 2a：同一二级分类 30 分钟内 ≥3 笔
  const byL2 = new Map<string, Transaction[]>();
  for (const tx of expenses) {
    const bucket = byL2.get(tx.category_l2) ?? [];
    bucket.push(tx);
    byL2.set(tx.category_l2, bucket);
  }
  for (const [l2, group] of byL2) {
    if (group.length < 3) continue;
    const sorted = [...group].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    for (let i = 0; i + 2 < sorted.length; i += 1) {
      const start = Date.parse(sorted[i].occurred_at);
      const end = Date.parse(sorted[i + 2].occurred_at);
      if (Number.isFinite(start) && Number.isFinite(end) && end - start <= SMALL_CHANGE_WINDOW_MS) {
        for (const tx of [sorted[i], sorted[i + 1], sorted[i + 2]]) {
          push(tx.id, { kind: 'small_change', label: FLAG_LABEL.small_change, detail: `30 分钟内 ${l2} 连刷 3 笔` });
        }
      }
    }
  }

  // 规则 2b：单笔 <10 元且同日 ≥5 笔
  const byDay = new Map<string, Transaction[]>();
  for (const tx of expenses) {
    const bucket = byDay.get(tx.occurred_date) ?? [];
    bucket.push(tx);
    byDay.set(tx.occurred_date, bucket);
  }
  for (const [date, group] of byDay) {
    if (group.length < SMALL_CHANGE_DAY_COUNT) continue;
    for (const tx of group) {
      if (tx.amount_cents < SMALL_CHANGE_MAX_CENTS) {
        push(tx.id, { kind: 'small_change', label: FLAG_LABEL.small_change, detail: `${date} 当天 ${group.length} 笔小额` });
      }
    }
  }

  // 规则 3：单笔 ≥ 当月日均支出 ×3（必须派生：月均随月内新增变化）
  if (key) {
    const monthExpenses = expenses.filter((tx) => tx.month_key === key);
    const total = monthExpenses.reduce((acc, tx) => acc + tx.amount_cents, 0);
    const days = Math.max(1, daysInMonth(key));
    const dailyAvg = total / days;
    if (dailyAvg > 0) {
      const threshold = dailyAvg * 3;
      for (const tx of monthExpenses) {
        if (tx.amount_cents >= threshold) {
          push(tx.id, {
            kind: 'large_amount',
            label: FLAG_LABEL.large_amount,
            detail: `超过当月日均 3 倍（日均 ¥${(dailyAvg / 100).toFixed(0)}）`,
          });
        }
      }
    }
  }

  // 规则 4：同一二级分类连续 7 天出现
  const datesByL2 = new Map<string, Set<string>>();
  for (const tx of expenses) {
    const set = datesByL2.get(tx.category_l2) ?? new Set<string>();
    set.add(tx.occurred_date);
    datesByL2.set(tx.category_l2, set);
  }
  for (const [l2, dateSet] of datesByL2) {
    if (dateSet.size < HABITUAL_DAYS) continue;
    const dates = [...dateSet].sort();
    let runStart = 0;
    for (let i = 1; i <= dates.length; i += 1) {
      const prev = dates[i - 1];
      const current = dates[i];
      const consecutive = current !== undefined && dayDiff(prev, current) === 1;
      if (!consecutive) {
        const runLength = i - runStart;
        if (runLength >= HABITUAL_DAYS) {
          const runDates = new Set(dates.slice(runStart, i));
          for (const tx of expenses) {
            if (tx.category_l2 === l2 && runDates.has(tx.occurred_date)) {
              push(tx.id, {
                kind: 'habitual',
                label: FLAG_LABEL.habitual,
                detail: `${l2} 连续 ${runLength} 天`,
              });
            }
          }
        }
        runStart = i;
      }
    }
  }

  return result;
}

function dayDiff(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00`);
  const db = Date.parse(`${b}T00:00:00`);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return Number.NaN;
  return Math.round((db - da) / (24 * 60 * 60 * 1000));
}

interface CacheEntry {
  version: number;
  result: Map<string, FlagHit[]>;
}

const monthCache = new Map<string, CacheEntry>();

/** 按月 memo：version 变化即失效（写操作后由 settingsRepo.bumpDataVersion 推进）。 */
export function getMonthFlags(monthKey: string, txs: Transaction[], dataVersion: number): Map<string, FlagHit[]> {
  const cached = monthCache.get(monthKey);
  if (cached && cached.version === dataVersion) return cached.result;
  const result = computeMonthFlags(txs, monthKey);
  monthCache.set(monthKey, { version: dataVersion, result });
  return result;
}

export function invalidateFlags(monthKey?: string): void {
  if (monthKey) monthCache.delete(monthKey);
  else monthCache.clear();
}

export function flagsFor(tx: Transaction, map: Map<string, FlagHit[]>): FlagHit[] {
  const hits = map.get(tx.id) ?? [];
  return [...hits].sort((a, b) => FLAG_ORDER.indexOf(a.kind) - FLAG_ORDER.indexOf(b.kind));
}

/** 汇总：本月被标记笔数 / 合计 / 占支出比 */
export interface ImpulseSummary {
  count: number;
  cents: number;
  ratio: number;
  kinds: Record<string, number>;
}

export function summarizeImpulse(txs: Transaction[], flagMap: Map<string, FlagHit[]>, expenseTotal: number): ImpulseSummary {
  const kinds: Record<string, number> = {};
  let count = 0;
  let cents = 0;
  for (const tx of txs) {
    if (tx.direction !== 'expense' || !isActive(tx)) continue;
    const hits = flagMap.get(tx.id);
    if (!hits || hits.length === 0) continue;
    count += 1;
    cents += tx.amount_cents;
    for (const hit of hits) {
      kinds[hit.kind] = (kinds[hit.kind] ?? 0) + 1;
    }
  }
  return {
    count,
    cents,
    ratio: expenseTotal > 0 ? cents / expenseTotal : 0,
    kinds,
  };
}
