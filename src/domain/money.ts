import type { Cents } from '../types';
import { LedgerError } from './errors';

/**
 * 金额唯一入口。全库约定：
 * - 只有 Cents（整数分）参与运算；
 * - 分 ↔ 元 只在边界（文本输入 / 展示）转换，且转换用「十进制位拼接」，**不做浮点乘除**；
 * - 任何求和先转分求和，最后一次性转元；
 * - 显示固定 2 位，用字符串拼接，不用 toFixed 反算。
 */

const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/** 把整数断言成 Cents（仅做有限性校验，不做四舍五入）。 */
export function asCents(value: number): Cents {
  if (!Number.isFinite(value)) {
    throw new LedgerError('MONEY_INVALID', `金额不是有效数字：${String(value)}`);
  }
  return Math.trunc(value) as Cents;
}

export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * 元 → 分。字符串输入按十进制位精确解析（'0.04' → 4）；
 * 数字输入先转十进制字面量再走同一条路径，绝不出现 `金额 * 100` 的浮点乘法。
 * 第三位小数按四舍五入处理（账单里极少出现，但不允许静默截断）。
 */
export function yuanToCents(input: string | number): Cents {
  const raw = typeof input === 'number' ? numberToDecimalLiteral(input) : input.trim();
  if (raw === '') {
    throw new LedgerError('MONEY_INVALID', '金额为空');
  }
  if (!DECIMAL_RE.test(raw)) {
    throw new LedgerError('MONEY_INVALID', `无法解析金额：${String(input)}`);
  }
  const negative = raw.startsWith('-');
  const body = raw.replace(/^[+-]/, '');
  const dotIndex = body.indexOf('.');
  const intPart = dotIndex >= 0 ? body.slice(0, dotIndex) : body;
  const fracPart = dotIndex >= 0 ? body.slice(dotIndex + 1) : '';
  const intDigits = intPart === '' ? '0' : intPart;
  const frac2 = `${fracPart}00`.slice(0, 2);
  // 十进制位拼接："15" + "00" → 1500；"0" + "04" → 4
  let total = Number(`${intDigits}${frac2}`);
  if (!Number.isSafeInteger(total)) {
    throw new LedgerError('MONEY_INVALID', `金额超出可安全表示范围：${raw}`);
  }
  if (fracPart.length >= 3 && Number(fracPart[2]) >= 5) {
    total += 1;
  }
  // '-0' / '-0.00' 必须归一成 0：负零不是规范零，会让 === 比较与排序出现意外
  if (total === 0) return 0 as Cents;
  return (negative ? -total : total) as Cents;
}

/** 分 → 元字符串，固定 2 位，纯整数运算。 */
export function centsToYuan(cents: Cents | number): string {
  const value = Math.trunc(cents);
  const negative = value < 0;
  const abs = Math.abs(value);
  const intPart = Math.floor(abs / 100);
  const fracPart = abs % 100;
  return `${negative ? '-' : ''}${intPart}.${String(fracPart).padStart(2, '0')}`;
}

/** 分 → 元数值，**仅用于图表 Y 轴**，不参与任何账目计算。 */
export function centsToYuanNumber(cents: Cents | number): number {
  return Number(centsToYuan(cents));
}

export interface FormatCentsOptions {
  /** 是否带 ¥，默认 true */
  symbol?: boolean;
  /** 正数是否显示 +，默认 false */
  showPlus?: boolean;
  /** 是否千分位，默认 true */
  grouping?: boolean;
}

/** 展示用格式化：formatCents(1500) → '¥15.00'，formatCents(-4) → '-¥0.04'。 */
export function formatCents(cents: Cents | number, opts: FormatCentsOptions = {}): string {
  const { symbol = true, showPlus = false, grouping = true } = opts;
  const text = centsToYuan(cents);
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const [intPart, fracPart] = body.split('.');
  const grouped = grouping ? groupThousands(intPart) : intPart;
  const sign = negative ? '-' : showPlus ? '+' : '';
  return `${sign}${symbol ? '¥' : ''}${grouped}.${fracPart}`;
}

export function groupThousands(digits: string): string {
  if (digits.length <= 3) return digits;
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    const posFromEnd = digits.length - i;
    out += digits[i];
    if (posFromEnd > 1 && posFromEnd % 3 === 1) out += ',';
  }
  return out;
}

/** 先分求和再转元：任何汇总都走这里，杜绝浮点累加。 */
export function sumCents(values: Iterable<number> | readonly number[]): Cents {
  let total = 0;
  for (const value of values as Iterable<number>) {
    if (!Number.isFinite(value)) continue;
    total += Math.trunc(value);
  }
  return total as Cents;
}

export function negateCents(value: Cents): Cents {
  return (-value) as Cents;
}

export function absCents(value: Cents): Cents {
  return Math.abs(value) as Cents;
}

/**
 * 从账单文本里抠出金额（'¥1,234.56'、'-12.49'、'12.49元'、'(12.49)'）。
 * 解析失败返回 null，由调用方记进 issues —— 不允许静默变成 0。
 */
export function parseMoneyString(raw: string | undefined | null): Cents | null {
  if (raw === undefined || raw === null) return null;
  let text = String(raw).trim();
  if (text === '' || text === '/' || text === '-' || text === '--') return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text
    .replace(/[¥￥$]/g, '')
    .replace(/元|人民币|CNY|RMB/gi, '')
    .replace(/[,，\s]/g, '')
    .trim();
  if (text.startsWith('+')) text = text.slice(1);
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  }
  if (text === '' || !/^\d+(?:\.\d+)?$/.test(text)) return null;
  const cents = yuanToCents(text);
  if (cents === 0) return 0 as Cents;
  return (negative ? -cents : cents) as Cents;
}

/** 数字 → 十进制字面量（绕开科学计数法，避免 '1e-7' 这类输入）。 */
function numberToDecimalLiteral(value: number): string {
  if (!Number.isFinite(value)) {
    throw new LedgerError('MONEY_INVALID', `金额不是有效数字：${String(value)}`);
  }
  const text = String(value);
  if (text.includes('e') || text.includes('E')) {
    // 科学计数法只在极大/极小值出现，直接按固定 6 位展开
    return value.toFixed(6);
  }
  return text;
}
