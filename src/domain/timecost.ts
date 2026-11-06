import type { Cents } from '../types';
import { asCents } from './money';

/**
 * M1 劳动时间换算。
 * 三档口径（用户选定优先，数据不足才回落，UI 灰字标注实际口径）：
 *   real             真实时薪 = 近 3 笔「接单报酬」收入合计 ÷ 填报工时
 *   salary_div_hours 月薪 ÷ 月工时（默认 8000 ÷ 174 ≈ 46 元/h）
 *   manual           直填时薪
 * 三者皆无 → 不显示时间成本（不显示 0、不用占位符），总览换成一次性引导。
 */

export type WageBasis = 'real' | 'salary_div_hours' | 'manual';

export interface WageSettings {
  hourly_wage_mode: WageBasis;
  monthly_salary_cents: Cents;
  monthly_hours: number;
  hourly_wage_manual_cents: Cents | null;
  workday_hours: number;
  time_cost_threshold_cents: Cents;
}

export interface RealWageInput {
  /** 近 3 笔接单报酬收入合计（分） */
  income_cents: Cents;
  /** 这 3 笔填报的工时合计（小时） */
  hours: number;
  count: number;
}

export interface WageResult {
  /** 每小时多少分；无法确定时为 null */
  cents: Cents | null;
  basis: WageBasis | null;
  /** 用户选定口径不可用、回落到其它口径时为 true */
  fellBack: boolean;
}

export interface TimeCost {
  hours: number;
  days?: number;
  unit: 'hour' | 'day';
  display: string;
  basis: WageBasis;
}

export const DEFAULT_WAGE_SETTINGS: WageSettings = {
  hourly_wage_mode: 'salary_div_hours',
  monthly_salary_cents: asCents(800000),
  monthly_hours: 174,
  hourly_wage_manual_cents: null,
  workday_hours: 8,
  time_cost_threshold_cents: asCents(10000),
};

export const WAGE_BASIS_LABEL: Record<WageBasis, string> = {
  real: '真实时薪（接单收入 ÷ 工时）',
  salary_div_hours: '月薪 ÷ 月工时',
  manual: '直填时薪',
};

/** 按口径顺序尝试，返回第一个可用值；用户选定口径优先但不阻塞。 */
export function resolveHourlyWage(
  settings: WageSettings,
  real?: RealWageInput | null,
): WageResult {
  const candidates: Array<() => { cents: Cents | null; basis: WageBasis }> = [
    () => ({ cents: realWage(real), basis: 'real' as WageBasis }),
    () => ({ cents: salaryWage(settings), basis: 'salary_div_hours' as WageBasis }),
    () => ({ cents: settings.hourly_wage_manual_cents, basis: 'manual' as WageBasis }),
  ];
  const preferred = settings.hourly_wage_mode;
  const ordered = [
    ...candidates.filter((_, index) => orderOf(preferred) === index),
    ...candidates.filter((_, index) => orderOf(preferred) !== index),
  ];
  for (const [index, candidate] of ordered.entries()) {
    const { cents, basis } = candidate();
    if (cents !== null && cents > 0) {
      return { cents, basis, fellBack: index > 0 };
    }
  }
  return { cents: null, basis: null, fellBack: false };
}

function orderOf(basis: WageBasis): number {
  if (basis === 'real') return 0;
  if (basis === 'salary_div_hours') return 1;
  return 2;
}

function realWage(real?: RealWageInput | null): Cents | null {
  if (!real || real.count < 3 || real.hours <= 0 || real.income_cents <= 0) return null;
  // 分 ÷ 小时 → 每小时的分；四舍五入到分
  return asCents(Math.round(real.income_cents / real.hours));
}

function salaryWage(settings: WageSettings): Cents | null {
  if (settings.monthly_hours <= 0 || settings.monthly_salary_cents <= 0) return null;
  return asCents(Math.round(settings.monthly_salary_cents / settings.monthly_hours));
}

/**
 * 金额 → 时间。hours = amount ÷ wage（2 位小数向下取整，避免夸大）；
 * ≥ workdayHours（默认 8）时改显示"工作日"，1 位小数。
 */
