import { db } from '../db';
import type { ReviewCard } from '../../types';
import { reviewCardId } from '../../domain/review';

/** 复盘卡快照：生成即固化，不随后续补录改写。 */

export async function getByMonth(monthKey: string): Promise<ReviewCard | undefined> {
  return db.reviews.get(reviewCardId(monthKey));
}

export function list(): Promise<ReviewCard[]> {
  return db.reviews.toArray().then((rows) => rows.sort((a, b) => (a.month_key < b.month_key ? 1 : -1)));
}

export async function upsert(card: ReviewCard): Promise<void> {
  await db.reviews.put(card);
}

export async function remove(monthKey: string): Promise<void> {
  await db.reviews.delete(reviewCardId(monthKey));
}
