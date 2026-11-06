import { LedgerError } from '../../domain/errors';
import type { Parser, ParseOutcome } from '../base';
import {
  buildRawRows,
  decodeBillText,
  extractFileTotal,
  findHeaderRow,
  isSummaryCells,
  parseCsvRows,
  resolveHeaderMap,
} from './tabular';
import {
  WECHAT_FIELD_HINTS,
  WECHAT_HEADER_MIN_HITS,
  WECHAT_HEADER_TOKENS,
  WECHAT_NEUTRAL_NOTE,
  WECHAT_REFUND_CALIBER_NOTE,
} from './wechatCommon';

/**
 * 微信支付账单 CSV（UTF-8，带 BOM）。
 * 导出文件前面有十几行说明，末尾（或开头）有「共 N 笔 / 收入：/ 支出：/ 中性交易：」汇总——都要跳过。
 * 金额列恒为正，方向由「收/支」列决定；`/` 是中性交易（见 normalize 的 NEUTRAL_DIRECTION_VALUES）。
 */
export const wechatCsvParser: Parser = {
  id: 'wechat_csv',
  label: '微信账单 CSV',
  fieldHints: WECHAT_FIELD_HINTS,
  async canHandle(file) {
    if (!/\.csv$/i.test(file.name)) return false;
    const text = await decodeBillText(file);
    const head = text.slice(0, 4000);
    return head.includes('微信支付账单明细') || (head.includes('交易单号') && head.includes('收/支'));
  },
  async parse(file, opts): Promise<ParseOutcome> {
    const text = await decodeBillText(file);
    const table = parseCsvRows(text);
    const headerRowIndex = findHeaderRow(table, WECHAT_HEADER_TOKENS, WECHAT_HEADER_MIN_HITS);
    if (headerRowIndex < 0) {
      throw new LedgerError('PARSE_FAILED', '没有找到微信账单表头（需要至少命中「交易时间 / 交易对方 / 收/支 / 金额(元) / 交易单号」中的 5 个列名）');
    }
    const { rows, headers } = buildRawRows(table, headerRowIndex, isSummaryCells);
    const headerMap = resolveHeaderMap(headers, wechatCsvParser.fieldHints, opts.headerMap);
    const declared = extractFileTotal(text);
    const fileTotal = declared ? { ...declared, totalsIncludeRefund: true } : undefined;
    const issues = rows.length === 0 ? [{ row: headerRowIndex + 1, reason: '表头之后没有可解析的明细行' }] : [];
    return {
      parserId: wechatCsvParser.id,
      rows,
      headerMap,
      fileTotal,
      issues,
      notes: [WECHAT_NEUTRAL_NOTE, WECHAT_REFUND_CALIBER_NOTE],
    };
  },
  isSummaryRow(row) {
    return isSummaryCells(row.cells);
  },
};
