import type { Account, Cents, FundQuote, Holding, Transaction } from '../types';
import { l1Icon, l1Name } from './categoryTree';
import { daysInMonth, formatMonthLabel, formatMonthShort, monthRange, shiftMonth } from './date';
import { isPlaceholderCode } from './holdingIdentity';
import type { HoldingProfitSnapshot } from './investment';
import { asCents } from './money';
import { addDays, monthsInRange, type DateRange } from './range';
import { isActiveTx } from './txUtils';

/**
 * 聚合口径（02-arch.md §3.6）。全部纯函数、只计算不存储：
 * 支出净额 = 支出毛额 − 退款冲正；结余 = 收入 − 支出净额；转账不进任何一边。
 */

export interface MonthTotals {
  /** 支出总额（毛） */
  expense_cents: Cents;
  /** 退款冲正合计 */
  refund_cents: Cents;
  /** 支出净额 = 毛 − 冲正，可为负 */
  net_expense_cents: Cents;
  income_cents: Cents;
  /** 结余 = 收入 − 支出净额 */
  balance_cents: Cents;
  transfer_cents: Cents;
  count: number;
}

const EMPTY_TOTALS: MonthTotals = {
  expense_cents: asCents(0),
  refund_cents: asCents(0),
  net_expense_cents: asCents(0),
  income_cents: asCents(0),
  balance_cents: asCents(0),
  transfer_cents: asCents(0),
  count: 0,
};

export function totalsOf(txs: readonly Transaction[]): MonthTotals {
  let expense = 0;
  let refund = 0;
  let income = 0;
  let transfer = 0;
  let count = 0;
  for (const tx of txs) {
    if (!isActiveTx(tx)) continue;
    count += 1;
    if (tx.direction === 'expense') expense += tx.amount_cents;
    else if (tx.direction === 'refund') refund += tx.amount_cents;
    else if (tx.direction === 'income') income += tx.amount_cents;
    else transfer += tx.amount_cents;
  }
  const netExpense = expense - refund;
  return {
    expense_cents: asCents(expense),
    refund_cents: asCents(refund),
    net_expense_cents: asCents(netExpense),
    income_cents: asCents(income),
    balance_cents: asCents(income - netExpense),
    transfer_cents: asCents(transfer),
    count,
  };
}

export function emptyTotals(): MonthTotals {
  return { ...EMPTY_TOTALS };
}

export interface CategoryShare {
  l1: string;
  name: string;
  icon: string;
  cents: Cents;
  ratio: number;
}

export interface CategorySharesResult {
  shares: CategoryShare[];
  /** 支出净额合计（分母） */
  total: Cents;
  pendingCount: number;
  hasPending: boolean;
}

/**
 * 分类占比：净额 = 该分类支出 − 该分类退款冲正；分母是支出净额。
 * 含待分类时 UI 必须打「含待分类」水印，避免被错误数据误导。
 */
export function categoryShares(txs: readonly Transaction[]): CategorySharesResult {
  const byL1 = new Map<string, number>();
  let pendingCount = 0;
  for (const tx of txs) {
    if (!isActiveTx(tx)) continue;
    if (tx.direction === 'expense') {
      byL1.set(tx.category_l1, (byL1.get(tx.category_l1) ?? 0) + tx.amount_cents);
      if (tx.category_l1 === 'other' && tx.category_l2 === 'pending') pendingCount += 1;
    } else if (tx.direction === 'refund') {
      // 退款不强制关联原单：用该笔自身分类冲减同分类净额
      byL1.set(tx.category_l1, (byL1.get(tx.category_l1) ?? 0) - tx.amount_cents);
    }
  }
  const total = [...byL1.values()].reduce((acc, value) => acc + value, 0);
  const shares: CategoryShare[] = [...byL1.entries()]
    .map(([l1, cents]) => ({
      l1,
      name: l1Name(l1),
      icon: l1Icon(l1),
      cents: asCents(cents),
      ratio: total > 0 ? cents / total : 0,
    }))
    .filter((share) => share.cents > 0)
    .sort((a, b) => b.cents - a.cents);
  return { shares, total: asCents(total), pendingCount, hasPending: pendingCount > 0 };
}

