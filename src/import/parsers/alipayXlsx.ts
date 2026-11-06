import { LedgerError } from '../../domain/errors';
import type { Parser, ParseOutcome } from '../base';
import { buildRawRows, findHeaderRow, isSummaryCells, resolveHeaderMap } from './tabular';
import { readWorkbookTables } from './xlsxReader';

/**
 * 支付宝导出的 XLSX / 银行流水 XLSX：结构与支付宝 CSV 一致，只是容器换成表格。
 * 表头行可能在若干说明行之后，按「交易时间 / 交易对方 / 收/支 / 金额 / 交易订单号」定位。
 */

/** 表头特征词，命中 5 个即认（与支付宝 CSV 保持同一套标准）。 */
const ALIPAY_HEADER_TOKENS = [
  '交易时间',
  '交易分类',
  '交易对方',
  '商品说明',
  '收/支',
  '金额',
  '交易订单号',
  '交易状态',
] as const;
const ALIPAY_HEADER_MIN_HITS = 5;

/** 前 30 行拼起来看特征，别扫整本工作簿。 */
function headText(rows: readonly string[][], limit = 30): string {
  return rows
    .slice(0, limit)
    .map((row) => row.join(''))
    .join('\n');
}

/** 前 30 行里任意一行最多能命中几个支付宝表头特征词。 */
function maxHeaderHits(rows: readonly string[][], tokens: readonly string[], limit = 30): number {
  let best = 0;
  for (const row of rows.slice(0, limit)) {
    const joined = row.join('|');
    const hits = tokens.filter((token) => joined.includes(token)).length;
    if (hits > best) best = hits;
  }
  return best;
}

export const alipayXlsxParser: Parser = {
  id: 'alipay_xlsx',
  label: '支付宝/银行账单 XLSX',
  fieldHints: {
    occurred_at: '交易时间',
    amount: '金额',
    direction: '收/支',
    counterparty: '交易对方',
    note: '商品说明',
    txn_no: '交易订单号',
    channel: '收/付款方式',
    status: '交易状态',
  },
  async canHandle(file) {
    if (!/\.(xlsx|xls)$/i.test(file.name)) return false;
    const tables = await readWorkbookTables(file, { keepBlankRows: true });
    const first = tables[0];
    if (!first) return false;
    const head = headText(first.rows);
    // 互斥：微信账单同样有「交易时间 / 交易对方 / 收/支 / 金额」4 列，
    // 不显式排除就会把微信的 Excel 当支付宝吞掉（导出来的方向列语义还不同）。
    if (head.includes('微信支付')) return false;
    const hits = maxHeaderHits(first.rows, ALIPAY_HEADER_TOKENS);
    // 有「支付宝」字样时放宽到 4 个（个别版本把「商品说明」改成「商品名称」）；
    // 没有字样时必须命中 5 个真实列名——微信表头最多只能命中 4 个，天然进不来
    if (head.includes('支付宝')) return hits >= 4;
    return hits >= ALIPAY_HEADER_MIN_HITS;
  },
  async parse(file, opts): Promise<ParseOutcome> {
    const tables = await readWorkbookTables(file);
    const rows: ParseOutcome['rows'] = [];
    const issues: ParseOutcome['issues'] = [];
    let headerMap: ParseOutcome['headerMap'] = {};

    for (const table of tables) {
      const headerRowIndex = findHeaderRow(table.rows, ALIPAY_HEADER_TOKENS, ALIPAY_HEADER_MIN_HITS);
      if (headerRowIndex < 0) continue;
      const built = buildRawRows(table.rows, headerRowIndex, isSummaryCells);
      rows.push(...built.rows);
      headerMap = resolveHeaderMap(built.headers, alipayXlsxParser.fieldHints, opts.headerMap);
    }

    if (rows.length === 0) {
      throw new LedgerError('PARSE_FAILED', '这张表里没有找到支付宝账单表头（交易时间 / 收/支 / 金额 / 交易订单号），可能不是支付宝账单');
    }
    return {
      parserId: alipayXlsxParser.id,
      rows,
      headerMap,
      issues,
      notes: ['支付宝汇总行的口径：笔数含「交易关闭」的行，金额不含；对账以金额为准，笔数差不算对账失败'],
    };
  },
  isSummaryRow(row) {
    return isSummaryCells(row.cells);
  },
};
