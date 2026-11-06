import type { Account, Category, CategoryRule } from '../types';
import { buildCategorySeed } from '../domain/categoryTree';
import { asCents } from '../domain/money';
import type { LedgerDatabase } from './db';
import { SETTING_KEYS, SEED_VERSION } from './settingKeys';
import { SEED_SETTING_DEFAULTS } from './settingDefaults';

/**
 * 种子数据：10 个一级分类（支出侧）+ 6 个收入侧一级 + 固定二级 + 内置关键词/时间规则 + 默认账户。
 * 幂等：靠 settings.seeded_version 判断，重复调用不会重复插入。
 *
 * 出厂默认值清单放在 `settingDefaults.ts`（纯数据模块），这里只负责把它写进库——
 * 合并恢复也要用同一份清单判断"本机这条动过没"，两边不能各存一份。
 */

/**
 * 出厂默认行的时间戳。
 *
 * 刻意取一个**远古固定值**而不是 `nowIso()`：默认值代表"从没人碰过的状态"，
 * 在时间上必须比任何真实操作都古老。用「现在」的后果是——新设备首次打开时 seed 出来的
 * 默认规则时间戳永远比备份里用户真正的修改更新，合并时被判「本机版本更新」而 skip，
 * 于是「手机上禁用的内置规则，换到电脑上又被自动启用」，且没有任何提示，
 * 用户只会觉得"有些账莫名被归到餐饮"。
 *
 * 同一个常量值还有个副作用是好的：`classify.ts` 的 `byPriority` 拿 `updated_at` 做 tie-break，
 * 内置规则原本就共用同一个 `nowIso()`（两两相等），改成共用同一个常量后仍然两两相等，排序零变化。
 */
export const SEED_EPOCH = '2000-01-01T00:00:00.000Z';

export function buildCategorySeedRows(): Category[] {
  return buildCategorySeed().map((row) => ({
    id: row.id,
    l1_id: row.l1_id,
    l1_name: row.l1_name,
    l2_id: row.l2_id,
    l2_name: row.l2_name,
    direction_scope: row.direction_scope,
    sort: row.sort,
    icon: row.icon,
    builtin: true,
    archived: false,
  }));
}

export function buildAccountSeed(): Account[] {
  return [
    {
      id: 'acc_cash',
      name: '现金',
      kind: 'cash',
      is_liability: false,
      opening_balance_cents: asCents(0),
      currency: 'CNY',
      default_channel: 'cash',
      archived: false,
      sort: 0,
    },
    {
      id: 'acc_wechat',
      name: '微信零钱',
      kind: 'wallet',
      is_liability: false,
      opening_balance_cents: asCents(0),
      currency: 'CNY',
      default_channel: 'wechat',
      archived: false,
      sort: 1,
    },
    {
      id: 'acc_alipay',
      name: '支付宝余额',
      kind: 'wallet',
      is_liability: false,
      opening_balance_cents: asCents(0),
      currency: 'CNY',
      default_channel: 'alipay',
      archived: false,
      sort: 2,
    },
    {
      id: 'acc_huabei',
      name: '花呗',
      kind: 'credit',
      // 负债账户：欠款记负数，净资产直接相加
      is_liability: true,
      opening_balance_cents: asCents(0),
      currency: 'CNY',
      default_channel: 'huabei',
      archived: false,
      sort: 3,
    },
    {
      id: 'acc_card',
      name: '银行卡',
      kind: 'debit',
      is_liability: false,
      opening_balance_cents: asCents(0),
      currency: 'CNY',
      default_channel: 'card',
      archived: false,
      sort: 4,
    },
  ];
}

interface BuiltinRuleSeed {
  id: string;
  keywords: string[];
  l1: string;
  l2?: string;
}

