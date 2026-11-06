import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import * as transactionRepo from '../db/repos/transactionRepo';
import { ensureSeeded } from '../db/seed';
import { totalsOf } from '../domain/aggregate';
import { detectInvestPrincipal, INVEST_PRINCIPAL_FLAG } from '../domain/investPrincipal';
import { runImport } from '../import/pipeline';
import { locateDiff, reconcile } from '../import/reconcile';
import { asCents } from '../domain/money';
import { makeImportFile } from './fixtures';
import { makeTx } from './txFixture';

/**
 * 「买基金的钱记成了支出」的识别与排除。
 *
 * 这件事错不起：错判一笔真实消费 → 支出被静默吞掉，用户很难发现；
 * 漏判一笔本金 → 趋势页「整体收益」把本金重复扣一遍，看起来像巨亏。
 * 所以规则整体偏保守（宁可漏判），并且必须有"历史数据不改也能对上"的护栏：
 * 同一份账单重复导入时，去重指纹仍按**原始**支出方向计算，不能因为改判而重复入账。
 */

describe('detectInvestPrincipal: 只认强特征，宁可漏判', () => {
  const expense = (counterparty: string, note = ''): ReturnType<typeof detectInvestPrincipal> =>
    detectInvestPrincipal({ direction: 'expense', counterparty, note });

  it('平台名命中：蚂蚁财富 / 天天基金 / 理财通 / 零钱通', () => {
    expect(expense('蚂蚁财富', '定投转入').matched).toBe(true);
    expect(expense('天天基金', '买入 华夏盛世混合').matched).toBe(true);
    expect(expense('理财通', '买入').matched).toBe(true);
    expect(expense('零钱通', '转入').matched).toBe(true);
  });

  it('金额动作命中：基金申购 / 基金定投 / 证券转入', () => {
    expect(expense('招商银行', '基金申购').matched).toBe(true);
    expect(expense('某券商', '证券转入').matched).toBe(true);
    expect(expense('工商银行', '银证转账').matched).toBe(true);
  });

  it('「基金」二字单独出现即可判定（个人账单里它几乎只有一种含义）', () => {
    expect(expense('广发基金').matched).toBe(true);
    expect(expense('某商户', '买入基金').matched).toBe(true);
  });

  it('场内标的：ETF 大小写都认', () => {
    expect(expense('华泰证券', '纳斯达克ETF').matched).toBe(true);
    expect(expense('华泰证券', '纳斯达克etf').matched).toBe(true);
  });

  it('黄金：积存金/纸黄金/黄金定投算投资，金店首饰不算', () => {
    expect(expense('工商银行', '积存金').matched).toBe(true);
    expect(expense('建设银行', '黄金定投').matched).toBe(true);
    expect(expense('周大福', '黄金项链').matched).toBe(false);
  });

  it('泛特征必须配动作词：理财课/股票群不算', () => {
    expect(expense('某平台', '理财课').matched).toBe(false);
    expect(expense('某平台', '股票交流群').matched).toBe(false);
    expect(expense('某平台', '理财产品买入').matched).toBe(true);
    expect(expense('某平台', '黄金转入').matched).toBe(true);
  });

  it('排除词优先级最高：基金考试报名不能当成买入', () => {
    expect(expense('某机构', '基金从业资格考试报名').matched).toBe(false);
    expect(expense('蚂蚁财富', '理财培训课程').matched).toBe(false);
  });

  it('转出/卖出不是买入：不收「转出」', () => {
    // 「转出」不在动作词表里，泛特征单独出现不判定
    expect(expense('某平台', '资金转出').matched).toBe(false);
  });

  it('只判支出：收入/退款/转账一律不动', () => {
    expect(detectInvestPrincipal({ direction: 'income', counterparty: '天天基金' }).matched).toBe(false);
    expect(detectInvestPrincipal({ direction: 'transfer', counterparty: '天天基金' }).matched).toBe(false);
    expect(detectInvestPrincipal({ direction: 'refund', counterparty: '天天基金' }).matched).toBe(false);
  });

  it('空文本不判定', () => {
    expect(detectInvestPrincipal({ direction: 'expense' }).matched).toBe(false);
    expect(detectInvestPrincipal({ direction: 'expense', counterparty: '  ' }).matched).toBe(false);
  });

  it('命中的关键词回传出来，导入报告里要能解释"为什么这笔被排除"', () => {
    expect(expense('蚂蚁财富', '').keyword).toBe('蚂蚁财富');
    expect(expense('某平台', '买入基金').keyword).toBe('买入基金');
    expect(expense('广发基金', '').keyword).toBe('基金');
    expect(expense('某平台', '理财产品买入').keyword).toBe('理财+买入');
  });
});

