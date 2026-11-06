import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import { ensureSeeded } from '../db/seed';
import { runImport, undoImport } from '../import/pipeline';
import { makeImportFile, WECHAT_CSV } from './fixtures';

async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
  await ensureSeeded(db);
}

describe('import pipeline: 幂等与对账', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('首次导入：3 笔入库，汇总行不入库，明细与文件合计对平', async () => {
    const report = await runImport(makeImportFile('wechat-2026-10.csv', WECHAT_CSV));
    expect(report.insertedRows).toBe(3);
    expect(report.duplicateRows).toBe(0);
    expect(report.failedRows).toBe(0);
    expect(report.sumExpense).toBe(1504);
    expect(report.sumIncome).toBe(2000);
    expect(report.reconciled).toBe(true);

    const rows = await db.transactions.toArray();
    // 「共 3 笔 / 收入：/ 支出：」这些汇总行不会变成交易
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.source === 'wechat')).toBe(true);
  });

  it('同文件导入两次：inserted = 0，重复项标 suspected 而不是静默丢弃', async () => {
    await runImport(makeImportFile('wechat-2026-10.csv', WECHAT_CSV));
    const second = await runImport(makeImportFile('wechat-2026-10.csv', WECHAT_CSV));

    expect(second.insertedRows).toBe(0);
    expect(second.duplicateRows).toBe(3);

    const rows = await db.transactions.toArray();
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.dedupe_status === 'suspected')).toHaveLength(3);
    expect(rows.filter((row) => row.dedupe_status === 'clean')).toHaveLength(3);
  });

  it('0.04 元与 20 元同时正确入库，分类判定链生效', async () => {
    await runImport(makeImportFile('wechat-2026-10.csv', WECHAT_CSV));
    const rows = await db.transactions.toArray();
    const tiny = rows.find((row) => row.counterparty === '青桔');
    expect(tiny?.amount_cents).toBe(4);
    expect(tiny?.category_l1).toBe('transport');
    expect(tiny?.category_l2).toBe('bike');

    const lunch = rows.find((row) => row.counterparty === '美团');
    expect(lunch?.amount_cents).toBe(1500);
    expect(lunch?.category_l1).toBe('food');
    expect(lunch?.category_l2).toBe('lunch');
    expect(lunch?.occurred_date).toBe('2026-10-01');
    expect(lunch?.month_key).toBe('2026-10');
  });

  it('撤销本次导入：整批软删，数据可恢复', async () => {
    const report = await runImport(makeImportFile('wechat-2026-10.csv', WECHAT_CSV));
    const count = await undoImport(report.batchId);
    expect(count).toBe(3);
    const rows = await db.transactions.toArray();
    expect(rows.every((row) => Boolean(row.deleted_at))).toBe(true);
  });
});
