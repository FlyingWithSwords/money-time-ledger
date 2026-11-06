import type { Direction } from '../types';

/**
 * 「买基金/理财/黄金的钱」识别。
 *
 * 为什么需要它：这笔钱在账单里常常被平台记成**支出**（支付宝「蚂蚁财富-定投转入」、
 * 微信「理财通买入」、银行「基金申购」）。但它不是消费，是资产形态转换：
 * 钱从左口袋进了右口袋。若按支出入账会出现两个后果：
 * 1. 当月支出凭空变大，结余变差；
 * 2. 趋势页的「整体收益」= 现金流 + 持仓浮盈，本金被扣一次、浮盈只加收益，
 *    等于**把本金重复扣了一遍**，看起来像巨亏。
 *
 * 所以入账时把它改判成 `transfer`（既不进收入也不进支出），并在 flags 里留标记，
 * 让这笔记录日后仍能被找出来（可筛选、可改回）。
 *
 * 设计原则：**宁可漏判，不可错判**。错杀一笔真实消费会静默吞掉支出，
 * 比漏掉一笔投资本金难发现得多。因此：
 * - 排除词（考试/培训/课程/咨询…）优先级最高，命中即放弃判定；
 * - 只认具体的平台名/产品名/动作词组合，不用「含赚/含投」这种宽泛字眼；
 * - 只在 direction === 'expense' 时判定（赎回、转账本来就不该动）。
 */

/** 落库标记：这笔记录曾被识别为投资本金（改判 transfer 的原因）。 */
export const INVEST_PRINCIPAL_FLAG = 'invest_principal';

/**
 * 一出现就**放弃**判定的词：这些词说明「基金/理财/黄金」只是话题而非交易标的。
 * 优先级高于所有正向特征 —— 宁可漏判。
 */
const EXCLUDE_HINTS = [
  '考试',
  '报名',
  '培训',
  '课程',
  '学费',
  '教材',
  '书籍',
  '资料',
  '会员',
  '咨询',
  '讲座',
  '科普',
  '广告',
  '招聘',
];

/**
 * 强特征：平台名 / 产品名 / 金融动作词。
 * 命中任意一个即可判定 —— 这些词出现在个人账单里几乎只有一种含义。
 */
const STRONG_HINTS = [
  // 平台
  '蚂蚁财富',
  '余额宝',
  '零钱通',
  '理财通',
  '天天基金',
  '蛋卷基金',
  '且慢',
  '好买基金',
  '京东金融',
  '招银理财',
  '兴银理财',
  // 动作（银行/券商口径）
  '基金申购',
  '基金定投',
  '基金买入',
  '买入基金',
  '申购基金',
  '认购基金',
  '基金转换',
  '证券转入',
  '银证转账',
  '证券保证金',
  // 黄金：积存金/纸黄金是投资品，不是首饰消费（首饰会是「金店」「珠宝」）
  '积存金',
  '纸黄金',
  '黄金定投',
  '黄金积存',
  '贵金属定投',
  // 场内基金/ETF：出现即标的本身
  'ETF',
];

/** 「基金」单独出现已经足够强：个人账单里的「基金」基本只有基金交易一种含义。 */
const FUND_WORD = '基金';

/** 泛特征：单独出现说明不了什么（「理财课」「股票群」），必须配动作词。 */
const GENERIC_HINTS = ['理财', '股票', '证券', '黄金', '金条'];

/** 与泛特征组合时才算数的动作词。注意**不含**「转出」：转出是卖出/提现，方向相反。 */
const ACTION_HINTS = ['转入', '买入', '申购', '认购', '定投', '转换', '存入', '买'];

export interface InvestPrincipalInput {
  direction: Direction;
  counterparty?: string;
  note?: string;
}

export interface InvestPrincipalResult {
  matched: boolean;
  /** 命中的关键词：写进导入报告，让用户知道这笔为什么被排除出支出 */
  keyword?: string;
}

/** 把对手方与备注拼成判定文本（去空白、统一小写以便匹配 ETF/etf）。 */
function judgeText(input: InvestPrincipalInput): string {
  const raw = `${input.counterparty ?? ''} ${input.note ?? ''}`.replace(/\s+/g, ' ').trim();
  return raw;
}

/**
 * 判断一笔**支出**是不是「买投资品」的本金。
 *
 * 命中顺序：排除词 → 强特征 → 「基金」→ 泛特征+动作词。
 */
export function detectInvestPrincipal(input: InvestPrincipalInput): InvestPrincipalResult {
  if (input.direction !== 'expense') return { matched: false };
  const text = judgeText(input);
  if (text.length === 0) return { matched: false };
  const upper = text.toUpperCase();

  if (EXCLUDE_HINTS.some((hint) => text.includes(hint))) return { matched: false };

  for (const hint of STRONG_HINTS) {
    const hit = hint === 'ETF' ? upper.includes('ETF') : text.includes(hint);
    if (hit) return { matched: true, keyword: hint };
  }

  if (text.includes(FUND_WORD)) return { matched: true, keyword: FUND_WORD };

  const generic = GENERIC_HINTS.find((hint) => text.includes(hint));
  if (generic) {
    const action = ACTION_HINTS.find((hint) => text.includes(hint));
    if (action) return { matched: true, keyword: `${generic}+${action}` };
  }

  return { matched: false };
}