export interface TrendPoint {
  month_key: string;
  label: string;
  expense_cents: Cents;
  net_expense_cents: Cents;
  income_cents: Cents;
}

/** 近 N 月趋势：按月分桶，缺数据的月补 0（柱图需要连续轴）。 */
export function monthlyTrend(months: readonly string[], txs: readonly Transaction[]): TrendPoint[] {
  const buckets = new Map<string, Transaction[]>();
  for (const tx of txs) {
    if (!isActiveTx(tx)) continue;
    const bucket = buckets.get(tx.month_key) ?? [];
    bucket.push(tx);
    buckets.set(tx.month_key, bucket);
  }
  return months.map((month) => {
    const totals = totalsOf(buckets.get(month) ?? []);
    return {
      month_key: month,
      label: formatMonthShort(month),
      expense_cents: totals.expense_cents,
      net_expense_cents: totals.net_expense_cents,
      income_cents: totals.income_cents,
    };
  });
}

export interface FlowPoint {
  /** 'YYYY-MM' */
  month_key: string;
  /** 跨年可读：该月是 1 月或序列首月 → '2024年1月'，其余 → '3月' */
  label: string;
  income_cents: Cents;
  /** 支出**净额**（支出毛额 − 退款冲正），与 MonthTotals.net_expense_cents 同口径 */
  expense_cents: Cents;
  net_cents: Cents;
  cum_income_cents: Cents;
  cum_expense_cents: Cents;
  /** 从序列起点开始累加，可为负 */
  cum_net_cents: Cents;
}

/**
 * 跨月流水序列（趋势页「收支统计图 / 累计利润 / 累计收支」用）。
 *
 * 与 monthlyTrend 的三点差异，都是刻意的：
 * 1) 只统计 `months` 里显式列出的月份 —— 用集合过滤，而不是"恰好落在区间内"这种隐式假设，
 *    区间外的交易一律丢弃（否则跨年序列会把邻月数据混进来）。
 * 2) 支出用**净额**（毛利减退款），并且直接借 totalsOf 计算，绝不重写 direction==='refund'
 *    判断 —— 两条路径口径必须同源，否则同一页两张图的数字会互相打架。
 * 3) 缺月补 0 而不是跳过 —— 图表 X 轴需要连续月份，缺月是"这个月花了 0"，不是断点。
 * 累计值从序列第一个点开始累加（不是从历史起点），所以"累计利润"读作
 * "从所选区间起点至今的净额"，UI 副标题必须写清这一点。
 */
export function flowSeries(months: readonly string[], txs: readonly Transaction[]): FlowPoint[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const month of months) {
    if (seen.has(month)) continue;
    seen.add(month);
    ordered.push(month);
  }

  const buckets = new Map<string, Transaction[]>();
  for (const month of ordered) buckets.set(month, []);
  for (const tx of txs) {
    if (!isActiveTx(tx)) continue;
    // 关键：过滤条件是「月份在 months 集合里」，不是 tx.month_key 与区间比较
    const bucket = buckets.get(tx.month_key);
    if (!bucket) continue;
    bucket.push(tx);
  }

  let cumIncome = 0;
  let cumExpense = 0;
  let cumNet = 0;
  return ordered.map((month, index) => {
    const totals = totalsOf(buckets.get(month) ?? []);
    const income = totals.income_cents;
    const expense = totals.net_expense_cents;
    const net = income - expense;
    cumIncome += income;
    cumExpense += expense;
    cumNet += net;
    return {
      month_key: month,
      // 跨年序列里两个「1 月」都带年份，序列首点也带年份，其余月份省略年份保持轴宽
      label: index === 0 || month.slice(5, 7) === '01' ? formatMonthLabel(month) : formatMonthShort(month),
      income_cents: asCents(income),
      expense_cents: asCents(expense),
      net_cents: asCents(net),
      cum_income_cents: asCents(cumIncome),
      cum_expense_cents: asCents(cumExpense),
      cum_net_cents: asCents(cumNet),
    };
  });
}

