import { LedgerError } from '../../domain/errors';
import type { Cents } from '../../types';
import type { FileTotal, MonthlyFileTotal, ParseIssue, ParseOutcome, Parser, RawRow, TargetField } from '../base';
import { buildLocalIso, parseLooseDateTime } from '../../domain/date';
import { asCents, centsToYuan, parseMoneyString } from '../../domain/money';
import { readWorkbookTables, type SheetTable } from './xlsxReader';

/**
 * 旧表格迁移（3 表 / 412 行）——把"手填的 Excel"还原成真实日期。
 *
 * 还原规则（02-arch.md §4）：
 * 1. 按「月份分隔行」（`8月` / `8月份`）切段；**分隔行同时携带小计金额是常态**
 *    （`['1月','','','','119.97','1244.06']`），所以判定只认日期列，不看"非空单元格个数"；
 * 2. 段内无年份日期用段内月份推断；
 * 3. 月份由大变小时 `year += 1`（12月 → 1月即跨年）；
 * 4. 同日多笔空白日期向下填充；
 * 5. 只读计算结果值（`cellFormula:false`，在 xlsxReader 里）；
 * 6. 汇总行（小计/合计/总计）跳过，**绝不入库**；
 * 7. 汇总**表**（收支统计）整表跳过，只从里面读年支出/年收入用于对账。
 */

interface LegacyLayout {
  headerRowIndex: number;
  dateCol: number;
  amountCol: number;
  /** 金额列本身就是收入列（如「基础收入/元」）→ 该表方向默认收入 */
  amountIsIncome: boolean;
  /** 月小计列：只出现在月份分隔行上，用作对账基准，**绝不入库** */
  subtotalCol?: number;
  /** 独立的「收/支」「借贷标志」列：逐行决定方向，缺了它收支混排表会把工资记成支出 */
  directionCol?: number;
  itemCol?: number;
  noteCol?: number;
  accountCol?: number;
}

export interface LegacyParseOptions {
  /** 无年份数据的起始年份；默认当前年 */
  defaultYear: number;
}

/** 一张表里某个月的小计（来自月份分隔行） */
export interface MonthSubtotal {
  month: number;
  cents: Cents;
}

const HEADER_SCAN_LIMIT = 25;

const DATE_COL_RE = /日期|时间|消费日/;
const AMOUNT_COL_RE = /金额|花费/;
/** 「基础收入/元」「结算收入/元」「收入金额/元」——收入表把金额写在列名里 */
const INCOME_COL_RE = /收入/;
/** 合计/小计/累计列是汇总，永远不当金额列（旧表就在明细旁边摆了"月消费总计"） */
const SUMMARY_COL_RE = /总计|小计|合计|汇总|累计/;
const ITEM_COL_RE = /项目|内容|用途|名称|品名|事项/;
const NOTE_COL_RE = /备注|说明/;
const ACCOUNT_COL_RE = /账户|支付方式|渠道/;
/** 独立方向列的列名（归一化后比较：「收/支」「收入/支出」「借贷标志」「交易类型」…） */
const DIRECTION_COL_RE = /^(?:收\/支|收支|收入\/支出|资金方向|借贷标志|收支类型|交易类型|类型)$/;

/** 列名归一化：去掉单位、括号、空白与标点，便于关键词比较 */
function normalizeHeader(text: string): string {
  return text
    .replace(/[（(]?(?:元|人民币)[）)]?/g, '')
    .replace(/[\s　]/g, '')
    .replace(/[：:]/g, '')
    .trim();
}

/**
 * 把「收/支」列的一个值映射成方向。
 * 认不出时返回 null —— 调用方必须提示用户，不许静默按默认值处理。
 */
export function mapDirectionText(text: string): 'income' | 'expense' | 'refund' | 'transfer' | null {
  const value = text.trim();
  if (value === '') return null;
  if (/退款|退货|冲正/.test(value)) return 'refund';
  if (/不计收支/.test(value)) return 'transfer';
  if (/收入|收款|入账|进账|贷方|转入|^收$|^入$/.test(value)) return 'income';
  if (/支出|付款|消费|出账|借方|转出|扣款|^支$|^出$/.test(value)) return 'expense';
  return null;
}

const DIRECTION_LABEL: Record<'income' | 'expense' | 'refund' | 'transfer', string> = {
  income: '收入',
  expense: '支出',
  refund: '退款',
  transfer: '不计收支',
};

