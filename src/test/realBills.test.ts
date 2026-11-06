import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import { ensureSeeded } from '../db/seed';
import { asCents, centsToYuan } from '../domain/money';
import type { Parser, RawRow } from '../import/base';
import { inferDirection, normalizeRow } from '../import/normalize';
import { runImport } from '../import/pipeline';
import { alipayCsvParser } from '../import/parsers/alipayCsv';
import { alipayXlsxParser } from '../import/parsers/alipayXlsx';
import { detectParser, loadParsers } from '../import/parsers';
import { extractFileTotal, findHeaderRow, findHeaderRowIndex, parseCsvRows } from '../import/parsers/tabular';
import { wechatXlsxParser } from '../import/parsers/wechatXlsx';
import { makeImportFile } from './fixtures';
import { buildWechatRealShape, makeWechatXlsxFile } from './fixtures/wechatRealShape';

/**
 * 真实账单导入回归（脱敏 fixture）。
 *
 * 为什么要单独一组：这两份账单的形状是从真实导出文件量出来的——
 * 支付宝表头在**第 24 行**且明细区用的是裸 LF（说明区却是 CRLF）；
 * 微信 XLSX 表头在**第 18 行**，收/支列用 `/` 表示中性交易。
 * 这些"脏细节"合成 fixture 一般不会写，所以专门按真实形态造一份。
 *
 * fixture 里没有一份用户真实数据：金额、商户、单号全部替换过，
 * 只保留表头文字、说明行数量与位置、列顺序、方向/状态的取值分布。
 */

const ALIPAY_FIXTURE = resolve(process.cwd(), 'src/test/fixtures/alipayCsv.real-shape.csv');
const alipayCsvText = readFileSync(ALIPAY_FIXTURE, 'utf8');

function alipayFile(): ReturnType<typeof makeImportFile> {
  return makeImportFile('alipay.real-shape.csv', alipayCsvText);
}

async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
  await ensureSeeded(db);
}

/** 跑一遍 normalize，返回按方向聚合的笔数与金额（分）。 */
function normalizeAll(
  rows: readonly RawRow[],
  headerMap: Record<string, string>,
): Record<string, { n: number; cents: number }> {
  const out: Record<string, { n: number; cents: number }> = {};
  for (const raw of rows) {
    const result = normalizeRow(raw, { fieldMap: headerMap, defaultYear: 2020 });
    if (!result.row) continue;
    const key = result.row.direction;
    out[key] = out[key] ?? { n: 0, cents: 0 };
    out[key].n += 1;
    out[key].cents += result.row.amount_cents;
  }
  return out;
}