/** 趋势页「整体收益走势」至少向前铺满的月数（区间更短时用它补足，免得曲线只剩一个点）。 */
export const OVERALL_TREND_MIN_MONTHS = 6;

/**
 * 整体收益走势：**从第一笔账**开始累计，X 轴默认只返回所选区间内的月份。
 *
 * 与 `flowSeries(monthsInRange(range))` 的区别是「零点在哪」：
 * - 后者从区间起点归零，回答「这段时间赚了多少」；
 * - 这里从记账第一天累计，回答「到某月为止一共攒了多少」。
 *
 * 区间起点之前的历史也会参与累计，所以曲线第一个点的 Y 值通常不是 0 ——
 * 这是刻意的：整体收益图应该接着历史往下画，而不是每到新区间就断一次。
 *
 * `minMonths` 是给 UI 用的「最少画几个月」：区间只选一个月时曲线退化成孤立的
 * 一个点，看不出任何走势，所以允许向前补足月份（不早于记账第一月）。
 * 默认 1 表示严格按区间返回，便于测试和「区间口径」的纯粹性。
 */
export function overallProfitSeries(
  allTxs: readonly Transaction[],
  range: DateRange,
  minMonths = 1,
): FlowPoint[] {
  const active = allTxs.filter(isActiveTx);
  if (active.length === 0) return [];

  let firstMonth = active[0].month_key;
  for (const tx of active) {
    if (tx.month_key < firstMonth) firstMonth = tx.month_key;
  }

  const toMonth = range.to.slice(0, 7);
  // 区间整个落在记账之前：没有可画的累计
  if (firstMonth > toMonth) return [];

  const fromMonth = range.from.slice(0, 7);
  const want = Math.max(1, Math.trunc(minMonths));
  let startMonth = fromMonth < firstMonth ? firstMonth : fromMonth;
  if (want > 1) {
    const span = monthsInRange({ from: `${startMonth}-01`, to: `${toMonth}-01` }).length;
    if (span < want) {
      const widened = shiftMonth(toMonth, -(want - 1));
      // 补足也不能早于记账第一月，否则会画出一段全 0 的假历史
      startMonth = widened < firstMonth ? firstMonth : widened;
    }
  }

  // 累计必须从第一笔账算起 —— flowSeries 的 cum 是从传入的 months 首月开始累加的，
  // 所以这里先铺满 firstMonth→区间末月，再把区间前的点裁掉，而不是只算区间那几个月。
  const months = monthsInRange({ from: `${firstMonth}-01`, to: range.to });
  const visible = flowSeries(months, allTxs).filter(
    (point) => point.month_key >= startMonth && point.month_key <= toMonth,
  );
  if (visible.length === 0) return visible;
  // 裁剪会把「序列首点」的完整年份标签一起裁掉，补回来免得 X 轴只剩「10月」这种悬空刻度
  const [head, ...rest] = visible;
  return [{ ...head, label: formatMonthLabel(head.month_key) }, ...rest];
}

/**
 * 含投资的整体收益点。
 *
 * `cum_net_cents` 仍是**纯现金流**累计（收入 − 支出净额），不要把它改写成含投资的值：
 * 那是下面「累计利润」等图共用的口径，改一处会静默影响全站。
 * 含投资的数字单独放在 `total_cents` 里。
 */
export interface OverallPoint extends FlowPoint {
  /** 该月末的持仓浮盈（市值 − 成本）；null = 定不了价，不是 0 */
  invest_cents: Cents | null;
  /** 整体收益 = 现金流累计 + 持仓浮盈；投资部分未知时整点为 null（宁可断线也不编数） */
  total_cents: Cents | null;
  /** 本月有几只持仓真的定了价（参与合计） */
  priced_holdings: number;
  /** 本月有几只持仓无法定价（缺净值或份额待补），已排除在合计外 */
  unpriced_holdings: number;
}

