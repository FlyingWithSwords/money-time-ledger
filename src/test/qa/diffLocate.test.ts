import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { db } from '../../db/db';
import { ensureSeeded } from '../../db/seed';
import { detectMonthSeparator, detectTableMonthly, detectTableTotals, parseLegacyTables } from '../../import/parsers/legacyXlsx';
import { readWorkbookTables } from '../../import/parsers/xlsxReader';
import type { ImportFile } from '../../import/base';
import { runImport } from '../../import/pipeline';
import { locateDiff, type ReconcileRow } from '../../import/reconcile';

/**
 * QA-R3：封版前追加改动（分层对账定位 + 分隔行带金额告警 + 累计合计取末值 + 逐月带年份）。
 * 这些都直接对应主理人 Round 1 点名的"误导性定位"与我在 Round 2 提的 hardening。
 */

const REAL_XLSX = process.env.QA_REAL_XLSX ?? 'C:/Users/Memphis/Desktop/账单例子.xlsx';
const HAS_REAL = existsSync(REAL_XLSX);

const row = (amount: number, date: string, direction: ReconcileRow['direction'] = 'expense'): ReconcileRow => ({
  amount_cents: amount as ReconcileRow['amount_cents'],
  direction,
  occurred_date: date,
});

describe('QA-R3a 分层定位：月级优先，不再误导到单笔', () => {
  const rows: ReconcileRow[] = [
    row(134790, '2023-04-18'), // 4 月明细 1347.90
    row(12000, '2023-01-04'), // 恰好等于差异的无关行（旧实现会指到它）
    row(50000, '2023-05-02'),
  ];
  const fileMonthly = [
    { month_key: '2023-04', expense: 146790 as never },
    { month_key: '2023-05', expense: 50000 as never },
    { month_key: '2023-01', expense: 12000 as never },
  ];

  it('有逐月数据时 scope=month，且不再断言"文件多 1 笔"', () => {
    const hint = locateDiff(rows, 12000 as never, { fileMonthly });
    expect(hint.scope).toBe('month');
    expect(hint.candidates).toHaveLength(0);
    expect(hint.months).toHaveLength(1);
    expect(hint.months[0].month_key).toBe('2023-04');
    expect(hint.months[0].delta).toBe(12000);
    expect(hint.message).toContain('2023-04');
    expect(hint.message).toContain('1467.90');
    expect(hint.message).toContain('1347.90');
    expect(hint.message).not.toContain('文件多 1 笔');
    // 关键：不得把差异指到"金额恰好等于 12000"的那笔 1 月 4 日交易上
    expect(hint.message).not.toContain('2023-01-04');
  });

  it('没有逐月数据时退化为单笔"疑似"，措辞必须存疑', () => {
    const hint = locateDiff(rows, 12000 as never);
    expect(hint.scope).toBe('row');
    expect(hint.candidates).toHaveLength(1);
    expect(hint.message).toContain('疑似');
    expect(hint.message).toContain('可能相关也可能只是巧合');
  });

  it('月级全对且无单笔等额 → scope=none，明确说定位不到', () => {
    const hint = locateDiff([row(5000, '2023-06-01')], 12000 as never, {
      fileMonthly: [{ month_key: '2023-06', expense: 5000 as never }],
    });
    expect(hint.scope).toBe('none');
    expect(hint.message).toContain('未能定位');
  });

  it('差异为 0 时 scope=none 且文案是「对平」', () => {
    const hint = locateDiff(rows, 0 as never);
    expect(hint.scope).toBe('none');
    expect(hint.message).toBe('对平');
  });
});

describe('QA-R3b 分隔行带金额：不静默吞，必须留痕', () => {
  it('日期列是「1月」但金额列有值 → 该行不入库，但 notes 必须提示', () => {
    const outcome = parseLegacyTables(
      [
        {
          name: '2023',
          rows: [
            ['日期', '项目', '金额'],
            ['1月', '午餐', '15.00'],
            ['2日', '晚餐', '20.00'],
          ],
        },
      ],
      { defaultYear: 2023 },
    );
    // 只有「2日」那笔入库
    expect(outcome.rows).toHaveLength(1);
    expect(outcome.rows[0].cells['金额']).toBe('20.00');
    // 但那笔 15.00 必须被人看见
    expect(outcome.issues).toHaveLength(0);
    const notes = outcome.notes ?? [];
    expect(notes.some((note) => note.includes('15.00') && note.includes('未入库'))).toBe(true);
  });

  it('真实旧表形态（金额列空、小计在其他列）不应产生这条告警', () => {
    const outcome = parseLegacyTables(
      [
        {
          name: '2023',
          rows: [
            ['日期', '支出事项', '金额/元', '备注', '三餐月消费总计/元', '月消费总计/元'],
            ['1月', '', '', '', '119.97', '1244.06'],
            ['2日', '午餐', '15.00', '', '', ''],
          ],
        },
      ],
      { defaultYear: 2023 },
    );
    expect(outcome.rows).toHaveLength(1);
    expect((outcome.notes ?? []).some((note) => note.includes('未入库'))).toBe(false);
  });
});

