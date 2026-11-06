import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';

dayjs.extend(customParseFormat);

/**
 * 日期约定的唯一实现处。
 * occurred_at 存「带本地偏移的 ISO 8601」（2026-11-03T12:31:00+08:00），
 * occurred_date / month_key 由 occurred_at 派生，任何写路径都必须同步。
 * 跨月跨年一律用 month_key 字符串比较，不用时间戳边界（时区/夏令时坑）。
 */

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 本地时区偏移，如 '+08:00' */
export function localOffsetString(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** Date → 本地带偏移 ISO（保留秒，毫秒丢弃）。 */
export function toLocalIso(date: Date): string {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    localOffsetString(date)
  );
}

/** 'YYYY-MM-DD' + 'HH:mm' → 本地带偏移 ISO。 */
export function buildLocalIso(dateStr: string, timeStr = '00:00', second = 0): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, second);
  return toLocalIso(date);
}

/** 由 ISO 派生索引字段，长度不足时安全降级。 */
export function deriveDateFields(iso: string): { occurred_date: string; month_key: string } {
  const date = iso.slice(0, 10);
  return { occurred_date: date, month_key: date.slice(0, 7) };
}

export function parseIsoToDate(iso: string): Date {
  return new Date(iso);
}

export function monthKeyOfDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

export function currentMonthKey(): string {
  return monthKeyOfDate(new Date());
}

export function todayDateString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** 月份平移，'2026-01' + (-1) → '2025-12'。 */
export function shiftMonth(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  const base = new Date(y, (m || 1) - 1 + delta, 1);
  return monthKeyOfDate(base);
}

export function daysInMonth(monthKey: string): number {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/** 生成从 startMonth 到 endMonth 的连续月份数组（含两端）。 */
export function monthRange(startMonth: string, endMonth: string): string[] {
  const list: string[] = [];
  let cursor = startMonth;
  let guard = 0;
  while (cursor <= endMonth && guard < 600) {
    list.push(cursor);
    cursor = shiftMonth(cursor, 1);
    guard += 1;
  }
  return list;
}

/** 周几，0=周日。 */
export function weekdayOf(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getDay();
}

/** '2026-11-03' → '11月3日 周二' */
/**
 * '2026-11-04' → '11月4日 周三'
 *
 * `withYear`：跨年区间下必须带年份。流水页支持任意区间后，「7月5日」在
 * 2019~2020 的列表里会同时指向两天，分组标题就失去定位作用了。
 */
export function formatDayLabel(dateStr: string, options: { withYear?: boolean } = {}): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const prefix = options.withYear ? `${y}年` : '';
  return `${prefix}${m}月${d}日 ${names[weekdayOf(dateStr)]}`;
}

/** '2026-11' → '2026年11月' */
export function formatMonthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  return `${y}年${m}月`;
}

/** '2026-11' → '11月' */
export function formatMonthShort(monthKey: string): string {
  const [, m] = monthKey.split('-').map(Number);
  return `${m}月`;
}

export interface ParsedDateTime {
  date: string;
  time: string;
}

/**
 * 宽松解析账单里的日期文本。支持的形态：
 * - '2026-11-03 12:31:00' / '2026/11/3 12:31' / '20261103' / '2026年11月3日'
 * - '11月3日'（无年份 → 用 fallbackYear）
 * - '3日'（无月份与年份 → 用 fallbackMonth / fallbackYear，旧表靠向下填充）
 * 解析失败返回 null，由 Parser 记 issue。
 */
export function parseLooseDateTime(
  raw: string | undefined | null,
  opts: { fallbackYear: number; fallbackMonth?: number },
): ParsedDateTime | null {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (text === '') return null;

  const timeMatch = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  const time = timeMatch ? `${pad2(Number(timeMatch[1]))}:${timeMatch[2]}` : '00:00';

  // 全日期：2026-11-03 / 2026/11/3 / 2026.11.3 / 2026年11月3日 / 20261103
  const full = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(text);
  if (full) {
    const [, y, m, d] = full;
    return { date: `${y}-${pad2(Number(m))}-${pad2(Number(d))}`, time };
  }
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) {
    const [, y, m, d] = compact;
    return { date: `${y}-${m}-${d}`, time };
  }
  // 无年份：11月3日
  const monthDay = /(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(text);
  if (monthDay) {
    const [, m, d] = monthDay;
    return { date: `${opts.fallbackYear}-${pad2(Number(m))}-${pad2(Number(d))}`, time };
  }
  // 无月份无年份：3日
  const dayOnly = /^(\d{1,2})\s*日?$/.exec(text);
  if (dayOnly && opts.fallbackMonth !== undefined) {
    const [, d] = dayOnly;
    return { date: `${opts.fallbackYear}-${pad2(opts.fallbackMonth)}-${pad2(Number(d))}`, time };
  }
  const parsed = dayjs(text, ['YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD'], true);
  if (parsed.isValid()) {
    return { date: parsed.format('YYYY-MM-DD'), time: parsed.format('HH:mm') };
  }
  return null;
}

export function hourOfIso(iso: string): number {
  return Number(iso.slice(11, 13));
}

export function minuteOfIso(iso: string): string {
  return iso.slice(11, 16);
}

/** 交易时段：工作日 09:30–11:30 / 13:00–15:00（只用本地时间，不做假期判断）。 */
export function isTradingTime(now: Date = new Date()): boolean {
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const morning = minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30;
  const afternoon = minutes >= 13 * 60 && minutes <= 15 * 60;
  return morning || afternoon;
}

/** 'HH:mm' → 分钟数 */
export function hhmmToMinutes(text: string): number {
  const [h, m] = text.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function nowIso(): string {
  return toLocalIso(new Date());
}

export { dayjs };
