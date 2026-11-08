import type { Cents, Direction, Transaction } from '../types';
import { normalizeText } from './classify';

/**
 * 收入来源识别（工资 / 补贴）。
 *
 * 解决的问题：工资、实习补贴、餐补这类钱常常是**从银行卡转到微信/支付宝**的，
 * 账单里「收/支」列写的是 `/` 或「不计收支」——按平台口径它是中性交易，
 * 于是被安静地判成 transfer，既不算收入也不算支出，一个月少看几千块。
 *
 * 但与投资本金相反，这里**不内置自动改判**：
 * 「转账」里混着信用卡还款、零钱提现、亲友往来，靠关键词猜「这算收入」比漏判更危险。
 * 所以内置词表只用来**找候选**，最终哪些来源算收入由用户在设置里多选确认，
 * 确认结果落进 settings.income_sources，之后导入按白名单精确匹配。
 *
 * 为什么不用 CategoryRule 表达：规则只改分类、不改方向（classify 的入参 direction 是只读的），
 * 而这里要解决的恰恰是方向错了。方向与分类必须一起改，所以单独一条设置项。
 */

export type IncomeSourceL1 = 'salary' | 'allowance';

/** 用户确认过的收入来源。 */
export interface IncomeSource {
  /** 归一化后的匹配关键词（含它就判收入） */
  keyword: string;
  /** 原始名称，仅供界面展示 */
  label: string;
  l1: IncomeSourceL1;
  l2: string;
}

const SALARY_HINTS = [
  '代发工资',
  '工资',
  '薪资',
  '薪金',
  '薪酬',
  '月薪',
  '底薪',
  '绩效',
  '奖金',
  '加班费',
  '劳务费',
  '劳务报酬',
  '代发',
];
const ALLOWANCE_HINTS = ['补贴', '津贴', '餐补', '饭补', '交通补', '通讯补', '电话补', '住房补', '租房补', '高温补', '补助'];

/**
 * 命中即**不**判为收入。
 *
 * 社保/公积金/个税是从工资里扣出去的钱，账单摘要常写成「工资代扣社保」；
 * 报销虽然也是进账，但它是垫付返还、不是劳动报酬，混进「工资补贴」会让
 * 「我这个月工资多少」这个最常问的问题失真——宁可让它留在待分类。
 */
const INCOME_EXCLUDE = ['社保', '公积金', '个税', '所得税', '代扣', '代缴', '缴纳', '发票', '报销'];

export interface DetectIncomeInput {
  direction: Direction;
  counterparty?: string;
  note?: string;
}

export interface IncomeDetection {
  l1: IncomeSourceL1;
  l2: string;
  /** 命中的线索词，界面用来说明「为什么判断成工资」 */
  hint: string;
  /** 'builtin' = 内置词表扫出来的候选；'whitelist' = 用户确认过的来源 */
  by: 'builtin' | 'whitelist';
}

/** 二级细分：具体补贴名优先，其次奖金，剩下的按工资落月薪。 */
function l2For(word: string): string {
  if (word.includes('餐补') || word.includes('饭补')) return 'allowance';
  if (word.includes('交通补') || word.includes('通讯补') || word.includes('电话补')) return 'allowance';
  if (word.includes('住房补') || word.includes('租房补') || word.includes('高温补')) return 'allowance';
  if (word === '奖金' || word === '绩效' || word === '加班费') return 'bonus';
  if (ALLOWANCE_HINTS.includes(word) || word.includes('补贴') || word.includes('津贴') || word === '补助') return 'allowance';
  return 'monthly';
}

function haystack(counterparty: string | undefined, note: string | undefined): string {
  return normalizeText(`${counterparty ?? ''} ${note ?? ''}`);
}

/**
 * 内置词表判定：只用于**生成候选**，不参与入账改判。
 *
 * 已退款/冲正的行直接跳过：钱确实回来过，改判成收入会和退款冲减重复计算。
 */
