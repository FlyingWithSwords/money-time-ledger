import { beforeEach, describe, expect, it } from 'vitest';
import { db, LedgerDatabase } from '../../db/db';
import { ensureSeeded } from '../../db/seed';
import { accountBalances, netWorth, totalsOf, categoryShares } from '../../domain/aggregate';
import { buildLocalIso, deriveDateFields, monthRange, shiftMonth } from '../../domain/date';
import { runImport } from '../../import/pipeline';
import type { Account, Cents, Transaction } from '../../types';
import { makeImportFile } from '../fixtures';
import { makeTx } from '../txFixture';

/**
 * QA-5：统计口径（净资产 / 三套支出数 / 退款 / 只计算不存储 / month_key 字符串比较）。
 */

const account = (patch: Partial<Account>): Account => ({
  id: 'acc_x',
  name: 'x',
  kind: 'cash',
  is_liability: false,
  opening_balance_cents: 0 as Cents,
  currency: 'CNY',
  archived: false,
  sort: 0,
  ...patch,
});

describe('QA-5a 三套支出口径互不污染', () => {
  const txs: Transaction[] = [
    makeTx({ id: 'e1', at: '2026-10-01T12:00:00+08:00', amount: 15000 }),
    makeTx({ id: 'e2', at: '2026-10-02T12:00:00+08:00', amount: 5000 }),
    makeTx({ id: 'r1', at: '2026-10-03T12:00:00+08:00', amount: 3000, direction: 'refund' }),
    makeTx({ id: 'i1', at: '2026-10-04T12:00:00+08:00', amount: 20000, direction: 'income' }),
    makeTx({ id: 't1', at: '2026-10-05T12:00:00+08:00', amount: 9999, direction: 'transfer' }),
  ];

  it('毛额 / 冲正 / 净额三套数同时存在且公式正确', () => {
    const totals = totalsOf(txs);
    expect(totals.expense_cents).toBe(20000);
    expect(totals.refund_cents).toBe(3000);
    expect(totals.net_expense_cents).toBe(17000);
    expect(totals.income_cents).toBe(20000);
    expect(totals.balance_cents).toBe(3000);
    expect(totals.transfer_cents).toBe(9999);
  });

  it('退款不计收入、不写负数', () => {
    const totals = totalsOf(txs);
    expect(totals.income_cents).toBe(20000); // 不含 refund 的 3000
    expect(txs.every((tx) => tx.amount_cents >= 0)).toBe(true);
  });

  it('转账不进任何一边', () => {
    const totals = totalsOf(txs);
    expect(totals.expense_cents + totals.income_cents + totals.refund_cents).toBe(43000);
  });

  it('软删与已裁决重复不进统计', () => {
    const dirty = [
      ...txs,
      { ...makeTx({ id: 'p1', at: '2026-10-06T12:00:00+08:00', amount: 1000 }), deleted_at: '2026-10-07T00:00:00+08:00' },
      makeTx({ id: 'p2', at: '2026-10-07T12:00:00+08:00', amount: 1000, dedupe_status: 'duplicate' }),
    ];
    expect(totalsOf(dirty).expense_cents).toBe(20000);
    expect(totalsOf(dirty).count).toBe(5);
  });

  it('分类占比：退款冲减同分类净额，分母为净额', () => {
    const result = categoryShares([
      makeTx({ id: 'c1', at: '2026-10-01T12:00:00+08:00', amount: 10000, l1: 'food' }),
      makeTx({ id: 'c2', at: '2026-10-02T12:00:00+08:00', amount: 2000, l1: 'food', direction: 'refund' }),
      makeTx({ id: 'c3', at: '2026-10-03T12:00:00+08:00', amount: 8000, l1: 'transport' }),
    ]);
    expect(result.total).toBe(16000);
    expect(result.shares.find((share) => share.l1 === 'food')?.cents).toBe(8000);
  });
});

describe('QA-5b 净资产 = 现金 + 基金市值 − 负债', () => {
  it('负债账户余额本身为负，直接相加', () => {
    const accounts = [
      account({ id: 'acc_cash', name: '现金', opening_balance_cents: 100000 as Cents }),
      account({ id: 'acc_huabei', name: '花呗', kind: 'credit', is_liability: true, opening_balance_cents: -30000 as Cents }),
    ];
    const txs = [
      makeTx({ id: 'x1', at: '2026-10-01T10:00:00+08:00', amount: 2000, direction: 'income', account_id: 'acc_cash' }),
      makeTx({ id: 'x2', at: '2026-10-02T10:00:00+08:00', amount: 1000, account_id: 'acc_huabei' }),
    ];
    const balances = accountBalances(accounts, txs);
    expect(balances.find((item) => item.account.id === 'acc_cash')?.balance_cents).toBe(102000);
    expect(balances.find((item) => item.account.id === 'acc_huabei')?.balance_cents).toBe(-31000);

    const result = netWorth(accounts, txs, 50000 as Cents);
    expect(result.cash_cents).toBe(102000);
    expect(result.liability_cents).toBe(-31000);
    expect(result.fund_cents).toBe(50000);
    expect(result.net_worth_cents).toBe(121000);
  });
});

describe('QA-5c 跨月跨年用 month_key 字符串比较（时区安全）', () => {
  it('月初 00:30 的本地时间不会被算到上个月', () => {
    const iso = buildLocalIso('2026-01-01', '00:30');
    expect(iso.startsWith('2026-01-01T00:30')).toBe(true);
    expect(deriveDateFields(iso)).toEqual({ occurred_date: '2026-01-01', month_key: '2026-01' });
  });

  it('month_key 平移与区间跨年正确', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2025-12', 1)).toBe('2026-01');
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});

describe('QA-5d 汇总只计算不存储', () => {
  it('schema 里没有任何月小计/日小计字段或表', () => {
    const probe = new LedgerDatabase('qa_schema_probe');
    const definition = probe.tables.map((table) => `${table.name}:${table.schema.primKey.name}:${table.schema.indexes.map((index) => index.name).join(',')}`);
    const text = definition.join('\n').toLowerCase();
    for (const forbidden of ['subtotal', 'month_total', 'monthly_total', 'day_total', 'xiaoj']) {
      expect(text, `schema 不应包含 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('导入后的交易行不含任何小计/汇总字段', async () => {
    await db.delete();
    await db.open();
    await ensureSeeded(db);
    await runImport(
      makeImportFile(
        'w.csv',
        [
          '微信支付账单明细',
          '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
          '2026-10-01 12:00:00,商户消费,美团,午餐,支出,¥15.00,花呗,支付成功,9001,M1,',
          '共 1 笔',
          '支出：15.00元',
        ].join('\n'),
      ),
    );
    const rows = await db.transactions.toArray();
    expect(rows).toHaveLength(1);
    const keys = Object.keys(rows[0]).join(',');
    expect(keys).not.toMatch(/小计|合计|汇总|subtotal|month_total/);
    // 也没有「小计」性质的交易（例如 counterparty 为 1月小计 的行）
    expect(rows.some((row) => /小计|合计|总计|汇总/.test(`${row.counterparty ?? ''}${row.note ?? ''}`))).toBe(false);
  });
});