export function costToTime(
  amount: Cents,
  wage: Cents,
  workdayHours = 8,
  basis: WageBasis = 'manual',
): TimeCost {
  if (!wage || wage <= 0) {
    throw new Error('costToTime: 时薪必须为正数');
  }
  const rawHours = Math.abs(amount) / wage;
  const hours = Math.floor(rawHours * 100) / 100;
  const safeWorkday = workdayHours > 0 ? workdayHours : 8;
  if (hours >= safeWorkday) {
    const rawDays = hours / safeWorkday;
    const days = Math.floor(rawDays * 10) / 10;
    return {
      hours,
      days,
      unit: 'day',
      display: `${trimZero(days)} 个工作日`,
      basis,
    };
  }
  return {
    hours,
    unit: 'hour',
    display: hours < 0.01 ? '不到 0.01 小时' : `${trimZero(hours)} 小时`,
    basis,
  };
}

/** 去掉多余尾零：10 → '10'，26.40 → '26.4'，0.32 → '0.32'（不要 '10.0' 这种半截结果） */
function trimZero(value: number): string {
  const text = value.toFixed(2);
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

/** 流水行内是否展示时间成本：达到阈值才展示，避免每行都是 0.0x 小时。 */
export function shouldShowTimeCost(amount: Cents, settings: WageSettings): boolean {
  return Math.abs(amount) >= settings.time_cost_threshold_cents;
}

/** 汇总横条文案：本月支出 ≈ 26.4 个工作日 */
export function formatTotalTimeCost(amount: Cents, wage: Cents, workdayHours = 8): string {
  const cost = costToTime(amount, wage, workdayHours);
  if (cost.unit === 'day') return `${trimZero(cost.days ?? 0)} 个工作日`;
  // 与行内文案保持一致：不足 0.01 小时不写成「0 小时」
  if (cost.hours < 0.01) return '不到 0.01 小时';
  return `${trimZero(cost.hours)} 小时`;
}

export interface WorkdayBudget {
  /** 已消耗的工作天数（1 位小数，向下取整，不夸大） */
  consumed_days: number;
  /** 这段时间理论上挣到的总工作天数（月工时 ÷ 每日工时） */
  total_days: number;
  /** 已消耗占总额的比例，可能 > 1（超支）。总天数为 0 时返回 null */
  ratio: number | null;
  /** 金额不够一天工时，单独给出小时数以便文案降级 */
  hours: number;
  /** 是否已超过这段时间的全部劳动所得 */
  overdrawn: boolean;
}

/**
 * 「这段时间挣来的工天，已经花掉了多少」。
 *
 * 为什么需要它：只显示单笔「这杯咖啡 = 0.5 小时」会诱发反向激励——
 * 半小时听着不贵，于是继续买。有实测用户因此把月支出做到预算的 115%：
 * 「剩余预算」被读成了「还能花的钱」。所以必须同时给出**总量**：
 * 你这个月挣来 21.75 个工作日，其中 11.3 个已经花掉了。
 *
 * 向下取整而不是四舍五入，理由与 costToTime 一致：不能夸大已消耗，也不能夸大剩余。
 */
export function workdayBudget(
  amount: Cents,
  wage: Cents,
  workdayHours: number,
  monthlyHours: number,
): WorkdayBudget | null {
  if (!wage || wage <= 0) return null;
  const safeWorkday = workdayHours > 0 ? workdayHours : 8;
  // 净支出可能为负（退款冲正大于支出），那意味着这段时间反而收回了钱，消耗记 0 而不是取绝对值
  const rawHours = amount > 0 ? amount / wage : 0;
  const hours = Math.floor(rawHours * 100) / 100;
  const consumedDays = Math.floor((hours / safeWorkday) * 10) / 10;
  const totalDays = monthlyHours > 0 ? Math.floor((monthlyHours / safeWorkday) * 10) / 10 : 0;
  return {
    consumed_days: consumedDays,
    total_days: totalDays,
    ratio: totalDays > 0 ? hours / safeWorkday / totalDays : null,
    hours,
    overdrawn: totalDays > 0 && hours / safeWorkday > totalDays,
  };
}