describe('表头定位：容忍真实表头，而不是要求一字不差', () => {
  it('findHeaderRow 按 minHits 命中：第 23 行才是表头也能找到', () => {
    const table: string[][] = [
      ['-----账单导出-----'],
      ['导出信息：'],
      ['姓名：示例'],
      ['共808笔记录'],
      ['收入：54笔 375.03元'],
      ['支出：289笔 6881.93元'],
      ['不计收支：465笔 12184.05元'],
      [''],
      ['特别提示：'],
      ['1.本回单内容……'],
      ['2.请勿将本回单……'],
      ['3.支付宝快捷支付……'],
      ['4.本回单如经任何涂改……'],
      ['5.部分账单如：充值提现……'],
      ['6.因统计逻辑不同……'],
      ['7.禁止将本回单……'],
      ['8.本明细仅供个人对账使用。'],
      [''],
      ['----支付宝支付科技有限公司  电子客户回单----'],
    ];
    // 第 19 行之后才是表头（这里构造到索引 23，与真实文件一致）
    while (table.length < 23) table.push(['']);
    table.push(['交易时间', '交易分类', '交易对方', '对方账号', '商品说明', '收/支', '金额', '收/付款方式', '交易状态', '交易订单号', '商家订单号', '备注', '']);
    table.push(['2020-07-31 21:22:42', '其他', '某商户', '/', '奖励', '收入', '0.03', '', '交易成功', 'TX1', 'MX1', '', '']);

    const tokens = ['交易时间', '交易分类', '交易对方', '商品说明', '收/支', '金额', '交易订单号', '交易状态'];
    expect(findHeaderRow(table, tokens, 5)).toBe(23);
    // 严格模式（全部命中）在这份文件上同样成立，说明旧接口没被破坏
    expect(findHeaderRowIndex(table, tokens)).toBe(23);
  });

  it('findHeaderRowIndex 仍是「全部命中」的严格模式，不会把说明行当表头', () => {
    const table = [
      ['微信支付账单明细'],
      ['甲,乙,丙,丁'],
      ['交易时间', '收/支', '金额'],
      ['交易时间', '交易分类', '交易对方', '对方账号', '商品说明', '收/支', '金额', '收/付款方式', '交易状态', '交易订单号', '商家订单号', '备注'],
    ];
    expect(findHeaderRow(table, ['交易时间', '收/支'], 2)).toBe(2);
    // 真实支付宝表头写的是「交易订单号」，不含子串「交易号」→ 严格模式找不到
    expect(findHeaderRowIndex(table, ['交易号', '金额'])).toBe(-1);
    // 支付宝 8 个特征词命中 5 个即认 → 找到真正的表头（第 4 行）
    const alipayTokens = ['交易时间', '交易分类', '交易对方', '商品说明', '收/支', '金额', '交易订单号', '交易状态'];
    expect(findHeaderRow(table, alipayTokens, 5)).toBe(3);
    expect(findHeaderRowIndex(table, alipayTokens)).toBe(3);
    // 命中门槛太高就退化成"找不到"——这正是旧实现导不进真实账单的原因
    expect(findHeaderRow(table, alipayTokens, 8)).toBe(3);
    expect(findHeaderRow(table, ['交易分类', '商品说明', '交易订单号'], 3)).toBe(3);
  });

  it('混合换行（说明区 CRLF + 明细区裸 LF）不能被解析成"一条记录"', () => {
    // 真实支付宝导出就是这样：前 23 行 CRLF，后面 800 多行裸 LF。
    // Papa 的换行自动探测只看开头，会把后面所有裸 LF 当成普通字符，
    // 整份明细塌成"一条 9709 单元格的记录"——必须先在 parseCsvRows 里统一换行。
    const prefix = ['共2笔记录', '交易时间,收/支,金额'].join('\r\n');
    const body = ['2020-01-01 00:00:00,支出,1.00', '2020-01-02 00:00:00,收入,2.00'].join('\n');
    const table = parseCsvRows(`${prefix}\r\n${body}`);
    expect(table).toHaveLength(4);
    expect(table[3]).toEqual(['2020-01-02 00:00:00', '收入', '2.00']);
  });
});

