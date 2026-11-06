import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import * as transactionRepo from '../db/repos/transactionRepo';
import { flowSeries, totalsOf } from '../domain/aggregate';
import { asCents } from '../domain/money';
import { wholeMonthRange } from '../domain/range';
import type { Transaction } from '../types';
import { makeTx } from './txFixture';

/** 三个月的固定样本：1 月有退款冲正、3 月支出大于收入（累计要变负）。 */
const SAMPLE: Transaction[] = [
  makeTx({ id: 'jan-exp', at: '2026-01-05T12:00:00+08:00', amount: 300000 }),
  makeTx({ id: 'jan-refund', at: '2026-01-06T12:00:00+08:00', amount: 20000, direction: 'refund' }),
  makeTx({ id: 'jan-income', at: '2026-01-10T12:00:00+08:00', amount: 500000, direction: 'income', l1: 'salary' }),
  makeTx({ id: 'feb-exp', at: '2026-02-03T12:00:00+08:00', amount: 500000 }),
  makeTx({ id: 'feb-income', at: '2026-02-11T12:00:00+08:00', amount: 500000, direction: 'income', l1: 'salary' }),
  makeTx({ id: 'mar-exp', at: '2026-03-02T12:00:00+08:00', amount: 400000 }),
  makeTx({ id: 'mar-refund', at: '2026-03-09T12:00:00+08:00', amount: 50000, direction: 'refund' }),
];

describe('flowSeries: 跨月流水序列', () => {
  it('空输入返回 months 个点且全部为 0（不是空数组）', () => {
    const points = flowSeries(['2026-01', '2026-02', '2026-03'], []);
    expect(points).toHaveLength(3);
    for (const point of points) {
      expect(point.income_cents).toBe(0);
      expect(point.expense_cents).toBe(0);
      expect(point.net_cents).toBe(0);
      expect(point.cum_income_cents).toBe(0);
      expect(point.cum_expense_cents).toBe(0);
      expect(point.cum_net_cents).toBe(0);
    }
  });

  it('单月收支与净额正确（支出用净额口径）', () => {
    const points = flowSeries(['2026-03'], [SAMPLE[5], SAMPLE[6]]);
    expect(points).toHaveLength(1);
    expect(points[0].income_cents).toBe(0);
    expect(points[0].expense_cents).toBe(350000); // 400000 − 50000 冲正
    expect(points[0].net_cents).toBe(-350000);
    expect(points[0].cum_net_cents).toBe(-350000);
  });

  it('跨年序列 label：1 月与序列首月带年份，其余只给月份', () => {
    const points = flowSeries(['2024-11', '2024-12', '2025-01', '2025-02'], []);
    expect(points.map((point) => point.label)).toEqual(['2024年11月', '12月', '2025年1月', '2月']);
  });

  it('退款冲正口径与 totalsOf 完全一致（否则两张图会打架）', () => {
    const points = flowSeries(['2026-01', '2026-02', '2026-03'], SAMPLE);
    for (const point of points) {
      const sameMonth = SAMPLE.filter((tx) => tx.month_key === point.month_key);
      const totals = totalsOf(sameMonth);
      expect(point.expense_cents).toBe(totals.net_expense_cents);
      expect(point.income_cents).toBe(totals.income_cents);
    }
  });

  it('累计值逐点手工核对（可为负）', () => {
    const points = flowSeries(['2026-01', '2026-02', '2026-03'], SAMPLE);

    expect(points.map((point) => point.income_cents)).toEqual([500000, 500000, 0]);
    expect(points.map((point) => point.expense_cents)).toEqual([280000, 500000, 350000]);
    expect(points.map((point) => point.net_cents)).toEqual([220000, 0, -350000]);

    expect(points.map((point) => point.cum_income_cents)).toEqual([500000, 1000000, 1000000]);
    expect(points.map((point) => point.cum_expense_cents)).toEqual([280000, 780000, 1130000]);
    expect(points.map((point) => point.cum_net_cents)).toEqual([220000, 220000, -130000]);
  });

  it('区间外交易被丢弃：months 只含 2026-03 时，4 月交易不影响任何数字', () => {
    const withApril = [...SAMPLE, makeTx({ id: 'apr-exp', at: '2026-04-02T12:00:00+08:00', amount: 999999 })];
    const onlyMarch = flowSeries(['2026-03'], withApril);
    expect(onlyMarch).toHaveLength(1);
    expect(onlyMarch[0].expense_cents).toBe(350000);
    expect(onlyMarch[0].cum_expense_cents).toBe(350000);
    expect(onlyMarch[0].cum_net_cents).toBe(-350000);
  });

  it('软删与被裁决为 duplicate 的交易不参与统计', () => {
    const deleted = { ...makeTx({ id: 'gone', at: '2026-03-03T12:00:00+08:00', amount: 70000 }), deleted_at: '2026-03-04T00:00:00Z' };
    const dup = makeTx({ id: 'dup', at: '2026-03-04T12:00:00+08:00', amount: 70000, dedupe_status: 'duplicate' });
    const points = flowSeries(['2026-03'], [SAMPLE[5], SAMPLE[6], deleted, dup]);
    expect(points[0].expense_cents).toBe(350000);
  });

  it('months 顺序即输出顺序，重复月份只出一次', () => {
    const points = flowSeries(['2026-03', '2026-01', '2026-03'], SAMPLE);
    expect(points.map((point) => point.month_key)).toEqual(['2026-03', '2026-01']);
  });
});

/**
 * 回归护栏：区间路径与月度路径在"区间正好是一个整月"时必须给出同一个数字。
 * 这条断言存在的意义：日后若有人把 listByDateRange 的闭区间改成半开、或给
 * occurred_date 索引加了偏移，两张图的数字会静默分叉，这里会立刻变红。
 */
describe('flowSeries: 区间聚合 vs 月度聚合的一致性护栏', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  afterAll(async () => {
    await db.delete();
  });

  it('整月区间的 totalsOf 与 listByMonth 的 totalsOf 完全相等', async () => {
    await transactionRepo.addMany(SAMPLE);
    // 邻月数据也入库，确认区间查询不会把它们带进来（也不会漏掉本月的）
    await transactionRepo.addMany([
      makeTx({ id: 'feb-extra', at: '2026-02-27T12:00:00+08:00', amount: 12300 }),
      makeTx({ id: 'apr-extra', at: '2026-04-01T12:00:00+08:00', amount: 45600 }),
    ]);

    const monthRangeOfMarch = wholeMonthRange('2026-03');
    const byMonth = await transactionRepo.listByMonth('2026-03');
    const byDate = await transactionRepo.listByDateRange(monthRangeOfMarch.from, monthRangeOfMarch.to);

    expect(byDate).toHaveLength(byMonth.length);
    expect(totalsOf(byDate)).toEqual(totalsOf(byMonth));

    // 两条路径得到的"该月支出净额"必须相等 —— 这是图表数字一致的前提
    const viaRange = flowSeries(['2026-03'], byDate)[0];
    const viaMonth = flowSeries(['2026-03'], byMonth)[0];
    expect(viaRange.expense_cents).toBe(viaMonth.expense_cents);
    expect(viaRange.expense_cents).toBe(asCents(350000));
  });
});
