import { describe, expect, it } from 'vitest';
import { buildHoldingViews, withInvestment, type FlowPoint } from '../domain/aggregate';
import { monthEndDate, monthlyHoldingProfit, navAsOf, navSeriesByCode } from '../domain/investment';
import { asCents } from '../domain/money';
import type { FundQuote, Holding } from '../types';

/**
 * 持仓浮盈的**历史**口径 —— 趋势页「整体收益」的投资部分。
 *
 * 这一层的每一分钱都可能被用户当成"我基金到底赚了多少"，所以测试盯的是三件事：
 * 月末取哪个净值、不存在的月份给 0 还是 null、以及和基金页（buildHoldingViews）
 * 在同一个净值下必须算出**完全相同**的数字。
 */

const CODE = '000051';

function makeHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    id: `hold_${CODE}`,
    fund_code: CODE,
    fund_name: '华夏盛世混合',
    platform: 'alipay',
    // 1000 份、成本 900 元 → 净值 1.0 时浮盈 +100 元
    shares: 1000,
    total_cost_cents: asCents(90000),
    avg_cost_nav: 0.9,
    first_buy_date: '2026-01-15',
    ...overrides,
  };
}

function navAt(date: string, nav: number, code = CODE, kind: FundQuote['kind'] = 'nav'): FundQuote {
  return {
    id: `${code}:${date}:${kind}`,
    fund_code: code,
    nav,
    nav_date: date,
    kind,
    quote_at: `${date}T10:00:00+08:00`,
    source: 'eastmoney_pzdata',
  };
}

const SERIES = [
  navAt('2026-01-20', 1.0),
  navAt('2026-02-28', 1.2),
  navAt('2026-03-10', 0.9),
];

describe('navSeriesByCode: 净值分组', () => {
  it('只收 kind=nav，按日期升序，同日重复取最后写入的', () => {
    const quotes = [
      navAt('2026-02-28', 1.2),
      navAt('2026-01-20', 1.0),
      navAt('2026-02-28', 1.25),
      navAt('2026-03-01', 9.9, CODE, 'estimate'),
    ];
    const series = navSeriesByCode(quotes).get(CODE) ?? [];
    expect(series.map((point) => point.nav_date)).toEqual(['2026-01-20', '2026-02-28']);
    expect(series[1].nav).toBe(1.25);
  });

  it('多只基金各归各的，互不串行', () => {
    const series = navSeriesByCode([navAt('2026-01-20', 1.0), navAt('2026-01-21', 2.0, '110011')]);
    expect(series.get(CODE)?.[0].nav).toBe(1);
    expect(series.get('110011')?.[0].nav).toBe(2);
  });
});

describe('navAsOf: 取"当天或之前最近"的净值', () => {
  it('不提前使用未来净值', () => {
    expect(navAsOf(SERIES, '2026-01-31')).toBe(1.0);
    expect(navAsOf(SERIES, '2026-03-01')).toBe(1.2);
  });

  it('月末当天有净值就取当天（闭区间）', () => {
    expect(navAsOf(SERIES, '2026-02-28')).toBe(1.2);
  });

  it('序列里全是未来数据 → null，不倒退用最早的一个', () => {
    expect(navAsOf(SERIES, '2026-01-01')).toBeNull();
  });

  it('空序列 / undefined → null', () => {
    expect(navAsOf([], '2026-01-31')).toBeNull();
    expect(navAsOf(undefined, '2026-01-31')).toBeNull();
  });
});