/**
 * 把持仓浮盈叠加到现金流累计上。
 *
 * 只加**浮盈**不加本金：用户的口径是「除投资成本外的净收益」，本金不是赚来的钱。
 * 投资部分为 null 时 `total_cents` 也给 null —— 图表靠断线表达"这段没有数据"，
 * 用 0 顶上会让用户以为那几个月基金持平。
 */
export function withInvestment(
  points: readonly FlowPoint[],
  snapshots: readonly HoldingProfitSnapshot[],
): OverallPoint[] {
  const byMonth = new Map(snapshots.map((snapshot) => [snapshot.month_key, snapshot]));
  return points.map((point) => {
    const snapshot = byMonth.get(point.month_key);
    const invest = snapshot ? snapshot.profit_cents : null;
    return {
      ...point,
      invest_cents: invest,
      total_cents: invest === null ? null : asCents(point.cum_net_cents + invest),
      priced_holdings: snapshot ? snapshot.priced : 0,
      unpriced_holdings: snapshot ? snapshot.unpriced : 0,
    };
  });
}

export function lastMonths(count: number, endMonth: string): string[] {
  const start = shiftMonth(endMonth, -(count - 1));
  return monthRange(start, endMonth);
}

/** 均值参考线（近 N 月支出净额均值），用于柱图横向参考线。 */
export function averageCents(points: readonly TrendPoint[], key: keyof Omit<TrendPoint, 'month_key' | 'label'> = 'net_expense_cents'): Cents {
  if (points.length === 0) return asCents(0);
  const total = points.reduce((acc, point) => acc + Number(point[key]), 0);
  return asCents(Math.round(total / points.length));
}

export interface CumulativePoint {
  day: number;
  label: string;
  cents: Cents;
}

/** 累计支出折线：本月 vs 上月叠加，看趋势斜率。 */
export function cumulativeByDay(txs: readonly Transaction[], month: string): CumulativePoint[] {
  const days = daysInMonth(month);
  const perDay = new Array<number>(days + 1).fill(0);
  for (const tx of txs) {
    if (!isActiveTx(tx) || tx.month_key !== month) continue;
    if (tx.direction !== 'expense') continue;
    const day = Number(tx.occurred_date.slice(8, 10));
    if (day >= 1 && day <= days) perDay[day] += tx.amount_cents;
  }
  const points: CumulativePoint[] = [];
  let running = 0;
  for (let day = 1; day <= days; day += 1) {
    running += perDay[day];
    points.push({ day, label: `${day}日`, cents: asCents(running) });
  }
  return points;
}

export interface RangeCumulativePoint {
  /** 'YYYY-MM-DD' */
  date: string;
  /** 轴标签：'3月5日'（抽样后仍然可读） */
  label: string;
  /** 截至当日的区间累计收入 */
  income_cents: Cents;
  /** 截至当日的区间累计支出**净额**（支出 − 退款冲正） */
  expense_cents: Cents;
}

/** 日历日点数超过这个值时按周抽样：一年 365 点尚可，两年 730 点会把折线挤成糊。 */
const RANGE_SAMPLE_THRESHOLD = 400;
const RANGE_SAMPLE_STEP = 7;

/**
 * 区间累计曲线（按 occurred_date 切片，与 month_key 无关）。
 *
 * ⚠️ 这里**绝不能**复用 cumulativeByDay：它用 `tx.month_key !== month` 直接跳过数据，
 * 区间数据会被过滤成空数组，而且不抛错。所以本函数只按 occurred_date 落桶。
 *
 * 语义：
 * - 区间内**每一天**都有点（没有交易的日子补上一日累计值），折线才不会断成一节节；
 * - 支出与 flowSeries 同口径（净额，扣除退款冲正）；
 * - 点数 > 400 时按 7 天步长抽样：保留第 0、7、14… 天，并**强制保留最后一天**，
 *   保证曲线终点仍是区间累计值；抽的是「显示点」，累计计算仍逐日进行，数值不失真。
 */