/** 内置关键词规则：关键词定一级；二级留空时由时间规则补全（美团 → 餐饮，按时间落午/晚餐）。 */
const BUILTIN_KEYWORDS: BuiltinRuleSeed[] = [
  { id: 'kw_meituan', keywords: ['美团', '饿了么', '外卖'], l1: 'food' },
  { id: 'kw_bike_qingju', keywords: ['青桔', '哈啰', '哈罗', '共享单车', '单车'], l1: 'transport', l2: 'bike' },
  { id: 'kw_metro', keywords: ['地铁', '轨道交通'], l1: 'transport', l2: 'metro' },
  { id: 'kw_bus', keywords: ['公交', '乘车码'], l1: 'transport', l2: 'bus' },
  { id: 'kw_taxi', keywords: ['打车', '滴滴', '高德打车', '出租车'], l1: 'transport', l2: 'taxi' },
  { id: 'kw_train', keywords: ['12306', '火车票', '机票'], l1: 'transport', l2: 'train' },
  { id: 'kw_rent', keywords: ['房租', '租金'], l1: 'housing', l2: 'rent' },
  { id: 'kw_utility', keywords: ['电费', '水费', '燃气', '物业费'], l1: 'housing', l2: 'utilities' },
  { id: 'kw_phone', keywords: ['话费', '中国移动', '中国联通', '中国电信'], l1: 'telecom', l2: 'phone' },
  { id: 'kw_subscription', keywords: ['会员', '订阅', '爱奇艺', '腾讯视频', '网易云', 'B站大会员'], l1: 'telecom', l2: 'subscription' },
  { id: 'kw_pdd', keywords: ['拼多多'], l1: 'shopping', l2: 'daily' },
  { id: 'kw_taobao', keywords: ['淘宝', '天猫', '京东'], l1: 'shopping', l2: 'daily' },
  { id: 'kw_express', keywords: ['快递', '顺丰', '菜鸟驿站', '中通', '圆通'], l1: 'shopping', l2: 'express' },
  { id: 'kw_medicine', keywords: ['药店', '医院', '门诊', '药房'], l1: 'medical', l2: 'medicine' },
  { id: 'kw_book', keywords: ['图书', '书店', '当当'], l1: 'learning', l2: 'book' },
  { id: 'kw_course', keywords: ['课程', '网课', '培训'], l1: 'learning', l2: 'course' },
  { id: 'kw_game', keywords: ['游戏', '王者荣耀', 'Steam'], l1: 'entertainment', l2: 'game' },
  { id: 'kw_gym', keywords: ['健身', '游泳', '球场'], l1: 'entertainment', l2: 'fitness' },
  { id: 'kw_redpacket', keywords: ['红包', '转账给'], l1: 'social', l2: 'redpacket' },
  { id: 'kw_salary', keywords: ['实习工资', '工资', '薪资'], l1: 'salary', l2: 'monthly' },
  { id: 'kw_job', keywords: ['接单', '开发费', '结算', '稿费'], l1: 'job', l2: 'project' },
  { id: 'kw_resale', keywords: ['转卖', '闲鱼', '卖出'], l1: 'resale', l2: 'other' },
];

export function buildBuiltinRules(): CategoryRule[] {
  const keywordRules: CategoryRule[] = BUILTIN_KEYWORDS.map((seed, index) => ({
    id: seed.id,
    kind: 'keyword',
    source: 'builtin',
    // 表序即优先级：更靠前 = 更具体
    priority: index,
    match: { keywords: seed.keywords },
    target_l1: seed.l1,
    target_l2: seed.l2,
    confidence: 0.7,
    hit_count: 0,
    enabled: true,
    updated_at: SEED_EPOCH,
  }));

  const timeRules: CategoryRule[] = [
    {
      id: 'time_lunch',
      kind: 'time_window',
      source: 'builtin',
      priority: 0,
      match: { time_from: '11:00', time_to: '14:00', amount_max_cents: asCents(5000) },
      target_l1: 'food',
      target_l2: 'lunch',
      confidence: 0.55,
      hit_count: 0,
      enabled: true,
      updated_at: SEED_EPOCH,
    },
    {
      id: 'time_dinner',
      kind: 'time_window',
      source: 'builtin',
      priority: 1,
      match: { time_from: '17:00', time_to: '21:00', amount_max_cents: asCents(8000) },
      target_l1: 'food',
      target_l2: 'dinner',
      confidence: 0.55,
      hit_count: 0,
      enabled: true,
      updated_at: SEED_EPOCH,
    },
    {
      id: 'time_breakfast',
      kind: 'time_window',
      source: 'builtin',
      priority: 2,
      match: { time_from: '06:00', time_to: '10:30', amount_max_cents: asCents(2500) },
      target_l1: 'food',
      target_l2: 'breakfast',
      confidence: 0.5,
      hit_count: 0,
      enabled: true,
      updated_at: SEED_EPOCH,
    },
  ];

  return [...keywordRules, ...timeRules];
}

/** 幂等种子。返回是否实际写入。 */
export async function ensureSeeded(database: LedgerDatabase): Promise<boolean> {
  const marker = await database.settings.get(SETTING_KEYS.seededVersion);
  if (marker && Number(marker.value) >= SEED_VERSION) return false;

  await database.transaction('rw', database.categories, database.accounts, database.rules, database.settings, async () => {
    const existingCategories = await database.categories.count();
    if (existingCategories === 0) {
      await database.categories.bulkAdd(buildCategorySeedRows());
    }
    const existingAccounts = await database.accounts.count();
    if (existingAccounts === 0) {
      await database.accounts.bulkAdd(buildAccountSeed());
    }
    const existingRules = await database.rules.count();
    if (existingRules === 0) {
      await database.rules.bulkAdd(buildBuiltinRules());
    }

    for (const item of SEED_SETTING_DEFAULTS) {
      const found = await database.settings.get(item.key);
      if (!found) await database.settings.put({ key: item.key, value: item.value });
    }
    await database.settings.put({ key: SETTING_KEYS.seededVersion, value: SEED_VERSION });
  });

  return true;
}
