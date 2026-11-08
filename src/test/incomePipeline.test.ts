import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import * as settingsRepo from '../db/repos/settingsRepo';
import { ensureSeeded } from '../db/seed';
import { SETTING_KEYS } from '../db/settingKeys';
import type { IncomeSource } from '../domain/incomeSource';
import { runImport } from '../import/pipeline';
import { makeImportFile } from './fixtures';

/**
 * 工资从银行卡转到微信时，「收/支」列写的是 `/`（中性交易）。
 * 按平台口径它不是收入，账本里少看几千块；改判成收入又会让对账莫名其妙多出差额。
 * 这组用例盯的就是这两个坑。
 */

const WAGE_SOURCE: IncomeSource = {
  keyword: 'xx科技有限公司',
  label: 'XX科技有限公司',
  l1: 'salary',
  l2: 'monthly',
};

const SALARY_CSV = [
  '微信支付账单明细',
  '微信昵称：[测试]',
  '----------------------微信支付账单明细列表--------------------',
  '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
  '2026-10-01 12:31:00,商户消费,美团,午餐,支出,¥15.00,花呗,支付成功,2001,M1,',
  '2026-10-05 10:00:00,转账,XX科技有限公司,代发工资,/,¥8000.00,零钱,已存入零钱,2002,M2,',
  '2026-10-05 10:01:00,转账,XX科技有限公司,社保代扣,/,¥800.00,零钱,已存入零钱,2003,M3,',
  '共 3 笔记录',
  '收入：0.00元',
  '支出：15.00元',
].join('\n');

async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
  await ensureSeeded(db);
}

describe('导入：工资来源白名单', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('没配白名单时保持原样：工资仍是转账，不算收入也不算支出', async () => {
    const report = await runImport(makeImportFile('wechat-salary.csv', SALARY_CSV));
    expect(report.incomeRows).toBe(0);
    expect(report.sumIncome).toBe(0);
    expect(report.sumExpense).toBe(1500);
    // 文件里这笔本来就不计收支，两边都不含它，所以是对平的
    expect(report.reconciled).toBe(true);

    const salary = (await db.transactions.toArray()).find((row) => row.note === '代发工资');
    expect(salary?.direction).toBe('transfer');
  });

  it('配了白名单后改判为收入，分类落到「工资补贴 · 月薪」', async () => {
    await settingsRepo.setIncomeSources([WAGE_SOURCE]);
    const report = await runImport(makeImportFile('wechat-salary.csv', SALARY_CSV));

    expect(report.incomeRows).toBe(1);
    expect(report.incomeCents).toBe(800000);
    expect(report.sumIncome).toBe(800000);
    // 支出侧完全不受影响
    expect(report.sumExpense).toBe(1500);

    const salary = (await db.transactions.toArray()).find((row) => row.note === '代发工资');
    expect(salary?.direction).toBe('income');
    expect(salary?.category_l1).toBe('salary');
    expect(salary?.category_l2).toBe('monthly');
  });

  it('改判后对账仍然对平：文件合计不含这笔，账本也不该拿它去比', async () => {
    await settingsRepo.setIncomeSources([WAGE_SOURCE]);
    const report = await runImport(makeImportFile('wechat-salary.csv', SALARY_CSV));

    expect(report.diffExpense).toBe(0);
    expect(report.diffIncome).toBe(0);
    expect(report.reconciled).toBe(true);
  });

  it('白名单命中但摘要含排除词（社保代扣）时不改判', async () => {
    await settingsRepo.setIncomeSources([WAGE_SOURCE]);
    const report = await runImport(makeImportFile('wechat-salary.csv', SALARY_CSV));
    expect(report.incomeRows).toBe(1);

    const social = (await db.transactions.toArray()).find((row) => row.note === '社保代扣');
    expect(social?.direction).toBe('transfer');
  });

  it('白名单里的分类被删掉时收敛到该一级的「其他」，不会写出不存在的分类', async () => {
    await db.categories.delete('salary.monthly');
    await settingsRepo.setIncomeSources([WAGE_SOURCE]);
    await runImport(makeImportFile('wechat-salary.csv', SALARY_CSV));

    const salary = (await db.transactions.toArray()).find((row) => row.note === '代发工资');
    expect(salary?.category_l1).toBe('salary');
    expect(salary?.category_l2).toBe('other');
  });

  it('导入报告里写明改判了几笔、多少钱，用户能核对', async () => {
    await settingsRepo.setIncomeSources([WAGE_SOURCE]);
    const report = await runImport(makeImportFile('wechat-salary.csv', SALARY_CSV));
    const note = report.notes.find((item) => item.includes('收入来源'));
    expect(note).toContain('1 笔');
    expect(note).toContain('8000.00');
  });
});

describe('收入来源设置的读写', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('默认是空数组，导入行为与旧版一致', async () => {
    expect(await settingsRepo.getIncomeSources()).toEqual([]);
  });

  it('写入后能读回，且推进 data_version 让图表重算', async () => {
    const before = await settingsRepo.getDataVersion();
    await settingsRepo.setIncomeSources([WAGE_SOURCE]);
    expect(await settingsRepo.getIncomeSources()).toEqual([WAGE_SOURCE]);
    expect(await settingsRepo.getDataVersion()).toBeGreaterThan(before);
  });

  it('脏数据（非数组 / 缺字段）收敛成空数组，不让整份账单导不进来', async () => {
    await settingsRepo.set(SETTING_KEYS.incomeSources, 'not-an-array');
    expect(await settingsRepo.getIncomeSources()).toEqual([]);

    await settingsRepo.set(SETTING_KEYS.incomeSources, [{ keyword: 'x', l1: 'unknown' }]);
    expect(await settingsRepo.getIncomeSources()).toEqual([]);
  });
});
