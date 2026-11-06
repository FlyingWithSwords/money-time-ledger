import type { Cents, FundQuote, Holding } from '../types';
import { daysInMonth } from './date';
import { isPlaceholderCode } from './holdingIdentity';
import { asCents } from './money';

/**
 * 持仓投资浮盈的**历史**口径。
 *
 * 为什么单独一个模块：基金模块只回答「此刻值多少」（`buildHoldingViews` 用最新净值），
 * 而趋势页要回答「过去每个月末值多少」。两者的数据前提完全不同，混在一起会互相污染。
 *
 * 三条不可退让的原则：
 * 1. **未知就是 null，不是 0**。份额待补、缺净值、买入日之后才有行情，都必须如实标出来，
 *    否则用户在图上看到的是「过去半年基金一分没赚」这种假信息。
 * 2. **只算浮盈（市值 − 成本），不把本金计入收益**。用户明确要求「除投资成本外净收益」：
 *    本金不是赚来的钱，混进来会让曲线凭空抬高一个本金量级。
 * 3. **不回溯未来**。`first_buy_date` 之前该持仓不存在；`closed_at` 之后不再持有。
 *    历史份额只能用当前份额近似（账本没有加仓流水），这一点由 UI 文案说明，绝不假装精确。
 */

export interface NavPointLite {
  nav: number;
  nav_date: string;
}

export interface HoldingProfitSnapshot {
  /** 'YYYY-MM' */
  month_key: string;
  /** 该月末持仓浮盈合计；没有任何可定价持仓（且确实有持仓）→ null */
  profit_cents: Cents | null;
  /** 参与合计的持仓数 */
  priced: number;
  /** 有份额但缺净值/缺份额（份额待补），已排除在合计外 */
  unpriced: number;
}

/** 净值序列按代码分组，按 nav_date 升序（同日只保留最后写入的一条）。 */
export function navSeriesByCode(quotes: readonly FundQuote[]): Map<string, NavPointLite[]> {
  const grouped = new Map<string, Map<string, number>>();
  for (const quote of quotes) {
    if (quote.kind !== 'nav') continue;
    let byDate = grouped.get(quote.fund_code);
    if (!byDate) {
      byDate = new Map();
      grouped.set(quote.fund_code, byDate);
    }
    byDate.set(quote.nav_date, quote.nav);
  }
  const result = new Map<string, NavPointLite[]>();
  for (const [code, byDate] of grouped) {
    result.set(
      code,
      [...byDate.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([nav_date, nav]) => ({ nav_date, nav })),
    );
  }
  return result;
}

/** 'YYYY-MM' → 该月最后一天 'YYYY-MM-DD'。 */
export function monthEndDate(monthKey: string): string {
  return `${monthKey}-${String(daysInMonth(monthKey)).padStart(2, '0')}`;
}

/** 取 `date` 当天或之前最近的一个净值点（future 数据不能提前用）。 */
export function navAsOf(series: readonly NavPointLite[] | undefined, date: string): number | null {
  if (!series || series.length === 0) return null;
  let nav: number | null = null;
  for (const point of series) {
    if (point.nav_date > date) break;
    nav = point.nav;
  }
  return nav;
}

/** 持仓在指定日期是否仍然存在（未清仓、已买入）。 */
function holdingAliveAt(holding: Holding, date: string): boolean {
  if (holding.first_buy_date && holding.first_buy_date > date) return false;
  if (holding.closed_at && holding.closed_at < date) return false;
  return true;
}

/**
 * 逐个月末计算持仓浮盈。
 *
 * 份额用**当前份额**近似历史（账本没有加仓流水，这是唯一可行且不编造的方法）；
 * 净值用该月末之前最近的净值点（净值是阶梯数据，取最近点是标准做法，不做插值）。
 */
export function monthlyHoldingProfit(
  holdings: readonly Holding[],
  navSeries: ReadonlyMap<string, readonly NavPointLite[]>,
  months: readonly string[],
): HoldingProfitSnapshot[] {
  return months.map((month_key) => {
    const date = monthEndDate(month_key);
    let sum = 0;
    let priced = 0;
    let unpriced = 0;
    let alive = 0;

    for (const holding of holdings) {
      if (!holdingAliveAt(holding, date)) continue;
      alive += 1;

      // 份额待补：市值/成本里有的是截图金额，收益未知，绝不按 0 计入
      if (holding.shares <= 0 || isPlaceholderCode(holding.fund_code)) {
        unpriced += 1;
        continue;
      }
      const nav = navAsOf(navSeries.get(holding.fund_code), date);
      if (nav === null) {
        unpriced += 1;
        continue;
      }
      // 全库唯一一处「元 → 分」的浮点边界，与 buildHoldingViews 保持同一算法
      const marketValue = Math.round(holding.shares * nav * 100);
      sum += marketValue - holding.total_cost_cents;
      priced += 1;
    }

    return {
      month_key,
      // 有持仓却一只都定不了价 → 未知；压根没持仓 → 0 是事实
      profit_cents: priced > 0 ? asCents(sum) : alive > 0 ? null : asCents(0),
      priced,
      unpriced,
    };
  });
}
