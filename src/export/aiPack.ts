import { categoryShares, topExpenses, totalsOf } from '../domain/aggregate';
import { l1Name } from '../domain/categoryTree';
import { computeMonthFlags, FLAG_LABEL } from '../domain/flags';
import { centsToYuan } from '../domain/money';
import { sourceBreakdown } from '../domain/provenance';
import { isActiveTx } from '../domain/txUtils';
import { SOURCE_LABEL, type Transaction } from '../types';

/**
 * AI 分析数据包（纯构建函数）。
 *
 * 产品定位（竞品分析结论）：本地生成结构化包 + 用户决定给谁看。
 * 反面教材是 BYOK 云端 LLM——开了云模型，账单数据就出境了。
 * 所以本模块**只做两件事**：聚合（复用 domain 层既有口径）+ 脱敏（商户代号化 / 备注可选），
 * 不碰 Dexie、不碰 DOM、不发任何网络请求——「导出」的最后一公里（复制/下载）由 UI 层完成。
 *
 * 确定性约定：同一批输入两次构建，代号分配结果必须完全一致。
 * 这靠「排序」而不是 Map 迭代顺序或随机数保证——用户把同一份包喂给不同 AI
 * 或分两次导出时，代号漂移会让两次分析的结论无法对照。
 */

export type CounterpartyMode = 'pseudonym' | 'strip' | 'full';

export interface AiPackOptions {
  /** 商户/对方名称如何处理。默认 pseudonym：分析价值保留（Top 商户榜仍有意义），真实名称不出现在包里。 */
  counterpartyMode?: CounterpartyMode;
  /** 是否包含备注原文。默认 false（备注常含地址/人名）。 */
  includeNotes?: boolean;
  /** 只导出该区间（YYYY-MM-DD 闭区间）；缺省 = 全部数据。 */
  fromDate?: string;
  toDate?: string;
}

export interface AiPack {
  schema_version: 1;
  pack_kind: 'ledger-ai-analysis';
  generated_at: string;
  privacy: { counterparty_mode: CounterpartyMode; notes_included: boolean; statement: string };
  summary: { range: { from: string; to: string }; months: number; tx_count: number; sources_covered: string[] };
  /** month 为 'YYYY-MM'（机器可排序），金额为元字符串 "1234.56"（两位小数、无千分位） */
  monthly: Array<{ month: string; income: string; expense: string; net: string }>;
  categories: Array<{ name: string; direction: string; total: string; count: number; share: string }>;
  top_merchants: Array<{ name: string; total: string; count: number }>;
  impulse: { kind_counts: Record<string, number>; most_worthless_count: number };
  /** 最多 10 笔；merchant 受 counterpartyMode 影响 */
  largest_expenses: Array<{ date: string; amount: string; category: string; merchant: string }>;
  field_dictionary: Record<string, string>;
  suggested_prompt: string;
  /** 仅当 includeNotes=true 时出现：备注原文（用户显式选择承担隐私风险） */
  notes?: Array<{ date: string; merchant: string; note: string }>;
}

/** 没有 counterparty 的交易的占位文案——明确告诉 AI「这里不是脱敏丢的，是本来就没记」。 */
const UNRECORDED_MERCHANT = '（未记录对方）';

const PRIVACY_STATEMENT = '本包由本地应用生成，未上传任何服务器；交给谁由使用者自行决定。';

/** 用户可整段复制给任何 AI 的提示词（写死，不随数据变化）。 */
const SUGGESTED_PROMPT =
  '你是一名个人财务分析师。请基于我提供的记账数据包（JSON，字段说明见 field_dictionary）分析：' +
  '1) 消费结构是否健康，哪些类目占比异常；2) 周期性/订阅类支出有哪些；3) 冲动消费（impulse 字段）集中在什么场景；' +
  '4) 结合 monthly 趋势给出下月可执行的省钱建议。要求：只依据数据说话，不编造；金额单位是元；' +
  '如果数据脱敏（商户为代号）就不要猜测真实商户。';

/**
 * 字段词典：包内每个字段的中文解释。AI 拿到的是「自带说明书」的 JSON，
 * 不需要用户再解释口径（净额/冲正/代号规则都写在这里）。
 */
