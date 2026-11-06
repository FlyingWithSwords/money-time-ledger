import { db } from '../db';
import { SETTING_KEYS } from '../settingKeys';
import { asCents } from '../../domain/money';
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
