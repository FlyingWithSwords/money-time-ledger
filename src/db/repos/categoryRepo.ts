import { db } from '../db';
import type { Category } from '../../types';

/** 分类维护。内置项只可改名与排序、不可删除；二级不允许自由文本入账。 */

export function list(): Promise<Category[]> {
  return db.categories.filter((row) => !row.archived).toArray();
}

export function listAll(): Promise<Category[]> {
  return db.categories.toArray();
}

export function listByScope(scope: 'expense' | 'income'): Promise<Category[]> {
  return db.categories
    .where('direction_scope')
    .equals(scope)
    .toArray()
    .then((rows) => rows.filter((row) => !row.archived));
}

export async function byId(id: string): Promise<Category | undefined> {
  return db.categories.get(id);
}

export async function upsert(category: Category): Promise<void> {
  await db.categories.put(category);
}

export async function rename(id: string, l2Name: string): Promise<void> {
  const found = await db.categories.get(id);
  if (!found) return;
  await db.categories.update(id, { l2_name: l2Name });
}

export async function setArchived(id: string, archived: boolean): Promise<void> {
  const found = await db.categories.get(id);
  if (!found) return;
  // 内置项不可删除（只可改名/排序），这里仅允许归档自建项
  if (found.builtin && archived) return;
  await db.categories.update(id, { archived });
}

/** 新增自建二级：id 仍为 `一级.二级`，禁止自由文本分类直接入账。 */
export async function addChild(l1: string, l2Id: string, l2Name: string): Promise<Category> {
  const existing = await db.categories.get(`${l1}.${l2Id}`);
  if (existing) return existing;
  const siblings = await db.categories.where('l1_id').equals(l1).toArray();
  const template = siblings[0];
  const category: Category = {
    id: `${l1}.${l2Id}`,
    l1_id: l1,
    l1_name: template?.l1_name ?? l1,
    l2_id: l2Id,
    l2_name: l2Name,
    direction_scope: template?.direction_scope ?? 'expense',
    sort: siblings.length,
    icon: template?.icon ?? '🧾',
    builtin: false,
    archived: false,
  };
  await db.categories.add(category);
  return category;
}

/** 合并分类：把 fromL1 名下的交易全部改挂到 toL1，然后归档 fromL1 的二级。 */
export async function mergeInto(fromL1: string, toL1: string, toL2: string): Promise<number> {
  const rows = await db.transactions.where('category_l1').equals(fromL1).toArray();
  const now = new Date().toISOString();
  await db.transactions.bulkUpdate(
    rows.map((row) => ({
      key: row.id,
      changes: { category_l1: toL1, category_l2: toL2, category_locked: true, updated_at: now },
    })),
  );
  const fromCategories = await db.categories.where('l1_id').equals(fromL1).toArray();
  await db.categories.bulkUpdate(
    fromCategories
      .filter((category) => !category.builtin)
      .map((category) => ({ key: category.id, changes: { archived: true } })),
  );
  return rows.length;
}

/** 供判定链使用的内存视图。 */
export interface CategoryTree {
  l1List: Array<{ id: string; name: string; icon: string; scope: 'expense' | 'income' }>;
  byL1: Map<string, Category[]>;
  all: Category[];
}

export async function loadTree(): Promise<CategoryTree> {
  const all = await list();
  const byL1 = new Map<string, Category[]>();
  const l1Map = new Map<string, { id: string; name: string; icon: string; scope: 'expense' | 'income' }>();
  for (const category of all) {
    const bucket = byL1.get(category.l1_id) ?? [];
    bucket.push(category);
    bucket.sort((a, b) => a.sort - b.sort);
    byL1.set(category.l1_id, bucket);
    if (!l1Map.has(category.l1_id)) {
      l1Map.set(category.l1_id, {
        id: category.l1_id,
        name: category.l1_name,
        icon: category.icon,
        scope: category.direction_scope === 'income' ? 'income' : 'expense',
      });
    }
  }
  const l1List = [...l1Map.values()].sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'expense' ? -1 : 1));
  return { l1List, byL1, all };
}
