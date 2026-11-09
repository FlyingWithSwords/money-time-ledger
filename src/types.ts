/**
 * 全局数据契约 —— 严格对齐 docs/02-arch.md §2.2。
 * 任何字段改名都视为破坏性变更，必须同步 schema 迁移与 ReviewCard.schema_version。
 */

/** 整数「分」，全库唯一金额类型。恒为整数，方向由 Direction 表达。 */
export type Cents = number & { readonly __unit: 'cent' };

export type Direction = 'expense' | 'income' | 'refund' | 'transfer';

export type Source = 'wechat' | 'alipay' | 'bank' | 'ocr' | 'manual' | 'legacy_xlsx';

export type DedupeStatus = 'clean' | 'suspected' | 'duplicate';

export type PaymentChannel = 'wechat' | 'alipay' | 'huabei' | 'card' | 'cash' | 'unknown';

export const DIRECTION_LABEL: Record<Direction, string> = {
  expense: '支出',
  income: '收入',
  refund: '退款冲正',
  transfer: '转账',
};

export const SOURCE_LABEL: Record<Source, string> = {
  wechat: '微信账单',
  alipay: '支付宝账单',
  bank: '银行流水',
  ocr: '截图识别',
  manual: '手动',
  legacy_xlsx: '旧表格',
};

/**
 * 短标签：流水页每一行都要带来源标记，长标签（「微信账单」）在窄屏会把
 * 商户名挤成省略号，所以列表内用两字标签，只有提示框里才用长标签。
 */
export const SOURCE_SHORT_LABEL: Record<Source, string> = {
  wechat: '微信',
  alipay: '支付宝',
  bank: '银行',
  ocr: '截图',
  manual: '手动',
  legacy_xlsx: '表格',
};

export const CHANNEL_LABEL: Record<PaymentChannel, string> = {
  wechat: '微信',
  alipay: '支付宝',
  huabei: '花呗',
  card: '银行卡',
  cash: '现金',
  unknown: '未知',
};

export interface Transaction {
  id: string;
  /** 平台单号派生（有单号）或行指纹（无单号），用于同 source 内幂等。 */
  external_id: string;
  /** 去重指纹：source + 分钟级时间 + 金额 + 方向 + 对手方 + seq。 */
  dedupe_key: string;
  source: Source;
  direction: Direction;
  amount_cents: Cents;
  /** '2026-11-03T12:31:00+08:00'，账单语义是本地时间，不存裸 UTC。 */
  occurred_at: string;
  occurred_date: string;
  month_key: string;
  category_l1: string;
  category_l2: string;
  account_id: string;
  payment_channel: PaymentChannel | string;
  counterparty?: string;
  /** 仅展示，不参与任何计算。 */
  note?: string;
  /** 仅主观标记 'most_worthless' 落库；其余 4 条自动规则查询时派生。 */
  flags: string[];
  manual_edited: boolean;
  category_locked: boolean;
  refund_of_id?: string;
  dedupe_status: DedupeStatus;
  duplicate_of?: string;
  /**
   * 这份记录被哪些来源共同确认过（「几个来源结合」）。
   *
   * 为什么不用 `source` 一个字段表达：`source` 是**首次入库**的来源，只增不改；
   * 而同一笔账完全可能先由微信账单导入、后又被截图/对账确认一遍。把后者写进
   * `source` 会让「按来源统计」永远只反映第一次，且再也无法追溯原始凭证。
   *
   * 缺省（undefined）语义 = `[source]`，所以老数据不需要回填。
   */
  source_refs?: Source[];
  import_batch_id?: string;
  imported_at: string;
  created_at: string;
  updated_at: string;
  /** 软删，支持撤销。 */
  deleted_at?: string;
}

export interface Account {
  id: string;
  name: string;
  kind: 'cash' | 'debit' | 'credit' | 'wallet' | 'loan';
  /** 负债账户（花呗/信用卡）：余额本身为负，净资产直接相加即可。 */
  is_liability: boolean;
  opening_balance_cents: Cents;
  currency: 'CNY';
  default_channel?: string;
  archived: boolean;
  sort: number;
}

export interface Category {
  /** 语义 ID：'food.lunch' */
  id: string;
  l1_id: string;
  l1_name: string;
  l2_id: string;
  l2_name: string;
  direction_scope: 'expense' | 'income' | 'both';
  sort: number;
  icon: string;
  builtin: boolean;
  archived: boolean;
}

export interface RuleMatch {
  keywords?: string[];
  merchant_pattern?: string;
  /** 'HH:mm' */
  time_from?: string;
  time_to?: string;
  amount_max_cents?: Cents;
  weekday?: number[];
  channel?: string[];
}

export interface CategoryRule {
  id: string;
  kind: 'keyword' | 'time_window' | 'learned';
  source: 'builtin' | 'user' | 'learned';
  /** 仅 user 规则使用，升序（小者优先）。 */
  priority: number;
  match: RuleMatch;
  target_l1: string;
  /** 二级留空 = 交给时间规则补全。 */
  target_l2?: string;
  confidence: number;
  hit_count: number;
  enabled: boolean;
  updated_at: string;
}

