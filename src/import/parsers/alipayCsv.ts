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

/**
 * 支付宝账单 CSV（GB18030/GBK 编码，需 TextDecoder('gbk')）。
 *
 * 真实导出文件（2019-08-01~2020-07-31，808 笔）的结构：
 *   1 行分隔线 → 导出信息 6 行 → 「共808笔记录」→ 收入/支出/不计收支 三行
 *   → 空行 → 「特别提示」+ 8 条注意事项 → 空行 → 分隔线
 *   → **第 24 行（0 基索引 23）才是表头**
 * 所以表头定位必须容忍前 23 行的噪音，且不能要求「交易号」这种阿里改过的列名。
 */

/** 表头特征词。命中 5 个即认（8 选 5），个别列改名不影响整份文件。 */
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

export const alipayCsvParser: Parser = {
  id: 'alipay_csv',
  label: '支付宝账单 CSV',
  // 全部用**真实列名**（2020 版导出格式），别再用「交易创建时间」「金额（元）」这种旧名
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
    if (!/\.csv$/i.test(file.name)) return false;
    const text = await decodeBillText(file);
    const head = text.slice(0, 4000);
    return head.includes('支付宝') && (head.includes('交易订单号') || head.includes('交易号') || head.includes('交易对方'));
  },
  async parse(file, opts): Promise<ParseOutcome> {
    const text = await decodeBillText(file);
    const table = parseCsvRows(text);
    const headerRowIndex = findHeaderRow(table, ALIPAY_HEADER_TOKENS, ALIPAY_HEADER_MIN_HITS);
    if (headerRowIndex < 0) {
      throw new LedgerError(
        'PARSE_FAILED',
        '没有找到支付宝账单表头（需要至少命中「交易时间 / 交易对方 / 收/支 / 金额 / 交易订单号」中的 5 个列名）',
      );
    }
    const { rows, headers } = buildRawRows(table, headerRowIndex, isSummaryCells);
    const headerMap = resolveHeaderMap(headers, alipayCsvParser.fieldHints, opts.headerMap);
    const fileTotal = extractFileTotal(text);
    const issues = rows.length === 0 ? [{ row: headerRowIndex + 1, reason: '表头之后没有可解析的明细行' }] : [];
    // info 级说明，不是错误：支付宝自己的汇总行口径就不一致（笔数含已关闭，金额不含），
    // 明细合计与金额能对上，笔数对不上属正常，不要报成对账失败
    const notes = [
      '支付宝汇总行的口径：笔数含「交易关闭」的行，金额不含；对账以金额为准，笔数差不算对账失败',
    ];
    return { parserId: alipayCsvParser.id, rows, headerMap, fileTotal, issues, notes };
  },
  isSummaryRow(row) {
    return isSummaryCells(row.cells);
  },
};
