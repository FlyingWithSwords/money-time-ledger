import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/db';
import { ensureSeeded } from '../../db/seed';
import { sumCents } from '../../domain/money';
import type { ImportFile } from '../../import/base';
import { runImport } from '../../import/pipeline';
import { isSummaryTable, parseLegacySheet, parseLegacyTables } from '../../import/parsers/legacyXlsx';
import { readWorkbookTables, type SheetTable } from '../../import/parsers/xlsxReader';

/**
 * QA-R2：主理人指定的针对性用例（分隔行变体 / 收入表头变体 / 收支混排 / 汇总表误判防护）
 * + 真实旧表的三条对照实验（证明"主动跳过"而不是"侥幸拦下"）。
 */

const REAL_XLSX = process.env.QA_REAL_XLSX ?? 'C:/Users/Memphis/Desktop/账单例子.xlsx';
const HAS_REAL = existsSync(REAL_XLSX);

function fileFromPath(path: string): ImportFile {
  const buffer = readFileSync(path);
  return {
    name: '账号账单.xlsx',
    size: buffer.byteLength,
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    readArrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    readText: async () => '',
  };
}

const parse = (rows: string[][], name = '2023') =>
  parseLegacySheet({ name, rows } as SheetTable, { defaultYear: 2023 });

describe('QA-R2a 月份分隔行三种变体', () => {
  it.each([
    ['1月', '2023-01-02'],
    ['01月', '2023-01-02'],
    ['1 月', '2023-01-02'],
    ['1月份', '2023-01-02'],
  ])('分隔行「%s」能被识别，且段内 2日 落在 %s', (separator, expected) => {
    const { rows, issues } = parse([
      ['日期', '项目', '金额'],
      [separator, '', ''],
      ['2日', '午餐', '15.00'],
      ['', '晚餐', '20.00'],
    ]);
    expect(issues.filter((issue) => issue.reason.includes('日期无法解析'))).toHaveLength(0);
    expect(rows.map((row) => row.cells['日期'])).toEqual([expected, expected]);
    expect(rows.map((row) => row.cells['金额'])).toEqual(['15.00', '20.00']);
  });

  it('分隔行夹带小计（真实旧表形态）仍被识别，且小计不入库', () => {
    const { rows } = parse([
      ['日期', '支出事项', '金额/元', '备注', '三餐月消费总计/元', '月消费总计/元'],
      ['1月', '', '', '', '119.97', '1244.06'],
      ['2日', '午餐', '15.00', '', '', ''],
      ['12月', '', '', '', '100.00', '575.51'],
      ['31日', '聚餐', '88.00', '', '', ''],
    ]);
    expect(rows.map((row) => row.cells['日期'])).toEqual(['2023-01-02', '2023-12-31']);
    expect(sumCents(rows.map((row) => Math.round(Number(row.cells['金额']) * 100)))).toBe(10300);
  });
});

describe('QA-R2b 收入表头三种变体', () => {
  it.each([['基础收入/元'], ['含税收入（元）'], ['收入金额']])('表头「%s」→ 方向必须是收入', (header) => {
    const { rows } = parse([
      ['日期', header, '备注'],
      ['1月', '', ''],
      ['1日', '96', 'x'],
      ['2日', '120', 'y'],
    ], '2023收入');
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.cells['收支'] === '收入')).toBe(true);
    expect(sumCents(rows.map((row) => Math.round(Number(row.cells['金额']) * 100)))).toBe(21600);
  });
});

