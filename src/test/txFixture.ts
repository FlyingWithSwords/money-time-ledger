import type { Cents, Transaction } from '../types';

interface Input {
  id: string;
  at: string;
  amount: number;
  l1?: string;
  l2?: string;
  direction?: Transaction['direction'];
  flags?: string[];
  dedupe_status?: Transaction['dedupe_status'];
  account_id?: string;
  source?: Transaction['source'];
  source_refs?: Transaction['source_refs'];
}

export function makeTx(input: Input): Transaction {
  const date = input.at.slice(0, 10);
  return {
    id: input.id,
    external_id: `ext_${input.id}`,
    dedupe_key: `key_${input.id}`,
    source: input.source ?? 'manual',
    source_refs: input.source_refs,
    direction: input.direction ?? 'expense',
    amount_cents: input.amount as Cents,
    occurred_at: input.at,
    occurred_date: date,
    month_key: date.slice(0, 7),
    category_l1: input.l1 ?? 'food',
    category_l2: input.l2 ?? 'lunch',
    account_id: input.account_id ?? 'acc_huabei',
    payment_channel: 'huabei',
    flags: input.flags ?? [],
    manual_edited: false,
    category_locked: false,
    dedupe_status: input.dedupe_status ?? 'clean',
    imported_at: input.at,
    created_at: input.at,
    updated_at: input.at,
  };
}
