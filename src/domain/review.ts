import { daysInMonth } from './date';
import type { Cents, Goal, ReviewCard, ReviewPayload, Transaction } from '../types';
import { categoryShares, totalsOf, topExpenses } from './aggregate';
import { computeMonthFlags, summarizeImpulse } from './flags';
import { asCents } from './money';
import { WAGE_BASIS_LABEL, costToTime, type WageResult } from './timecost';
import { isActiveTx } from './txUtils';
import { l1Name } from './categoryTree';

/**
 * M3 月度复盘卡片。
 * 关键设计：payload 是**生成时点的快照**，落库后不随后续补录改写 ——
 * 复盘卡是可回看/可分享的历史结论，不是实时汇总。
 */

export const REVIEW_SCHEMA_VERSION = 1;

export function reviewCardId(monthKey: string): string {
  return `review:${monthKey}`;
}

export interface ReviewInput {
  monthKey: string;
  monthTxs: readonly Transaction[];
  prevMonthTxs: readonly Transaction[];
  goals: readonly Goal[];
  /** 截至该月末的累计结余（分），用于储蓄目标进度 */
  cumulativeSavingsCents: Cents;
  wage: WageResult;
  workdayHours: number;
  /** 生成时的「待分类」笔数，用于水印一致性 */
  pendingUncategorized: number;
}

export function buildReviewPayload(input: ReviewInput): ReviewPayload {
  const totals = totalsOf(input.monthTxs);
  const shares = categoryShares(input.monthTxs);
  const priciest = topExpenses(input.monthTxs, 1)[0];
  const flagMap = computeMonthFlags([...input.monthTxs], input.monthKey);
  const impulse = summarizeImpulse([...input.monthTxs], flagMap, totals.net_expense_cents);
  const prevTotals = totalsOf(input.prevMonthTxs);
  const momDelta = totals.net_expense_cents - prevTotals.net_expense_cents;

  const mostWorthless = input.monthTxs
    .filter((tx) => isActiveTx(tx) && tx.direction === 'expense' && tx.flags?.includes('most_worthless'))
    .map((tx) => ({ id: tx.id, cents: tx.amount_cents }));

  const timeCost =
    input.wage.cents !== null && input.wage.cents > 0
      ? costToTime(totals.net_expense_cents, input.wage.cents, input.workdayHours, input.wage.basis ?? 'manual')
      : null;

  return {
    totals: {
      expense_cents: totals.expense_cents,
      income_cents: totals.income_cents,
      net_cents: totals.balance_cents,
    },
    top3: shares.shares.slice(0, 3).map((share) => ({
      category_l1: share.l1,
      cents: share.cents,
      ratio: share.ratio,
    })),
    priciest: priciest
      ? {
          id: priciest.id,
          cents: priciest.amount_cents,
          category_l2: `${l1Name(priciest.category_l1)}·${priciest.category_l2}`,
          date: priciest.occurred_date,
        }
      : undefined,
    most_worthless: mostWorthless,
    impulse: {
      count: impulse.count,
      cents: asCents(impulse.cents),
      ratio: impulse.ratio,
      kinds: impulse.kinds,
    },
    mom: {
      expense_delta_cents: asCents(momDelta),
      expense_delta_ratio: prevTotals.net_expense_cents !== 0 ? momDelta / prevTotals.net_expense_cents : 0,
    },
    goal_progress: input.goals
      .filter((goal) => goal.status !== 'archived')
      .map((goal) => {
        const percent =
          goal.target_cents > 0 ? Math.max(0, Math.min(1, input.cumulativeSavingsCents / goal.target_cents)) : 0;
        const expected = expectedProgressCents(goal, input.monthKey);
        const behind = Math.max(0, expected - input.cumulativeSavingsCents);
        return { goal_id: goal.id, percent, behind_cents: asCents(behind) };
      }),
    time_cost_line: {
      hours: timeCost ? timeCost.hours : 0,
      basis: input.wage.basis ? WAGE_BASIS_LABEL[input.wage.basis] : '未设置时薪',
    },
    pending_uncategorized: input.pendingUncategorized,
  };
}

export function buildReviewCard(input: ReviewInput, generatedAt: string): ReviewCard {
  return {
    id: reviewCardId(input.monthKey),
    month_key: input.monthKey,
    generated_at: generatedAt,
    schema_version: REVIEW_SCHEMA_VERSION,
    payload: buildReviewPayload(input),
  };
}

/** 按时间进度推算"此刻本该存到多少"，用于判断落后多少。 */
function expectedProgressCents(goal: Goal, monthKey: string): number {
  const created = Date.parse(goal.created_at.slice(0, 10));
  const deadline = Date.parse(goal.deadline);
  const [y, m] = monthKey.split('-').map(Number);
  const monthEnd = new Date(y, m, 0).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(deadline) || deadline <= created) return goal.target_cents;
  const ratio = Math.max(0, Math.min(1, (Math.min(monthEnd, deadline) - created) / (deadline - created)));
  return Math.round(goal.target_cents * ratio);
}

/** 复盘卡在分享时的默认文案：**不含绝对金额**（PRD §4 M3 边界）。 */
export function shareLinesWithoutAmount(card: ReviewCard): string[] {
  const payload = card.payload;
  const lines: string[] = [];
  lines.push(`${card.month_key} 月复盘`);
  if (payload.top3[0]) {
    lines.push(`钱主要花在：${l1Name(payload.top3[0].category_l1)}（占 ${Math.round(payload.top3[0].ratio * 100)}%）`);
  }
  lines.push(`冲动标记 ${payload.impulse.count} 笔，占支出 ${Math.round(payload.impulse.ratio * 100)}%`);
  if (payload.time_cost_line.hours > 0) {
    lines.push(`这个月花掉的时间 ≈ ${payload.time_cost_line.hours} 小时`);
  }
  lines.push(payload.mom.expense_delta_cents <= 0 ? '比上月更省' : '比上月多花');
  return lines;
}

export function monthDays(monthKey: string): number {
  return daysInMonth(monthKey);
}
