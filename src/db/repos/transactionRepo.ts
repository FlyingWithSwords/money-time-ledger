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

/**
 * 删除操作的**回执**：撤销只认「这一批 + 这一个时间戳」。
 *
 * 撤销为什么不能只靠 id 列表：id 列表在「删」与「撤销」之间会变旧。
 * 同一笔可能在这期间被别处又删过一次（比如去重裁决把重复行改判删除），
 * 也可能已被用户在「已删除」里手动恢复。按 id 无脑 restore 会把这些行一起捞回来，
 * 用户看到的就是「撤销恢复出了我没选的东西」。带上时间戳才能一眼判定：
 * 这一行现在还属于我这次删的那批吗？
 */
export interface DeleteReceipt {
  /** 本次真正删掉的行（本来就已删的不会进来） */
  ids: string[];
  /** 整批共用的 `deleted_at`；空串表示这次一行都没删 */
  stamp: string;
}

/** 上下文内单调递增的删除时间戳，见 nextDeleteStamp。 */
let lastDeleteStamp = 0;

/**
 * 生成删除时间戳，并保证本上下文内严格递增。
 *
 * 撤销靠 `deleted_at` 精确匹配，两次删除落在同一毫秒就会串台：
 * 撤销 A 会把同一毫秒删掉的 B 一起捞回来（快节奏连点、批量脚本、测试里都很容易撞上）。
 * 让时间戳严格递增，代价只是同一毫秒内的第二笔删除多 1ms，用户感知不到。
 */
function nextDeleteStamp(): string {
  const now = Date.now();
  const ms = now > lastDeleteStamp ? now : lastDeleteStamp + 1;
  lastDeleteStamp = ms;
  return new Date(ms).toISOString();
}

/** 软删一笔，返回这次使用的删除时间戳（撤销时按它精确匹配）。 */
export async function softDelete(id: string): Promise<string> {
  const stamp = nextDeleteStamp();
  await db.transactions.update(id, { deleted_at: stamp, updated_at: stamp });
  return stamp;
}

/**
 * 把一批记录改判为收入并落到指定分类（工资/补贴）。
 *
 * 只改方向、分类与锁定标记，金额与日期不动——用户是在纠正「这笔被平台记成了转账」，
 * 不是在改账。退款行直接跳过：钱已经回来了，再判成收入会和退款冲减重复计算。
 * 返回实际发生变化的条数（已经是对的就不重复写，避免无意义的 updated_at 抖动）。
 */
export async function markIncome(ids: readonly string[], l1: string, l2: string): Promise<number> {
  if (ids.length === 0) return 0;
  const now = new Date().toISOString();
  let changed = 0;
  await db.transaction('rw', db.transactions, async () => {
    for (const id of ids) {
      const tx = await db.transactions.get(id);
      if (!tx || tx.direction === 'refund') continue;
      if (tx.direction === 'income' && tx.category_l1 === l1 && tx.category_l2 === l2) continue;
      await db.transactions.update(id, {
        direction: 'income',
        category_l1: l1,
        category_l2: l2,
        category_locked: true,
        manual_edited: true,
        updated_at: now,
      });
      changed += 1;
    }
  });
  return changed;
}

/**
 * 批量改分类：一次写一批，单事务。
 *
 * 逐条 update 而不是 bulkUpdate，是因为要**保留**原有的 other 字段（flags 等）；
 * bulkUpdate 的 changes 是浅合并，本身没问题，但拿不到「这个 id 是否存在」的判断，
 * 会把已删除/不存在的 id 静默吞掉，界面上就变成「点了没反应」。
 */
export async function bulkUpdateCategory(ids: readonly string[], l1: string, l2: string): Promise<number> {
  if (ids.length === 0) return 0;
  const now = new Date().toISOString();
  let changed = 0;
  await db.transaction('rw', db.transactions, async () => {
    for (const id of ids) {
      const tx = await db.transactions.get(id);
      if (!tx) continue;
      await db.transactions.update(id, {
        category_l1: l1,
        category_l2: l2,
        category_locked: true,
        manual_edited: true,
        updated_at: now,
      });
      changed += 1;
    }
  });
  return changed;
}

/**
 * 批量删除（软删），返回回执。
 *
 * 已经删过的跳过：背包里选中的行可能包含上一次操作后已被别处删掉的，
 * 重复写 deleted_at 会让「撤销」提示显示的条数虚高，更糟的是让撤销把
 * 那些**本来就已经删掉**的行一起恢复出来。所以回执里只放这次真正改了的 id，
 * 并且整批共用同一个时间戳，撤销才能做到「精确回滚到操作前」。
 */
export async function bulkSoftDelete(ids: readonly string[]): Promise<DeleteReceipt> {
  if (ids.length === 0) return { ids: [], stamp: '' };
  const stamp = nextDeleteStamp();
  const deleted: string[] = [];
  await db.transaction('rw', db.transactions, async () => {
    for (const id of ids) {
      const tx = await db.transactions.get(id);
      if (!tx || tx.deleted_at) continue;
      await db.transactions.update(id, { deleted_at: stamp, updated_at: stamp });
      deleted.push(id);
    }
  });
  return deleted.length > 0 ? { ids: deleted, stamp } : { ids: [], stamp: '' };
}

/**
 * 批量加备注：**追加**而不是覆盖。
 *
 * 原有备注往往是账单原文（「美团-外卖订单」「退款」），覆盖掉等于毁掉唯一的原始凭证；
 * 追加后用「 · 」分隔，重复追加同一句话会被跳过，避免连点两下变成「备注 · 备注」。
 */
export async function bulkAppendNote(ids: readonly string[], text: string): Promise<number> {
  const note = text.trim();
  if (ids.length === 0 || !note) return 0;
  const now = new Date().toISOString();
  let changed = 0;
  await db.transaction('rw', db.transactions, async () => {
    for (const id of ids) {
      const tx = await db.transactions.get(id);
      if (!tx) continue;
      const current = tx.note ?? '';
      if (current.includes(note)) continue;
      await db.transactions.update(id, {
        note: current ? `${current} · ${note}` : note,
        manual_edited: true,
        updated_at: now,
      });
      changed += 1;
    }
  });
  return changed;
}

/**
 * 撤销一次删除：只恢复**那一次**删掉的行，返回实际恢复条数。
 *
 * 两道闸门缺一不可：
 * - 只认回执里的 id（这次真正删掉的），不碰选择时列表里本来就已删的行；
 * - 还要 `deleted_at === stamp`（这一行现在仍是那次删的），
 *   期间被别处删过（时间戳不同）或已被手动恢复过的，一律不动。
 *
 * 因此它是幂等的：撤销点两次，第二次返回 0，不会出现「恢复出已删记录」的怪象。
 */
export async function undoDelete(receipt: DeleteReceipt): Promise<number> {
  if (!receipt.stamp || receipt.ids.length === 0) return 0;
  const now = new Date().toISOString();
  let changed = 0;
  await db.transaction('rw', db.transactions, async () => {
    for (const id of receipt.ids) {
      const tx = await db.transactions.get(id);
      if (!tx || tx.deleted_at !== receipt.stamp) continue;
      await db.transactions.update(id, { deleted_at: undefined, updated_at: now });
      changed += 1;
    }
  });
  return changed;
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
