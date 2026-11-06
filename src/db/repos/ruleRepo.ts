import { db } from '../db';
import type { CategoryRule } from '../../types';

/** 分类规则读写。内置规则可停用可编辑，学习规则自动维护。 */

export function list(): Promise<CategoryRule[]> {
  return db.rules.toArray();
}

export function listEnabled(): Promise<CategoryRule[]> {
  return db.rules.filter((rule) => rule.enabled).toArray();
}

export async function upsert(rule: CategoryRule): Promise<void> {
  await db.rules.put(rule);
}

export async function upsertMany(rules: CategoryRule[]): Promise<void> {
  if (rules.length === 0) return;
  await db.rules.bulkPut(rules);
}

export async function remove(id: string): Promise<void> {
  const found = await db.rules.get(id);
  if (!found || found.source === 'builtin') return;
  await db.rules.delete(id);
}

export async function toggle(id: string, enabled: boolean): Promise<void> {
  await db.rules.update(id, { enabled });
}

export async function bumpHit(id: string): Promise<void> {
  const found = await db.rules.get(id);
  if (!found) return;
  await db.rules.update(id, { hit_count: found.hit_count + 1 });
}

export async function findByMerchantPattern(pattern: string): Promise<CategoryRule | undefined> {
  const rows = await db.rules.where('source').equals('learned').toArray();
  return rows.find((rule) => rule.match.merchant_pattern === pattern);
}

/** 用户手改分类后写回学习规则（同商户下次直接套用）。 */
export async function saveLearned(rule: CategoryRule): Promise<void> {
  await db.rules.put(rule);
}

/** 判定链需要的规则快照（只取启用的，按优先级预排序）。 */
export async function loadForClassify(): Promise<CategoryRule[]> {
  const rows = await listEnabled();
  return rows.sort((a, b) => {
    const rank = (rule: CategoryRule): number => {
      if (rule.source === 'user') return 0;
      if (rule.source === 'learned') return 1;
      if (rule.kind === 'keyword') return 2;
      return 3;
    };
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    return a.priority - b.priority;
  });
}
