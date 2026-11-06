import { describe, expect, it } from 'vitest';
import {
  addDays,
  currentMonthRange,
  isWholeMonth,
  lastNDays,
  lastNMonthsRange,
  monthsInRange,
  normalizeRange,
  previousComparableRange,
  rangeDays,
  rangeLabel,
  shiftRangeBack,
  wholeMonthRange,
  yearToDate,
} from '../domain/range';

/**
 * 区间工具的口径测试。
 * 重点是**边界**：等长前移必须首尾相接、月末必须认闰年、跨年不能退化成"12 月 31 日之后"。
 */
describe('range: 日期区间工具', () => {
  it('shiftRangeBack 等长且首尾相接（18 天区间 → 前一区间 to = 本区间 from 前一天）', () => {
    const range = { from: '2026-03-01', to: '2026-03-18' };
    expect(rangeDays(range)).toBe(18);

    const prev = shiftRangeBack(range);
    expect(rangeDays(prev)).toBe(18);
    expect(prev.to).toBe(addDays(range.from, -1));
    expect(prev.to).toBe('2026-02-28');
    expect(prev.from).toBe('2026-02-11');
    // 首尾相接意味着不重叠：prev.to < range.from
    expect(prev.to < range.from).toBe(true);

    // 再往前一段仍然等长且连续
    const prev2 = shiftRangeBack(range, 2);
    expect(rangeDays(prev2)).toBe(18);
    expect(prev2.to).toBe(addDays(prev.from, -1));
  });

  it('shiftRangeBack 跨年：2026-01-05~2026-01-10 往前推 6 天落在 2025-12', () => {
    const prev = shiftRangeBack({ from: '2026-01-05', to: '2026-01-10' });
    expect(prev.from).toBe('2025-12-30');
    expect(prev.to).toBe('2026-01-04');
    expect(prev.from.startsWith('2025-12')).toBe(true);
  });

  it('isWholeMonth 认闰年与平年，缺一天就不算整月', () => {
    expect(isWholeMonth({ from: '2026-02-01', to: '2026-02-28' })).toBe(true);
    expect(isWholeMonth({ from: '2024-02-01', to: '2024-02-29' })).toBe(true);
    expect(isWholeMonth({ from: '2026-02-01', to: '2026-02-27' })).toBe(false);
    // 2024 年 2 月只到 28 号 = 不是整月
    expect(isWholeMonth({ from: '2024-02-01', to: '2024-02-28' })).toBe(false);
    // 跨月一定不是整月
    expect(isWholeMonth({ from: '2026-01-01', to: '2026-02-28' })).toBe(false);
  });

  it('monthsInRange 跨年升序且连续', () => {
    expect(monthsInRange({ from: '2025-11-15', to: '2026-02-03' })).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    // 单日区间也要覆盖到它所在的月份
    expect(monthsInRange({ from: '2026-03-18', to: '2026-03-18' })).toEqual(['2026-03']);
  });

  it('rangeDays 含首尾', () => {
    expect(rangeDays({ from: '2026-01-01', to: '2026-01-01' })).toBe(1);
    expect(rangeDays({ from: '2026-01-01', to: '2026-01-02' })).toBe(2);
    expect(rangeDays({ from: '2026-01-01', to: '2026-12-31' })).toBe(365);
    expect(rangeDays({ from: '2024-01-01', to: '2024-12-31' })).toBe(366);
    expect(rangeDays({ from: '2026-03-10', to: '2026-03-01' })).toBe(0);
  });

  it('lastNDays / yearToDate 边界（含闰日与跨年）', () => {
    expect(lastNDays(1, '2026-03-01')).toEqual({ from: '2026-03-01', to: '2026-03-01' });
    expect(lastNDays(7, '2026-01-03')).toEqual({ from: '2025-12-28', to: '2026-01-03' });
    expect(lastNDays(2, '2024-03-01')).toEqual({ from: '2024-02-29', to: '2024-03-01' });

    expect(yearToDate('2026-02-28')).toEqual({ from: '2026-01-01', to: '2026-02-28' });
    expect(yearToDate('2026-01-01')).toEqual({ from: '2026-01-01', to: '2026-01-01' });
  });

  it('currentMonthRange / wholeMonthRange 给出当月完整自然月', () => {
    expect(currentMonthRange('2026-11-04')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(currentMonthRange('2024-02-10')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(wholeMonthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(lastNMonthsRange(3, '2026-03-18')).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(lastNMonthsRange(1, '2026-03-18')).toEqual({ from: '2026-03-01', to: '2026-03-31' });
  });

  it('rangeLabel 整月说月份、非整月给起止日', () => {
    expect(rangeLabel({ from: '2026-03-01', to: '2026-03-31' })).toBe('2026年3月');
    expect(rangeLabel({ from: '2026-03-01', to: '2026-03-18' })).toBe('2026-03-01 ~ 2026-03-18');
  });

  it('previousComparableRange：整月比上一个自然月，任意区间比等长区间', () => {
    // 31 天的月份若用等长前移会落到「1/29 ~ 2/28」，那不是"上月"
    expect(previousComparableRange({ from: '2026-03-01', to: '2026-03-31' })).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    // 跨年
    expect(previousComparableRange({ from: '2026-01-01', to: '2026-01-31' })).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
    // 非整月仍按等长前移
    expect(previousComparableRange({ from: '2026-03-01', to: '2026-03-18' })).toEqual({
      from: '2026-02-11',
      to: '2026-02-28',
    });
  });

  it('normalizeRange 兜底反向区间，addDays 跨月跨年都正确', () => {
    expect(normalizeRange({ from: '2026-03-18', to: '2026-03-01' })).toEqual({ from: '2026-03-01', to: '2026-03-18' });
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });
});
