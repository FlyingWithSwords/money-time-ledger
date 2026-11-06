import { describe, expect, it } from 'vitest';
import { flowSeries, overallProfitSeries, totalsOf } from '../domain/aggregate';
import type { DateRange } from '../domain/range';
import { wholeMonthRange } from '../domain/range';
import type { Transaction } from '../types';
import { makeTx } from './txFixture';

/** 与 flowSeries.test 同一份样本：1 月净 +220000，2 月 0，3 月 −350000。 */
const SAMPLE: Transaction[] = [
  makeTx({ id: 'jan-exp', at: '2026-01-05T12:00:00+08:00', amount: 300000 }),
  makeTx({ id: 'jan-refund', at: '2026-01-06T12:00:00+08:00', amount: 20000, direction: 'refund' }),
  makeTx({ id: 'jan-income', at: '2026-01-10T12:00:00+08:00', amount: 500000, direction: 'income', l1: 'salary' }),
  makeTx({ id: 'feb-exp', at: '2026-02-03T12:00:00+08:00', amount: 500000 }),
  makeTx({ id: 'feb-income', at: '2026-02-11T12:00:00+08:00', amount: 500000, direction: 'income', l1: 'salary' }),
  makeTx({ id: 'mar-exp', at: '2026-03-02T12:00:00+08:00', amount: 400000 }),
  makeTx({ id: 'mar-refund', at: '2026-03-09T12:00:00+08:00', amount: 50000, direction: 'refund' }),
];

const span = (from: string, to: string): DateRange => ({ from, to });

describe('overallProfitSeries: 从记账第一天累计的整体收益', () => {
  it('无交易时返回空数组（页面走空态，而不是画一条贴地零线）', () => {
    expect(overallProfitSeries([], wholeMonthRange('2026-03'))).toEqual([]);
  });

  it('区间落在记账之前：没有累计可画，返回空数组', () => {
    expect(overallProfitSeries(SAMPLE, wholeMonthRange('2025-12'))).toEqual([]);
  });

  it('只看 3 月：X 轴只给 3 月一个点，但累计值承接 1—2 月的历史', () => {
    const points = overallProfitSeries(SAMPLE, wholeMonthRange('2026-03'));
    expect(points).toHaveLength(1);
    expect(points[0].month_key).toBe('2026-03');
    // 220000 + 0 − 350000，不是 −350000
    expect(points[0].cum_net_cents).toBe(-130000);
    expect(points[0].net_cents).toBe(-350000);
  });

  it('区间 2—3 月：首点已经是历史累计（220000），不从 0 起算', () => {
    const points = overallProfitSeries(SAMPLE, span('2026-02-01', '2026-03-31'));
    expect(points.map((point) => point.month_key)).toEqual(['2026-02', '2026-03']);
    expect(points.map((point) => point.cum_net_cents)).toEqual([220000, -130000]);
  });

  it('全历史区间：三个月逐点累计（与 flowSeries 全量口径一致）', () => {
    const points = overallProfitSeries(SAMPLE, span('2026-01-01', '2026-03-31'));
    expect(points.map((point) => point.cum_net_cents)).toEqual([220000, 220000, -130000]);
    // 首点不为 0 正是这张图存在的理由
    expect(points[0].cum_net_cents).not.toBe(0);
  });

  it('区间中间缺月补 0 且累计持平（4 月无交易不跳过）', () => {
    const withMay = [...SAMPLE, makeTx({ id: 'may-exp', at: '2026-05-08T12:00:00+08:00', amount: 10000 })];
    const points = overallProfitSeries(withMay, span('2026-03-01', '2026-06-30'));
    expect(points.map((point) => point.month_key)).toEqual(['2026-03', '2026-04', '2026-05', '2026-06']);
    expect(points.map((point) => point.cum_net_cents)).toEqual([-130000, -130000, -140000, -140000]);
  });

  it('末点等于全量流水的净额合计（与其它图表的数字必须同源）', () => {
    const points = overallProfitSeries(SAMPLE, span('2026-01-01', '2026-03-31'));
    const totals = totalsOf(SAMPLE);
    expect(points[points.length - 1].cum_net_cents).toBe(totals.income_cents - totals.net_expense_cents);
    // 与 flowSeries 直接算全量序列的最后一点完全相等
    const full = flowSeries(['2026-01', '2026-02', '2026-03'], SAMPLE);
    expect(points[points.length - 1].cum_net_cents).toBe(full[full.length - 1].cum_net_cents);
  });

  it('软删交易既不进累计，也不把起始月拉到它所在的月份', () => {
    const deleted: Transaction = {
      ...makeTx({ id: 'gone', at: '2025-06-01T12:00:00+08:00', amount: 777700 }),
      deleted_at: '2025-06-02T00:00:00Z',
    };
    const points = overallProfitSeries([...SAMPLE, deleted], span('2025-06-01', '2026-03-31'));
    expect(points.map((point) => point.month_key)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(points[0].cum_net_cents).toBe(220000);
  });

  it('被裁决为 duplicate 的交易不参与累计', () => {
    const dup = makeTx({ id: 'dup', at: '2026-03-04T12:00:00+08:00', amount: 70000, dedupe_status: 'duplicate' });
    const points = overallProfitSeries([...SAMPLE, dup], span('2026-01-01', '2026-03-31'));
    expect(points[points.length - 1].cum_net_cents).toBe(-130000);
  });

  it('X 轴月份恒等于区间内月份，且严格按月升序', () => {
    const points = overallProfitSeries(SAMPLE, span('2026-01-15', '2026-02-20'));
    expect(points.map((point) => point.month_key)).toEqual(['2026-01', '2026-02']);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].month_key > points[i - 1].month_key).toBe(true);
    }
  });
});

/**
 * minMonths：区间太短时向前补足月份。
 *
 * 为什么需要：区间只选一个月，曲线就是一个孤立的点，"走势"无处可看。
 * 补足只能往**历史方向**补，绝不能早于记账第一月（否则前面会挂上一段全 0 的假历史，
 * 用户会以为那几个月真的一分没攒）。
 */
describe('overallProfitSeries: 区间过短时向前补足', () => {
  it('minMonths=6 且历史只有 3 个月：补到记账第一月就停，不会造出更早的空月', () => {
    const points = overallProfitSeries(SAMPLE, wholeMonthRange('2026-03'), 6);
    expect(points.map((point) => point.month_key)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(points[0].month_key).toBe('2026-01');
  });

  it('minMonths=6 且历史足够长：向前铺满 6 个月，末点仍是区间末月的累计', () => {
    const long = [makeTx({ id: 'jun-25', at: '2025-06-01T12:00:00+08:00', amount: 100000 }), ...SAMPLE];
    const points = overallProfitSeries(long, wholeMonthRange('2026-03'), 6);
    expect(points.map((point) => point.month_key)).toEqual([
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
    ]);
    // 补足只改 X 轴范围，累计值不变：−100000 + 220000 − 350000
    expect(points[points.length - 1].cum_net_cents).toBe(-230000);
  });

  it('默认 minMonths=1 时严格按区间返回，不做任何补足', () => {
    const points = overallProfitSeries(SAMPLE, wholeMonthRange('2026-03'));
    expect(points.map((point) => point.month_key)).toEqual(['2026-03']);
  });

  it('区间够长时不触发补足（月份集合与区间完全一致）', () => {
    const points = overallProfitSeries(SAMPLE, span('2026-01-01', '2026-03-31'), 6);
    expect(points.map((point) => point.month_key)).toEqual(['2026-01', '2026-02', '2026-03']);
  });
});
