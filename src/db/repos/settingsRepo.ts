import { db } from '../db';
import { SETTING_KEYS } from '../settingKeys';
import { asCents } from '../../domain/money';
import type { IncomeSource, IncomeSourceFilter } from '../../domain/incomeSource';
import type { WageSettings } from '../../domain/timecost';
import { DEFAULT_WAGE_SETTINGS } from '../../domain/timecost';

/** 设置读写。业务数据的唯一来源仍是 IndexedDB，这里只存口径与开关。 */

export async function get<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  if (!row) return fallback;
  return row.value as T;
}

export async function set(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}

export async function getMany(keys: readonly string[]): Promise<Record<string, unknown>> {
  const rows = await db.settings.bulkGet([...keys]);
  const out: Record<string, unknown> = {};
  rows.forEach((row, index) => {
    if (row) out[keys[index]] = row.value;
  });
  return out;
}

/** 任何写操作后调用：使按月 memo（标记/聚合）失效。 */
export async function bumpDataVersion(): Promise<number> {
  const current = await get<number>(SETTING_KEYS.dataVersion, 1);
  const next = current + 1;
  await set(SETTING_KEYS.dataVersion, next);
  return next;
}

export async function getDataVersion(): Promise<number> {
  return get<number>(SETTING_KEYS.dataVersion, 1);
}

export async function getWageSettings(): Promise<WageSettings> {
  const values = await getMany([
    SETTING_KEYS.hourlyWageMode,
    SETTING_KEYS.monthlySalaryCents,
    SETTING_KEYS.monthlyHours,
    SETTING_KEYS.hourlyWageManualCents,
    SETTING_KEYS.workdayHours,
    SETTING_KEYS.timeCostThresholdCents,
  ]);
  const manual = values[SETTING_KEYS.hourlyWageManualCents];
  return {
    hourly_wage_mode:
      (values[SETTING_KEYS.hourlyWageMode] as WageSettings['hourly_wage_mode']) ?? DEFAULT_WAGE_SETTINGS.hourly_wage_mode,
    monthly_salary_cents: asCents(
      (values[SETTING_KEYS.monthlySalaryCents] as number) ?? DEFAULT_WAGE_SETTINGS.monthly_salary_cents,
    ),
    monthly_hours: (values[SETTING_KEYS.monthlyHours] as number) ?? DEFAULT_WAGE_SETTINGS.monthly_hours,
    hourly_wage_manual_cents:
      typeof manual === 'number' ? asCents(manual) : DEFAULT_WAGE_SETTINGS.hourly_wage_manual_cents,
    workday_hours: (values[SETTING_KEYS.workdayHours] as number) ?? DEFAULT_WAGE_SETTINGS.workday_hours,
    time_cost_threshold_cents: asCents(
      (values[SETTING_KEYS.timeCostThresholdCents] as number) ?? DEFAULT_WAGE_SETTINGS.time_cost_threshold_cents,
    ),
  };
}

export async function setWageSettings(patch: Partial<WageSettings>): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    if (patch.hourly_wage_mode !== undefined) await set(SETTING_KEYS.hourlyWageMode, patch.hourly_wage_mode);
    if (patch.monthly_salary_cents !== undefined) await set(SETTING_KEYS.monthlySalaryCents, patch.monthly_salary_cents);
    if (patch.monthly_hours !== undefined) await set(SETTING_KEYS.monthlyHours, patch.monthly_hours);
    if (patch.hourly_wage_manual_cents !== undefined) {
      await set(SETTING_KEYS.hourlyWageManualCents, patch.hourly_wage_manual_cents);
    }
    if (patch.workday_hours !== undefined) await set(SETTING_KEYS.workdayHours, patch.workday_hours);
    if (patch.time_cost_threshold_cents !== undefined) {
      await set(SETTING_KEYS.timeCostThresholdCents, patch.time_cost_threshold_cents);
    }
    await set(SETTING_KEYS.dataVersion, (await get<number>(SETTING_KEYS.dataVersion, 1)) + 1);
  });
}

export type ThemeMode = 'light' | 'dark' | 'system';

export async function getThemeMode(): Promise<ThemeMode> {
  return get<ThemeMode>(SETTING_KEYS.theme, 'system');
}

export async function setThemeMode(mode: ThemeMode): Promise<void> {
  await set(SETTING_KEYS.theme, mode);
}

export async function getRealWageHours(): Promise<number> {
  return get<number>(SETTING_KEYS.realWageHours, 0);
}

export async function setRealWageHours(hours: number): Promise<void> {
  await set(SETTING_KEYS.realWageHours, hours);
  await bumpDataVersion();
}

export async function isOcrPackDownloaded(): Promise<boolean> {  return get<boolean>(SETTING_KEYS.ocrPackDownloaded, false);
}

export async function markOcrPackDownloaded(): Promise<void> {
  await set(SETTING_KEYS.ocrPackDownloaded, true);
}

export async function isOnboarded(): Promise<boolean> {
  return get<boolean>(SETTING_KEYS.onboarded, false);
}

export async function setOnboarded(): Promise<void> {
  await set(SETTING_KEYS.onboarded, true);
}

export async function getLastBackupAt(): Promise<string | null> {
  return get<string | null>(SETTING_KEYS.lastBackupAt, null);
}

export async function markBackupDone(at: string): Promise<void> {
  await set(SETTING_KEYS.lastBackupAt, at);
}

/**
 * 单条来源的宽松校验。
 *
 * 整条丢掉的条件只有「没法用」的：关键词不是字符串、一级分类不认识。
 * 其余字段一律给默认值——老版本存下的条目没有 `filter`、可能也没有 `label`，
 * 丢掉它们等于让用户之前勾过的来源集体失效，账会突然少几千块收入。
 */
function normalizeIncomeSource(raw: unknown): IncomeSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Partial<IncomeSource> & { filter?: unknown };
  if (typeof item.keyword !== 'string' || !item.keyword.trim()) return null;
  if (item.l1 !== 'salary' && item.l1 !== 'allowance') return null;
  const source: IncomeSource = {
    keyword: item.keyword,
    label: typeof item.label === 'string' && item.label ? item.label : item.keyword,
    l1: item.l1,
    l2: typeof item.l2 === 'string' && item.l2 ? item.l2 : 'monthly',
  };
  const filter = normalizeIncomeFilter(item.filter);
  if (filter) source.filter = filter;
  return source;
}

/** 高级条件同样宽松：只留下类型对且非空的字段，全空就等于没设条件。 */
function normalizeIncomeFilter(raw: unknown): IncomeSourceFilter | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const input = raw as Record<string, unknown>;
  const out: IncomeSourceFilter = {};
  for (const key of ['min_cents', 'max_cents'] as const) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = Math.round(value);
  }
  for (const key of ['include', 'exclude'] as const) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 用户确认过的收入来源（工资/补贴）。
 *
 * 读的时候要防御脏数据：早期版本可能写进过字符串或对象，导入管线按数组消费，
 * 一旦拿到非数组会直接抛错、整份账单导不进来——这里收敛成空数组，最坏退化成「不自动改判」。
 */
export async function getIncomeSources(): Promise<IncomeSource[]> {
  const value = await get<unknown>(SETTING_KEYS.incomeSources, []);
  if (!Array.isArray(value)) return [];
  return value.map(normalizeIncomeSource).filter((item): item is IncomeSource => item !== null);
}

export async function setIncomeSources(sources: readonly IncomeSource[]): Promise<void> {
  await set(SETTING_KEYS.incomeSources, sources);
  await bumpDataVersion();
}
