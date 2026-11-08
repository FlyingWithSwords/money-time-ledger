import type { Cents, Direction } from '../types';
import { asCents, centsToYuan } from '../domain/money';
import type { MonthlyFileTotal } from './base';

/**
 * 对账（02-arch.md §3.2）。明细合计 vs 文件声明合计，差一分即报告并尝试定位。
 * 文件合计优先取账单尾部汇总行，其次取用户输入，都没有 → reconciled = false（无法对账）。
 */

export interface ReconcileRow {
  amount_cents: Cents;
  direction: Direction;
  occurred_date: string;
  rowIndex?: number;
  /**
   * 已改判 transfer、但**文件里算在支出侧**的行（买基金/理财的本金）。
   *
   * 它不进 `sumExpense`（账本里确实不算支出），但对账必须把它加回去，
   * 否则每一份含基金买入的账单都会显示「差 N 元」，看起来像解析漏单。
   * 与 refundOnExpense 是同一个套路：口径差，不是丢数据。
   */
  excluded?: boolean;
  /**
   * 已改判成收入、但**文件里算在中性侧**（收/支 = `/` 或「不计收支」）的行。
   *
   * 工资、补贴从银行卡转到微信/支付宝时就是这样：账本里它是实打实的收入，
   * 但文件合计的收入侧不含它。不在这里扣掉，每份含工资转账的账单都会显示
   * 「收入多出 N 元」——用户会以为解析多记了，实际是口径差。
   */
  excluded_income?: boolean;
}

export interface ReconcileInput {
  fileExpense?: Cents;
  fileIncome?: Cents;
  /**
   * 退款冲正原本记在支出侧 / 收入侧的金额。
   * 文件的收入/支出合计大多按**发生额**统计（含随后被退款的行），而本账把退款单列为 refund、
   * 两边都不计；不比毛额的话，每一份带退款的账单都会永远差一笔退款金额
   * （看起来像解析漏单，实际是口径差）。
   * 不传 = 0 —— 旧调用方（旧 Excel、手工输入）行为完全不变。
   */
  refundOnExpense?: Cents;
  refundOnIncome?: Cents;
  rows: readonly ReconcileRow[];
}

export interface ReconcileResult {
  sumExpense: Cents;
  sumIncome: Cents;
  sumRefund: Cents;
  /** 文件合计 − 明细合计；无法对账为 null */
  diffExpense: Cents | null;
  diffIncome: Cents | null;
  /** 两项都为 0（或未提供）才算对平 */
  reconciled: boolean;
  /** 是否真的拿到了可对比的文件合计 */
  comparable: boolean;
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  let sumExpense = 0;
  let sumIncome = 0;
  let sumRefund = 0;
  /** 被排除出支出、但仍属文件支出侧的金额（投资本金） */
  let excludedExpense = 0;
  /** 账本算收入、但文件合计的收入侧不含的金额（工资/补贴改判） */
  let incomeOffFile = 0;
  for (const row of input.rows) {
    // 排除行的方向已被改判成 transfer：既不进支出也不进收入，只在对账时按文件口径加回
    if (row.excluded) {
      excludedExpense += row.amount_cents;
      continue;
    }
    if (row.direction === 'expense') sumExpense += row.amount_cents;
    else if (row.direction === 'income') {
      sumIncome += row.amount_cents;
      // 工资改判的行仍进 sumIncome（账本口径它确实是收入），但要比文件合计少算一份
      if (row.excluded_income) incomeOffFile += row.amount_cents;
    } else if (row.direction === 'refund') sumRefund += row.amount_cents;
  }
  // 毛额口径：文件合计含已退款的行与被排除的投资本金，都按原侧加回去才与明细可比
  const grossExpense = sumExpense + (input.refundOnExpense ?? 0) + excludedExpense;
  const grossIncome = sumIncome - incomeOffFile + (input.refundOnIncome ?? 0);
  const diffExpense = input.fileExpense !== undefined ? asCents(input.fileExpense - grossExpense) : null;
  const diffIncome = input.fileIncome !== undefined ? asCents(input.fileIncome - grossIncome) : null;
  const comparable = diffExpense !== null || diffIncome !== null;
  // 没有可比对的合计时不能算"对平"——那是「无法对账」，必须让用户看见
  const reconciled = comparable && (diffExpense ?? 0) === 0 && (diffIncome ?? 0) === 0;
  return {
    sumExpense: asCents(sumExpense),
    sumIncome: asCents(sumIncome),
    sumRefund: asCents(sumRefund),
    diffExpense,
    diffIncome,
    reconciled,
    comparable,
  };
}

