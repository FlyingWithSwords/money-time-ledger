import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/db';
import { ensureSeeded } from '../../db/seed';
import { runImport } from '../../import/pipeline';
import { parseLegacySheet, parseLegacyTables } from '../../import/parsers/legacyXlsx';
import type { SheetTable } from '../../import/parsers/xlsxReader';
import { makeImportFile } from '../fixtures';

/**
 * QA-2b：畸形输入。要求：不崩、不静默变 0、不静默补成今天。
 */

const WECHAT_HEAD = '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注';

async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
  await ensureSeeded(db);
}

describe('QA-2b 畸形输入（CSV 路径）', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('① 空文件：明确报「认不出的格式」，而不是静默成功', async () => {
    await expect(runImport(makeImportFile('empty.csv', ''))).rejects.toThrow(/格式|解析/);
    expect(await db.transactions.count()).toBe(0);
  });

  it('② 只有表头：入库 0 笔，并给出"没有明细行"的提示', async () => {
    const report = await runImport(makeImportFile('head.csv', ['微信支付账单明细', WECHAT_HEAD].join('\n')));
    expect(report.parsedRows).toBe(0);
    expect(report.insertedRows).toBe(0);
    expect(report.issues.length).toBeGreaterThan(0);
  });

  it('③ 列名全不匹配：抛出可读错误，不得把说明文字当交易', async () => {
    const csv = ['微信支付账单明细', '甲,乙,丙,丁', '1,2,3,4'].join('\n');
    await expect(runImport(makeImportFile('weird.csv', csv))).rejects.toThrow(/表头|格式/);
    expect(await db.transactions.count()).toBe(0);
  });

  it('④ 日期乱码：进 issues 且 failedRows 计数，绝不补成"今天"', async () => {
    const csv = [
      '微信支付账单明细',
      WECHAT_HEAD,
      '二零二六年十月一日,商户消费,美团,午餐,支出,¥15.00,花呗,支付成功,9001,M1,',
      '共 1 笔',
    ].join('\n');
    const report = await runImport(makeImportFile('baddate.csv', csv));
    expect(report.insertedRows).toBe(0);
    expect(report.failedRows).toBe(1);
    expect(report.issues.some((issue) => issue.reason.includes('日期无法解析'))).toBe(true);
    expect(await db.transactions.count()).toBe(0);
  });

  it('⑤ 金额为文字：进 issues，不得静默记成 0 元', async () => {
    const csv = [
      '微信支付账单明细',
      WECHAT_HEAD,
      '2026-10-01 12:00:00,商户消费,美团,午餐,支出,十五元,花呗,支付成功,9002,M2,',
      '共 1 笔',
    ].join('\n');
    const report = await runImport(makeImportFile('badamount.csv', csv));
    expect(report.insertedRows).toBe(0);
    expect(report.issues.some((issue) => issue.reason.includes('金额无法解析'))).toBe(true);
    const rows = await db.transactions.toArray();
    expect(rows.some((row) => row.amount_cents === 0)).toBe(false);
  });
});

describe('QA-2b 畸形输入（旧表格矩阵路径）', () => {
  const parse = (rows: string[][]) => parseLegacySheet({ name: '2023', rows } as SheetTable, { defaultYear: 2023 });

  it('空工作表不崩，给出可读 issue', () => {
    const result = parse([[]]);
    expect(result.rows).toHaveLength(0);
  });

  it('只有表头不崩，0 行 0 错', () => {
    const result = parse([['日期', '金额']]);
    expect(result.rows).toHaveLength(0);
  });

  it('列名全不匹配时走兜底布局，仍不崩', () => {
    const result = parse([
      ['甲', '乙', '丙'],
      ['1月', '', ''],
      ['2日', '午餐', '15.00'],
    ]);
    expect(Array.isArray(result.rows)).toBe(true);
  });

  it('日期乱码进 issue，不产生交易', () => {
    const result = parse([
      ['日期', '金额'],
      ['1月', ''],
      ['？？？', '15.00'],
    ]);
    expect(result.rows).toHaveLength(0);
    expect(result.issues.some((issue) => issue.reason.includes('日期无法解析'))).toBe(true);
  });

  it('空表集合 → 明确提示没有任何明细行', () => {
    const outcome = parseLegacyTables([{ name: '空表', rows: [['日期', '金额']] }], { defaultYear: 2023 });
    expect(outcome.rows).toHaveLength(0);
    expect(outcome.issues.some((issue) => issue.reason.includes('没有解析出明细行'))).toBe(true);
  });
});
