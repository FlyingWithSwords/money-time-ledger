import { LedgerError } from '../../domain/errors';
import type { Parser, ParseOutcome } from '../base';
import { buildRawRows, findHeaderRow, isSummaryCells, resolveHeaderMap } from './tabular';
import { readWorkbookTables } from './xlsxReader';
import {
  WECHAT_FIELD_HINTS,
  WECHAT_HEADER_MIN_HITS,
  WECHAT_HEADER_TOKENS,
  WECHAT_NEUTRAL_NOTE,
  WECHAT_REFUND_CALIBER_NOTE,
  wechatFileTotalFromLines,
} from './wechatCommon';

/**
 * 微信支付账单 XLSX。
 *
 * 微信客户端/网页版既能导 CSV 也能导 Excel，真实文件长这样（单 sheet，A1:K207）：
 *   1 标题「微信支付账单明细」→ 昵称 → 起止时间 → 导出类型 → 导出时间 → **空行**
 *   → 共189笔记录 → 收入： → 支出： → 中性交易： → 「注：」+4 条说明 → **空行**
 *   → 分隔线 → **第 18 行（0 基索引 17）才是表头**
 * 之前项目里只有 CSV 版解析器，xlsx 版账单直接没人接，会被当成「认不出的格式」。
 */
const WECHAT_MARKER = '微信支付账单明细';

function headText(rows: readonly string[][], limit = 30): string {
  return rows
    .slice(0, limit)
    .map((row) => row.join(''))
    .join('\n');
}

export const wechatXlsxParser: Parser = {
  id: 'wechat_xlsx',
  label: '微信账单 Excel',
  fieldHints: WECHAT_FIELD_HINTS,
  async canHandle(file) {
    if (!/\.(xlsx|xls)$/i.test(file.name)) return false;
    const tables = await readWorkbookTables(file, { keepBlankRows: true });
    const first = tables[0];
    if (!first) return false;
    const head = headText(first.rows);
    if (head.includes(WECHAT_MARKER)) return true;
    // 兜底：老版本导出没有标题行，但「交易单号」+「收/支」这组列名只有微信账单才有
    return head.includes('交易单号') && head.includes('收/支');
  },
  async parse(file, opts): Promise<ParseOutcome> {
    // keepBlankRows: true —— 让 issue 里的行号与用户在 Excel 里看到的行号一致
    const tables = await readWorkbookTables(file, { keepBlankRows: true });
    const rows: ParseOutcome['rows'] = [];
    const issues: ParseOutcome['issues'] = [];
    let headerMap: ParseOutcome['headerMap'] = {};
    let fileTotal: ParseOutcome['fileTotal'];

    for (const table of tables) {
      const headerRowIndex = findHeaderRow(table.rows, WECHAT_HEADER_TOKENS, WECHAT_HEADER_MIN_HITS);
      if (headerRowIndex < 0) continue;
      const built = buildRawRows(table.rows, headerRowIndex, isSummaryCells);
      rows.push(...built.rows);
      headerMap = resolveHeaderMap(built.headers, wechatXlsxParser.fieldHints, opts.headerMap);
      // 汇总区在表头之前（微信把汇总写在标题下面），所以取表头之前的所有行来抽合计
      fileTotal = wechatFileTotalFromLines(table.rows.slice(0, headerRowIndex));
      break;
    }

    if (rows.length === 0 && Object.keys(headerMap).length === 0) {
      throw new LedgerError('PARSE_FAILED', '这张表里没有找到微信账单表头（需要「交易时间 / 收/支 / 金额(元)」等列名）');
    }
    if (rows.length === 0) {
      issues.push({ row: 1, reason: '表头之后没有可解析的明细行' });
    }
    return {
      parserId: wechatXlsxParser.id,
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