/** 持仓所在平台。同一基金在支付宝和天天基金是两笔独立持仓，靠这个区分。 */
export type HoldingPlatform = 'alipay' | 'tiantian' | 'bank' | 'broker' | 'manual' | 'other';

export const HOLDING_PLATFORM_LABEL: Record<HoldingPlatform, string> = {
  alipay: '支付宝',
  tiantian: '天天基金',
  bank: '银行',
  broker: '券商',
  manual: '手动',
  other: '其他',
};

export interface Holding {
  id: string;
  fund_code: string;
  fund_name: string;
  /**
   * 持仓所在平台。v3 之前的旧数据统一回填 'manual'（当时只能手动录入）。
   * 唯一性由 (platform, fund_code) 复合表达：同平台同代码幂等覆盖，
   * 跨平台同代码共存——同一只基金在两个平台的仓位、成本完全独立。
   */
  platform: HoldingPlatform;
  /** 4 位小数。基金=份额；黄金（积存金/纸黄金）=克重，共用这套模型。 */
  shares: number;
  /** 多笔加仓合并为加权成本 */
  total_cost_cents: Cents;
  avg_cost_nav: number;
  first_buy_date: string;
  /** 清仓保留记录，计入历史收益 */
  closed_at?: string;
}

export interface FundQuote {
  /** `${code}:${navDate}:${kind}` */
  id: string;
  fund_code: string;
  nav: number;
  acc_nav?: number;
  nav_date: string;
  kind: 'nav' | 'estimate' | 'market_price';
  quote_at: string;
  source: string;
}

export interface Goal {
  id: string;
  name: string;
  target_cents: Cents;
  deadline: string;
  status: 'active' | 'achieved' | 'archived';
  created_at: string;
}

export interface Budget {
  id: string;
  month_key: string;
  category_l1: string;
  limit_cents: Cents;
}

/**
 * 消费计划备忘录的类型。
 *
 * - `save` = 攒钱：拖着**收入**记录往里累计，攒够目标就进入「可以消费了」。
 * - `spend` = 消费：拖着**支出**记录往里累计，花到目标就算完成；
 *   实际花得比预算少，完成时把差额记成「省下多少」。
 *
 * 两者刻意是**两条独立记录**，不做余额联动：用户明确要的就是
 * 「攒钱买主机」和「主机采购」各自一条进度，而不是一个双向账本。
 */
export type PlanKind = 'save' | 'spend';
export type PlanStatus = 'active' | 'done' | 'archived';

export const PLAN_KIND_LABEL: Record<PlanKind, string> = {
  save: '攒钱',
  spend: '消费',
};

export interface Plan {
  id: string;
  title: string;
  kind: PlanKind;
  target_cents: Cents;
  note?: string;
  status: PlanStatus;
  created_at: string;
  completed_at?: string;
  /**
   * 完成瞬间冻结的累计额。
   *
   * 不冻结的话，完成之后再有流水删改，「省下 320 元」会跟着变，
   * 用户回看历史时看到的是一个不断改写的结论——那不是记录，是幻觉。
   */
  settled_cents?: Cents;
  sort: number;
}

/**
 * 计划 ↔ 流水的关联。
 *
 * 主键用 `${plan_id}:${tx_id}` 而不是自增：同一笔流水在同一计划里只能累计一次
 * （拖两次不该翻倍），但可以同时属于「攒钱」和「消费」两条独立计划。
 */
export interface PlanEntry {
  id: string;
  plan_id: string;
  tx_id: string;
  created_at: string;
}

export interface Setting {
  key: string;
  value: unknown;
}

export interface ImportIssue {
  row: number;
  reason: string;
  raw?: string;
}

export interface ImportBatch {
  id: string;
  source: Source;
  file_name?: string;
  file_hash: string;
  file_total_expense_cents?: Cents;
  file_total_income_cents?: Cents;
  parsed_rows: number;
  inserted_rows: number;
  duplicate_rows: number;
  failed_rows: number;
  sum_expense_cents: Cents;
  sum_income_cents: Cents;
  sum_refund_cents: Cents;
  diff_expense_cents: Cents;
  reconciled: boolean;
  issues: ImportIssue[];
  created_at: string;
  undone_at?: string;
}

export interface ReviewPayload {
  totals: { expense_cents: Cents; income_cents: Cents; net_cents: Cents };
  top3: Array<{ category_l1: string; cents: Cents; ratio: number }>;
  priciest?: { id: string; cents: Cents; category_l2: string; date: string };
  most_worthless: Array<{ id: string; cents: Cents }>;
  impulse: { count: number; cents: Cents; ratio: number; kinds: Record<string, number> };
  mom: { expense_delta_cents: Cents; expense_delta_ratio: number };
  time_cost_line: { hours: number; basis: string };
  pending_uncategorized: number;
}

export interface ReviewCard {
  id: string;
  month_key: string;
  generated_at: string;
  schema_version: number;
  payload: ReviewPayload;
}