export function cumulativeInRange(range: DateRange, txs: readonly Transaction[]): RangeCumulativePoint[] {
  const start = range.from <= range.to ? range.from : range.to;
  const end = range.from <= range.to ? range.to : range.from;
  if (start > end) return [];

  const perDayIncome = new Map<string, number>();
  const perDayExpense = new Map<string, number>();
  for (const tx of txs) {
    if (!isActiveTx(tx)) continue;
    // 过滤条件是 occurred_date 落在区间内，不用 month_key（区间可以不是整月）
    if (tx.occurred_date < start || tx.occurred_date > end) continue;
    if (tx.direction === 'income') {
      perDayIncome.set(tx.occurred_date, (perDayIncome.get(tx.occurred_date) ?? 0) + tx.amount_cents);
    } else if (tx.direction === 'expense') {
      perDayExpense.set(tx.occurred_date, (perDayExpense.get(tx.occurred_date) ?? 0) + tx.amount_cents);
    } else if (tx.direction === 'refund') {
      perDayExpense.set(tx.occurred_date, (perDayExpense.get(tx.occurred_date) ?? 0) - tx.amount_cents);
    }
  }

  const totalDays = Math.max(1, Math.round((Date.parse(`${end}T12:00:00`) - Date.parse(`${start}T12:00:00`)) / 86400000) + 1);
  const sampled = totalDays > RANGE_SAMPLE_THRESHOLD;

  const points: RangeCumulativePoint[] = [];
  let cumIncome = 0;
  let cumExpense = 0;
  for (let index = 0; index < totalDays; index += 1) {
    const date = addDays(start, index);
    cumIncome += perDayIncome.get(date) ?? 0;
    cumExpense += perDayExpense.get(date) ?? 0;
    const isLast = index === totalDays - 1;
    if (sampled && index % RANGE_SAMPLE_STEP !== 0 && !isLast) continue;
    const [, month, day] = date.split('-').map(Number);
    points.push({
      date,
      label: `${month}月${day}日`,
      income_cents: asCents(cumIncome),
      expense_cents: asCents(cumExpense),
    });
  }
  return points;
}

/** 最贵 N 笔（时间成本榜也用它）。 */
export function topExpenses(txs: readonly Transaction[], limit = 5): Transaction[] {
  return txs
    .filter((tx) => isActiveTx(tx) && tx.direction === 'expense')
    .sort((a, b) => b.amount_cents - a.amount_cents)
    .slice(0, limit);
}

export interface AccountBalance {
  account: Account;
  balance_cents: Cents;
}

/** 账户余额 = opening + Σincome − Σexpense（负债账户 opening 为负，故直接相加）。 */
export function accountBalances(accounts: readonly Account[], txs: readonly Transaction[]): AccountBalance[] {
  const flows = new Map<string, number>();
  for (const tx of txs) {
    if (!isActiveTx(tx)) continue;
    const current = flows.get(tx.account_id) ?? 0;
    if (tx.direction === 'income') flows.set(tx.account_id, current + tx.amount_cents);
    else if (tx.direction === 'expense') flows.set(tx.account_id, current - tx.amount_cents);
    else if (tx.direction === 'refund') flows.set(tx.account_id, current + tx.amount_cents);
  }
  return accounts.map((account) => ({
    account,
    balance_cents: asCents(account.opening_balance_cents + (flows.get(account.id) ?? 0)),
  }));
}

export interface HoldingView {
  holding: Holding;
  /** 最近一次成功获取的净值/场内价；没有则为 null（绝不显示 0） */
  nav: number | null;
  nav_date: string | null;
  quote_at: string | null;
  quote_kind: 'nav' | 'market_price' | null;
  /** 数据过期（非交易时段或刷新失败）→ UI 打「数据截至 X 日」灰字 */
  stale: boolean;
  market_value_cents: Cents | null;
  cost_nav: number;
  profit_cents: Cents | null;
  profit_ratio: number | null;
}

