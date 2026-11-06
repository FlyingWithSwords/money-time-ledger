import { describe, expect, it } from 'vitest';
import { accountBalances, buildCompare, categoryShares, netWorth, totalsOf, topExpenses } from '../domain/aggregate';
import { asCents } from '../domain/money';
import type { Account } from '../types';
import { makeTx } from './txFixture';

const accounts: Account[] = [
  {
    id: 'acc_huabei',
    name: '花呗',
    kind: 'credit',
    is_liability: true,
    opening_balance_cents: asCents(0),
    currency: 'CNY',
    archived: false,
    sort: 0,
  },
  {
    id: 'acc_card',
    name: '银行卡',
    kind: 'debit',
    is_liability: false,
    opening_balance_cents: asCents(100000),
    currency: 'CNY',
    archived: false,
    sort: 1,
  },
];

describe('aggregate: 口径', () => {
  it('支出净额 = 毛额 − 退款冲正；转账不进任何一边', () => {
    const txs = [
      makeTx({ id: '1', at: '2026-10-01T12:00:00+08:00', amount: 1500 }),
      makeTx({ id: '2', at: '2026-10-02T12:00:00+08:00', amount: 500, direction: 'refund' }),
      makeTx({ id: '3', at: '2026-10-03T12:00:00+08:00', amount: 220000, direction: 'income', l1: 'salary' }),
      makeTx({ id: '4', at: '2026-10-04T12:00:00+08:00', amount: 9999, direction: 'transfer' }),
    ];
    const totals = totalsOf(txs);
    expect(totals.expense_cents).toBe(1500);
    expect(totals.refund_cents).toBe(500);
    expect(totals.net_expense_cents).toBe(1000);
    expect(totals.income_cents).toBe(220000);
    expect(totals.balance_cents).toBe(219000);
    expect(totals.transfer_cents).toBe(9999);
  });

  it('已删除与 duplicate 不参与统计', () => {
    const txs = [
      makeTx({ id: '1', at: '2026-10-01T12:00:00+08:00', amount: 1500 }),
      makeTx({ id: '2', at: '2026-10-01T12:00:00+08:00', amount: 1500, dedupe_status: 'duplicate' }),
    ];
    expect(totalsOf(txs).expense_cents).toBe(1500);
  });

  it('分类占比按净额，含待分类时打水印', () => {
    const txs = [
      makeTx({ id: '1', at: '2026-10-01T12:00:00+08:00', amount: 3000, l1: 'food', l2: 'lunch' }),
      makeTx({ id: '2', at: '2026-10-02T12:00:00+08:00', amount: 1000, l1: 'transport', l2: 'metro' }),
      makeTx({ id: '3', at: '2026-10-03T12:00:00+08:00', amount: 200, l1: 'food', l2: 'lunch', direction: 'refund' }),
      makeTx({ id: '4', at: '2026-10-04T12:00:00+08:00', amount: 1000, l1: 'other', l2: 'pending' }),
    ];
    const result = categoryShares(txs);
    expect(result.hasPending).toBe(true);
    expect(result.pendingCount).toBe(1);
    const food = result.shares.find((share) => share.l1 === 'food');
    expect(food?.cents).toBe(2800);
    expect(result.total).toBe(4800);
  });

  it('净资产 = 现金 + 基金 − 负债', () => {
    const txs = [
      makeTx({ id: '1', at: '2026-10-01T12:00:00+08:00', amount: 30000, account_id: 'acc_huabei' }),
      makeTx({ id: '2', at: '2026-10-02T12:00:00+08:00', amount: 50000, account_id: 'acc_card' }),
    ];
    const balances = accountBalances(accounts, txs);
    expect(balances.find((item) => item.account.id === 'acc_card')?.balance_cents).toBe(50000);
    expect(balances.find((item) => item.account.id === 'acc_huabei')?.balance_cents).toBe(-30000);
    const result = netWorth(accounts, txs, asCents(275000));
    expect(result.net_worth_cents).toBe(295000);
    expect(result.liability_cents).toBe(-30000);
  });

  it('同比需 ≥12 个月数据才出现', () => {
    const months = ['2026-08', '2026-09', '2026-10'];
    const txs = months.map((month, index) =>
      makeTx({ id: `m${index}`, at: `${month}-05T12:00:00+08:00`, amount: 10000 + index * 1000 }),
    );
    const compare = buildCompare('2026-10', txs, months);
    expect(compare.mom.baseline_cents).toBe(11000);
    expect(compare.yoy).toBeNull();
    expect(compare.avg3?.baseline_cents ?? null).not.toBeNull();
  });

  it('最贵 N 笔只取支出', () => {
    const txs = [
      makeTx({ id: '1', at: '2026-10-01T12:00:00+08:00', amount: 100 }),
      makeTx({ id: '2', at: '2026-10-02T12:00:00+08:00', amount: 900 }),
      makeTx({ id: '3', at: '2026-10-03T12:00:00+08:00', amount: 99999, direction: 'income', l1: 'salary' }),
    ];
    const top = topExpenses(txs, 1);
    expect(top).toHaveLength(1);
    expect(top[0].amount_cents).toBe(900);
  });
});
