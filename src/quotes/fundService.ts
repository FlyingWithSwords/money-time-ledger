import * as holdingRepo from '../db/repos/holdingRepo';
import { buildHoldingViews, fundMarketValue, type HoldingView } from '../domain/aggregate';
import { isPlaceholderCode } from '../domain/holdingIdentity';
import { asCents } from '../domain/money';
import type { Cents, FundQuote } from '../types';
import { refreshQuotes, type RefreshOutcome } from './scheduler';
import { manualProvider } from './manual';
import type { NavPoint, QuoteRange } from './types';

/** 基金模块应用服务：把 holdings + quotes 组装成可展示的持仓视图。 */

export interface FundsState {
  views: HoldingView[];
  totalValueCents: Cents;
  totalCostCents: Cents;
  totalProfitCents: Cents;
  totalProfitRatio: number | null;
  /** 是否有任何一只基金用到了缓存价（用于顶部"数据可能延迟"提示） */
  hasStale: boolean;
}

export async function loadFundsState(): Promise<FundsState> {
  const holdings = await holdingRepo.listActive();
  // NAME: 占位代码没有真实基金，查行情只会白发一次请求
  const codes = holdings.map((holding) => holding.fund_code).filter((code) => !isPlaceholderCode(code));
  const quotes: Map<string, FundQuote> = await holdingRepo.latestQuotes(codes);
  const views = buildHoldingViews(holdings, quotes).map((view) => ({
    ...view,
    stale: view.quote_at === null || isStale(view.quote_at),
  }));
  const totalValue = fundMarketValue(views);
  const totalCost = asCents(holdings.reduce((acc, holding) => acc + holding.total_cost_cents, 0));
  const totalProfit = asCents(totalValue - totalCost);
  return {
    views,
    totalValueCents: totalValue,
    totalCostCents: totalCost,
    totalProfitCents: totalProfit,
    totalProfitRatio: totalCost > 0 ? totalProfit / totalCost : null,
    hasStale: views.some((view) => view.stale),
  };
}

/** 超过 12 小时的行情视为"可能延迟"，但不影响计算。 */
function isStale(quoteAt: string): boolean {
  const parsed = Date.parse(quoteAt);
  if (!Number.isFinite(parsed)) return true;
  return Date.now() - parsed > 12 * 60 * 60 * 1000;
}

export async function refreshFunds(): Promise<{ state: FundsState; outcomes: RefreshOutcome[] }> {
  const holdings = await holdingRepo.listActive();
  // 占位持仓（只有名称和市值）没有可查询的基金代码，跳过，避免刷新时刷出一堆失败
  const codes = holdings.map((holding) => holding.fund_code).filter((code) => !isPlaceholderCode(code));
  const outcomes = await refreshQuotes(codes);
  const state = await loadFundsState();
  return { state, outcomes };
}

export async function loadSeries(code: string, range: QuoteRange): Promise<NavPoint[]> {
  try {
    return await manualProvider.fetchSeries(code, range);
  } catch {
    return [];
  }
}

export const fundsService = {
  loadFundsState,
  refreshFunds,
  loadSeries,
};