/** 多笔加仓合并为加权成本：avg_cost_nav = total_cost ÷ shares。 */
export function avgCostNav(shares: number, totalCostCents: number): number {
  if (!shares || shares <= 0) return 0;
  return totalCostCents / 100 / shares;
}

export function buildHoldingViews(
  holdings: readonly Holding[],
  latestQuotes: ReadonlyMap<string, FundQuote>,
): HoldingView[] {
  return holdings.map((holding) => {
    const quote = latestQuotes.get(holding.fund_code);
    const nav = quote ? quote.nav : null;
    /**
     * 占位持仓（从持仓列表页导入、份额待补）：shares = 0，
     * 截图里的金额被存进了 total_cost_cents（反推成本）。
     * 此时市值 = 那笔金额，收益未知 → null。
     *
     * 不能走下面的 shares × nav：0 × 净值 = 0，收益会变成「-成本」，
     * 用户会看到一只「巨亏」的持仓——这是最不能接受的一种错账。
     */
    const placeholder = holding.shares <= 0;
    /** 截图导入的降级记录（占位代码或份额待补）：没有行情时用截图金额当市值 */
    const synthetic = placeholder || isPlaceholderCode(holding.fund_code);
    // 基金净值本身就是浮点数（0.5916 这类 4 位小数），市值天然是浮点结果；
    // 这是全库唯一一处「元 → 分」的浮点边界，转换后立刻回到整数分运算。
    const marketValue =
      holding.shares > 0 && nav !== null
        ? asCents(Math.round(holding.shares * nav * 100))
        : synthetic
          ? holding.total_cost_cents
          : null;
    // 份额和行情缺任意一个，收益就是未知 → null（UI 显示「待补」，不拿 0 冒充）
    const profit =
      holding.shares > 0 && nav !== null && marketValue !== null
        ? asCents(marketValue - holding.total_cost_cents)
        : null;
    const profitRatio =
      profit !== null && holding.total_cost_cents > 0 ? profit / holding.total_cost_cents : null;
    return {
      holding,
      nav,
      nav_date: quote ? quote.nav_date : null,
      quote_at: quote ? quote.quote_at : null,
      quote_kind: quote ? (quote.kind === 'estimate' ? 'nav' : quote.kind) : null,
      stale: true,
      market_value_cents: marketValue,
      cost_nav: holding.avg_cost_nav || avgCostNav(holding.shares, holding.total_cost_cents),
      profit_cents: profit,
      profit_ratio: profitRatio,
    };
  });
}

export function fundMarketValue(views: readonly HoldingView[]): Cents {
  return asCents(views.reduce((acc, view) => acc + (view.market_value_cents ?? 0), 0));
}

export function fundTotalCost(holdings: readonly Holding[]): Cents {
  return asCents(holdings.filter((holding) => !holding.closed_at).reduce((acc, holding) => acc + holding.total_cost_cents, 0));
}

export interface NetWorthResult {
  net_worth_cents: Cents;
  cash_cents: Cents;
  fund_cents: Cents;
  liability_cents: Cents;
}

/**
 * 净资产 = Σ账户余额 + Σ基金市值。
 * 负债账户余额本身为负（花呗欠 300 记 −30000），故直接相加。
 */
export function netWorth(
  accounts: readonly Account[],
  txs: readonly Transaction[],
  fundValue: Cents,
): NetWorthResult {
  const balances = accountBalances(accounts, txs);
  let cash = 0;
  let liability = 0;
  for (const item of balances) {
    if (item.account.is_liability) liability += Math.min(0, item.balance_cents);
    else cash += item.balance_cents;
  }
  return {
    net_worth_cents: asCents(cash + liability + fundValue),
    cash_cents: asCents(cash),
    fund_cents: fundValue,
    liability_cents: asCents(liability),
  };
}

export interface CompareResult {
  current_cents: Cents;
  baseline_cents: Cents | null;
  delta_cents: Cents;
  /** 绝对变化率；基线为 0 时给 null，由 UI 决定文案 */
  ratio: number | null;
  label: string;
}