describe('QA-R3c 表内合计：累计式汇总表必须取到全年', () => {
  it('年支出列逐月累计时取最后一个非零值', () => {
    const totals = detectTableTotals([
      ['年份', '月份', '月支出', '年支出', '年收入'],
      ['2023', '1', '1244.06', '1244.06', '2561'],
      ['', '2', '1031.98', '2276.04', '4358.43'],
      ['', '12', '575.51', '20911.81', '52903.88'],
    ]);
    expect(totals.expense).toBe(2091181);
    expect(totals.income).toBe(5290388);
  });

  it('合计列尾部有 0 / 空行时取最后一个非零值（不是首行，也不是末行）', () => {
    const totals = detectTableTotals([
      ['月份', '年支出'],
      ['1', '1244.06'],
      ['2', '2017.44'],
      ['3', '3005.51'],
      ['', '0'],
      ['', ''],
    ]);
    expect(totals.expense, '首行 1244.06 与末尾 0 都是错的，必须取 3005.51').toBe(300551);
  });
});

describe('QA-R3d 逐月合计带年份（年份列向下沿用）', () => {
  it('月份只有 1..12 时，靠年份列向下填充成 2023-01..2023-12', () => {
    const monthly = detectTableMonthly([
      ['年份', '月份', '月支出', '月收入'],
      ['2023', '1', '1244.06', '2561'],
      ['', '2', '1031.98', '1797.43'],
      ['', '12', '575.51', '22400'],
    ]);
    expect(monthly.map((item) => item.month_key)).toEqual(['2023-01', '2023-02', '2023-12']);
    expect(monthly[0].expense).toBe(124406);
    expect(monthly[2].income).toBe(2240000);
  });
});

describe.skipIf(!HAS_REAL)('QA-R3e 真实旧表：实测对账结论与 notes', () => {
  const fileFromPath = (path: string): ImportFile => {
    const buffer = readFileSync(path);
    return {
      name: '账单例子.xlsx',
      size: buffer.byteLength,
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      readArrayBuffer: async () =>
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
      readText: async () => '',
    };
  };

  it('fileTotal 带 12 个月逐月合计，且 4 月差异可被月级定位', async () => {
    const tables = await readWorkbookTables(fileFromPath(REAL_XLSX));
    const outcome = parseLegacyTables(tables, { defaultYear: 2023 });
    expect(outcome.rows).toHaveLength(399);
    expect(outcome.issues).toHaveLength(0);
    expect(outcome.fileTotal?.expense).toBe(2091181);
    expect(outcome.fileTotal?.income).toBe(5290388);
    expect(outcome.fileTotal?.monthly).toHaveLength(12);
    expect(outcome.fileTotal?.monthly?.map((item) => item.month_key)).toEqual([
      '2023-01', '2023-02', '2023-03', '2023-04', '2023-05', '2023-06',
      '2023-07', '2023-08', '2023-09', '2023-10', '2023-11', '2023-12',
    ]);
    // notes 仍是那两条，文本未被改动
    expect(outcome.notes).toHaveLength(2);
    expect(outcome.notes?.[0]).toContain('汇总表');
    expect(outcome.notes?.[1]).toContain('差 120.00');
  });

  it('端到端 report.diffHint：scope=month，只报 4 月，不指向任何单笔日期', async () => {
    await db.delete();
    await db.open();
    await ensureSeeded(db);
    const report = await runImport(fileFromPath(REAL_XLSX), { defaultYear: 2023 });

    expect(report.sumExpense).toBe(2079181);
    expect(report.sumIncome).toBe(5325201);
    expect(report.comparable).toBe(true);
    expect(report.diffExpense).toBe(12000);
    expect(report.reconciled).toBe(false);
    expect(report.fileMonthly).toHaveLength(12);

    const hint = report.diffHint;
    expect(hint).not.toBeNull();
    expect(hint?.scope).toBe('month');
    expect(hint?.months).toHaveLength(1);
    expect(hint?.months[0].month_key).toBe('2023-04');
    expect(hint?.months[0].delta).toBe(12000);
    expect(hint?.message).toContain('2023-04');
    expect(hint?.message).not.toMatch(/\d{4}-\d{2}-\d{2}/); // 不得出现任何单笔日期
    console.log(`[QA-R3] diffHint = ${hint?.message}`);
  });
});
