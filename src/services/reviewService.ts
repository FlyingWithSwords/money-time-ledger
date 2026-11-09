import * as reviewRepo from '../db/repos/reviewRepo';
import * as settingsRepo from '../db/repos/settingsRepo';
import * as transactionRepo from '../db/repos/transactionRepo';
import { nowIso, shiftMonth } from '../domain/date';
import { reviewCardId, buildReviewCard } from '../domain/review';
import { asCents } from '../domain/money';
import type { ReviewCard } from '../types';
import { resolveHourlyWage } from '../domain/timecost';

/**
 * 复盘卡生成服务：把"读数据 + 算快照 + 落库"收在一处。
 * 纯本地计算，无需后台；每月 1 日首次打开时自动补上月卡片。
 */

export async function generateReviewCard(monthKey: string): Promise<ReviewCard> {
  const [monthTxs, prevTxs, settings, realHours, allTxs] = await Promise.all([
    transactionRepo.listByMonth(monthKey),
    transactionRepo.listByMonth(shiftMonth(monthKey, -1)),
    settingsRepo.getWageSettings(),
    settingsRepo.getRealWageHours(),
    transactionRepo.listAll(),
  ]);

  const recentJobs = allTxs
    .filter((tx) => tx.direction === 'income' && tx.category_l1 === 'job')
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))
    .slice(0, 3);
  const wage = resolveHourlyWage(settings, {
    income_cents: asCents(recentJobs.reduce((acc, tx) => acc + tx.amount_cents, 0)),
    hours: realHours,
    count: recentJobs.length,
  });

  const pending = monthTxs.filter(
    (tx) => tx.category_l1 === 'other' && tx.category_l2 === 'pending' && !tx.deleted_at,
  ).length;

  const card = buildReviewCard(
    {
      monthKey,
      monthTxs,
      prevMonthTxs: prevTxs,
      wage,
      workdayHours: settings.workday_hours,
      pendingUncategorized: pending,
    },
    nowIso(),
  );
  await reviewRepo.upsert(card);
  return card;
}

export async function getOrCreateReviewCard(monthKey: string): Promise<ReviewCard> {
  const existing = await reviewRepo.getByMonth(monthKey);
  if (existing) return existing;
  return generateReviewCard(monthKey);
}

/** 每月 1 日首次打开 App：若上月有账且没有卡片，自动生成一次。 */
export async function autoGenerateLastMonthCard(): Promise<ReviewCard | null> {
  const now = new Date();
  if (now.getDate() !== 1) return null;
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastMonth = shiftMonth(currentMonth, -1);
  const existing = await reviewRepo.getByMonth(lastMonth);
  if (existing) return null;
  const txs = await transactionRepo.listByMonth(lastMonth);
  if (txs.length === 0) return null;
  return generateReviewCard(lastMonth);
}

export function reviewRoute(monthKey: string): string {
  return `/review/${monthKey}`;
}

export { reviewCardId };
