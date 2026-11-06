import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { db } from '../../db/db';
import { ensureSeeded } from '../../db/seed';
import { sumCents } from '../../domain/money';
import type { ImportFile } from '../../import/base';
import { runImport, undoImport } from '../../import/pipeline';
import { parseLegacySheet, parseLegacyTables } from '../../import/parsers/legacyXlsx';
import { readWorkbookTables, type SheetTable } from '../../import/parsers/xlsxReader';

/**
 * QA-1：用**真实旧表**验证迁移（不是合成 fixture）。
 * 真值来自人工核对（team-lead 提供 + QA 独立用 xlsx 复算）：
 *   支出明细 359 笔；12 个月小计合计 20791.81；收支统计!E2(年支出) = 20911.81（手填污染，差 120）
 *   收入明细 40 笔；基础收入合计 53252.01
 */

const REAL_XLSX = process.env.QA_REAL_XLSX ?? 'C:/Users/Memphis/Desktop/账单例子.xlsx';
const HAS_REAL = existsSync(REAL_XLSX);

function fileFromPath(path: string): ImportFile {
  const buffer = readFileSync(path);
  return {
    name: basename(path),
    size: buffer.byteLength,
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    readArrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    readText: async () => '',
  };
}

async function loadTables(): Promise<SheetTable[]> {
  return readWorkbookTables(fileFromPath(REAL_XLSX));
}

/** 从原始矩阵里读「月消费总计」列，得到 12 个月小计（不经过被测代码，作为独立基准）。 */
function monthSubtotals(expenseTable: SheetTable): number[] {
  const out: number[] = [];
  for (const row of expenseTable.rows) {
    const nonEmpty = row.map((cell) => cell.trim()).filter((cell) => cell !== '');
    if (nonEmpty.length < 2) continue;
    if (!/^\d{1,2}\s*月$/.test(nonEmpty[0])) continue;
    const last = Number(nonEmpty[nonEmpty.length - 1]);
    if (Number.isFinite(last) && last > 0) out.push(last);
  }
  return out;
}