describe('reconcile: 排除投资本金后仍然对得平', () => {
  it('excluded 行不进 sumExpense，但按文件口径加回后差额为 0', () => {
    const result = reconcile({
      fileExpense: asCents(81500),
      rows: [
        { amount_cents: asCents(1500), direction: 'expense', occurred_date: '2026-10-01' },
        { amount_cents: asCents(80000), direction: 'transfer', occurred_date: '2026-10-03', excluded: true },
      ],
    });
    expect(result.sumExpense).toBe(1500);
    expect(result.diffExpense).toBe(0);
    expect(result.reconciled).toBe(true);
  });

  it('月级差异定位把 excluded 计入文件口径，不会误报"这个月少了 N 元"', () => {
    const rows = [
      { amount_cents: asCents(1500), direction: 'expense' as const, occurred_date: '2026-10-01' },
      { amount_cents: asCents(80000), direction: 'transfer' as const, occurred_date: '2026-10-03', excluded: true },
    ];
    const hint = locateDiff(rows, asCents(1234), { fileMonthly: [{ month_key: '2026-10', expense: asCents(81500) }] });
    // 表内 815 − 明细（1500 + 80000 分）= 0 → 该月没有差异，不该出现月级结论
    expect(hint.months).toHaveLength(0);
  });
});

const INVEST_CSV = [
  '微信支付账单明细',
  '微信昵称：[测试]',
  '----------------------微信支付账单明细列表--------------------',
  '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
  '2026-10-01 12:31:00,商户消费,美团,午餐,支出,¥15.00,花呗,支付成功,3001,M1,',
  '2026-10-03 10:00:00,商户消费,蚂蚁财富,基金定投-易方达蓝筹精选混合,支出,¥500.00,零钱,支付成功,3002,M2,',
  '2026-10-05 09:00:00,商户消费,天天基金,买入 华夏盛世混合,支出,¥300.00,零钱,支付成功,3003,M3,',
  '共 3 笔记录',
  '收入：0.00元',
  '支出：815.00元',
].join('\n');

describe('导入管线：投资本金改判为不计收支', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await ensureSeeded(db);
  });

  it('两笔买基金改判 transfer、打标记，支出只剩真实消费，且对账仍平', async () => {
    const report = await runImport(makeImportFile('wechat-invest.csv', INVEST_CSV));

    expect(report.insertedRows).toBe(3);
    expect(report.investRows).toBe(2);
    expect(report.investCents).toBe(80000);
    // 支出只算美团 15 元；文件说 815，对账仍要平（明细里把本金加回文件口径）
    expect(report.sumExpense).toBe(1500);
    expect(report.reconciled).toBe(true);
    expect(report.diffExpense).toBe(0);

    const rows = await db.transactions.toArray();
    const investRows = rows.filter((row) => row.flags.includes(INVEST_PRINCIPAL_FLAG));
    expect(investRows).toHaveLength(2);
    expect(investRows.every((row) => row.direction === 'transfer')).toBe(true);
    expect(investRows.map((row) => row.counterparty).sort()).toEqual(['天天基金', '蚂蚁财富']);

    const lunch = rows.find((row) => row.counterparty === '美团');
    expect(lunch?.direction).toBe('expense');
    expect(lunch?.flags).toEqual([]);
  });

  it('历史数据是支出时重复导入同一份账单：仍然判重，不会再多出一笔本金', async () => {
    await runImport(makeImportFile('wechat-invest.csv', INVEST_CSV));

    // 模拟"上一版把这个投资行记成了支出"的历史数据（去重指纹不变）
    const existing = (await db.transactions.toArray()).find((row) => row.counterparty === '蚂蚁财富');
    expect(existing).toBeTruthy();
    await db.transactions.update(existing!.id, { direction: 'expense', flags: [] });

    const second = await runImport(makeImportFile('wechat-invest.csv', INVEST_CSV));
    expect(second.insertedRows).toBe(0);
    expect(second.duplicateRows).toBe(3);

    // 账本里不会出现"同一笔本金被记两次支出"
    const rows = await db.transactions.toArray();
    const principals = rows.filter((row) => row.counterparty === '蚂蚁财富');
    expect(principals).toHaveLength(2); // 原记录 + 本次的疑似重复副本
    expect(principals.every((row) => row.dedupe_status === 'clean' || row.dedupe_status === 'suspected')).toBe(true);
  });

  it('投资本金不计入「待分类」，用户不会被引到一堆转账记录上去归类', async () => {
    const report = await runImport(makeImportFile('wechat-invest.csv', INVEST_CSV));
    expect(report.pendingUncategorized).toBe(0);
  });

  it('报告里给出可读说明，用户知道钱去哪了', async () => {
    const report = await runImport(makeImportFile('wechat-invest.csv', INVEST_CSV));
    const note = report.notes.find((item) => item.includes('买基金/理财/黄金的本金'));
    expect(note).toBeTruthy();
    expect(note).toContain('2 笔');
    expect(note).toContain('800.00');
  });
});