describe('支付宝 CSV：真实形态 fixture', () => {
  it('解析出 40 行明细，收/支三类分布与真实文件一致', async () => {
    const outcome = await alipayCsvParser.parse(alipayFile(), {});
    expect(outcome.rows).toHaveLength(40);

    const declared: Record<string, number> = {};
    for (const row of outcome.rows) declared[row.cells['收/支']] = (declared[row.cells['收/支']] ?? 0) + 1;
    expect(declared).toEqual({ 收入: 6, 支出: 20, 不计收支: 14 });
  });

  it('列映射必须落到真实列名上（交易订单号/商品说明/收付款方式/交易状态）', async () => {
    const outcome = await alipayCsvParser.parse(alipayFile(), {});
    expect(outcome.headerMap).toMatchObject({
      occurred_at: '交易时间',
      amount: '金额',
      direction: '收/支',
      counterparty: '交易对方',
      note: '商品说明',
      txn_no: '交易订单号',
      channel: '收/付款方式',
      status: '交易状态',
    });
  });

  it('方向归一：支出 19 笔 496.08、收入 6 笔 192.13、不计收支 15 笔 2441.62', async () => {
    const outcome = await alipayCsvParser.parse(alipayFile(), {});
    const agg = normalizeAll(outcome.rows, outcome.headerMap as Record<string, string>);
    // 20 笔支出里有 1 笔「交易关闭」→ 钱没动，归到 transfer
    expect(agg.expense).toEqual({ n: 19, cents: 49608 });
    expect(agg.income).toEqual({ n: 6, cents: 19213 });
    // 14 笔不计收支 + 1 笔「已关闭的支出」= 15 笔
    expect(agg.transfer).toEqual({ n: 15, cents: 244162 });
    expect(agg.refund).toBeUndefined();
  });

  it('「交易关闭」6 笔全部判为 transfer，并在备注里标注', async () => {
    const outcome = await alipayCsvParser.parse(alipayFile(), {});
    const closed = outcome.rows.filter((row) => row.cells['交易状态'] === '交易关闭');
    expect(closed).toHaveLength(6);
    for (const raw of closed) {
      const result = normalizeRow(raw, { fieldMap: outcome.headerMap, defaultYear: 2020 });
      expect(result.row?.direction, `第 ${raw.rowIndex} 行交易关闭不得判成支出`).toBe('transfer');
      expect(result.row?.note).toContain('（交易关闭）');
    }
    // 其中 1 笔原文写的是「支出」——这正是最容易被记成消费的那种
    const declaredExpenseClosed = closed.filter((row) => row.cells['收/支'] === '支出');
    expect(declaredExpenseClosed).toHaveLength(1);
  });

  it('「退款成功」且收/支=不计收支 保持 transfer，不翻成 refund（否则重复冲减）', async () => {
    const outcome = await alipayCsvParser.parse(alipayFile(), {});
    const refunds = outcome.rows.filter((row) => row.cells['交易状态'] === '退款成功');
    expect(refunds).toHaveLength(2);
    for (const raw of refunds) {
      expect(raw.cells['收/支']).toBe('不计收支');
      expect(raw.cells['商品说明'].startsWith('退款-')).toBe(true);
      const result = normalizeRow(raw, { fieldMap: outcome.headerMap, defaultYear: 2020 });
      expect(result.row?.direction).toBe('transfer');
    }
  });

  it('文件汇总：收入 6笔 192.13 / 支出 20笔 496.08 / 不计收支 14笔 2411.62', async () => {
    const outcome = await alipayCsvParser.parse(alipayFile(), {});
    expect(outcome.fileTotal).toMatchObject({
      income: 19213,
      expense: 49608,
      neutral: 241162,
      count: 40,
      incomeCount: 6,
      expenseCount: 20,
      neutralCount: 14,
    });
  });

  it('端到端：40 笔全部入库、金额对平（笔数含已关闭不影响对账）', async () => {
    await resetDb();
    const report = await runImport(alipayFile());
    console.log(
      `[alipay fixture] parsed=${report.parsedRows} inserted=${report.insertedRows} failed=${report.failedRows} ` +
        `expense=${centsToYuan(report.sumExpense)} income=${centsToYuan(report.sumIncome)} diff=${report.diffExpense}`,
    );
    expect(report.parserId).toBe('alipay_csv');
    expect(report.parsedRows).toBe(40);
    expect(report.insertedRows).toBe(40);
    expect(report.failedRows).toBe(0);
    expect(report.sumExpense).toBe(49608);
    expect(report.sumIncome).toBe(19213);
    // 支付宝自报「20笔 496.08元」：笔数含已关闭、金额不含。金额对上就算对平
    expect(report.diffExpense).toBe(0);
    expect(report.reconciled).toBe(true);
    expect(report.notes.some((note) => note.includes('笔数'))).toBe(true);
    expect(report.notes.some((note) => note.includes('已把 6 笔「交易关闭」'))).toBe(true);
  });
});