/**
 * 月份分隔行：日期列整格就是一个月份（可带"份/明细/账单"等后缀）。
 * 只看日期列 —— 分隔行右侧那两列小计（三餐小计 / 月消费小计、结算收入）不参与判定。
 */
const MONTH_SEPARATOR_RE = /^(\d{1,2})\s*月(?:份)?\s*(?:明细|账单|支出|消费|收入|合计|总计)?$/;

/** 一张表里出现 ≥2 个这种列名，就认为它是「汇总表」而不是明细表 */
const SUMMARY_TABLE_MARKERS = [/年支出/, /年收入/, /月支出/, /月收入/, /累计收入/, /累计支出/, /累计利润/];

/** 合计列：允许「年支出 / 支出合计 / 累计支出 / 总支出」，但**排除**「月支出」（那是逐月明细） */
const EXPENSE_TOTAL_RE = /^(?:年|年度|年度总|累计|总)?支出(?:合计|总额|总计|累计)?$/;
const INCOME_TOTAL_RE = /^(?:年|年度|年度总|累计|总)?收入(?:合计|总额|总计|累计)?$/;

/** 日期列必须"自证身份"：至少 2 格长得像日期，兜底布局才不会抓错列 */
const DATE_LIKE_RE = /^(\d{1,2}\s*[日月号])|(\d{4}[-/.]\d{1,2})|(\d{1,2}[-/.]\d{1,2})/;

/** 方向列必须"自证身份"：下方至少有一格写得像收入/支出，否则「类型」可能只是分类名 */
function looksLikeDirectionColumn(rows: readonly string[][], headerIndex: number, col: number): boolean {
  const limit = Math.min(rows.length, headerIndex + 31);
  for (let r = headerIndex + 1; r < limit; r += 1) {
    if (mapDirectionText((rows[r] ?? [])[col] ?? '') !== null) return true;
  }
  return false;
}

export function detectLayout(rows: readonly string[][]): LegacyLayout | null {
  const limit = Math.min(rows.length, HEADER_SCAN_LIMIT);
  for (let i = 0; i < limit; i += 1) {
    const cells = rows[i] ?? [];
    const dateCol = cells.findIndex((cell) => DATE_COL_RE.test(cell));
    if (dateCol < 0) continue;

    // ① 优先找「支出金额」列：含"金额/花费"，且不是合计列、不是收入列
    let amountCol = cells.findIndex(
      (cell) => AMOUNT_COL_RE.test(cell) && !SUMMARY_COL_RE.test(cell) && !INCOME_COL_RE.test(cell),
    );
    let amountIsIncome = false;
    // ② 没有"金额"字样时，找第一个非合计的收入列（「基础收入/元」）
    if (amountCol < 0) {
      amountCol = cells.findIndex((cell) => INCOME_COL_RE.test(cell) && !SUMMARY_COL_RE.test(cell));
      amountIsIncome = amountCol >= 0;
    }
    if (amountCol < 0) continue;

    const itemCol = cells.findIndex((cell) => ITEM_COL_RE.test(cell));
    const noteCol = cells.findIndex((cell) => NOTE_COL_RE.test(cell));
    const accountCol = cells.findIndex((cell) => ACCOUNT_COL_RE.test(cell));
    // 独立方向列：列名归一化后形如「收/支」「借贷标志」，且下方确实写着收入/支出
    const rawDirectionCol = cells.findIndex((cell) => DIRECTION_COL_RE.test(normalizeHeader(cell)));
    const directionCol =
      rawDirectionCol >= 0 &&
      rawDirectionCol !== dateCol &&
      rawDirectionCol !== amountCol &&
      looksLikeDirectionColumn(rows, i, rawDirectionCol)
        ? rawDirectionCol
        : undefined;
    // 月小计列：除日期列/金额列外，列名像「合计」或「收入」的列。
    // 取**最后一个**——旧表同时有「三餐月消费总计」和「月消费总计」时，后者才是当月合计。
    let subtotalCol: number | undefined;
    for (let col = cells.length - 1; col >= 0; col -= 1) {
      if (col === dateCol || col === amountCol || col === directionCol) continue;
      const header = cells[col] ?? '';
      if (SUMMARY_COL_RE.test(header) || INCOME_COL_RE.test(header)) {
        subtotalCol = col;
        break;
      }
    }
    return {
      headerRowIndex: i,
      dateCol,
      amountCol,
      amountIsIncome,
      subtotalCol,
      directionCol,
      itemCol: itemCol >= 0 && itemCol !== amountCol && itemCol !== dateCol ? itemCol : undefined,
      noteCol: noteCol >= 0 && noteCol !== itemCol && noteCol !== amountCol ? noteCol : undefined,
      accountCol: accountCol >= 0 && accountCol !== amountCol ? accountCol : undefined,
    };
  }
  return null;
}

