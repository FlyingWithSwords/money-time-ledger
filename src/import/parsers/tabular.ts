import Papa from 'papaparse';
import type { Cents } from '../../types';
import type { FileTotal, ImportFile, RawRow, TargetField } from '../base';
import { parseMoneyString } from '../../domain/money';
import { autoFieldMap } from '../normalize';

/**
 * 表格类账单的共用工具：编码嗅探、CSV 解析、表头定位、行对象化、尾部汇总行提取。
 * 中文账单常见 GBK（支付宝）与 UTF-8 BOM（微信），两种都要能读。
 */

export async function decodeBillText(file: ImportFile): Promise<string> {
  const buffer = await file.readArrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  try {
    // 严格 UTF-8：遇到非法字节会抛错，据此判定需要 GBK
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

export function parseCsvRows(text: string): string[][] {
  // 换行必须先归一。真实支付宝导出（2019-08~2020-07）是**混用**的：
  // 前 23 行说明区是 CRLF，明细区 800 多行是裸 LF。
  // Papa 的 newline 自动探测只看开头，会认定换行是 \r\n，于是后面所有裸 LF 都不当换行，
  // 整份明细被解析成"一条记录（9709 个单元格）"——这是支付宝账单一直导不进来的第二个病根。
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  const result = Papa.parse<string[]>(normalized, {
    skipEmptyLines: 'greedy',
    delimiter: '',
  });
  return (result.data as unknown as string[][]).map((row) =>
    (Array.isArray(row) ? row : []).map((cell) => (cell ?? '').toString().trim()),
  );
}

/**
 * 找到表头所在行：命中至少 `minHits` 个 tokens 的那一行。
 *
 * 为什么不是「全部命中」：真实账单的表头各家各版本都在变——
 * 支付宝 2020 版写「交易订单号」（不含子串「交易号」），写「金额」而不是「金额（元）」。
 * 要求全命中就等于要求表头一字不差，换一个导出年份就整份文件导不进来。
 * 5/8 命中足以把「说明行/汇总行」排除掉，又不会因为个别列改名而失效。
 */
export function findHeaderRow(rows: readonly string[][], tokens: readonly string[], minHits: number): number {
  const need = Math.max(1, Math.min(minHits, tokens.length));
  for (let i = 0; i < rows.length; i += 1) {
    const joined = (rows[i] ?? []).join('|');
    let hits = 0;
    for (const token of tokens) {
      if (joined.includes(token)) hits += 1;
      if (hits >= need) return i;
    }
  }
  return -1;
}

/** 找到表头所在行：包含**所有** required 关键词的那一行（旧调用方的严格模式）。 */
export function findHeaderRowIndex(rows: readonly string[][], required: readonly string[]): number {
  return findHeaderRow(rows, required, required.length);
}

export function cleanHeader(header: string): string {
  return header.replace(/["']/g, '').replace(/\s+/g, '').trim();
}

export interface BuildRowsResult {
  rows: RawRow[];
  headers: string[];
  headerRowIndex: number;
}

/** 把二维表转成 RawRow（cells 以原始表头为 key）。 */
export function buildRawRows(
  table: readonly string[][],
  headerRowIndex: number,
  isSummary?: (cells: Record<string, string>) => boolean,
): BuildRowsResult {
  const headers = (table[headerRowIndex] ?? []).map(cleanHeader);
  const rows: RawRow[] = [];
  for (let i = headerRowIndex + 1; i < table.length; i += 1) {
    const line = table[i] ?? [];
    if (line.every((cell) => cell === '')) continue;
    const cells: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (!header) return;
      cells[header] = (line[index] ?? '').toString().trim();
    });
    if (isSummary && isSummary(cells)) continue;
    rows.push({ rowIndex: i + 1, cells, raw: line.join(' | ') });
  }
  return { rows, headers, headerRowIndex };
}

/** 汇总行里的一段「<label>：<N>笔 <金额>元」。label 已收敛成 4 种语义。 */
type TotalLabel = 'income' | 'expense' | 'neutral';

const TOTAL_LINE_RE =
  /^(?:已)?(收入|支出|不计收支|中性交易)\s*[:：]?\s*(?:(\d+)\s*笔)?\s*([\d,]+(?:\.\d+)?)\s*元?/;

function labelOf(text: string): TotalLabel {
  if (text === '收入') return 'income';
  if (text === '支出') return 'expense';
  return 'neutral';
}

/**
 * 从账单汇总区提取声明合计。
 * 微信：`支出：120笔 19516.07元` / `中性交易：24笔 24317.89元`；
 * 支付宝：`支出：289笔 6881.93元` / `不计收支：465笔 12184.05元`；旧表：`已支出: 1234.00元`。
 *
 * 关键：`289笔 6881.93元` 这种形态必须先吃掉「N笔」，否则会把笔数当金额
 * （旧实现 `/支出[:：]?([\d,.]+)/` 抓到的是 289 → 289.00 元，凭空多出一笔巨额支出）。
 */
export function extractFileTotal(text: string): FileTotal | undefined {
  const lines = text.split(/\r?\n/);
  let expense: number | undefined;
  let income: number | undefined;
  let neutral: number | undefined;
  let count: number | undefined;
  let expenseCount: number | undefined;
  let incomeCount: number | undefined;
  let neutralCount: number | undefined;

  for (const rawLine of lines) {
    const line = rawLine.replace(/^[",\s]+|[",\s]+$/g, '');
    if (line === '') continue;

    const totalMatch = TOTAL_LINE_RE.exec(line);
    if (totalMatch) {
      const cents = parseMoneyString(totalMatch[3]);
      const countValue = totalMatch[2] === undefined ? undefined : Number(totalMatch[2]);
      if (cents !== null) {
        const amount = Math.abs(cents);
        const label = labelOf(totalMatch[1]);
        if (label === 'expense') {
          expense = amount;
          expenseCount = countValue;
        } else if (label === 'income') {
          income = amount;
          incomeCount = countValue;
        } else {
          neutral = amount;
          neutralCount = countValue;
        }
      }
    }

    const countMatch = /共\s*(\d+)\s*笔/.exec(line);
    if (countMatch) count = Number(countMatch[1]);
  }

  const nothing =
    expense === undefined && income === undefined && neutral === undefined && count === undefined;
  if (nothing) return undefined;
  return {
    expense: expense as Cents | undefined,
    income: income as Cents | undefined,
    neutral: neutral as Cents | undefined,
    count,
    expenseCount,
    incomeCount,
    neutralCount,
  };
}

/** 汇总/说明行（"共 N 笔""合计""收入：20.00元"等）不得进入明细。 */
export function isSummaryCells(cells: Record<string, string>): boolean {
  const values = Object.values(cells);
  const joined = values.join('');
  if (/^[-\s]*$/.test(joined)) return true;
  if (/共\s*\d+\s*笔/.test(joined)) return true;
  if (/^(?:已)?(?:收入|支出|中性交易)\s*[:：]?\s*[\d,.]+/.test(joined.trim())) return true;
  if (values.filter((value) => value !== '').length === 1 && /^[-—\s]+$/.test(values.find((v) => v !== '') ?? '')) {
    return true;
  }
  return values.some((value) => /^(小计|合计|总计|汇总|月合计|本月合计)/.test(value));
}

export function resolveHeaderMap(
  headers: readonly string[],
  hints: Partial<Record<TargetField, string>>,
  override?: Partial<Record<TargetField, string>>,
): Partial<Record<TargetField, string>> {
  const auto = autoFieldMap(headers, hints);
  return { ...auto, ...(override ?? {}) };
}
