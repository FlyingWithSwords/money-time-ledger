import { describe, expect, it } from 'vitest';
import { locateDiff, reconcile } from '../import/reconcile';
import { asCents } from '../domain/money';

const rows = [
  { amount_cents: asCents(1500), direction: 'expense' as const, occurred_date: '2026-10-01' },
  { amount_cents: asCents(4), direction: 'expense' as const, occurred_date: '2026-10-01' },
  { amount_cents: asCents(2000), direction: 'income' as const, occurred_date: '2026-10-02' },
  { amount_cents: asCents(12000), direction: 'refund' as const, occurred_date: '2026-10-03' },
];

describe('reconcile: 明细合计 vs 文件合计', () => {
  it('完全一致 → 对平', () => {
    const result = reconcile({ fileExpense: asCents(1504), fileIncome: asCents(2000), rows });
    expect(result.sumExpense).toBe(1504);
    expect(result.sumIncome).toBe(2000);
    expect(result.sumRefund).toBe(12000);
    expect(result.diffExpense).toBe(0);
    expect(result.reconciled).toBe(true);
    expect(result.comparable).toBe(true);
  });

  it('差一分就报差异，绝不四舍五入掩盖', () => {
    const result = reconcile({ fileExpense: asCents(1505), rows });
    expect(result.diffExpense).toBe(1);
    expect(result.reconciled).toBe(false);
  });

  it('文件没给合计 → 无法对账，不假装对平', () => {
    const result = reconcile({ rows });
    expect(result.diffExpense).toBeNull();
    expect(result.comparable).toBe(false);
    expect(result.reconciled).toBe(false);
  });

  it('差异定位到具体金额的行', () => {
    const hint = locateDiff(rows, asCents(12000));
    expect(hint.candidates).toHaveLength(1);
    expect(hint.candidates[0].occurred_date).toBe('2026-10-03');
    expect(hint.message).toContain('120.00');
  });

  it('定位不到单笔时给出可执行提示', () => {
    const hint = locateDiff(rows, asCents(777));
    expect(hint.candidates).toHaveLength(0);
    expect(hint.message).toContain('未能定位');
  });

  it('有逐月数据时按月定位，且不会被金额巧合的无关行带偏', () => {
    // 真实场景：4 月表内合计比明细多 120 元；1 月恰好有一笔真实的 120.00 支出
    const legacyRows = [
      { amount_cents: asCents(134790), direction: 'expense' as const, occurred_date: '2023-04-30' },
      { amount_cents: asCents(12000), direction: 'expense' as const, occurred_date: '2023-01-04' },
    ];
    const hint = locateDiff(legacyRows, asCents(12000), {
      fileMonthly: [{ month_key: '2023-04', expense: asCents(146790) }],
    });
    expect(hint.scope).toBe('month');
    expect(hint.months).toHaveLength(1);
    expect(hint.months[0].month_key).toBe('2023-04');
    expect(hint.months[0].delta).toBe(12000);
    expect(hint.message).toContain('4 月');
    expect(hint.message).toContain('2023-04');
    // 关键：不得出现"1 月 4 日"这种把巧合当结论的误导
    expect(hint.message).not.toContain('2023-01-04');
    expect(hint.candidates).toHaveLength(0);
  });

  it('逐月全对时才降级到单笔，且措辞是「疑似」而不是断言漏单', () => {
    const legacyRows = [
      { amount_cents: asCents(134790), direction: 'expense' as const, occurred_date: '2023-04-30' },
      { amount_cents: asCents(12000), direction: 'expense' as const, occurred_date: '2023-01-04' },
    ];
    // 4 月表内与明细一致 → 月级无差异，年度合计却差了 120：只能降级到单笔线索
    const hint = locateDiff(legacyRows, asCents(12000), {
      fileMonthly: [{ month_key: '2023-04', expense: asCents(134790) }],
    });
    expect(hint.scope).toBe('row');
    expect(hint.message).toContain('疑似');
    expect(hint.message).not.toContain('文件多');
    expect(hint.message).toContain('2023-01-04');
  });
});