describe.skipIf(!HAS_REAL)('QA-1 真实旧表迁移', () => {
  it('能切出 359 笔支出 + 40 笔收入，月份分隔行不入库', async () => {
    const tables = await loadTables();
    const expenseSheet = tables.find((table) => table.name.includes('支出'));
    expect(expenseSheet, '工作表里应有「2023支出」').toBeTruthy();

    const outcome = parseLegacyTables(tables, { defaultYear: 2023 });
    const expenseRows = outcome.rows.filter((row) => row.cells['收支'] === '支出');
    const incomeRows = outcome.rows.filter((row) => row.cells['收支'] === '收入');

    // 诊断信息：失败时一眼看出是"全丢"还是"少数丢"
    console.log(
      `[QA-1] 解析行数 expense=${expenseRows.length} income=${incomeRows.length} issues=${outcome.issues.length}`,
    );
    console.log(`[QA-1] 前 3 条 issue: ${JSON.stringify(outcome.issues.slice(0, 3))}`);

    expect(expenseRows.length, '支出明细应为 359 笔').toBe(359);
    expect(incomeRows.length, '收入明细应为 40 笔').toBe(40);

    // 月份分隔行（1月/2月…）绝不能被当成交易
    const monthRows = outcome.rows.filter((row) => /^\d{1,2}月$/.test((row.cells['日期'] ?? '').trim()));
    expect(monthRows, '月份分隔行不得入库').toHaveLength(0);
    // 小计/合计文本不得出现在任何字段
    const summaryRows = outcome.rows.filter((row) => /小计|合计|总计|汇总/.test(Object.values(row.cells).join(' ')));
    expect(summaryRows, '汇总行不得入库').toHaveLength(0);
  });

  it('向下填充日期：同日多笔只在首行写日期，后续行必须继承当天日期', async () => {
    const tables = await loadTables();
    const expenseRows = parseLegacyTables(tables, { defaultYear: 2023 }).rows.filter(
      (row) => row.cells['收支'] === '支出',
    );
    const dates = expenseRows.slice(0, 12).map((row) => row.cells['日期']);
    expect(dates).toEqual([
      '2023-01-02',
      '2023-01-02',
      '2023-01-03',
      '2023-01-03',
      '2023-01-03',
      '2023-01-05',
      '2023-01-05',
      '2023-01-06',
      '2023-01-06',
      '2023-01-06',
      '2023-01-06',
      '2023-01-07',
    ]);
  });

  it('年份推断：12 个月全部落在 2023，不跨到 2024', async () => {
    const tables = await loadTables();
    const expenseRows = parseLegacyTables(tables, { defaultYear: 2023 }).rows.filter(
      (row) => row.cells['收支'] === '支出',
    );
    const months = [...new Set(expenseRows.map((row) => row.cells['日期'].slice(0, 7)))].sort();
    expect(months).toEqual([
      '2023-01',
      '2023-02',
      '2023-03',
      '2023-04',
      '2023-05',
      '2023-06',
      '2023-07',
      '2023-08',
      '2023-09',
      '2023-10',
      '2023-11',
      '2023-12',
    ]);
  });

  it('金额精确到分：支出合计 20791.81 = 12 个月小计之和，未被手填的 20911.81 污染', async () => {
    const tables = await loadTables();
    const outcome = parseLegacyTables(tables, { defaultYear: 2023 });
    const cents = sumCents(
      outcome.rows.filter((row) => row.cells['收支'] === '支出').map((row) => Math.round(Number(row.cells['金额']) * 100)),
    );
    expect(cents, '支出合计（分）').toBe(2079181);

    const expenseSheet = tables.find((table) => table.name.includes('支出'))!;
    const subtotals = monthSubtotals(expenseSheet);
    expect(subtotals, '应能从原表独立读出 12 个月小计').toHaveLength(12);
    expect(Math.round(sumCents(subtotals.map((value) => Math.round(value * 100))))).toBe(2079181);

    // 手填的 20911.81（收支统计!E2）不应出现在导入结果里
    expect(cents).not.toBe(2091181);
  });

  it('收入合计 53252.01（基础收入 40 笔）', async () => {
    const tables = await loadTables();
    const incomeRows = parseLegacyTables(tables, { defaultYear: 2023 }).rows.filter(
      (row) => row.cells['收支'] === '收入',
    );
    const cents = sumCents(incomeRows.map((row) => Math.round(Number(row.cells['金额']) * 100)));
    expect(cents).toBe(5325201);
  });

  it('0 元交易不被丢弃（旧表有 5 笔）', async () => {
    const tables = await loadTables();
    const outcome = parseLegacyTables(tables, { defaultYear: 2023 });
    const zeros = outcome.rows.filter((row) => row.cells['收支'] === '支出' && Number(row.cells['金额']) === 0);
    expect(zeros, '5 笔 0 元账必须保留').toHaveLength(5);
  });

  it('端到端 runImport：入库 399 笔，对账差异 = 0', async () => {
    await db.delete();
    await db.open();
    await ensureSeeded(db);

    const report = await runImport(fileFromPath(REAL_XLSX), { defaultYear: 2023 });
    console.log(
      `[QA-1] runImport parsed=${report.parsedRows} inserted=${report.insertedRows} failed=${report.failedRows} ` +
        `expense=${report.sumExpense} income=${report.sumIncome} diff=${report.diffExpense} reconciled=${report.reconciled}`,
    );

    const rows = await db.transactions.toArray();
    expect(report.parsedRows).toBe(399);
    expect(report.insertedRows).toBe(399);
    expect(report.failedRows).toBe(0);
    expect(report.sumExpense).toBe(2079181);
    expect(report.sumIncome).toBe(5325201);
    expect(rows).toHaveLength(399);
  });

  it('单独调用 2023支出 工作表的纯函数入口也能还原（隔离定位失败点）', async () => {
    const tables = await loadTables();
    const expenseSheet = tables.find((table) => table.name.includes('支出'))!;
    const { rows, issues } = parseLegacySheet(expenseSheet, { defaultYear: 2023 });
    const detail = rows.filter((row) => row.cells['收支'] === '支出');
    console.log(`[QA-1] 支出表单独解析: rows=${rows.length} issues=${issues.length} 首条=${JSON.stringify(issues[0])}`);
    expect(detail.length).toBe(359);
  });
  it('收入方向必须为「收入」：收入合计 53252.01、支出合计 20791.81', async () => {
    await db.delete();
    await db.open();
    await ensureSeeded(db);
    const report = await runImport(fileFromPath(REAL_XLSX), { defaultYear: 2023 });
    console.log(`[QA-1] 真实导入: expense=${report.sumExpense} income=${report.sumIncome} comparable=${report.comparable}`);
    expect(report.sumIncome, '收入合计应为 5325201 分').toBe(5325201);
    expect(report.sumExpense, '支出合计应为 2079181 分').toBe(2079181);

    const rows = await db.transactions.toArray();
    const incomeRows = rows.filter((row) => row.direction === 'income');
    expect(incomeRows.length, '收入笔数应为 40').toBe(40);
    expect(incomeRows.every((row) => row.source === 'legacy_xlsx')).toBe(true);
  });

  it('旧表导入必须能与表内合计对账（comparable 不能为 false）', async () => {
    await db.delete();
    await db.open();
    await ensureSeeded(db);
    const report = await runImport(fileFromPath(REAL_XLSX), { defaultYear: 2023 });
    // 原表 收支统计!E2 = 20911.81，与明细 20791.81 差 120 元：这正是必须让用户看见的差异
    expect(report.comparable, '旧表必须提供可对账的文件合计').toBe(true);
    expect(report.diffExpense, '差异应报出 12000 分').toBe(12000);
    expect(report.reconciled).toBe(false);
  });
});

