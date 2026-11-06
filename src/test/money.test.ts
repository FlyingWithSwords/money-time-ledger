import { describe, expect, it } from 'vitest';
import { centsToYuan, formatCents, parseMoneyString, sumCents, yuanToCents } from '../domain/money';

describe('money: 分 ↔ 元', () => {
  it('0.04 与 9400 同时精确', () => {
    expect(yuanToCents('0.04')).toBe(4);
    expect(yuanToCents('9400')).toBe(940000);
    expect(yuanToCents(0.04)).toBe(4);
    expect(yuanToCents(9400)).toBe(940000);
    expect(centsToYuan(4)).toBe('0.04');
    expect(centsToYuan(940000)).toBe('9400.00');
  });

  it('往返零浮点误差', () => {
    const samples = ['0.04', '0.00', '0.01', '12.49', '15.00', '1234.56', '9400', '0.1', '0.2', '99.99'];
    for (const sample of samples) {
      const cents = yuanToCents(sample);
      expect(centsToYuan(cents)).toBe(Number(sample).toFixed(2));
      expect(yuanToCents(centsToYuan(cents))).toBe(cents);
    }
  });

  it('一百分不会漂移', () => {
    const cents = Array.from({ length: 100 }, () => yuanToCents('0.01'));
    expect(sumCents(cents)).toBe(100);
    expect(centsToYuan(sumCents(cents))).toBe('1.00');
    // 0.1 + 0.2 的经典浮点陷阱：分求和必须精确
    expect(sumCents([yuanToCents('0.1'), yuanToCents('0.2')])).toBe(30);
  });

  it('第三位小数四舍五入，不静默截断', () => {
    expect(yuanToCents('1.005')).toBe(101);
    expect(yuanToCents('1.004')).toBe(100);
    expect(yuanToCents('-0.045')).toBe(-5);
  });

  it('展示固定两位并带千分位', () => {
    expect(formatCents(1500)).toBe('¥15.00');
    expect(formatCents(940000)).toBe('¥9,400.00');
    expect(formatCents(123456)).toBe('¥1,234.56');
    expect(formatCents(-4)).toBe('-¥0.04');
    expect(formatCents(1500, { symbol: false })).toBe('15.00');
    expect(formatCents(1500, { showPlus: true })).toBe('+¥15.00');
  });

  it('账单文本解析', () => {
    expect(parseMoneyString('¥1,234.56')).toBe(123456);
    expect(parseMoneyString('15.00元')).toBe(1500);
    expect(parseMoneyString('-12.49')).toBe(-1249);
    expect(parseMoneyString('(12.49)')).toBe(-1249);
    expect(parseMoneyString('/')).toBeNull();
    expect(parseMoneyString('未知')).toBeNull();
  });

  it('非法输入抛类型化错误而不是返回 0', () => {
    expect(() => yuanToCents('abc')).toThrowError(/无法解析金额/);
    expect(() => yuanToCents('')).toThrowError(/金额为空/);
  });
});
