import { describe, expect, it } from 'vitest';
import { computeMonthFlags, flagsFor, summarizeImpulse } from '../../domain/flags';
import {
  costToTime,
  DEFAULT_WAGE_SETTINGS,
  formatTotalTimeCost,
  resolveHourlyWage,
  shouldShowTimeCost,
  type WageSettings,
} from '../../domain/timecost';
import type { Cents } from '../../types';
import { makeTx } from '../txFixture';

/**
 * QA-6：时间成本口径与冲动标记。
 */

const settings = (patch: Partial<WageSettings> = {}): WageSettings => ({ ...DEFAULT_WAGE_SETTINGS, ...patch });

describe('QA-6a 时薪三档降级链', () => {
  it('默认口径：月薪 8000 ÷ 174h ≈ 46 元/h', () => {
    const result = resolveHourlyWage(settings());
    expect(result.basis).toBe('salary_div_hours');
    expect(result.cents).toBe(4598);
    expect(result.fellBack).toBe(false);
  });

  it('真实时薪可用时优先（用户选 real）', () => {
    const result = resolveHourlyWage(settings({ hourly_wage_mode: 'real' }), {
      income_cents: 300000 as Cents,
      hours: 10,
      count: 3,
    });
    expect(result.basis).toBe('real');
    expect(result.cents).toBe(30000);
  });

  it('真实时薪数据不足（<3 笔）→ 降级到月薪口径，并标记 fellBack', () => {
    const result = resolveHourlyWage(settings({ hourly_wage_mode: 'real' }), {
      income_cents: 300000 as Cents,
      hours: 10,
      count: 2,
    });
    expect(result.basis).toBe('salary_div_hours');
    expect(result.fellBack).toBe(true);
  });

  it('直填时薪：月薪为 0 时回落到 manual', () => {
    const result = resolveHourlyWage(
      settings({ hourly_wage_mode: 'manual', monthly_salary_cents: 0 as Cents, hourly_wage_manual_cents: 6000 as Cents }),
    );
    expect(result.basis).toBe('manual');
    expect(result.cents).toBe(6000);
  });

  it('三档全无 → null（不得显示 0 小时）', () => {
    const result = resolveHourlyWage(
      settings({ monthly_salary_cents: 0 as Cents, hourly_wage_manual_cents: null, monthly_hours: 0 }),
    );
    expect(result.cents).toBeNull();
    expect(result.basis).toBeNull();
  });

  it('阈值以下不展示时间成本（默认 100 元）', () => {
    expect(shouldShowTimeCost(9999 as Cents, settings())).toBe(false);
    expect(shouldShowTimeCost(10000 as Cents, settings())).toBe(true);
  });
});

describe('QA-6b 时间换算单位与取整', () => {
  it('15.00 元 @46 元/h ≈ 0.32~0.33 小时（向下取整，不夸大）', () => {
    const cost = costToTime(1500 as Cents, 4600 as Cents);
    expect(cost.unit).toBe('hour');
    expect(cost.hours).toBeLessThanOrEqual(1500 / 4600);
    expect(cost.hours).toBe(0.32);
    expect(cost.display).toContain('小时');
  });

  it('≥8 小时转「天」，1 位小数', () => {
    const cost = costToTime(80000 as Cents, 1000 as Cents); // 80 小时
    expect(cost.unit).toBe('day');
    expect(cost.days).toBe(10);
    expect(cost.display).toBe('10 个工作日');
  });

  it('7.99 小时仍是小时，8.00 小时才转天（边界）', () => {
    expect(costToTime(799 as Cents, 100 as Cents).unit).toBe('hour');
    expect(costToTime(800 as Cents, 100 as Cents).unit).toBe('day');
  });

  it('0.04 元不显示 0 小时', () => {
    expect(costToTime(4 as Cents, 4600 as Cents).display).toBe('不到 0.01 小时');
  });

  it('时薪为 0 时必须抛错，不允许算出 Infinity', () => {
    expect(() => costToTime(100 as Cents, 0 as Cents)).toThrow();
  });

  it('汇总横条：26.4 个工作日', () => {
    // 26.4 天 × 8h × 100 元/h = 21120 元
    expect(formatTotalTimeCost(2112000 as Cents, 10000 as Cents)).toBe('26.4 个工作日');
  });
});

