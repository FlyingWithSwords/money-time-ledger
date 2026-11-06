import { describe, expect, it } from 'vitest';
import { asCents } from '../domain/money';
import { costToTime, DEFAULT_WAGE_SETTINGS, resolveHourlyWage, type WageSettings } from '../domain/timecost';

const base: WageSettings = { ...DEFAULT_WAGE_SETTINGS };

describe('timecost: 三档口径', () => {
  it('月薪 ÷ 月工时（8000 ÷ 174 ≈ 45.98）', () => {
    const result = resolveHourlyWage({ ...base, hourly_wage_mode: 'salary_div_hours' }, null);
    expect(result.basis).toBe('salary_div_hours');
    expect(result.cents).toBe(4598);
    expect(result.fellBack).toBe(false);
  });

  it('直填时薪', () => {
    const result = resolveHourlyWage(
      { ...base, hourly_wage_mode: 'manual', hourly_wage_manual_cents: asCents(6000) },
      null,
    );
    expect(result.basis).toBe('manual');
    expect(result.cents).toBe(6000);
  });

  it('真实时薪 = 近 3 笔接单收入 ÷ 填报工时', () => {
    const result = resolveHourlyWage(
      { ...base, hourly_wage_mode: 'real' },
      { income_cents: asCents(85600), hours: 18, count: 3 },
    );
    expect(result.basis).toBe('real');
    expect(result.cents).toBe(4756);
  });

  it('真实口径数据不足 → 回落并标记 fellBack', () => {
    const result = resolveHourlyWage(
      { ...base, hourly_wage_mode: 'real' },
      { income_cents: asCents(85600), hours: 18, count: 2 },
    );
    expect(result.basis).toBe('salary_div_hours');
    expect(result.fellBack).toBe(true);
  });

  it('三档都不可用 → cents 为 null（页面不显示 0）', () => {
    const result = resolveHourlyWage(
      {
        ...base,
        hourly_wage_mode: 'manual',
        monthly_salary_cents: asCents(0),
        monthly_hours: 0,
        hourly_wage_manual_cents: null,
      },
      null,
    );
    expect(result.cents).toBeNull();
    expect(result.basis).toBeNull();
  });

  it('换算小时，2 位小数向下取整', () => {
    const cost = costToTime(asCents(1500), asCents(4598), 8);
    expect(cost.hours).toBe(0.32);
    expect(cost.unit).toBe('hour');
    expect(cost.display).toBe('0.32 小时');
  });

  it('≥8 小时改显示工作日', () => {
    const cost = costToTime(asCents(118000), asCents(4598), 8);
    expect(cost.unit).toBe('day');
    expect(cost.days).toBe(3.2);
    expect(cost.display).toBe('3.2 个工作日');
  });
});
