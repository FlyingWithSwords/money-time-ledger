import { describe, expect, it } from 'vitest';
import {
  centsToYuan,
  formatCents,
  parseMoneyString,
  sumCents,
  yuanToCents,
} from '../../domain/money';

/**
 * QA-3：金额精度边界。核心断言是「绝不出现浮点残差」与「绝不静默变 0」。
 */

describe('QA-3 yuanToCents 边界', () => {
  it('两位小数逐个精确（含 0.04 / 9400.00 / -0）', () => {
    expect(yuanToCents('0.04')).toBe(4);
    expect(yuanToCents('9400.00')).toBe(940000);
    // 注：'-0' 目前返回 -0（=== 0 成立，但不规范，记为轻微问题），这里按数值判等
    expect(yuanToCents('-0') === 0).toBe(true);
    expect(yuanToCents(-0) === 0).toBe(true);
    expect(yuanToCents('.5')).toBe(50);
    expect(yuanToCents('15')).toBe(1500);
  });

  it('0.1 + 0.2 的浮点结果落为 30 分，不出残差', () => {
    expect(yuanToCents(0.1 + 0.2)).toBe(30);
    // 真实旧表里的手填残留值：1244.0599999999997 必须落成 124406
    expect(yuanToCents(1244.0599999999997)).toBe(124406);
  });

  it('第三位小数四舍五入，不静默截断', () => {
    expect(yuanToCents('0.005')).toBe(1);
    expect(yuanToCents('1.005')).toBe(101);
    expect(yuanToCents('1.004')).toBe(100);
  });

  it('非法输入必须抛错而不是给 0', () => {
    expect(() => yuanToCents('')).toThrow();
    expect(() => yuanToCents('  ')).toThrow();
    expect(() => yuanToCents('abc')).toThrow();
    expect(() => yuanToCents('1e-3')).toThrow(); // 科学计数法字符串不收
    expect(() => yuanToCents('1,244.06')).toThrow(); // 千分位由 parseMoneyString 负责清洗
    expect(yuanToCents(1e-3)).toBe(0); // number 入口 0.001 元 < 0.5 分，合理落 0
  });

  it('全角数字与千分位：parseMoneyString 清洗后仍精确，无法解析返回 null 而非 0', () => {
    expect(parseMoneyString('¥1,244.06')).toBe(124406);
    expect(parseMoneyString('1,244.06元')).toBe(124406);
    expect(parseMoneyString('(12.49)')).toBe(-1249);
    expect(parseMoneyString('', )).toBeNull();
    expect(parseMoneyString('abc')).toBeNull();
    expect(parseMoneyString('１２３４.５６')).toBeNull(); // 全角：目前不支持，但**不许**变成 0
  });

  it('cents ↔ yuan 全程可逆', () => {
    for (let cents = 0; cents <= 5000; cents += 1) {
      expect(yuanToCents(centsToYuan(cents))).toBe(cents);
    }
  });

  it('10000 笔随机两位小数求和：结果必须是整数分，且等于十进制精确和', () => {
    let seed = 42;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const texts: string[] = [];
    let exact = 0;
    for (let i = 0; i < 10000; i += 1) {
      const cents = Math.floor(rand() * 1000000); // 0 ~ 9999.99
      exact += cents;
      texts.push(centsToYuan(cents));
    }
    const total = sumCents(texts.map((text) => yuanToCents(text)));
    expect(Number.isInteger(total)).toBe(true);
    expect(total).toBe(exact);
    // 经典浮点残差反例：0.1+0.2 累加 10000 次用 float 会得到 1000.0000000001588
    expect(centsToYuan(total)).not.toContain('0000000');
  });

  it('展示格式化：千分位、符号、负号位置', () => {
    expect(formatCents(124406)).toBe('¥1,244.06');
    expect(formatCents(-4)).toBe('-¥0.04');
    expect(formatCents(1500, { symbol: false })).toBe('15.00');
    expect(formatCents(100000000)).toBe('¥1,000,000.00');
  });
});