export function detectBuiltinIncome(input: DetectIncomeInput): IncomeDetection | null {
  if (input.direction === 'income' || input.direction === 'refund') return null;
  const hay = haystack(input.counterparty, input.note);
  if (!hay) return null;
  if (INCOME_EXCLUDE.some((word) => hay.includes(word))) return null;
  // 更具体的词优先（「代发工资」优于「工资」），长度相同按表序
  const candidates = [...SALARY_HINTS, ...ALLOWANCE_HINTS]
    .filter((word) => hay.includes(word))
    .sort((a, b) => b.length - a.length);
  const hint = candidates[0];
  if (!hint) return null;
  /**
   * 一级统一落「工资补贴」：用户要的就是把工资与补贴放在一起看一个总数。
   * 「津贴补贴」一级保留给存量数据与用户自建，内置词表不再往里写——
   * 否则同一笔餐补可能落在两个一级，筛选时漏账。
   */
  return {
    l1: 'salary',
    l2: l2For(hint),
    hint,
    by: 'builtin',
  };
}

/**
 * 用户白名单判定：导入时真正决定方向的这一步。
 *
 * 与内置词表的区别是**只认用户勾过的关键词**，不做任何模糊猜测；
 * 排除词同样生效——用户勾了「XX公司」，账单里出现「XX公司-社保代扣」仍然不算收入。
 */
export function detectWhitelistedIncome(
  input: DetectIncomeInput,
  sources: readonly IncomeSource[],
): IncomeDetection | null {
  if (input.direction === 'income' || input.direction === 'refund') return null;
  if (sources.length === 0) return null;
  const hay = haystack(input.counterparty, input.note);
  if (!hay) return null;
  if (INCOME_EXCLUDE.some((word) => hay.includes(word))) return null;
  let best: IncomeSource | undefined;
  let bestLen = 0;
  for (const source of sources) {
    const needle = normalizeText(source.keyword);
    if (needle && hay.includes(needle) && needle.length > bestLen) {
      best = source;
      bestLen = needle.length;
    }
  }
  if (!best) return null;
  return { l1: best.l1, l2: best.l2, hint: best.label, by: 'whitelist' };
}

export interface IncomeCandidate extends IncomeSource {
  count: number;
  cents: Cents;
  /** 当前被记成哪些方向，展示用 */
  directions: Direction[];
  /** 涉及的流水 id，应用时按 id 精确改判 */
  ids: string[];
  /** 最近一笔的日期，让用户认得出是哪笔 */
  latest_date: string;
}

/**
 * 扫描候选来源：把「当前不是收入、但摘要像工资/补贴」的记录按**对方名**聚合。
 *
 * 按对方名而不是按命中的线索词聚合，是因为用户要选的单位是「来源」（哪家公司、哪个代发渠道），
 * 而不是「含哪个字」。对方名缺失时才退回用命中的线索词当 key——那样勾一次就能覆盖
 * 这批「备注里只写了工资」的记录。
 */
export function scanIncomeCandidates(txs: readonly Transaction[]): IncomeCandidate[] {
  const buckets = new Map<string, IncomeCandidate>();
  for (const tx of txs) {
    if (tx.deleted_at) continue;
    const hit = detectBuiltinIncome({ direction: tx.direction, counterparty: tx.counterparty, note: tx.note });
    if (!hit) continue;
    const name = (tx.counterparty ?? '').trim();
    const key = normalizeText(name) || normalizeText(hit.hint);
    if (!key) continue;
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
      existing.cents = (existing.cents + tx.amount_cents) as Cents;
      if (!existing.directions.includes(tx.direction)) existing.directions.push(tx.direction);
      existing.ids.push(tx.id);
      if (tx.occurred_date > existing.latest_date) existing.latest_date = tx.occurred_date;
      continue;
    }
    buckets.set(key, {
      keyword: key,
      label: name || hit.hint,
      l1: hit.l1,
      l2: hit.l2,
      count: 1,
      cents: tx.amount_cents as Cents,
      directions: [tx.direction],
      ids: [tx.id],
      latest_date: tx.occurred_date,
    });
  }
  // 金额大的排前面：工资通常几千、补贴几百，先让用户看见值得配的那一条
  return [...buckets.values()].sort((a, b) => b.cents - a.cents || b.count - a.count);
}

/** 白名单去重合并：同一关键词只保留一条，后写入的覆盖前面的分类选择。 */
export function mergeIncomeSources(
  existing: readonly IncomeSource[],
  incoming: readonly IncomeSource[],
): IncomeSource[] {
  const map = new Map<string, IncomeSource>();
  for (const item of [...existing, ...incoming]) {
    const key = normalizeText(item.keyword);
    if (!key) continue;
    map.set(key, { ...item, keyword: key });
  }
  return [...map.values()];
}
