import { db } from '../db';
import type { Account } from '../../types';

/** 账户（含负债账户）。花呗/信用卡未还属负债，直接影响净资产口径。 */

export function list(): Promise<Account[]> {
  return db.accounts.filter((row) => !row.archived).toArray().then((rows) => rows.sort((a, b) => a.sort - b.sort));
}

export async function byId(id: string): Promise<Account | undefined> {
  return db.accounts.get(id);
}

export async function upsert(account: Account): Promise<void> {
  await db.accounts.put(account);
}

export async function setOpeningBalance(id: string, cents: number): Promise<void> {
  await db.accounts.update(id, { opening_balance_cents: cents as Account['opening_balance_cents'] });
}

export async function remove(id: string): Promise<void> {
  await db.accounts.delete(id);
}