/** 日期列在抽样里是否真的长得像日期（兜底布局的准入门槛）。 */
function looksLikeDateColumn(rows: readonly string[][], col: number): boolean {
  let hits = 0;
  for (const row of rows.slice(0, 60)) {
    const cell = (row[col] ?? '').trim();
    if (cell === '') continue;
    if (DATE_LIKE_RE.test(cell)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

/** 没有表头时按"第一列是日期、最像金额的列是金额"兜底；日期列不合格就整表放弃。 */
function fallbackLayout(rows: readonly string[][]): LegacyLayout | null {
  const sample = rows.slice(0, 60);
  if (!looksLikeDateColumn(sample, 0)) return null;
  const width = Math.max(...sample.map((row) => row.length), 1);
  let bestCol = 1;
  let bestScore = -1;
  for (let col = 1; col < width; col += 1) {
    let score = 0;
    for (const row of sample) {
      const value = row[col] ?? '';
      if (/^-?\d+(?:\.\d{1,2})?$/.test(value)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCol = col;
    }
  }
  if (bestScore <= 0) return null;
  return { headerRowIndex: -1, dateCol: 0, amountCol: bestCol, amountIsIncome: false };
}

/**
 * 月份分隔行判定。只用日期列，不看其他列有没有金额 ——
 * 真实旧表的分隔行是 `['1月','','','','119.97','1244.06']`（月份 + 三餐小计 + 月小计），
 * 旧实现"非空 > 2 就否决"直接把 10/11/12 月连同全部明细丢光。
 */
export function detectMonthSeparator(cells: readonly string[], dateCol = 0): number | null {
  const cell = (cells[dateCol] ?? '').trim();
  if (cell === '') return null;
  const matched = MONTH_SEPARATOR_RE.exec(cell);
  if (!matched) return null;
  const month = Number(matched[1]);
  return month >= 1 && month <= 12 ? month : null;
}

export function isSummaryCells(cells: readonly string[]): boolean {
  const nonEmpty = cells.filter((cell) => cell.trim() !== '');
  if (nonEmpty.length === 0) return false;
  return nonEmpty.some((cell) => /小计|合计|总计|汇总/.test(cell));
}

/** 汇总表（收支统计）：整表不入明细，只贡献 fileTotal。 */
export function isSummaryTable(rows: readonly string[][]): boolean {
  const limit = Math.min(rows.length, 5);
  for (let i = 0; i < limit; i += 1) {
    const cells = rows[i] ?? [];
    const hits = SUMMARY_TABLE_MARKERS.filter((re) => cells.some((cell) => re.test(cell))).length;
    if (hits >= 2) return true;
  }
  return false;
}

/** 从汇总表里读「年支出 / 年收入」这类表内合计，供对账用。 */
export function detectTableTotals(rows: readonly string[][]): FileTotal {
  const limit = Math.min(rows.length, 10);
  for (let i = 0; i < limit; i += 1) {
    const cells = rows[i] ?? [];
    const expenseCol = cells.findIndex((cell) => EXPENSE_TOTAL_RE.test(cell.trim()));
    const incomeCol = cells.findIndex((cell) => INCOME_TOTAL_RE.test(cell.trim()));
    if (expenseCol < 0 && incomeCol < 0) continue;
    const pick = (col: number): Cents | undefined => {
      if (col < 0) return undefined;
      // 取**最后一个**非零值：累计式汇总表（每月都填、末行才是全年）用"第一个"
      // 会拿到 1 月的数字，对账立刻报出巨额假差异。年度合计总在最后。
      let found: Cents | undefined;
      for (let r = i + 1; r < rows.length; r += 1) {
        const value = parseMoneyString((rows[r] ?? [])[col] ?? '');
        if (value !== null && value !== 0) found = asCents(Math.abs(value));
      }
      return found;
    };
    const totals: FileTotal = {};
    const expense = pick(expenseCol);
    const income = pick(incomeCol);
    if (expense !== undefined) totals.expense = expense;
    if (income !== undefined) totals.income = income;
    if (expense !== undefined || income !== undefined) return totals;
  }
  return {};
}

export const LEGACY_HEADER_MAP: Partial<Record<TargetField, string>> = {
  occurred_at: '日期',
  amount: '金额',
  direction: '收支',
  counterparty: '项目',
  note: '备注',
  channel: '账户',
};

/** 纯函数：把工作表矩阵还原成 RawRow。单测直接调用这里，不碰 xlsx。 */
export function parseLegacySheet(
  table: SheetTable,
  opts: LegacyParseOptions,
): { rows: RawRow[]; issues: ParseIssue[]; notes: string[]; monthSubtotals: MonthSubtotal[] } {
  const rows = table.rows;
  const layout = detectLayout(rows) ?? fallbackLayout(rows);
  if (!layout) {
    return {
      rows: [],
      issues: [{ row: 0, reason: `「${table.name}」认不出日期列与金额列，整表已跳过`, raw: table.name }],
      notes: [],
      monthSubtotals: [],
    };
  }
  const sheetYearMatch = /(20\d{2})/.exec(table.name);
  let year = sheetYearMatch ? Number(sheetYearMatch[1]) : opts.defaultYear;
  let currentMonth: number | undefined;
  let lastDateText: string | null = null;

  const out: RawRow[] = [];
  const issues: ParseIssue[] = [];
  const notes: string[] = [];
  const monthSubtotals: MonthSubtotal[] = [];

  for (let r = Math.max(layout.headerRowIndex + 1, 0); r < rows.length; r += 1) {
    const cells = rows[r] ?? [];
    if (cells.every((cell) => cell.trim() === '')) continue;

    const month = detectMonthSeparator(cells, layout.dateCol);
    if (month !== null) {
      // 月份由大变小时跨年（12月 → 1月）
      if (currentMonth !== undefined && month < currentMonth) year += 1;
      currentMonth = month;
      lastDateText = null;
      // 分隔行右侧的小计只用于对账基准，不入库（下一行 continue 就是这条线）
      if (layout.subtotalCol !== undefined) {
        const subtotal = parseMoneyString(cells[layout.subtotalCol] ?? '');
        if (subtotal !== null) monthSubtotals.push({ month, cents: asCents(Math.abs(subtotal)) });
      }
      // 分隔行却在金额列上有值 → 可能是"日期写成整月"的真实交易，绝不静默吞掉
      const sepAmount = parseMoneyString(cells[layout.amountCol] ?? '');
      if (sepAmount !== null && sepAmount !== 0) {
        notes.push(
          `第 ${r + 1} 行被识别为 ${month} 月的月份分隔行，该行金额 ${centsToYuan(Math.abs(sepAmount))} 元未入库，请确认这是一笔交易还是小计`,
        );
      }
      continue;
    }

    if (isSummaryCells(cells)) {
      issues.push({ row: r + 1, reason: '汇总行已跳过（汇总只计算不存储）', raw: cells.join(' | ') });
      continue;
    }

    const dateText = (cells[layout.dateCol] ?? '').trim();
    const rawAmount = (cells[layout.amountCol] ?? '').trim();

    let dateForRow = dateText;
    if (dateForRow === '') {
      if (!lastDateText) {
        issues.push({ row: r + 1, reason: '日期为空且上文无可填充的日期', raw: cells.join(' | ') });
        continue;
      }
      dateForRow = lastDateText;
    } else {
      lastDateText = dateText;
    }

    const parsedAmount = parseMoneyString(rawAmount);
    let direction = layout.amountIsIncome ? '收入' : '支出';
    if (layout.directionCol !== undefined) {
      // 收支混排表靠这一列定方向；认不出来必须提示，不许静默按默认值记成支出
      const directionText = (cells[layout.directionCol] ?? '').trim();
      const mapped = mapDirectionText(directionText);
      if (mapped !== null) {
        direction = DIRECTION_LABEL[mapped];
      } else if (directionText === '') {
        notes.push(`第 ${r + 1} 行「收/支」列为空，已按整表默认「${direction}」处理，请核对`);
      } else {
        notes.push(
          `第 ${r + 1} 行「收/支」列写着「${directionText}」，无法判定收支方向，已按整表默认「${direction}」处理，请核对`,
        );
      }
    }
    if (parsedAmount === null) {
      issues.push({ row: r + 1, reason: `金额无法解析："${rawAmount}"`, raw: cells.join(' | ') });
      continue;
    }
    let amountValue: Cents = parsedAmount;
    if (parsedAmount < 0) {
      // 旧表用公式 −12.49 表达退款：还原成独立方向，不写负数
      amountValue = Math.abs(parsedAmount) as Cents;
      direction = '退款';
    }
    if (!currentMonth) {
      const parsedEarlier = parseLooseDateTime(dateForRow, { fallbackYear: year });
      const monthFromDate = parsedEarlier ? Number(parsedEarlier.date.slice(5, 7)) : undefined;
      if (monthFromDate) currentMonth = monthFromDate;
    }
    const parsed = parseLooseDateTime(dateForRow, { fallbackYear: year, fallbackMonth: currentMonth });
    if (!parsed) {
      issues.push({ row: r + 1, reason: `日期无法解析："${dateForRow}"`, raw: cells.join(' | ') });
      continue;
    }

    const cellsOut: Record<string, string> = {
      日期: parsed.date,
      金额: centsToYuan(amountValue),
      收支: direction,
    };
    if (layout.itemCol !== undefined) cellsOut['项目'] = cells[layout.itemCol] ?? '';
    if (layout.noteCol !== undefined) cellsOut['备注'] = cells[layout.noteCol] ?? '';
    if (layout.accountCol !== undefined) cellsOut['账户'] = cells[layout.accountCol] ?? '';

    out.push({
      rowIndex: r + 1,
      cells: cellsOut,
      raw: `${table.name} · ${cells.join(' | ')}`,
    });
  }

  return { rows: out, issues, notes, monthSubtotals };
}

function mergeTotals(base: FileTotal | undefined, next: FileTotal): FileTotal | undefined {
  if (next.expense === undefined && next.income === undefined) return base;
  const merged: FileTotal = { ...(base ?? {}) };
  if (merged.expense === undefined && next.expense !== undefined) merged.expense = next.expense;
  if (merged.income === undefined && next.income !== undefined) merged.income = next.income;
  return merged;
}

/**
 * 汇总表里的逐月数字（收支统计的 `年份` + `月份` + `月支出` + `月收入`）。
 * 用来把年度差异**定位到具体月份**——PRD S1 那个「手工核 40 分钟才发现 4 月差 120 元」的场景。
 * 年份列是合并单元格风格（只有首行写 2023），所以向下沿用上一次见到的年份。
 */
export function detectTableMonthly(rows: readonly string[][]): MonthlyFileTotal[] {
  const limit = Math.min(rows.length, 10);
  for (let i = 0; i < limit; i += 1) {
    const cells = rows[i] ?? [];
    const yearCol = cells.findIndex((cell) => /^年份?$/.test(cell.trim()));
    const monthCol = cells.findIndex((cell) => /^月份?$/.test(cell.trim()));
    const expenseCol = cells.findIndex((cell) => /^月支出$/.test(cell.trim()));
    const incomeCol = cells.findIndex((cell) => /^月收入$/.test(cell.trim()));
    if (monthCol < 0 || (expenseCol < 0 && incomeCol < 0)) continue;
    const out: MonthlyFileTotal[] = [];
    let year = new Date().getFullYear();
    for (let r = i + 1; r < rows.length; r += 1) {
      const line = rows[r] ?? [];
      if (yearCol >= 0) {
        const yearText = Number((line[yearCol] ?? '').trim());
        if (Number.isInteger(yearText) && yearText > 1900 && yearText < 3000) year = yearText;
      }
      const month = Number((line[monthCol] ?? '').trim());
      if (!Number.isInteger(month) || month < 1 || month > 12) continue;
      const expense = expenseCol >= 0 ? parseMoneyString(line[expenseCol] ?? '') : null;
      const income = incomeCol >= 0 ? parseMoneyString(line[incomeCol] ?? '') : null;
      const item: MonthlyFileTotal = { month_key: `${year}-${String(month).padStart(2, '0')}` };
      if (expense !== null) item.expense = asCents(Math.abs(expense));
      if (income !== null) item.income = asCents(Math.abs(income));
      out.push(item);
    }
    if (out.length > 0) return out;
  }
  return [];
}

export function parseLegacyTables(tables: readonly SheetTable[], opts: LegacyParseOptions): ParseOutcome {
  const rows: RawRow[] = [];
  const issues: ParseIssue[] = [];
  const notes: string[] = [];
  let fileTotal: FileTotal | undefined;
  /** 明细表分隔行上的月小计：支出侧取「月消费总计」列，收入侧取「结算收入」列 */
  const sheetMonthly: { expense: MonthSubtotal[]; income: MonthSubtotal[] } = { expense: [], income: [] };
  const tableMonthly: MonthlyFileTotal[] = [];

  for (const table of tables) {
    // 汇总表整表跳过：它既不是明细，也绝不能被当作明细遍历（否则年月汇总会被写成交易）
    if (isSummaryTable(table.rows)) {
      fileTotal = mergeTotals(fileTotal, detectTableTotals(table.rows));
      tableMonthly.push(...detectTableMonthly(table.rows));
      notes.push(`「${table.name}」是汇总表：只取表内合计用于对账，明细不入库`);
      continue;
    }
    const result = parseLegacySheet(table, opts);
    rows.push(...result.rows);
    issues.push(...result.issues.map((issue) => ({ ...issue, raw: issue.raw ? `${table.name} · ${issue.raw}` : table.name })));
    notes.push(...result.notes.map((note) => `${table.name} · ${note}`));
    const bucket = result.rows.some((row) => row.cells['收支'] === '收入') ? sheetMonthly.income : sheetMonthly.expense;
    bucket.push(...result.monthSubtotals);
  }

  // 年度差异 → 落到具体月份，让用户知道"差在哪个月"（真实旧表是 4 月差 120 元）
  for (const month of tableMonthly) {
    if (month.expense === undefined) continue;
    const monthNumber = Number(month.month_key.slice(5, 7));
    const local = sheetMonthly.expense.find((item) => item.month === monthNumber);
    if (local && month.expense !== local.cents) {
      const delta = month.expense - local.cents;
      notes.push(
        `支出 ${monthNumber} 月：表内合计 ${centsToYuan(month.expense)}，明细小计 ${centsToYuan(local.cents)}，差 ${centsToYuan(Math.abs(delta))}`,
      );
    }
  }

  if (rows.length === 0) {
    issues.push({ row: 0, reason: '所有工作表都没有解析出明细行：请确认表格里有「日期」与「金额」两列' });
  }

  // 逐月合计挂到 fileTotal 上，供 locateDiff 做月级定位（单笔金额匹配只是兜底）
  const totalWithMonthly: FileTotal | undefined =
    fileTotal || tableMonthly.length > 0
      ? { ...(fileTotal ?? {}), ...(tableMonthly.length > 0 ? { monthly: tableMonthly } : {}) }
      : undefined;

  const outcome: ParseOutcome = {
    parserId: 'legacy_xlsx',
    rows,
    headerMap: { ...LEGACY_HEADER_MAP },
    issues,
  };
  if (totalWithMonthly) outcome.fileTotal = totalWithMonthly;
  if (notes.length > 0) outcome.notes = notes;
  return outcome;
}

export const legacyXlsxParser: Parser = {
  id: 'legacy_xlsx',
  label: '旧表格（Excel 3 表迁移）',
  fieldHints: { ...LEGACY_HEADER_MAP },
  async canHandle(file) {
    return /\.(xlsx|xls)$/i.test(file.name);
  },
  async parse(file, opts): Promise<ParseOutcome> {
    const tables = await readWorkbookTables(file);
    if (tables.length === 0) {
      throw new LedgerError('PARSE_FAILED', '这个 Excel 里没有可读的工作表');
    }
    return parseLegacyTables(tables, { defaultYear: opts.defaultYear ?? new Date().getFullYear() });
  },
  isSummaryRow(row) {
    return isSummaryCells(Object.values(row.cells));
  },
};

/** 供 UI 预览用：把日期 + 时间拼成最终 occurred_at（与 normalize 保持一致）。 */
export function legacyDateToIso(date: string, time = '00:00'): string {
  return buildLocalIso(date, time);
}
