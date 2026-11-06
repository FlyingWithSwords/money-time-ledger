import { db } from '../db';
import type { Cents, Direction, Source, Transaction } from '../../types';
import { mergeSources, provenanceOf } from '../../domain/provenance';
import { isActiveTx } from '../../domain/txUtils';

/** 交易读写。所有写路径必须同步 occurred_date / month_key，且写后推进 data_version。 */

export async function addMany(txs: Transaction[]): Promise<void> {
  if (txs.length === 0) return;
  await db.transactions.bulkAdd(txs);
}

export async function add(tx: Transaction): Promise<void> {
  await db.transactions.add(tx);
}

export async function getById(id: string): Promise<Transaction | undefined> {
  return db.transactions.get(id);
}

export function listByMonth(monthKey: string, includeDeleted = false): Promise<Transaction[]> {
  return db.transactions
    .where('month_key')
    .equals(monthKey)
    .toArray()
    .then((rows) => (includeDeleted ? rows : rows.filter(isActiveTx)));
}

export function listByMonthDirection(monthKey: string, direction: Direction): Promise<Transaction[]> {
  return db.transactions
    .where('[month_key+direction]')
    .equals([monthKey, direction])
    .toArray()
    .then((rows) => rows.filter(isActiveTx));
}

export function listAll(includeDeleted = false): Promise<Transaction[]> {
  return db.transactions.toArray().then((rows) => (includeDeleted ? rows : rows.filter(isActiveTx)));
}

export function listByDateRange(fromDate: string, toDate: string, includeDeleted = false): Promise<Transaction[]> {
  return db.transactions
    .where('occurred_date')
    .between(fromDate, toDate, true, true)
    .toArray()
    .then((rows) => (includeDeleted ? rows : rows.filter(isActiveTx)));
}

export function findByDedupeKey(dedupeKey: string, source: Source): Promise<Transaction | undefined> {
  return db.transactions.where('[dedupe_key+source]').equals([dedupeKey, source]).first();
}

export function listByBatch(batchId: string): Promise<Transaction[]> {
  return db.transactions.where('import_batch_id').equals(batchId).toArray();
}

export async function updateTx(id: string, patch: Partial<Transaction>): Promise<void> {
  await db.transactions.update(id, { ...patch, updated_at: new Date().toISOString() } as Partial<Transaction>);
}

export async function updateCategory(id: string, l1: string, l2: string): Promise<void> {
  await db.transactions.update(id, {
    category_l1: l1,
    category_l2: l2,
    category_locked: true,
    manual_edited: true,
    updated_at: new Date().toISOString(),
  });
}

export async function setMostWorthless(id: string, value: boolean): Promise<void> {
  const tx = await db.transactions.get(id);
  if (!tx) return;
  const flags = new Set(tx.flags ?? []);
  if (value) flags.add('most_worthless');
  else flags.delete('most_worthless');
  await db.transactions.update(id, { flags: [...flags], updated_at: new Date().toISOString() });
}

/**
 * 把历史上被记成「支出」的投资本金（买基金/理财/黄金）改判为不计收支。
 *
 * 只改 `direction` 与 `flags`，金额、日期、分类、备注一概不动：
 * 这是能表达「额度不是消费」的最小改动，用户在流水里仍能逐笔看到并改回。
 * 已经不在支出侧的记录直接跳过（不会把收入或退款误改）。
 */
export async function markInvestPrincipal(ids: readonly string[], flag: string): Promise<number> {
  if (ids.length === 0) return 0;
  const now = new Date().toISOString();
  let changed = 0;
  await db.transaction('rw', db.transactions, async () => {
    for (const id of ids) {
      const tx = await db.transactions.get(id);
      if (!tx || tx.direction !== 'expense') continue;
      const flags = tx.flags.includes(flag) ? tx.flags : [...tx.flags, flag];
      await db.transactions.update(id, { direction: 'transfer', flags, updated_at: now });
      changed += 1;
    }
  });
  return changed;
}

export async function softDelete(id: string): Promise<void> {
  const now = new Date().toISOString();
  await db.transactions.update(id, { deleted_at: now, updated_at: now });
}

export async function restore(id: string): Promise<void> {
  await db.transactions.update(id, { deleted_at: undefined, updated_at: new Date().toISOString() });
}

/** 撤销整批导入：批量软删该 batch 的记录，返回受影响条数。 */
export async function softDeleteByBatch(batchId: string): Promise<number> {
  const rows = await db.transactions.where('import_batch_id').equals(batchId).toArray();
  const now = new Date().toISOString();
  await db.transactions.bulkUpdate(
    rows.filter((row) => !row.deleted_at).map((row) => ({ key: row.id, changes: { deleted_at: now, updated_at: now } })),
  );
  return rows.filter((row) => !row.deleted_at).length;
}

/**
 * 疑似重复裁决：keep → clean，discard → duplicate + 软删。
 *
 * keep 时要把被丢弃那条的**来源**并进来：用户判定「这两条其实是同一笔」，
 * 等于宣告「这笔账同时有两个凭证来源」。不合并来源，界面就会永远显示成
 * 「只来自微信」，而他明明是用支付宝账单核对过的。
 */
export async function resolveDuplicate(id: string, action: 'keep' | 'discard'): Promise<void> {
  const now = new Date().toISOString();
  if (action === 'keep') {
    const kept = await db.transactions.get(id);
    if (!kept) return;
    const discarded = (await db.transactions.toArray()).filter((row) => row.duplicate_of === id);
    const merged = mergeSources(
      provenanceOf(kept),
      discarded.flatMap((row) => provenanceOf(row)),
    );
    await db.transactions.update(id, {
      dedupe_status: 'clean',
      duplicate_of: undefined,
      source_refs: merged,
      updated_at: now,
    });
  } else {
    await db.transactions.update(id, { dedupe_status: 'duplicate', deleted_at: now, updated_at: now });
  }
}