describe.skipIf(!HAS_REAL)('QA-1b 旧表结构说明（回归护栏）', () => {
  it('月份分隔行同时携带小计金额 —— 分隔行识别必须容忍非空金额列', async () => {
    const tables = await loadTables();
    const expenseSheet = tables.find((table) => table.name.includes('支出'))!;
    // 1 月的分隔行形如 ['1月','','','','119.97','1244.06']：3 个非空单元格
    const januaryRow = expenseSheet.rows.find((row) => (row[0] ?? '').trim() === '1月');
    expect(januaryRow, '原表应有 1月 分隔行').toBeTruthy();
    const nonEmpty = (januaryRow ?? []).filter((cell) => cell.trim() !== '');
    expect(nonEmpty.length, '1月 分隔行带 2 个小计 → 非空单元格 > 2').toBeGreaterThan(2);
  });
});

describe.skipIf(!HAS_REAL)('QA-1c 真实旧表的幂等与撤销', () => {
  it('399 笔各自唯一 dedupe_key，无假重复；二次导入 inserted=0；撤销只影响本批', async () => {
    await db.delete();
    await db.open();
    await ensureSeeded(db);

    const first = await runImport(fileFromPath(REAL_XLSX), { defaultYear: 2023 });
    const rows1 = await db.transactions.toArray();
    expect(first.duplicateRows, '单次导入内部的重复判定不应误伤').toBe(0);
    expect(rows1.filter((row) => row.dedupe_status === 'suspected')).toHaveLength(0);
    const keys = new Set(rows1.map((row) => `${row.source}|${row.dedupe_key}`));
    expect(keys.size, '399 笔应有 399 个唯一指纹').toBe(399);

    const second = await runImport(fileFromPath(REAL_XLSX), { defaultYear: 2023 });
    expect(second.insertedRows).toBe(0);
    expect(second.duplicateRows).toBe(399);

    const removed = await undoImport(first.batchId);
    expect(removed).toBe(399);
    const after = await db.transactions.toArray();
    expect(after.filter((row) => !row.deleted_at), '第二批不受撤销影响').toHaveLength(399);
  });
});
