import { SETTING_KEYS } from './settingKeys';

/**
 * 出厂默认值 —— 唯一来源。
 *
 * 为什么要单独一个文件、不写在 `seed.ts` 里：
 * `merge.ts` 需要这份清单来判断「本机这条设置是用户改过的，还是没人动过、只是被 seed 占了坑」，
 * 而 `merge.ts` 必须保持**不依赖 Dexie 的纯逻辑**（它是 `src/test/backupMerge.test.ts` 的被测对象；
 * 一旦从 `seed.ts` 导入，整条 db 依赖链会跟进单测，纯逻辑测试就得先开 IndexedDB）。
 * 本文件除了 `settingKeys`（零依赖的键名常量表）之外不 import 任何东西，
 * 既保住了「页面不得出现裸字符串键」的约定，也不会把任何运行时依赖带进来。
 *
 * 两处消费，**必须是同一份**：首次打开应用时写进 settings、合并恢复时判断默认值。
 * 两份清单一旦分叉，就会出现「seed 写的是 A，合并以为默认是 B」的静默错判——
 * 而这种错判不会报错，只会让用户换设备后时薪莫名其妙变回 8000/174。
 */
export const SEED_SETTING_DEFAULTS: ReadonlyArray<{ key: string; value: unknown }> = [
  { key: SETTING_KEYS.hourlyWageMode, value: 'salary_div_hours' },
  { key: SETTING_KEYS.monthlySalaryCents, value: 800000 },
  { key: SETTING_KEYS.monthlyHours, value: 174 },
  { key: SETTING_KEYS.hourlyWageManualCents, value: null },
  { key: SETTING_KEYS.workdayHours, value: 8 },
  { key: SETTING_KEYS.timeCostThresholdCents, value: 10000 },
  { key: SETTING_KEYS.realWageHours, value: 0 },
  { key: SETTING_KEYS.theme, value: 'system' },
  { key: SETTING_KEYS.dataVersion, value: 1 },
  { key: SETTING_KEYS.ocrPackDownloaded, value: false },
  { key: SETTING_KEYS.onboarded, value: false },
];

/**
 * 合并时用的查表形式（键 → 值）。
 *
 * 模块级只建一次，避免每次恢复都重新拼一遍；同时它是「出厂默认值唯一来源」的第二种视图，
 * 与上面的数组同源同值，不会分叉。
 *
 * 注意判断"有没有这个键"必须用 `in` / `hasOwnProperty`，不能用 `record[key] !== undefined`：
 * `hourly_wage_manual_cents` 的出厂默认值就是 `null`（表示"没手填过时薪"），
 * 拿 undefined 当哨兵会把"默认值是 null"和"这不是默认键"混成一件事，合并时的豁免就永远不生效。
 */
export const SEED_SETTING_DEFAULTS_RECORD: Readonly<Record<string, unknown>> = Object.fromEntries(
  SEED_SETTING_DEFAULTS.map((item) => [item.key, item.value]),
);
