import { db } from '../db';
import type { Goal } from '../../types';

/** M4 储蓄目标。进度只在展示层按累计结余增量计算，不落库。 */

export function list(): Promise<Goal[]> {
  return db.goals.toArray().then((rows) => rows.sort((a, b) => a.created_at.localeCompare(b.created_at)));
}

export function listActive(): Promise<Goal[]> {
  return db.goals
    .where('status')
    .equals('active')
    .toArray()
    .then((rows) => rows.sort((a, b) => a.deadline.localeCompare(b.deadline)));
}

export async function upsert(goal: Goal): Promise<void> {
  await db.goals.put(goal);
}

export async function remove(id: string): Promise<void> {
  await db.goals.delete(id);
}

export async function markAchieved(id: string): Promise<void> {
  await db.goals.update(id, { status: 'achieved' });
}
