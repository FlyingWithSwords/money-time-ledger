import type { Transaction } from '../types';
import { formatCents } from './money';
import { isActiveTx } from './txUtils';

/**
 * 跨平台对账匹配引擎（纯逻辑，不依赖 Dexie，可独立测试）。
 *
 * 它要解决的问题：同一笔消费「美团外卖 35.00」可能同时出现在支付宝账单、
 * 微信账单和自制表格里。各算一遍统计就虚高。同源去重（dedupe_key）拦不住
 * 这种情况——微信和支付宝给同一笔交易的单号/时间本来就不同。
 *
 * 交互裁定：**只产出候选，绝不自动合并**。两杯同价柠檬水是两笔真实消费，
 * 自动判定不可信，最终裁决必须交给用户逐条确认（确认/否定的写路径见
 * transactionRepo.confirmPairMatch 与 dismissalRepo.dismissPair）。
 */

export interface CandidatePair {
  /** tx id，约定 a 是较早那笔（确认合并时以 a 为 keep，来源合并顺序更自然）。 */
  a: string;
  b: string;
  /** 判定依据，用户可见中文文案。文案必须可被用户验证，不能只给一个分数。 */
  reasons: string[];
  /** 排序用，越大越像。金额一致是配对前提，不参与加分。 */
  score: number;
}

export interface CrossMatchOptions {
  /** 日期窗口（天，闭区间），默认 3。支付与扣款通知常有时差，但差太久更像巧合。 */
  dateWindowDays?: number;
}

const DEFAULT_DATE_WINDOW_DAYS = 3;
/** Dice 相似度阈值：低于它就不说「相似」，改说「请核对」。 */
const COUNTERPARTY_SIMILARITY_THRESHOLD = 0.6;

/**
 * 否定裁决的 key：两笔 id 排序后用 '|' 拼接。
 * 与 dismissalRepo.pairKey 必须逐字节一致——这里刻意不 import dismissalRepo
 * （那会连带引入 Dexie，破坏本模块的纯函数性），所以两边各自实现这一行
 * 逻辑，改动任何一边都必须同步另一边。
 */
export function pairDismissalKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

/**
 * 对手方归一化：去空白与常见分隔标点，中英文都按字符处理。
 * **保留 `*`**——支付宝把姓名脱敏成「*义」，星号是身份语义的一部分，
 * 「扫钱码付款-给*义」与「给*义」能否互相包含取决于它。
 */