export function compareMonths(
  currentCents: Cents,
  baselineCents: Cents | null,
  label: string,
): CompareResult {
  if (baselineCents === null) {
    return { current_cents: currentCents, baseline_cents: null, delta_cents: asCents(0), ratio: null, label };
  }
  const delta = asCents(currentCents - baselineCents);
  return {
    current_cents: currentCents,
    baseline_cents: baselineCents,
    delta_cents: delta,
    ratio: baselineCents !== 0 ? delta / baselineCents : null,
    label,
  };
}

export interface CompareBundle {
  mom: CompareResult;
  yoy: CompareResult | null;
  avg3: CompareResult | null;
}

/**
 * 三类对比：环比（有上月数据就有）、同比（≥12 个月数据才出现）、近 3 月均值。
 * **只和自己比** —— 产品内不得出现"同龄人/平均用户"。
 */
export function buildCompare(
  monthKey: string,
  txs: readonly Transaction[],
  availableMonths: readonly string[],
): CompareBundle {
  const current = totalsOf(txs.filter((tx) => tx.month_key === monthKey)).net_expense_cents;
  const prevMonth = shiftMonth(monthKey, -1);
  const prev = availableMonths.includes(prevMonth)
    ? totalsOf(txs.filter((tx) => tx.month_key === prevMonth)).net_expense_cents
    : null;
  const lastYearMonth = shiftMonth(monthKey, -12);
  const lastYear = availableMonths.includes(lastYearMonth)
    ? totalsOf(txs.filter((tx) => tx.month_key === lastYearMonth)).net_expense_cents
    : null;

  const avgMonths = [1, 2, 3].map((offset) => shiftMonth(monthKey, -offset)).filter((m) => availableMonths.includes(m));
  const avgBase =
    avgMonths.length > 0
      ? asCents(
          Math.round(
            avgMonths.reduce((acc, m) => acc + totalsOf(txs.filter((tx) => tx.month_key === m)).net_expense_cents, 0) /
              avgMonths.length,
          ),
        )
      : null;

  return {
    mom: compareMonths(current, prev, '比上月'),
    yoy: lastYear !== null ? compareMonths(current, lastYear, '比去年同月') : null,
    avg3: avgBase !== null ? compareMonths(current, avgBase, `比近 ${avgMonths.length} 月均值`) : null,
  };
}

export interface OverviewVM {
  month_key: string;
  totals: MonthTotals;
  prev_totals: MonthTotals;
  mom_delta_cents: Cents;
  net_worth: NetWorthResult;
  pending_count: number;
  suspected_count: number;
  /** 该月有账但没生成复盘卡 */
  review_ready: boolean;
}

export function buildOverview(input: {
  monthKey: string;
  monthTxs: readonly Transaction[];
  prevMonthTxs: readonly Transaction[];
  allTxs: readonly Transaction[];
  accounts: readonly Account[];
  fundValue: Cents;
  pendingCount: number;
  suspectedCount: number;
  hasReview: boolean;
}): OverviewVM {
  const totals = totalsOf(input.monthTxs);
  const prev = totalsOf(input.prevMonthTxs);
  return {
    month_key: input.monthKey,
    totals,
    prev_totals: prev,
    mom_delta_cents: asCents(totals.net_expense_cents - prev.net_expense_cents),
    net_worth: netWorth(input.accounts, input.allTxs, input.fundValue),
    pending_count: input.pendingCount,
    suspected_count: input.suspectedCount,
    review_ready: totals.count > 0 && !input.hasReview,
  };
}

/** 日均支出，用于「异常单笔」规则解释与目标进度推算。 */
export function dailyAverage(txs: readonly Transaction[], monthKey: string): Cents {
  const total = totalsOf(txs.filter((tx) => tx.month_key === monthKey)).net_expense_cents;
  const days = Math.max(1, daysInMonth(monthKey));
  return asCents(Math.round(total / days));
}