describe('QA-6c 五条冲动标记规则', () => {
  it('深夜规则边界：22:59 不算 / 23:00 算 / 04:59 算 / 05:00 不算', () => {
    const tx = (id: string, at: string) =>
      makeTx({ id, at, amount: 2000, l1: 'food', l2: `l2_${id}` });
    const [before, start, nearEnd, end] = [
      tx('a', '2026-10-05T22:59:00+08:00'),
      tx('b', '2026-10-05T23:00:00+08:00'),
      tx('c', '2026-10-06T04:59:00+08:00'),
      tx('d', '2026-10-06T05:00:00+08:00'),
    ];
    const map = computeMonthFlags([before, start, nearEnd, end], '2026-10');
    const kinds = (id: string) => flagsFor({ ...before, id }, map).map((hit) => hit.kind);

    expect(kinds('a')).not.toContain('late_night');
    expect(kinds('b')).toContain('late_night');
    expect(kinds('c')).toContain('late_night');
    expect(kinds('d')).not.toContain('late_night');
  });

  it('碎钞 a：同一二级分类 30 分钟内 ≥3 笔', () => {
    const txs = [
      makeTx({ id: 's1', at: '2026-10-08T12:00:00+08:00', amount: 500, l2: 'coffee' }),
      makeTx({ id: 's2', at: '2026-10-08T12:10:00+08:00', amount: 500, l2: 'coffee' }),
      makeTx({ id: 's3', at: '2026-10-08T12:29:00+08:00', amount: 500, l2: 'coffee' }),
      makeTx({ id: 's4', at: '2026-10-08T13:30:00+08:00', amount: 500, l2: 'coffee' }),
    ];
    const map = computeMonthFlags(txs, '2026-10');
    for (const id of ['s1', 's2', 's3']) {
      expect(map.get(id)?.some((hit) => hit.kind === 'small_change'), id).toBe(true);
    }
    expect(map.get('s4')?.some((hit) => hit.kind === 'small_change')).toBe(false);
  });

  it('碎钞 b：单笔 <10 元且同日 ≥5 笔', () => {
    const txs = Array.from({ length: 5 }, (_, index) =>
      makeTx({
        id: `d${index}`,
        at: `2026-10-09T1${index}:00:00+08:00`,
        amount: index === 0 ? 200 : 2000,
        l2: `cat${index}`,
      }),
    );
    const map = computeMonthFlags(txs, '2026-10');
    expect(map.get('d0')?.some((hit) => hit.kind === 'small_change')).toBe(true);
    expect(map.get('d1')?.some((hit) => hit.kind === 'small_change')).toBe(false);
  });

  it('大额：单笔 ≥ 当月日均 ×3', () => {
    const txs = [
      makeTx({ id: 'n1', at: '2026-10-01T10:00:00+08:00', amount: 1000, l2: 'a' }),
      makeTx({ id: 'n2', at: '2026-10-02T10:00:00+08:00', amount: 1000, l2: 'b' }),
      makeTx({ id: 'big', at: '2026-10-03T10:00:00+08:00', amount: 500000, l2: 'c' }),
    ];
    const map = computeMonthFlags(txs, '2026-10');
    expect(map.get('big')?.some((hit) => hit.kind === 'large_amount')).toBe(true);
  });

  it('习惯性：同一二级分类连续 7 天出现', () => {
    const txs = Array.from({ length: 7 }, (_, index) =>
      makeTx({ id: `h${index}`, at: `2026-10-0${index + 1}T08:00:00+08:00`, amount: 1500, l2: 'breakfast' }),
    );
    const map = computeMonthFlags(txs, '2026-10');
    expect(map.get('h0')?.some((hit) => hit.kind === 'habitual')).toBe(true);

    // 中间断一天就不算
    const broken = txs.filter((tx) => tx.occurred_date !== '2026-10-04');
    const brokenMap = computeMonthFlags(broken, '2026-10');
    expect(brokenMap.get('h0')?.some((hit) => hit.kind === 'habitual')).toBe(false);
  });

  it('最不值：只认落库的主观标记', () => {
    const txs = [
      makeTx({ id: 'w1', at: '2026-10-01T10:00:00+08:00', amount: 3000, flags: ['most_worthless'] }),
      makeTx({ id: 'w2', at: '2026-10-02T10:00:00+08:00', amount: 3000 }),
    ];
    const map = computeMonthFlags(txs, '2026-10');
    expect(map.get('w1')?.some((hit) => hit.kind === 'most_worthless')).toBe(true);
    expect(map.get('w2')?.some((hit) => hit.kind === 'most_worthless') ?? false).toBe(false);
  });

  it('四条自动规则是「查询时派生」：补录一笔后结论必须跟着变', () => {
    const base = [
      makeTx({ id: 'p1', at: '2026-10-01T10:00:00+08:00', amount: 1000, l2: 'a' }),
      makeTx({ id: 'p2', at: '2026-10-02T10:00:00+08:00', amount: 1000, l2: 'b' }),
      makeTx({ id: 'big', at: '2026-10-03T10:00:00+08:00', amount: 30000, l2: 'c' }),
    ];
    const before = computeMonthFlags(base, '2026-10');
    expect(before.get('big')?.some((hit) => hit.kind === 'large_amount'), '初始应命中大额').toBe(true);

    // 补录一笔巨款 → 日均抬高 → 原「大额」不再命中
    const after = computeMonthFlags(
      [...base, makeTx({ id: 'huge', at: '2026-10-04T10:00:00+08:00', amount: 3000000, l2: 'd' })],
      '2026-10',
    );
    expect(after.get('big')?.some((hit) => hit.kind === 'large_amount') ?? false, '补录后结论应改变').toBe(false);
    // 派生结论不得写回交易（原对象保持不变）
    expect(base[2].flags).toEqual([]);
  });

  it('汇总：被标记笔数与金额只统计支出', () => {
    const txs = [
      makeTx({ id: 'x1', at: '2026-10-05T23:30:00+08:00', amount: 2000, l2: 'a' }),
      makeTx({ id: 'x2', at: '2026-10-05T12:00:00+08:00', amount: 2000, l2: 'b', direction: 'income' }),
    ];
    const map = computeMonthFlags(txs, '2026-10');
    const summary = summarizeImpulse(txs, map, 2000);
    expect(summary.count).toBe(1);
    expect(summary.cents).toBe(2000);
  });
});
