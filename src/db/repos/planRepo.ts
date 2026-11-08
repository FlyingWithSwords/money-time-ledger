import { db } from '../db';
import type { Cents, Plan, PlanEntry } from '../../types';
import { linkedCents } from '../../domain/planProgress';
import { isActiveTx } from '../../domain/txUtils';

/** 消费计划备忘录的读写。 */

export function entryId(planId: string, txId: string): string {
  return `${planId}:${txId}`;
}

export function list(): Promise<Plan[]> {
  return db.plans.toArray().then((rows) => rows.sort((a, b) => a.sort - b.sort || (a.created_at < b.created_at ? 1 : -1)));
}

export function getById(id: string): Promise<Plan | undefined> {
  return db.plans.get(id);
}

export async function create(input: {
  id: string;
  title: string;
  kind: Plan['kind'];
  target_cents: Cents;
  note?: string;
}): Promise<Plan> {
  const all = await db.plans.toArray();
  const plan: Plan = {
    id: input.id,
    title: input.title,
    kind: input.kind,
    target_cents: input.target_cents,
    note: input.note,
    status: 'active',
    created_at: new Date().toISOString(),
    sort: all.length,
  };
  await db.plans.put(plan);
  return plan;
}

export async function update(id: string, patch: Partial<Omit<Plan, 'id'>>): Promise<void> {
  await db.plans.update(id, patch);
}

/** 删除计划：连带清掉关联表，不碰流水本身。 */
export async function remove(id: string): Promise<void> {
  await db.transaction('rw', db.plans, db.plan_entries, async () => {
    await db.plan_entries.where('plan_id').equals(id).delete();
    await db.plans.delete(id);
  });
}

/**
 * 标记完成：把当前累计额冻结进 settled_cents。
 *
 * 「省下多少钱」是按这个冻结值算的，所以必须在改状态之前算好——
 * 顺序颠倒会拿到 undefined，界面显示成「省下 0 元」。
 */
export async function complete(id: string): Promise<void> {
  const plan = await db.plans.get(id);
  if (!plan || plan.status === 'done') return;
  const entries = await db.plan_entries.where('plan_id').equals(id).toArray();
  const txs = await db.transactions.bulkGet(entries.map((entry) => entry.tx_id));
  const alive = txs.filter((tx): tx is NonNullable<typeof tx> => !!tx && isActiveTx(tx));
  const { cents } = linkedCents(plan, alive);
  await db.plans.update(id, {
    status: 'done',
    completed_at: new Date().toISOString(),
    settled_cents: cents,
  });
}

/** 取消完成：清掉冻结值，回到按实时累计计算。 */
export async function reopen(id: string): Promise<void> {
  await db.plans.update(id, { status: 'active', completed_at: undefined, settled_cents: undefined });
}

export async function archive(id: string): Promise<void> {
  await db.plans.update(id, { status: 'archived' });
}

/**
 * 把若干流水挂到计划上。
 *
 * 用 put 而不是 add：主键是 `plan:tx`，重复拖同一笔是幂等的覆盖，
 * 不会因为用户手抖拖了两次就翻倍累计。返回**新挂上**的条数。
 */
export async function link(planId: string, txIds: readonly string[]): Promise<number> {
  if (txIds.length === 0) return 0;
  const now = new Date().toISOString();
  let added = 0;
  await db.transaction('rw', db.plan_entries, async () => {
    for (const txId of txIds) {
      const id = entryId(planId, txId);
      const existing = await db.plan_entries.get(id);
      if (existing) continue;
      const entry: PlanEntry = { id, plan_id: planId, tx_id: txId, created_at: now };
      await db.plan_entries.put(entry);
      added += 1;
    }
  });
  return added;
}

export async function unlink(planId: string, txId: string): Promise<void> {
  await db.plan_entries.delete(entryId(planId, txId));
}

export function entriesOf(planId: string): Promise<PlanEntry[]> {
  return db.plan_entries.where('plan_id').equals(planId).toArray();
}

export function allEntries(): Promise<PlanEntry[]> {
  return db.plan_entries.toArray();
}

/** 某笔流水被挂到了哪些计划（流水行上标「已加入计划」用）。 */
export async function plansOfTx(txId: string): Promise<PlanEntry[]> {
  return db.plan_entries.where('tx_id').equals(txId).toArray();
}