/**
 * 跨平台对账的**确认**裁决：keep/drop 两笔是「同一笔」。
 *
 * 与同源去重的 resolveDuplicate 分开实现，不复用：resolveDuplicate 靠
 * duplicate_of 反查「同组被丢弃的兄弟」，而跨源配对的 keep/drop 是用户
 * 现场指定的两笔 id，语义与查法都不同——硬复用会把两张不同的裁决网搅在一起。
 *
 * 单事务保证两笔要么都写、要么都没写：只软删一边却没合并来源（或反过来）
 * 都会让流水页面出现「合并了一半」的中间态。
 */
export async function confirmPairMatch(keepId: string, dropId: string): Promise<void> {
  if (keepId === dropId) {
    throw new Error('对账合并失败：keep 与 drop 不能是同一笔交易');
  }
  const now = new Date().toISOString();
  await db.transaction('rw', db.transactions, async () => {
    // 在事务内取：缺任何一笔都抛错，整个事务回滚，不会只写一半
    const keep = await db.transactions.get(keepId);
    const drop = await db.transactions.get(dropId);
    if (!keep || !drop) {
      throw new Error('对账合并失败：交易记录不存在');
    }
    // drop：软删（流水「已删除」区可恢复）+ 标记 duplicate，统计口径自动把它排除
    await db.transactions.update(dropId, {
      dedupe_status: 'duplicate',
      duplicate_of: keepId,
      deleted_at: now,
      updated_at: now,
    });
    // keep：把 drop 的凭证来源并进来，界面才能显示「微信+支付宝」这样的多来源
    await db.transactions.update(keepId, {
      source_refs: mergeSources(provenanceOf(keep), provenanceOf(drop)),
      updated_at: now,
    });
  });
}

export async function countPending(): Promise<number> {
  const rows = await db.transactions.where('category_l1').equals('other').toArray();
  return rows.filter(
    (row) => isActiveTx(row) && row.category_l2 === 'pending' && row.direction !== 'transfer',
  ).length;
}

export async function countSuspected(): Promise<number> {
  const all = await db.transactions.toArray();
  return all.filter((row) => isActiveTx(row) && row.dedupe_status === 'suspected').length;
}

export function listSuspected(): Promise<Transaction[]> {
  return db.transactions.toArray().then((rows) => rows.filter((row) => isActiveTx(row) && row.dedupe_status === 'suspected'));
}

export async function monthsWithData(): Promise<string[]> {
  const keys = await db.transactions.orderBy('month_key').uniqueKeys();
  return (keys as string[]).filter((key) => typeof key === 'string' && key.length === 7);
}

export async function sumAllByDirection(direction: Direction): Promise<Cents> {
  const rows = await db.transactions.where('direction').equals(direction).toArray();
  return rows.filter(isActiveTx).reduce((acc, row) => acc + row.amount_cents, 0) as Cents;
}

export interface LedgerFilter {
  keyword?: string;
  /** 日期区间（闭区间）。给了区间就用 occurred_date 索引收窄，不再按整月取。 */
  fromDate?: string;
  toDate?: string;
  l1?: string;
  channel?: string;
  source?: string;
  direction?: Direction;
  minCents?: number;
  maxCents?: number;
  onlyFlagged?: boolean;
  onlyImpulse?: boolean;
}

/**
 * 流水筛选：先在索引上收窄，再在内存里做多维过滤（10 万笔量级足够）。
 *
 * 注意：这里的 `source` 过滤走的是**主来源** `tx.source`，不是 `source_refs`。
 * 这是刻意的——筛选「微信」应当筛出「由微信凭证导入的那些行」；
 * 如果按 `source_refs` 筛，一笔后来被截图确认过的微信账会同时出现在两个来源下，
 * 用户来回切筛选就会看到同一笔账出现两次，那是更糟的体验。
 * 多来源只影响**展示**（行内标「微信+截图」），不影响筛选归属。
 */
export async function search(filter: LedgerFilter): Promise<Transaction[]> {
  const byRange =
    filter.fromDate && filter.toDate
      ? await listByDateRange(filter.fromDate, filter.toDate, true)
      : await listAll(true);
  const keyword = filter.keyword?.trim().toLowerCase();
  return byRange.filter((tx) => {
    if (tx.deleted_at) return false;
    if (filter.direction && tx.direction !== filter.direction) return false;
    if (filter.l1 && tx.category_l1 !== filter.l1) return false;
    if (filter.channel && tx.payment_channel !== filter.channel) return false;
    if (filter.source && tx.source !== filter.source) return false;
    if (filter.minCents !== undefined && tx.amount_cents < filter.minCents) return false;
    if (filter.maxCents !== undefined && tx.amount_cents > filter.maxCents) return false;
    if (filter.onlyFlagged && !(tx.flags ?? []).includes('most_worthless')) return false;
    if (keyword) {
      const hay = `${tx.counterparty ?? ''}${tx.note ?? ''}${tx.category_l1}${tx.category_l2}`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  });
}

export async function countAll(): Promise<number> {
  return db.transactions.count();
}

/** 估算占用体积（MB），设置页展示；>5 万笔提示导出备份后归档旧年份。 */
export async function estimateSizeMb(): Promise<number> {
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    return Math.round(((estimate.usage ?? 0) / (1024 * 1024)) * 10) / 10;
  }
  return 0;
}