const FIELD_DICTIONARY: Record<string, string> = {
  schema_version: '数据包结构版本号，当前为 1',
  pack_kind: '数据包类型，固定为 ledger-ai-analysis（个人记账账本分析包）',
  generated_at: '数据包生成时间（ISO 8601，本机时钟）',
  'privacy.counterparty_mode': '商户/对方名称处理方式：pseudonym=代号替代（如 商户A），strip=完全去除，full=保留原名',
  'privacy.notes_included': '是否包含交易备注原文（true 时才有 notes 段）',
  'privacy.statement': '隐私声明：数据由本地应用生成，未经任何服务器',
  'summary.range.from': '统计区间起始日期（YYYY-MM-DD，含当天；空串表示无数据）',
  'summary.range.to': '统计区间结束日期（YYYY-MM-DD，含当天）',
  'summary.months': '统计覆盖的自然月个数',
  'summary.tx_count': '进入统计的交易笔数（已排除软删除与裁决为重复的记录，不含转账）',
  'summary.sources_covered': '数据来源中文标签清单（如 微信账单、手动），多来源确认的账在每个来源下都有体现',
  'monthly[].month': '月份，格式 YYYY-MM',
  'monthly[].income': '当月收入合计（元，两位小数字符串）',
  'monthly[].expense': '当月支出净额（元）＝ 支出毛额 − 退款冲正，与全应用统计口径一致',
  'monthly[].net': '当月结余（元）＝ 收入 − 支出净额',
  'categories[].name': '一级分类中文名（如「餐饮」「交通」）',
  'categories[].direction': '统计方向，当前为「支出」（净额口径，退款已冲减对应分类）',
  'categories[].total': '该分类支出净额合计（元）',
  'categories[].count': '该分类交易笔数（含参与冲正的退款笔）',
  'categories[].share': '该分类占支出净额总额的比例，如「23.4%」',
  'top_merchants[].name': '商户/对方名称（受 privacy.counterparty_mode 影响；代号按支出净额从大到小分配为 商户A、商户B…）',
  'top_merchants[].total': '在该商户的支出净额合计（元，已扣退款）',
  'top_merchants[].count': '在该商户的支出与退款交易笔数',
  'impulse.kind_counts': '冲动/可疑消费标记计数（按当月数据逐月判定后汇总），键为中文标签：深夜(23:00–05:00 消费)、碎钞(30 分钟内同分类连刷 3 笔或当日 5 笔以上小额)、大额(单笔 ≥ 当月日均支出 3 倍)、习惯性(同一二级分类连续 7 天出现)、后悔(用户主观标记「最不值」)',
  'impulse.most_worthless_count': '被用户标记为「最不值」的交易笔数',
  'largest_expenses[].date': '交易发生日期（YYYY-MM-DD）',
  'largest_expenses[].amount': '单笔支出金额（元，毛额）',
  'largest_expenses[].category': '一级分类中文名',
  'largest_expenses[].merchant': '商户名称（受脱敏模式影响；未记录对方时为「（未记录对方）」）',
  'notes[].date': '该条备注所在交易的日期（仅 privacy.notes_included=true 时出现）',
  'notes[].merchant': '该条备注所在交易的商户（受脱敏模式影响）',
  'notes[].note': '备注原文（可能含地址、人名，用户已知晓并选择包含）',
  suggested_prompt: '建议整段复制给 AI 的分析提示词',
};

/**
 * 序号 → 商户代号：0→商户A … 25→商户Z，26→商户AA。
 * 为什么不用随机后缀：同一商户必须两次构建拿到同一代号（见文件头确定性约定）。
 */
function merchantCode(index: number): string {
  let rest = index;
  let code = '';
  do {
    code = String.fromCharCode(65 + (rest % 26)) + code;
    rest = Math.floor(rest / 26) - 1;
  } while (rest >= 0);
  return `商户${code}`;
}