function normalizeCounterparty(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/[\s\u3000·•・\-—–_~/\\|,，.。;；:：!！?？()（）[\]【】{}｛｝「」『』“”"'‘’]/g, '')
    .toLowerCase();
}

/** 字符二元组计数（Dice 系数用）。 */
function bigramCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i += 1) {
    const gram = text.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/** Dice 字符二元组相似度：2·|A∩B| / (|A|+|B|)，对短商户名比编辑距离更稳。 */
function diceSimilarity(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) {
    // 单字符串没法切成二元组，退化为全等判断
    return a === b ? 1 : 0;
  }
  const countsA = bigramCounts(a);
  const countsB = bigramCounts(b);
  let overlap = 0;
  for (const [gram, count] of countsA) {
    overlap += Math.min(count, countsB.get(gram) ?? 0);
  }
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

/**
 * 两天（'YYYY-MM-DD'）相差的天数。
 * 拼上 T00:00:00Z 走 UTC 解析：纯日期串不带时区，各环境解析结果一致。
 */
function daysBetween(dateA: string, dateB: string): number {
  const ms = Date.parse(`${dateA}T00:00:00Z`) - Date.parse(`${dateB}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

interface Verdict {
  reason: string;
  score: number;
}

function dateVerdict(dayDiff: number): Verdict {
  if (dayDiff === 0) return { reason: '同一天交易', score: 3 };
  // 差 1~2 天很常见（支付与扣款通知的时间差），差 3 天以上大概率只是同价巧合
  const score = dayDiff === 1 ? 2 : dayDiff === 2 ? 1 : 0;
  return {
    reason: `日期相差 ${dayDiff} 天，可能是支付与扣款的时间差，也可能只是巧合`,
    score,
  };
}

function counterpartyVerdict(a: string | undefined, b: string | undefined): Verdict {
  const na = normalizeCounterparty(a);
  const nb = normalizeCounterparty(b);
  // 有字段但归一化后为空（比如对手方就一个 '-'）视为缺信息，不说「不同」冤枉它
  if (na.length === 0 || nb.length === 0) {
    return { reason: '有一方缺少对手方信息', score: 0 };
  }
  // 包含关系优先于相似度：财付通-美团外卖 ⊃ 美团外卖，是同一笔的最强信号
  if (na.includes(nb) || nb.includes(na)) {
    return { reason: '对手方吻合（一方包含另一方）', score: 3 };
  }
  const similarity = diceSimilarity(na, nb);
  if (similarity >= COUNTERPARTY_SIMILARITY_THRESHOLD) {
    return { reason: `对手方相似度 ${Math.round(similarity * 100)}%`, score: 2 };
  }
  // 都有对手方但对不上：这恰恰是用户最需要人工看的组合，负分排到后面但不隐藏
  return { reason: '对手方不同——请核对是否真的同一笔', score: -2 };
}

/** 排序比较器：日期 → 时间 → id，保证 a/b 在 pair 里的顺序确定。 */
function compareTxOrder(x: Transaction, y: Transaction): number {
  if (x.occurred_date !== y.occurred_date) return x.occurred_date < y.occurred_date ? -1 : 1;
  if (x.occurred_at !== y.occurred_at) return x.occurred_at < y.occurred_at ? -1 : 1;
  return x.id < y.id ? -1 : 1;
}

/**
 * 找出疑似「同一笔」的跨来源交易对。
 *
 * 性能：先按 (direction, amount_cents) 分桶，桶内按日期排序后只在窗口内滑动
 * 比较——不做 n² 全量两两比。金额要求**完全一致**（差一分钱的配对理由说不清，
 * 用户也无法验证），所以分桶本身就是精确过滤。
 */
export function findCrossSourcePairs(
  txs: readonly Transaction[],
  dismissedKeys: ReadonlySet<string>,
  options: CrossMatchOptions = {},
): CandidatePair[] {
  const windowDays = options.dateWindowDays ?? DEFAULT_DATE_WINDOW_DAYS;
  if (txs.length < 2) return [];

  // transfer（充值/还款）跨平台噪音太大，不参与；软删与已裁决 duplicate 由 isActiveTx 排除
  const eligible = txs.filter((tx) => isActiveTx(tx) && tx.direction !== 'transfer');

  const buckets = new Map<string, Transaction[]>();
  for (const tx of eligible) {
    const bucketKey = `${tx.direction}|${tx.amount_cents}`;
    const bucket = buckets.get(bucketKey) ?? [];
    bucket.push(tx);
    buckets.set(bucketKey, bucket);
  }

  const pairs: CandidatePair[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    bucket.sort(compareTxOrder);
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const earlier = bucket[i];
        const later = bucket[j];
        const dayDiff = daysBetween(later.occurred_date, earlier.occurred_date);
        // 桶已按日期升序：一旦超过窗口，后面的只会更远，直接换下一个 i
        if (dayDiff > windowDays) break;
        // 同源（同一个凭证导出的）不配——那是同源去重的职责，不归跨平台对账管
        if (earlier.source === later.source) continue;
        const key = pairDismissalKey(earlier.id, later.id);
        if (dismissedKeys.has(key)) continue;

        const byDate = dateVerdict(dayDiff);
        const byCounterparty = counterpartyVerdict(earlier.counterparty, later.counterparty);
        pairs.push({
          a: earlier.id,
          b: later.id,
          reasons: [
            `金额完全一致 ${formatCents(earlier.amount_cents)}`,
            byDate.reason,
            byCounterparty.reason,
          ],
          score: byDate.score + byCounterparty.score,
        });
      }
    }
  }

  // 排序时要用 pair.a 的日期，先建 id → tx 映射，避免比较器里 O(n) 查找
  const byId = new Map<string, Transaction>();
  for (const tx of eligible) byId.set(tx.id, tx);

  // score 降序（最像的排最前），再按 pair 中较早那笔的日期降序（近的账优先处理）
  pairs.sort((x, y) => {
    if (y.score !== x.score) return y.score - x.score;
    const dx = byId.get(x.a)?.occurred_date ?? '';
    const dy = byId.get(y.a)?.occurred_date ?? '';
    if (dx !== dy) return dx < dy ? 1 : -1;
    return x.a < y.a ? 1 : -1;
  });
  return pairs;
}