describe('微信 XLSX：真实形态 fixture（程序化生成，不提交二进制）', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('fixture 自身形态：17 行前缀 + 第 18 行表头 + 189 行明细', () => {
    const { matrix, meta } = buildWechatRealShape();
    expect(matrix).toHaveLength(17 + 1 + 189);
    expect(meta.headerRowNumber).toBe(18);
    expect(matrix[17]).toEqual([
      '交易时间',
      '交易类型',
      '交易对方',
      '商品',
      '收/支',
      '金额(元)',
      '支付方式',
      '当前状态',
      '交易单号',
      '商户单号',
      '备注',
    ]);
    expect(meta.declared.income.n).toBe(45);
    expect(meta.declared.expense.n).toBe(120);
    expect(meta.declared.neutral.n).toBe(24);
    expect(meta.refund.n).toBe(10);
  });

  it('能被 wechat_xlsx 认领，且不会被支付宝 XLSX 抢走', async () => {
    const { file } = await makeWechatXlsxFile();
    const detected = await detectParser(file);
    expect(detected?.id).toBe('wechat_xlsx');
    expect(await alipayXlsxParser.canHandle(file), '支付宝 xlsx 必须与微信互斥').toBe(false);
  });

  it('解析 189 行；列映射落到「当前状态 / 商品 / 金额(元)」', async () => {
    const { file } = await makeWechatXlsxFile();
    const outcome = await wechatXlsxParser.parse(file, {});
    expect(outcome.rows).toHaveLength(189);
    expect(outcome.headerMap).toMatchObject({
      occurred_at: '交易时间',
      amount: '金额(元)',
      direction: '收/支',
      counterparty: '交易对方',
      note: '商品',
      txn_no: '交易单号',
      channel: '支付方式',
      status: '当前状态',
    });
  });

  it('收/支 = / 的 24 行全部判为 transfer（绝不落进 expense）', async () => {
    const { file, meta } = await makeWechatXlsxFile();
    const outcome = await wechatXlsxParser.parse(file, {});
    const neutralRows = outcome.rows.filter((row) => row.cells['收/支'] === '/');
    expect(neutralRows).toHaveLength(24);
    const agg = normalizeAll(outcome.rows, outcome.headerMap as Record<string, string>);
    for (const raw of neutralRows) {
      const result = normalizeRow(raw, { fieldMap: outcome.headerMap, defaultYear: 2020 });
      expect(result.row?.direction, `第 ${raw.rowIndex} 行 / 应为 transfer`).toBe('transfer');
    }
    expect(agg.transfer).toEqual({ n: 24, cents: meta.declared.neutral.cents });
    expect(centsToYuan(asCents(agg.transfer.cents)), '中性交易合计').toBe(centsToYuan(asCents(meta.declared.neutral.cents)));
  });

  it('「群收款 / 收款方备注」不会被「收款」二字翻成收入（真实踩过的坑）', async () => {
    const { file } = await makeWechatXlsxFile();
    const outcome = await wechatXlsxParser.parse(file, {});
    const trapRows = outcome.rows.filter(
      (row) =>
        row.cells['收/支'] === '支出' &&
        `${row.cells['交易类型']}${row.cells['商品']}`.includes('收款') &&
        // 退款状态优先：退款行判 refund 是对的，不属于这条回归
        !row.cells['当前状态'].includes('退款'),
    );
    expect(trapRows.length, 'fixture 里应有「群收款/二维码收款」这类行').toBeGreaterThan(0);
    for (const raw of trapRows) {
      const result = normalizeRow(raw, { fieldMap: outcome.headerMap, defaultYear: 2020 });
      expect(result.row?.direction, `第 ${raw.rowIndex} 行含「收款」但收/支是支出`).toBe('expense');
    }
  });

  it('「已全额退款」判 refund；部分退款判 refund 并提示金额需核对', async () => {
    const { file, meta } = await makeWechatXlsxFile();
    const outcome = await wechatXlsxParser.parse(file, {});
    const full = outcome.rows.filter((row) => row.cells['当前状态'] === '已全额退款');
    expect(full).toHaveLength(8);
    for (const raw of full) {
      expect(normalizeRow(raw, { fieldMap: outcome.headerMap, defaultYear: 2020 }).row?.direction).toBe('refund');
    }

    const partial = outcome.rows.filter(
      (row) => row.cells['当前状态'].includes('已退款') && !row.cells['当前状态'].includes('已全额退款'),
    );
    expect(partial.length, '部分退款 2 行').toBe(2);
    for (const raw of partial) {
      const result = normalizeRow(raw, { fieldMap: outcome.headerMap, defaultYear: 2020 });
      expect(result.row?.direction).toBe('refund');
      expect(result.row?.note).toContain('（部分退款）');
      expect(result.issues.some((issue) => issue.reason.includes('人工核对'))).toBe(true);
    }

    const agg = normalizeAll(outcome.rows, outcome.headerMap as Record<string, string>);
    expect(agg.refund).toEqual({ n: meta.refund.n, cents: meta.refund.cents });
    expect(meta.refund.n).toBe(10);
  });

  it('汇总区在表头之前也能抽到中性交易合计', async () => {
    const { file, meta } = await makeWechatXlsxFile();
    const outcome = await wechatXlsxParser.parse(file, {});
    expect(outcome.fileTotal).toMatchObject({
      income: meta.declared.income.cents,
      expense: meta.declared.expense.cents,
      neutral: meta.declared.neutral.cents,
      count: 189,
      incomeCount: 45,
      expenseCount: 120,
      neutralCount: 24,
      totalsIncludeRefund: true,
    });
  });

  it('端到端：189 笔入库、退款按原侧还原后收入支出都对平', async () => {
    const { file, meta } = await makeWechatXlsxFile();
    const report = await runImport(file);
    console.log(
      `[wechat fixture] parsed=${report.parsedRows} inserted=${report.insertedRows} failed=${report.failedRows} ` +
        `expense=${centsToYuan(report.sumExpense)} income=${centsToYuan(report.sumIncome)} ` +
        `refund=${centsToYuan(report.sumRefund)} diff=${report.diffExpense}`,
    );
    expect(report.parserId).toBe('wechat_xlsx');
    expect(report.parsedRows).toBe(189);
    expect(report.insertedRows).toBe(189);
    expect(report.failedRows).toBe(0);

    // 明细侧：支出 = 120 - 7 笔退款；收入 = 45 - 3 笔退款；退款 10 笔
    expect(report.sumExpense).toBe(meta.declared.expense.cents - meta.refundOnExpense);
    expect(report.sumIncome).toBe(meta.declared.income.cents - meta.refundOnIncome);
    expect(report.sumRefund).toBe(meta.refund.cents);
    // 文件按发生额统计，还原后两侧都必须对平
    expect(report.diffExpense).toBe(0);
    expect(report.reconciled).toBe(true);
    expect(report.notes.some((note) => note.includes('中性交易与文件声明一致'))).toBe(true);

    const rows = await db.transactions.toArray();
    expect(rows.filter((row) => row.direction === 'transfer')).toHaveLength(24);
    expect(rows.filter((row) => row.direction === 'transfer').every((row) => row.amount_cents > 0)).toBe(true);
  });
});

