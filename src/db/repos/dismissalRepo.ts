import { db } from '../db';

/**
 * 跨平台对账的**否定裁决**仓储。
 *
 * 用户点「不是，记住这个判断」时写入这里；匹配引擎每次跑之前把全量 key
 * 捞出来当过滤器，被否决过的对不再骚扰用户。
 *
 * 工程取舍：pair_dismissals **不加入备份表清单**（backup.ts 的 TABLE_NAMES
 * 是硬编码清单，不按 db.tables 自动枚举，本表天然不会被收进备份）。对账
 * 裁决是「这台机器的工作状态」而不是「这个人的账」：换一台设备，那边可能
 * 根本没有这两笔交易，把 key 同步过去只会留下悬空引用，还可能反过来压制
 * 那台机器上合法的候选对。
 */

/** 裁决 key：两笔 id 排序后用 '|' 拼接，(a,b) 与 (b,a) 永远命中同一条。 */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

/** 记住「这两笔不是同一笔」。重复点同一个对是幂等的（put 覆盖同 id）。 */
export async function dismissPair(a: string, b: string): Promise<void> {
  const id = pairKey(a, b);
  await db.pair_dismissals.put({ id, created_at: new Date().toISOString() });
}

/** 全量取裁决 key，给匹配引擎当过滤器。数据量是「人工点过的对」，几百条封顶，全量取没有压力。 */
export async function listDismissedKeys(): Promise<string[]> {
  const rows = await db.pair_dismissals.toArray();
  return rows.map((row) => row.id);
}
