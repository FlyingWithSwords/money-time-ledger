import { daysInMonth, formatMonthLabel, monthRange, shiftMonth, todayDateString } from './date';

/**
 * 日期区间工具（YYYY-MM-DD 闭区间）。
 *
 * 为什么单独一个文件：月度语义（month_key）与区间语义（occurred_date）是两套坐标系。
 * 既有聚合函数里 monthlyTrend / cumulativeByDay / buildCompare / dailyAverage 全部按
 * month_key 分桶，喂区间数据不会报错、但会静默给出**整月**数字；所以区间统计必须走
 * 「按 occurred_date 切片 + 自行累计」这条独立路径，本文件提供这条路径的底座。
 *
 * 全部函数都是纯函数，日期字符串只用 'YYYY-MM-DD' 字面量比较（不碰时间戳与时区），
 * 需要做日期加减时才构造本地中午的 Date（见 addDays 注释）。
 */

export interface DateRange {
  /** 起始日，含。'YYYY-MM-DD' */
  from: string;
  /** 结束日，含。'YYYY-MM-DD' */
  to: string;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 'YYYY-MM-DD' → 当日 12:00 的时间戳；非法输入返回 NaN。 */
function noonOf(dateStr: string): number {
  return Date.parse(`${dateStr}T12:00:00`);
}

/**
 * 日期加减 N 天。
 *
 * 为什么用「本地中午」当锚点：直接 new Date(y, m-1, d) 是本地 00:00，
 * 在夏令时切换日 +1 天可能落回前一天 23:00；正午离边界 12 小时，任何 ±1 小时的
 * 偏移都不会跨日。中国无夏令时，但库不做地域假设。
 */
export function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return dateStr;
  const base = new Date(y, m - 1, d, 12, 0, 0, 0);
  base.setDate(base.getDate() + delta);
  return `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(base.getDate())}`;
}

/** 把任意顺序的两个端点整理成 from <= to（Store / UI 层都用它兜底）。 */
export function normalizeRange(range: DateRange): DateRange {
  return range.from <= range.to ? { from: range.from, to: range.to } : { from: range.to, to: range.from };
}

/** 某个整月的区间：'2026-02' → 2026-02-01 ~ 2026-02-28（闰年自动 29）。 */
export function wholeMonthRange(monthKey: string): DateRange {
  const days = daysInMonth(monthKey);
  return { from: `${monthKey}-01`, to: `${monthKey}-${pad2(days)}` };
}

/** 当月 1 号 ~ 当月末。today 可注入，便于测试跨年/闰年边界。 */
export function currentMonthRange(today: string = todayDateString()): DateRange {
  return wholeMonthRange(today.slice(0, 7));
}

/**
 * 等长前移 N 个区间。
 *
 * 语义：区间长度 L 天 → 前一区间是 [from − L, from − 1]，**首尾相接且不重叠**。
 * times=2 时继续往前再退 L 天。跨月/跨年/闰年由 addDays 的日历运算保证。
 */
export function shiftRangeBack(range: DateRange, times = 1): DateRange {
  const { from, to } = normalizeRange(range);
  const steps = Math.max(1, Math.trunc(times));
  const length = rangeDays({ from, to });
  if (length <= 0) return { from, to };
  const newFrom = addDays(from, -length * steps);
  return { from: newFrom, to: addDays(newFrom, length - 1) };
}

/**
 * 「上一期」的可比区间 —— 对比卡片（较上月 / 较上一个等长区间）用。
 *
 * 为什么不能一律用 shiftRangeBack：31 天的月份往前推 31 天会落到「1 月 29 日 ~ 2 月 28 日」，
 * 那不是"上月"，却顶着「较上月」的文案 —— 一个能跑但数字错的对比。
 * 所以整月区间比**上一个自然月**（2 月 28 天也要和 1 月 31 天比，这才是"月"的含义），
 * 任意区间才比等长区间（首尾相接、不重叠）。
 */
export function previousComparableRange(range: DateRange): DateRange {
  if (isWholeMonth(range)) return wholeMonthRange(shiftMonth(range.from.slice(0, 7), -1));
  return shiftRangeBack(range, 1);
}

/** 区间天数，含首尾：01-01~01-01 = 1；01-01~01-02 = 2。 */
export function rangeDays(range: DateRange): number {
  const start = noonOf(range.from);
  const end = noonOf(range.to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  const diff = Math.round((end - start) / MS_PER_DAY) + 1;
  return diff > 0 ? diff : 0;
}

/** 是否恰好是某个自然月（from 是 1 号且 to 是该月最后一天）。 */
export function isWholeMonth(range: DateRange): boolean {
  const fromMonth = range.from.slice(0, 7);
  if (fromMonth !== range.to.slice(0, 7)) return false;
  if (range.from.slice(8, 10) !== '01') return false;
  return Number(range.to.slice(8, 10)) === daysInMonth(fromMonth);
}

/** 区间覆盖到的所有 YYYY-MM（升序、去重、连续）。 */
export function monthsInRange(range: DateRange): string[] {
  const { from, to } = normalizeRange(range);
  return monthRange(from.slice(0, 7), to.slice(0, 7));
}

/** 整月 → '2026年3月'；否则 → '2026-03-01 ~ 2026-03-18'。 */
export function rangeLabel(range: DateRange): string {
  if (isWholeMonth(range)) return formatMonthLabel(range.from.slice(0, 7));
  const { from, to } = normalizeRange(range);
  return `${from} ~ ${to}`;
}

/** 最近 N 天（含今天）。 */
export function lastNDays(n: number, today: string = todayDateString()): DateRange {
  const days = Math.max(1, Math.trunc(n));
  return { from: addDays(today, -(days - 1)), to: today };
}

/** 最近 N 个自然月（含本月），首月从 1 号起算。 */
export function lastNMonthsRange(months: number, today: string = todayDateString()): DateRange {
  const count = Math.max(1, Math.trunc(months));
  const end = currentMonthRange(today);
  const start = wholeMonthRange(shiftMonth(today.slice(0, 7), -(count - 1)));
  return { from: start.from, to: end.to };
}

/** 今年 1 月 1 日 ~ 今天。 */
export function yearToDate(today: string = todayDateString()): DateRange {
  return { from: `${today.slice(0, 4)}-01-01`, to: today };
}

/** 两个区间是否完全相同（快捷按钮高亮判定用）。 */
export function sameRange(a: DateRange, b: DateRange): boolean {
  return a.from === b.from && a.to === b.to;
}
