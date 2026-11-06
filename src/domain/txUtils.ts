import type { Transaction } from '../types';

/** 一笔交易是否进入统计：软删的不算，被裁决为 duplicate 的不算。 */
export function isActiveTx(tx: Transaction): boolean {
  return !tx.deleted_at && tx.dedupe_status !== 'duplicate';
}

/** 时间倒序（同日按录入时间倒序），流水列表用它。 */
export function sortByTimeDesc(txs: readonly Transaction[]): Transaction[] {
  return [...txs].sort((a, b) => {
    if (a.occurred_at !== b.occurred_at) return a.occurred_at < b.occurred_at ? 1 : -1;
    return a.created_at < b.created_at ? 1 : -1;
  });
}

export interface DayGroup {
  date: string;
  txs: Transaction[];
}

/** 按日分组（已倒序）。 */
export function groupByDate(txs: readonly Transaction[]): DayGroup[] {
  const map = new Map<string, Transaction[]>();
  for (const tx of sortByTimeDesc(txs)) {
    const bucket = map.get(tx.occurred_date) ?? [];
    bucket.push(tx);
    map.set(tx.occurred_date, bucket);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, list]) => ({ date, txs: list }));
}

/** 当日净支出（支出 − 退款冲正），用于日分组表头。 */
export function dayNetExpenseCents(txs: readonly Transaction[]): number {
  let total = 0;
  for (const tx of txs) {
    if (tx.direction === 'expense') total += tx.amount_cents;
    else if (tx.direction === 'refund') total -= tx.amount_cents;
  }
  return total;
}

/** 三个口径固定命名，任何页面都不得混用。 */
export const AMOUNT_BASIS_LABEL = {
  gross: '支出总额（毛）',
  refund: '退款冲正合计',
  net: '支出净额',
} as const;