describe('monthlyHoldingProfit: 逐月末浮盈', () => {
  const series = navSeriesByCode(SERIES);

  it('每个月末用当时的净值算浮盈（市值 − 成本）', () => {
    const snapshots = monthlyHoldingProfit([makeHolding()], series, ['2026-01', '2026-02', '2026-03']);
    // 1 月：1000 × 1.0 = 1000 元，成本 900 → +100；2 月：1.2 → +300；3 月：0.9 → 0
    expect(snapshots.map((snapshot) => snapshot.profit_cents)).toEqual([10000, 30000, 0]);
    expect(snapshots.map((snapshot) => snapshot.priced)).toEqual([1, 1, 1]);
    expect(snapshots.map((snapshot) => snapshot.unpriced)).toEqual([0, 0, 0]);
  });

  it('买入月之前不算这只持仓：那时浮盈是 0（事实），不是 null', () => {
    const snapshots = monthlyHoldingProfit([makeHolding()], series, ['2025-12']);
    expect(snapshots[0].profit_cents).toBe(0);
    expect(snapshots[0].priced).toBe(0);
    expect(snapshots[0].unpriced).toBe(0);
  });

  it('完全没有持仓时每个月都是 0（不是未知）', () => {
    const snapshots = monthlyHoldingProfit([], series, ['2026-01', '2026-02']);
    expect(snapshots.map((snapshot) => snapshot.profit_cents)).toEqual([0, 0]);
  });

  it('有持仓但缺净值 → null，绝不拿 0 冒充', () => {
    const snapshots = monthlyHoldingProfit([makeHolding()], series, ['2026-01']);
    const early = monthlyHoldingProfit([makeHolding()], new Map(), ['2026-01']);
    expect(snapshots[0].profit_cents).toBe(10000);
    expect(early[0].profit_cents).toBeNull();
    expect(early[0].unpriced).toBe(1);
  });

  it('份额待补（占位持仓）不计入合计，并计入 unpriced', () => {
    const placeholder = makeHolding({
      id: 'hold_name',
      fund_code: 'NAME:易方达蓝筹精选混合',
      fund_name: '易方达蓝筹精选混合',
      shares: 0,
      total_cost_cents: asCents(893273),
    });
    const snapshots = monthlyHoldingProfit([makeHolding(), placeholder], series, ['2026-02']);
    expect(snapshots[0].profit_cents).toBe(30000);
    expect(snapshots[0].priced).toBe(1);
    expect(snapshots[0].unpriced).toBe(1);
  });

  it('只有占位持仓 → 整个月未知（null）', () => {
    const placeholder = makeHolding({ fund_code: 'NAME:某基金', shares: 0 });
    const snapshots = monthlyHoldingProfit([placeholder], series, ['2026-02']);
    expect(snapshots[0].profit_cents).toBeNull();
    expect(snapshots[0].unpriced).toBe(1);
  });

  it('清仓之后不再计入浮盈（按月末是否仍持有判断）', () => {
    const closed = makeHolding({ closed_at: '2026-02-15' });
    const snapshots = monthlyHoldingProfit([closed], series, ['2026-01', '2026-02']);
    // 1 月末还持有 → +100 元；2 月 15 日已清仓，2 月末不再持有 → 0
    expect(snapshots[0].profit_cents).toBe(10000);
    expect(snapshots[1].profit_cents).toBe(0);
    expect(snapshots[1].priced).toBe(0);
    // 清仓会让曲线掉一截：卖出得到的现金账本里没有记录，这里不编一个数字给它
  });

  it('多只持仓求和；其中一只缺净值时其余照算并标 unpriced', () => {
    const other = makeHolding({
      id: 'hold_other',
      fund_code: '110011',
      shares: 2000,
      total_cost_cents: asCents(200000),
      first_buy_date: '2026-01-01',
    });
    const withBoth = navSeriesByCode([...SERIES, navAt('2026-02-27', 1.5, '110011')]);
    const snapshots = monthlyHoldingProfit([makeHolding(), other], withBoth, ['2026-02']);
    // 华夏 +300 元；另一只 2000 × 1.5 = 3000 元，成本 2000 → +1000 元
    expect(snapshots[0].profit_cents).toBe(30000 + 100000);
    expect(snapshots[0].priced).toBe(2);

    const missing = monthlyHoldingProfit([makeHolding(), other], series, ['2026-02']);
    expect(missing[0].profit_cents).toBe(30000);
    expect(missing[0].unpriced).toBe(1);
  });

  it('浮点份额/净值也落在整数分上，不残留浮点尾数', () => {
    const odd = makeHolding({ shares: 1234.5678, total_cost_cents: asCents(150000) });
    const oddSeries = navSeriesByCode([navAt('2026-01-31', 1.2345)]);
    const [snapshot] = monthlyHoldingProfit([odd], oddSeries, ['2026-01']);
    expect(Number.isInteger(snapshot.profit_cents)).toBe(true);
    expect(snapshot.profit_cents).toBe(Math.round(1234.5678 * 1.2345 * 100) - 150000);
  });

  it('同一净值下与基金页 buildHoldingViews 的浮盈完全一致（两处算法不许分叉）', () => {
    const holding = makeHolding();
    const latest = navAt('2026-02-28', 1.2);
    const views = buildHoldingViews([holding], new Map([[CODE, latest]]));
    const [snapshot] = monthlyHoldingProfit([holding], navSeriesByCode([latest]), ['2026-02']);
    expect(snapshot.profit_cents).toBe(views[0].profit_cents);
  });
});

describe('monthEndDate', () => {
  it('闰年 2 月是 29 号', () => {
    expect(monthEndDate('2024-02')).toBe('2024-02-29');
    expect(monthEndDate('2026-02')).toBe('2026-02-28');
    expect(monthEndDate('2026-12')).toBe('2026-12-31');
  });
});

describe('withInvestment: 把浮盈叠加到现金流累计上', () => {
  function point(monthKey: string, cumNet: number): FlowPoint {
    return {
      month_key: monthKey,
      label: monthKey,
      income_cents: asCents(0),
      expense_cents: asCents(0),
      net_cents: asCents(0),
      cum_income_cents: asCents(0),
      cum_expense_cents: asCents(0),
      cum_net_cents: asCents(cumNet),
    };
  }

  it('整体收益 = 现金流累计 + 持仓浮盈，现金流字段本身不被改写', () => {
    const points = [point('2026-01', -200000), point('2026-02', -100000)];
    const [jan, feb] = withInvestment(points, [
      { month_key: '2026-01', profit_cents: asCents(10000), priced: 1, unpriced: 0 },
      { month_key: '2026-02', profit_cents: asCents(30000), priced: 1, unpriced: 0 },
    ]);
    expect(jan.cum_net_cents).toBe(-200000);
    expect(jan.total_cents).toBe(-190000);
    expect(feb.total_cents).toBe(-70000);
  });

  it('投资部分未知时 total 为 null（断线），但仍保留现金流数字', () => {
    const [jan] = withInvestment([point('2026-01', -200000)], [
      { month_key: '2026-01', profit_cents: null, priced: 0, unpriced: 1 },
    ]);
    expect(jan.total_cents).toBeNull();
    expect(jan.invest_cents).toBeNull();
    expect(jan.unpriced_holdings).toBe(1);
    expect(jan.cum_net_cents).toBe(-200000);
  });

  it('没有对应月份快照时按未知处理，不默认 0', () => {
    const [jan] = withInvestment([point('2026-01', 5000)], []);
    expect(jan.total_cents).toBeNull();
    expect(jan.invest_cents).toBeNull();
    expect(jan.unpriced_holdings).toBe(0);
  });
});