describe('QA-R2c 收支混排表（独立「收/支」列）', () => {
  /**
   * 已修复（R2 收口）：`legacyXlsx` 新增 `directionCol` + `mapDirectionText`，
   * 手写 Excel（无「交易号」→ 不会被 alipayXlsx 接管）带独立「收/支」列时逐行定方向。
   * 原来挂在 it.fails 上作为金丝雀，缺陷消失后按设计变红，此处摘标记转正。
   */
  it('带独立收/支列时方向应逐行生效', () => {
    const { rows } = parse([
      ['日期', '项目', '金额', '收/支'],
      ['3月', '', '', ''],
      ['1日', '工资', '8000.00', '收入'],
      ['2日', '午餐', '15.00', '支出'],
      ['3日', '退货', '12.49', '退款'],
    ]);
    const directions = rows.map((row) => row.cells['收支']);
    expect(directions, '收/支列必须逐行决定方向').toEqual(['收入', '支出', '退款']);
    // 方向变化不得篡改金额：三笔合计应是 8000 + 15 + 12.49
    expect(sumCents(rows.map((row) => Math.round(Number(row.cells['金额']) * 100)))).toBe(802749);
  });

  it('「收/支」列写着认不出的值 → 落整表默认方向，但必须有 notes 提示', () => {
    const { rows, notes } = parse([
      ['日期', '项目', '金额', '收/支'],
      ['3月', '', '', ''],
      ['1日', '工资', '8000.00', '收入'],
      ['2日', '杂项', '15.00', '其他'],
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[1].cells['收支'], '认不出时沿用整表默认（支出）').toBe('支出');
    expect(
      notes.some((note) => note.includes('其他') && note.includes('无法判定收支方向')),
      '不许静默按默认值记成支出，必须给出 notes',
    ).toBe(true);
  });

  it('「类型」列若不含任何真方向值 → 不当作方向列（避免分类列被误读）', () => {
    const { rows } = parse([
      ['日期', '类型', '金额'],
      ['3月', '', ''],
      ['1日', '餐饮', '15.00'],
      ['2日', '交通', '8.00'],
    ]);
    expect(rows.map((row) => row.cells['收支'])).toEqual(['支出', '支出']);
  });

  it('同一张表若整体是收入列，方向仍然正确（对照：已有机制没坏）', () => {
    const { rows } = parse([
      ['日期', '项目', '收入金额', '收/支'],
      ['3月', '', '', ''],
      ['1日', '工资', '8000.00', '收入'],
    ], '2023收入');
    expect(rows[0].cells['收支']).toBe('收入');
  });
});

describe('QA-R2d 汇总表误判防护', () => {
  it('冒充明细的汇总表（含日期列 + ≥2 汇总标记）必须整表跳过', () => {
    const rows = [
      ['日期', '月支出', '月收入', '年支出'],
      ['2023-01-01', '1244.06', '2561', '20911.81'],
      ['2023-02-01', '1031.98', '1797.43', '20911.81'],
    ];
    expect(isSummaryTable(rows)).toBe(true);
    const outcome = parseLegacyTables([{ name: '收支统计', rows }], { defaultYear: 2023 });
    expect(outcome.rows, '汇总表不得产生任何交易').toHaveLength(0);
    expect(outcome.notes?.some((note) => note.includes('汇总表'))).toBe(true);
  });

  it('明细表里的「合计」行必须跳过，其余明细保留', () => {
    const { rows, issues } = parse([
      ['日期', '项目', '金额'],
      ['5月', '', ''],
      ['1日', '午餐', '15.00'],
      ['2日', '晚餐', '20.00'],
      ['合计', '', '35.00'],
      ['5月小计', '', '35.00'],
    ]);
    expect(rows.map((row) => row.cells['项目'])).toEqual(['午餐', '晚餐']);
    expect(issues.filter((issue) => issue.reason.includes('汇总行已跳过')).length).toBeGreaterThanOrEqual(2);
  });

  it('日期列不像日期的表整表放弃，不硬猜列', () => {
    const outcome = parseLegacyTables(
      [{ name: 'Sheet1', rows: [['甲', '乙', '丙'], ['a', 'b', 'c'], ['d', 'e', 'f']] }],
      { defaultYear: 2023 },
    );
    expect(outcome.rows).toHaveLength(0);
  });

  /**
   * 已知问题（轻微）：门槛是"前 5 行命中 ≥2 个汇总标记"。只有 1 个标记、但日期列可解析的
   * 汇总表会被当成明细，把年合计写成交易。真实旧表（≥3 个标记）不受影响。
   */
  it.fails('单标记汇总表（只有「年支出」列 + 年合计）不应入库（当前会入库假交易）', () => {
    const outcome = parseLegacyTables(
      [{ name: '汇总', rows: [['日期', '年支出'], ['2023-01-01', '20911.81'], ['2023-02-01', '20911.81']] }],
      { defaultYear: 2023 },
    );
    expect(outcome.rows).toHaveLength(0);
  });

  /**
   * 已知问题（轻微）：明细表若恰好同时有「月支出」「月收入」两列，会被判成汇总表整表丢弃
   * （有 note 提示，但数据确实没进来）。建议把 isSummaryTable 收紧为"必须含 年支出/年收入/累计*"。
   */
  it.fails('带「月支出」「月收入」两列的明细表不应被整表跳过（当前会丢整表）', () => {
    const outcome = parseLegacyTables(
      [
        {
          name: '明细',
          rows: [
            ['日期', '项目', '金额', '月支出', '月收入'],
            ['2日', '午餐', '15.00', '', ''],
            ['3日', '晚餐', '20.00', '', ''],
          ],
        },
      ],
      { defaultYear: 2023 },
    );
    expect(outcome.rows.length).toBe(2);
  });
});

describe.skipIf(!HAS_REAL)('QA-R2e 真实旧表对照实验：证明「主动跳过」而非侥幸', () => {
  const load = async (): Promise<SheetTable[]> => readWorkbookTables(fileFromPath(REAL_XLSX));

  it('把「收支统计」改成可解析形态（加日期+金额）后，仍然一笔都不入库', async () => {
    const tables = await load();
    const summary = tables.find((table) => table.name === '收支统计')!;
    // 人为把它"伪装"成明细：日期列填可解析的日期，金额列填真实金额
    const disguised: SheetTable = {
      name: '收支统计（伪装）',
      rows: summary.rows.map((row, index) =>
        index === 0 ? row : [`2023-0${Math.min(index, 9)}-01`, ...row.slice(1)],
      ),
    };
    const outcome = parseLegacyTables([disguised], { defaultYear: 2023 });
    expect(outcome.rows, '汇总表即便日期可解析也不得入库').toHaveLength(0);
    expect(outcome.notes?.some((note) => note.includes('汇总表'))).toBe(true);
  });

  it('改掉 sheet 名后仍被跳过（判定基于内容而非名字）', async () => {
    const tables = await load();
    const summary = tables.find((table) => table.name === '收支统计')!;
    const outcome = parseLegacyTables([{ name: '随便一个名字', rows: summary.rows }], { defaultYear: 2023 });
    expect(outcome.rows).toHaveLength(0);
    expect(outcome.notes?.length).toBeGreaterThan(0);
  });

  it('删掉汇总表后明细数量不变（399 笔），说明汇总表贡献 0 笔', async () => {
    const tables = await load();
    const withSummary = parseLegacyTables(tables, { defaultYear: 2023 });
    const withoutSummary = parseLegacyTables(
      tables.filter((table) => table.name !== '收支统计'),
      { defaultYear: 2023 },
    );
    expect(withSummary.rows.length).toBe(399);
    expect(withoutSummary.rows.length).toBe(399);
    // 唯一差别是对账用的 fileTotal
    expect(withSummary.fileTotal?.expense).toBe(2091181);
    expect(withoutSummary.fileTotal?.expense).toBeUndefined();
  });

  it('「结算收入」列未被当成第二笔交易（收入合计不是 105,807）', async () => {
    const tables = await load();
    const outcome = parseLegacyTables(tables, { defaultYear: 2023 });
    const income = outcome.rows.filter((row) => row.cells['收支'] === '收入');
    const total = sumCents(income.map((row) => Math.round(Number(row.cells['金额']) * 100)));
    expect(total).toBe(5325201);
    expect(total).toBeLessThan(10580000);
    expect(income).toHaveLength(40);
  });

  it('月份分隔行的小计未入库：交易表里没有 1244.06 / 10360.81 这类小节记录', async () => {
    await db.delete();
    await db.open();
    await ensureSeeded(db);
    const report = await runImport(fileFromPath(REAL_XLSX), { defaultYear: 2023 });
    const rows = await db.transactions.toArray();
    expect(rows).toHaveLength(399);
    expect(report.sumExpense).toBe(2079181);
    // 12 个月「月消费总计」合计 20791.81；若小计入库，支出合计必然超过这个数
    const subtotalAmounts = [124406, 103198, 72947, 134790, 77005, 64292, 137860, 44148, 1036081, 216282, 10621, 57551];
    const hits = rows.filter((row) => subtotalAmounts.includes(row.amount_cents as number));
    // 真实明细里可能存在与小计等额的单笔（属于巧合），但绝不允许与"分隔行"成对出现
    for (const row of hits) {
      expect(row.counterparty ?? '', `小计行不应带「月」字样: ${row.counterparty}`).not.toMatch(/^\d{1,2}月$/);
    }
    // 0.04 元这类真实小额必须保留（区别于小计）
    expect(rows.some((row) => row.amount_cents === 4)).toBe(true);
  });

  it('矩阵含 3 张表，支出表 359 笔明细可独立还原', async () => {
    const tables = await load();
    expect(tables.map((table) => table.name)).toEqual(['收支统计', '2023支出', '2023收入']);
    const expenseSheet = tables.find((table) => table.name === '2023支出')!;
    const { rows } = parseLegacySheet(expenseSheet, { defaultYear: 2023 });
    expect(rows.filter((row) => row.cells['收支'] === '支出')).toHaveLength(359);
  });
});