/** 差异定位的粒度：月级 → 单笔 → 定位不到 */
export type DiffScope = 'none' | 'month' | 'row';

export interface MonthDiff {
  /** '2023-04' */
  month_key: string;
  fileCents: Cents;
  detailCents: Cents;
  /** 表内 − 明细 */
  delta: Cents;
}

export interface UnmatchedHint {
  /** 差异金额（文件 − 明细） */
  diff: Cents;
  /** 可能的未匹配行（仅 scope === 'row' 时非空） */
  candidates: ReconcileRow[];
  message: string;
  scope: DiffScope;
  /** 逐月差异（仅 scope === 'month' 时非空） */
  months: MonthDiff[];
}

export interface LocateDiffOptions {
  /** 表内逐月合计。给了就**优先按月定位**——合计差异通常是某个月填错，未必是某笔漏掉 */
  fileMonthly?: readonly MonthlyFileTotal[];
}

function detailExpenseByMonth(rows: readonly ReconcileRow[]): Map<string, Cents> {
  const map = new Map<string, Cents>();
  for (const row of rows) {
    // 月级比对的口径是「文件里这个月记了多少支出」，所以排除行也要算进来
    if (row.direction !== 'expense' && !row.excluded) continue;
    const key = row.occurred_date.slice(0, 7);
    map.set(key, asCents((map.get(key) ?? 0) + row.amount_cents));
  }
  return map;
}

function monthLabel(monthKey: string): string {
  const month = Number(monthKey.slice(5, 7));
  return Number.isInteger(month) && month >= 1 && month <= 12 ? `${month} 月（${monthKey}）` : monthKey;
}

/**
 * 差异定位（分层）：
 * 1. **月级优先**：有逐月表内合计时先按月比对。命中月级差异就只报月级结论，
 *    不再去猜"哪一笔"——否则会撞上金额恰好相同的无关行，给出"文件多 1 笔 120.00 于 1 月 4 日"
 *    这种比不诊断更坏的误导（真实原因是 4 月合计填错 120 元）。
 * 2. **单笔兜底**：月级全对或没有逐月数据才按金额匹配，且措辞必须是"疑似"，不得断言漏单。
 */
export function locateDiff(
  rows: readonly ReconcileRow[],
  diff: Cents,
  options: LocateDiffOptions = {},
): UnmatchedHint {
  if (diff === 0) {
    return { diff: asCents(0), candidates: [], message: '对平', scope: 'none', months: [] };
  }

  // ① 月级比对
  const byMonth = detailExpenseByMonth(rows);
  const months: MonthDiff[] = [];
  for (const item of options.fileMonthly ?? []) {
    if (item.expense === undefined) continue;
    const detailCents = byMonth.get(item.month_key) ?? asCents(0);
    const delta = asCents(item.expense - detailCents);
    if (delta !== 0) {
      months.push({ month_key: item.month_key, fileCents: item.expense, detailCents, delta });
    }
  }
  if (months.length > 0) {
    const head = months
      .slice(0, 3)
      .map(
        (month) =>
          `${monthLabel(month.month_key)}表内 ${centsToYuan(month.fileCents)}、明细 ${centsToYuan(month.detailCents)}，差 ${centsToYuan(Math.abs(month.delta))}`,
      )
      .join('；');
    const more = months.length > 3 ? `；另有 ${months.length - 3} 个月不一致` : '';
    return {
      diff,
      candidates: [],
      scope: 'month',
      months,
      message: `差 ${centsToYuan(Math.abs(diff))} 元。按月比对：${head}${more}。请先核对这几个月的原始记录，而不是逐笔找。`,
    };
  }

  // ② 单笔兜底：金额相等只是线索，不是结论
  const target = Math.abs(diff);
  const candidates = rows
    .filter((row) => row.amount_cents === target)
    .sort((a, b) => (a.direction === 'expense' ? 0 : 1) - (b.direction === 'expense' ? 0 : 1));
  if (candidates.length > 0) {
    const first = candidates[0];
    return {
      diff,
      candidates,
      scope: 'row',
      months: [],
      message: `疑似差异：${first.occurred_date} 有 1 笔 ${centsToYuan(target)}，与合计差异（${centsToYuan(Math.abs(diff))} 元）金额相同，可能相关也可能只是巧合，请核对这一行。`,
    };
  }
  return {
    diff,
    candidates: [],
    scope: 'none',
    months: [],
    message: `差 ${centsToYuan(Math.abs(diff))} 元：未能定位到单笔，也没有逐月数据可比，请核对账单尾部汇总数字或分段导入。`,
  };
}
