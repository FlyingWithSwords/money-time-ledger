import { db } from '../db';
import type { ImportBatch } from '../../types';

/** 导入批次：一次导入一条记录，支持「撤销本次导入」。 */

export async function add(batch: ImportBatch): Promise<void> {
  await db.batches.put(batch);
}

export function list(): Promise<ImportBatch[]> {
  return db.batches.toArray().then((rows) => rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)));
}

export async function get(id: string): Promise<ImportBatch | undefined> {
  return db.batches.get(id);
}

export async function markUndone(id: string, at: string): Promise<void> {
  await db.batches.update(id, { undone_at: at });
}

export async function remove(id: string): Promise<void> {
  await db.batches.delete(id);
}

export function listRecent(limit = 10): Promise<ImportBatch[]> {
  return list().then((rows) => rows.slice(0, limit));
}
