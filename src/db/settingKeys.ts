/** Setting 键名唯一清单（02-arch.md §7），页面不得出现裸字符串键。 */
export const SETTING_KEYS = {
  hourlyWageMode: 'hourly_wage_mode',
  monthlySalaryCents: 'monthly_salary_cents',
  monthlyHours: 'monthly_hours',
  hourlyWageManualCents: 'hourly_wage_manual_cents',
  workdayHours: 'workday_hours',
  timeCostThresholdCents: 'time_cost_threshold_cents',
  /** 真实时薪口径：近 3 笔接单报酬对应的填报工时合计（小时），由用户填 */
  realWageHours: 'real_wage_hours',
  theme: 'theme',
  dataVersion: 'data_version',
  ocrPackDownloaded: 'ocr_pack_downloaded',
  lastBackupAt: 'last_backup_at',
  /** 本机设备名（如"我的手机"），多设备来回导备份时用来分辨哪份更新 */
  deviceLabel: 'device_label',
  seededVersion: 'seeded_version',
  onboarded: 'onboarded',
  /** 上次用的分类，手动记账默认选中（PRD「记住上次分类」） */
  lastCategory: 'last_category',
  /**
   * 用户确认过的「哪些来源算收入」。存 IncomeSource[]：
   * 命中关键词就把方向改判为 income 并按给定分类入账。
   * 单独一条设置而不是 CategoryRule，因为规则只改分类、改不了方向。
   */
  incomeSources: 'income_sources',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

export const SEED_VERSION = 3;
