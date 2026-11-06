import { useLiveQuery } from 'dexie-react-hooks';
import * as categoryRepo from '../../db/repos/categoryRepo';
import * as settingsRepo from '../../db/repos/settingsRepo';
import * as transactionRepo from '../../db/repos/transactionRepo';
import * as accountRepo from '../../db/repos/accountRepo';
import * as holdingRepo from '../../db/repos/holdingRepo';
import type { Account, Cents, Category, FundQuote, Holding, Transaction } from '../../types';
import { asCents } from '../../domain/money';
import { resolveHourlyWage, type WageResult, type WageSettings } from '../../domain/timecost';
import { DEFAULT_WAGE_SETTINGS } from '../../domain/timecost';
import { shiftMonth } from '../../domain/date';
import type { DateRange } from '../../domain/range';
import type { CategoryTree } from '../../db/repos/categoryRepo';

/** 页面数据钩子集中在这里：页面只负责呈现，不在组件里写 Σ。 */

export function useWageSettings(): WageSettings {
  const value = useLiveQuery(() => settingsRepo.getWageSettings(), [], DEFAULT_WAGE_SETTINGS);
  return value ?? DEFAULT_WAGE_SETTINGS;
}

export function useDataVersion(): number {
  const value = useLiveQuery(() => settingsRepo.getDataVersion(), [], 1);
  return value ?? 1;
}

export function useCategories(): Category[] {
  const value = useLiveQuery(() => categoryRepo.list(), [], []);
  return value ?? [];
}

export function useCategoryTree(): CategoryTree {
  const empty: CategoryTree = { l1List: [], byL1: new Map(), all: [] };
  const value = useLiveQuery(() => categoryRepo.loadTree(), [], empty);
  return value ?? empty;
}

export function useAccounts(): Account[] {
  const value = useLiveQuery(() => accountRepo.list(), [], []);
  return value ?? [];
}

export function useMonthTxs(monthKey: string): Transaction[] {
  const value = useLiveQuery(() => transactionRepo.listByMonth(monthKey), [monthKey], []);
  return value ?? [];
}

/**
 * 任意起止日期（闭区间）的交易。
 *
 * 走 occurred_date 索引（唯一有索引的日期字段）；occurred_at 没有索引，
 * 按它做区间查询会退化成全表扫。
 * 依赖里带 dataVersion：写操作推进版本号后即使 Dexie 的变更订阅漏了也能重新取一次。
 */
export function useRangeTxs(range: DateRange): Transaction[] {
  const dataVersion = useDataVersion();
  const value = useLiveQuery(
    () => transactionRepo.listByDateRange(range.from, range.to),
    [range.from, range.to, dataVersion],
    [],
  );
  return value ?? [];
}

export function usePrevMonthTxs(monthKey: string): Transaction[] {
  const prev = shiftMonth(monthKey, -1);
  return useMonthTxs(prev);
}

export function useAllTxs(): Transaction[] {
  const value = useLiveQuery(() => transactionRepo.listAll(), [], []);
  return value ?? [];
}

/** 全部持仓（含已清仓）：趋势页要按 first_buy_date/closed_at 决定每月是否计入。 */
export function useHoldings(): Holding[] {
  const value = useLiveQuery(() => holdingRepo.list(), [], []);
  return value ?? [];
}

/** 全部历史净值点（kind='nav'）：按月估值持仓浮盈的唯一数据来源。 */
export function useNavQuotes(): FundQuote[] {
  const value = useLiveQuery(() => holdingRepo.listNavQuotes(), [], []);
  return value ?? [];
}

export function useRecentMonthsTxs(monthKeys: readonly string[]): Transaction[] {
  const key = monthKeys.join(',');
  const value = useLiveQuery(async () => {
    const chunks = await Promise.all(monthKeys.map((month) => transactionRepo.listByMonth(month)));
    return chunks.flat();
  }, [key], []);
  return value ?? [];
}

/** 真实时薪口径：近 3 笔「接单报酬」收入合计 ÷ 用户在设置页填报的工时合计。 */
export function useWageResult(settings: WageSettings): WageResult {
  const hours = useLiveQuery(() => settingsRepo.getRealWageHours(), [], 0) ?? 0;
  const txs = useLiveQuery(() => transactionRepo.listAll(), [], []);
  const recentJobs = (txs ?? [])
    .filter((tx) => tx.direction === 'income' && tx.category_l1 === 'job' && !tx.deleted_at)
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))
    .slice(0, 3);
  const incomeCents = recentJobs.reduce((acc, tx) => acc + tx.amount_cents, 0);
  return resolveHourlyWage(settings, {
    income_cents: asCents(incomeCents),
    hours,
    count: recentJobs.length,
  });
}

export function sumBy(list: readonly Transaction[], pick: (tx: Transaction) => Cents): Cents {
  return asCents(list.reduce((acc, tx) => acc + pick(tx), 0));
}