describe('markInvestPrincipal: 改正已入账的历史记录', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await ensureSeeded(db);
  });

  it('只把支出改判为不计收支，金额/日期/分类一律不动，并保留原有 flags', async () => {
    await transactionRepo.addMany([
      makeTx({ id: 'inv', at: '2026-10-03T10:00:00+08:00', amount: 50000 }),
      makeTx({ id: 'meal', at: '2026-10-04T12:00:00+08:00', amount: 2000 }),
    ]);
    await transactionRepo.setMostWorthless('inv', true);

    const changed = await transactionRepo.markInvestPrincipal(['inv', 'meal'], INVEST_PRINCIPAL_FLAG);
    expect(changed).toBe(2);

    const inv = await transactionRepo.getById('inv');
    expect(inv?.direction).toBe('transfer');
    expect(inv?.amount_cents).toBe(50000);
    expect(inv?.occurred_date).toBe('2026-10-03');
    expect(inv?.category_l2).toBe('lunch');
    expect(inv?.flags).toContain('most_worthless');
    expect(inv?.flags).toContain(INVEST_PRINCIPAL_FLAG);
  });

  it('已经在收入/转账侧的记录不会被误改', async () => {
    await transactionRepo.addMany([
      makeTx({ id: 'salary', at: '2026-10-10T09:00:00+08:00', amount: 800000, direction: 'income', l1: 'salary' }),
    ]);
    const changed = await transactionRepo.markInvestPrincipal(['salary'], INVEST_PRINCIPAL_FLAG);
    expect(changed).toBe(0);
    const salary = await transactionRepo.getById('salary');
    expect(salary?.direction).toBe('income');
    expect(salary?.flags).not.toContain(INVEST_PRINCIPAL_FLAG);
  });

  it('重复执行不会把标记叠两遍', async () => {
    await transactionRepo.addMany([makeTx({ id: 'inv', at: '2026-10-03T10:00:00+08:00', amount: 50000 })]);
    await transactionRepo.markInvestPrincipal(['inv'], INVEST_PRINCIPAL_FLAG);
    await transactionRepo.markInvestPrincipal(['inv'], INVEST_PRINCIPAL_FLAG);
    const inv = await transactionRepo.getById('inv');
    expect(inv?.flags.filter((flag) => flag === INVEST_PRINCIPAL_FLAG)).toHaveLength(1);
  });

  it('改判之后月度支出真的变小、结余变大（口径变了，不是只改了字段）', async () => {
    await transactionRepo.addMany([
      makeTx({ id: 'inv', at: '2026-10-03T10:00:00+08:00', amount: 50000 }),
      makeTx({ id: 'meal', at: '2026-10-04T12:00:00+08:00', amount: 2000 }),
      makeTx({ id: 'salary', at: '2026-10-10T09:00:00+08:00', amount: 800000, direction: 'income', l1: 'salary' }),
    ]);
    const before = totalsOf(await transactionRepo.listByMonth('2026-10'));
    expect(before.net_expense_cents).toBe(52000);
    expect(before.balance_cents).toBe(748000);

    await transactionRepo.markInvestPrincipal(['inv'], INVEST_PRINCIPAL_FLAG);

    const after = totalsOf(await transactionRepo.listByMonth('2026-10'));
    expect(after.net_expense_cents).toBe(2000);
    expect(after.balance_cents).toBe(798000);
    expect(after.transfer_cents).toBe(50000);
  });
});