describe('extractFileTotal：认「中性交易」与「不计收支」，且不把笔数当金额', () => {
  it('微信：中性交易：24笔 24317.89元', () => {
    const total = extractFileTotal(['共189笔记录', '收入：45笔 17481.03元', '支出：120笔 19516.07元', '中性交易：24笔 24317.89元'].join('\n'));
    expect(total).toMatchObject({
      count: 189,
      income: 1748103,
      incomeCount: 45,
      expense: 1951607,
      expenseCount: 120,
      neutral: 2431789,
      neutralCount: 24,
    });
  });

  it('支付宝：不计收支：465笔 12184.05元；「289笔」不能被当成 289.00 元', () => {
    const total = extractFileTotal(
      ['共808笔记录', '收入：54笔 375.03元', '支出：289笔 6881.93元', '不计收支：465笔 12184.05元'].join('\n'),
    );
    expect(total?.neutral).toBe(1218405);
    expect(total?.neutralCount).toBe(465);
    expect(total?.expense).toBe(688193);
    expect(total?.expenseCount).toBe(289);
    expect(total?.expense).not.toBe(28900);
  });

  it('旧形态（已支出: 1234.00元）仍然认', () => {
    expect(extractFileTotal('已支出: 1234.00元')).toMatchObject({ expense: 123400 });
    expect(extractFileTotal('收入：20.00元')).toMatchObject({ income: 2000 });
    expect(extractFileTotal('没有任何汇总行')).toBeUndefined();
  });
});

describe('inferDirection：收/支列压倒关键词扫描', () => {
  const parserNeutral = (value: string): string => inferDirection({ directionText: value });

  it('中性符号与「不计收支」都是 transfer', () => {
    expect(parserNeutral('/')).toBe('transfer');
    expect(parserNeutral('／')).toBe('transfer');
    expect(parserNeutral('不计收支')).toBe('transfer');
  });

  it('「/」只按整格比对：对方账号、商品里出现 / 不能影响判定', () => {
    expect(inferDirection({ directionText: '支出', typeText: '对方账号 / 商品 / 支付方式 /' })).toBe('expense');
    expect(inferDirection({ directionText: '收入', typeText: '/ / /' })).toBe('income');
  });

  it('交易关闭优先于收/支列的「支出」', () => {
    expect(inferDirection({ directionText: '支出', statusText: '交易关闭' })).toBe('transfer');
  });

  it('没有收/支列时才靠关键词（退款/转账）兜底', () => {
    expect(inferDirection({ typeText: '退款-订单A' })).toBe('refund');
    expect(inferDirection({ typeText: '余额宝收益' })).toBe('expense');
  });
});

describe('parser 注册：可用 parser 一览', () => {
  it('微信 xlsx 已注册且排在支付宝 xlsx 之前', async () => {
    const parsers: Parser[] = await loadParsers();
    const ids = parsers.map((parser) => parser.id);
    expect(ids).toContain('wechat_xlsx');
    expect(ids.indexOf('wechat_xlsx')).toBeLessThan(ids.indexOf('alipay_xlsx'));
  });
});