/** 纯字符串比较的 tie-break：localeCompare 的排序结果随宿主环境漂移，会破坏确定性。 */
function compareByName(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

interface MerchantAgg {
  name: string;
  /** 支出净额（支出 − 退款冲正），与 totalsOf 同口径 */
  netCents: number;
  count: number;
}

export function buildAiPack(txs: readonly Transaction[], options: AiPackOptions = {}): AiPack {
  const counterpartyMode: CounterpartyMode = options.counterpartyMode ?? 'pseudonym';
  const includeNotes: boolean = options.includeNotes ?? false;

  // 1) 过滤：软删/重复不进包；区间按 occurred_date 字符串比较（闭区间），
  //    与全库「不用时间戳边界」的日期约定一致。
  const scoped: Transaction[] = txs.filter((tx) => {
    if (!isActiveTx(tx)) return false;
    if (options.fromDate !== undefined && tx.occurred_date < options.fromDate) return false;
    if (options.toDate !== undefined && tx.occurred_date > options.toDate) return false;
    return true;
  });

  // 2) 区间与月份：缺省区间 = 实际数据的最早/最晚一天（「全部数据」的诚实描述）
  const sortedDates = scoped.map((tx) => tx.occurred_date).sort();
  const rangeFrom = options.fromDate ?? (sortedDates[0] ?? '');
  const rangeTo = options.toDate ?? (sortedDates[sortedDates.length - 1] ?? '');
  const monthKeys = [...new Set(scoped.map((tx) => tx.month_key))].sort();

  // 3) 逐月汇总：直接调 totalsOf，绝不重写 direction 判断——
  //    两条路径口径必须同源，否则包里的数字和应用内页面会互相打架。
  const monthly = monthKeys.map((month) => {
    const totals = totalsOf(scoped.filter((tx) => tx.month_key === month));
    return {
      month,
      income: centsToYuan(totals.income_cents),
      expense: centsToYuan(totals.net_expense_cents),
      net: centsToYuan(totals.income_cents - totals.net_expense_cents),
    };
  });

  // 4) 分类占比：完全复用 categoryShares（净额口径），只补一个它不算的 count。
  const countByL1 = new Map<string, number>();
  for (const tx of scoped) {
    if (tx.direction === 'expense' || tx.direction === 'refund') {
      countByL1.set(tx.category_l1, (countByL1.get(tx.category_l1) ?? 0) + 1);
    }
  }
  const categories = categoryShares(scoped).shares.map((share) => ({
    name: share.name,
    direction: '支出',
    total: centsToYuan(share.cents),
    count: countByL1.get(share.l1) ?? 0,
    share: `${(share.ratio * 100).toFixed(1)}%`,
  }));

  // 5) 商户聚合 + 代号表。收入方向的对手方也要进代号表（同一张表），
  //    否则备注/最大支出里的收入对手方会漏出真名。
  const merchantAgg = new Map<string, MerchantAgg>();
  for (const tx of scoped) {
    const name = tx.counterparty?.trim();
    if (!name) continue; // 未记录对方不参与商户榜，展示层用占位文案
    const entry = merchantAgg.get(name) ?? { name, netCents: 0, count: 0 };
    if (tx.direction === 'expense') entry.netCents += tx.amount_cents;
    else if (tx.direction === 'refund') entry.netCents -= tx.amount_cents;
    if (tx.direction === 'expense' || tx.direction === 'refund') entry.count += 1;
    merchantAgg.set(name, entry);
  }
  // 排序 = 代号分配顺序：支出净额降序、同额按名称升序（纯比较，跨平台确定）。
  const ranked = [...merchantAgg.values()].sort(
    (a, b) => b.netCents - a.netCents || compareByName(a.name, b.name),
  );
  const codeMap = new Map<string, string>();
  ranked.forEach((entry, index) => {
    codeMap.set(entry.name, merchantCode(index));
  });

  /** 展示名：strip 一律当作未记录；pseudonym 查代号表；full 原名。 */
  const displayName = (raw: string | undefined): string => {
    const name = raw?.trim();
    if (!name || counterpartyMode === 'strip') return UNRECORDED_MERCHANT;
    if (counterpartyMode === 'full') return name;
    return codeMap.get(name) ?? UNRECORDED_MERCHANT;
  };

  // strip 模式下商户榜没有意义（所有名字都会变成占位文案），直接给空数组，
  // 让 AI 明确知道「这包不含商户维度」而不是看到一排「（未记录对方）」。
  const topMerchants =
    counterpartyMode === 'strip'
      ? []
      : ranked
          .filter((entry) => entry.netCents > 0)
          .slice(0, 10)
          .map((entry) => ({
            name: displayName(entry.name),
            total: centsToYuan(entry.netCents),
            count: entry.count,
          }));

  // 6) 冲动消费标记：flags 是「相对当月数据」的派生规则（大额看当月日均、
  //    习惯性看连续 7 天），跨月混算会让分母失真，所以必须逐月调用再汇总。
  const kindCounts: Record<string, number> = {};
  for (const month of monthKeys) {
    const monthTxs = scoped.filter((tx) => tx.month_key === month);
    const flagMap = computeMonthFlags(monthTxs, month);
    for (const hits of flagMap.values()) {
      for (const hit of hits) {
        kindCounts[hit.label] = (kindCounts[hit.label] ?? 0) + 1;
      }
    }
  }

  // 7) 最大单笔：复用 topExpenses（金额降序、只看活跃支出）
  const largestExpenses = topExpenses(scoped, 10).map((tx) => ({
    date: tx.occurred_date,
    amount: centsToYuan(tx.amount_cents),
    category: l1Name(tx.category_l1),
    merchant: displayName(tx.counterparty),
  }));

  const pack: AiPack = {
    schema_version: 1,
    pack_kind: 'ledger-ai-analysis',
    generated_at: new Date().toISOString(),
    privacy: {
      counterparty_mode: counterpartyMode,
      notes_included: includeNotes,
      statement: PRIVACY_STATEMENT,
    },
    summary: {
      range: { from: rangeFrom, to: rangeTo },
      months: monthKeys.length,
      tx_count: scoped.length,
      sources_covered: sourceBreakdown(scoped).map((item) => SOURCE_LABEL[item.source]),
    },
    monthly,
    categories,
    top_merchants: topMerchants,
    impulse: {
      kind_counts: kindCounts,
      most_worthless_count: kindCounts[FLAG_LABEL.most_worthless] ?? 0,
    },
    largest_expenses: largestExpenses,
    field_dictionary: FIELD_DICTIONARY,
    suggested_prompt: SUGGESTED_PROMPT,
  };

  // 8) 备注：默认不含（备注常含地址/人名）。包含时也只给「日期 + 脱敏商户 + 原文」
  //    三元组，不带金额与分类——给 AI 的上下文够用，隐私面尽量小。
  if (includeNotes) {
    pack.notes = scoped
      .filter((tx) => typeof tx.note === 'string' && tx.note.trim() !== '')
      .map((tx) => ({
        date: tx.occurred_date,
        merchant: displayName(tx.counterparty),
        note: tx.note as string,
      }));
  }

  return pack;
}
