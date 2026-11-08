import type { Cents, Plan, Transaction } from '../types';
import { asCents, formatCents } from './money';

/**
 * 计划进度计算（纯函数，不碰数据库）。
 *
 * 口径只认「已关联到这条计划」的流水，不按分类或时间窗口推算：
 * 用户拖进来的就是他要算的，没拖进来的哪怕分类完全一致也不算——
 * 记账工具最忌讳替用户「猜」他攒了多少钱。
 *
 * 方向规则：
 * - `save`（攒钱）只累计收入。支出拖进来直接忽略，不计入 skipped 的话
 *   进度条会莫名其妙不动而界面又不说原因。
 * - `spend`（消费）累计支出，退款按负额冲减。收入拖进来同样忽略。
 */

export interface PlanProgress {
  /** 已关联流水的累计额（save=收入，spend=支出净额） */
  linked_cents: Cents;
  target_cents: Cents;
  /** 0–100，超支可超过 100 */
  percent: number;
  /** 累计是否已达到目标 */
  reached: boolean;
  /** 还差多少（已达标为 0） */
  remaining_cents: Cents;
  /** 超出目标多少（未超为 0） */
  over_cents: Cents;
  /** 实际计入的流水条数 */
  linked_count: number;
  /** 方向不符被忽略的条数 */
  skipped_count: number;
  /**
   * 预算内完成省下的钱。
   * 只有「已标记完成」且最终花费低于目标时才有值；未完成是 null（还没定论）。
   * save 计划恒为 null——攒得多余不是「省下」，是攒得比计划多。
   */
  saved_cents: Cents | null;
}

/** save 计划累计收入；spend 计划累计支出净额（退款冲减）。 */
export function linkedCents(plan: Plan, txs: readonly Transaction[]): { cents: Cents; counted: number; skipped: number } {
  let cents = 0;
  let counted = 0;
  let skipped = 0;
  for (const tx of txs) {
    if (tx.deleted_at) continue;
    if (plan.kind === 'save') {
      if (tx.direction !== 'income') {
        skipped += 1;
        continue;
      }
      cents += tx.amount_cents;
      counted += 1;
      continue;
    }
    if (tx.direction === 'expense') {
      cents += tx.amount_cents;
      counted += 1;
    } else if (tx.direction === 'refund') {
      cents -= tx.amount_cents;
      counted += 1;
    } else {
      skipped += 1;
    }
  }
  return { cents: asCents(cents), counted, skipped };
}

export function planProgress(plan: Plan, linkedTxs: readonly Transaction[]): PlanProgress {
  const live = linkedCents(plan, linkedTxs);
  /**
   * 已完成的计划读冻结值。
   * 不读冻结值就会出现「完成时省了 320，三个月后回看变成省了 180」——
   * 因为期间删过一笔关联流水，而那个结论早已被用户当成事实。
   */
  const settled = plan.status === 'done' && plan.settled_cents !== undefined ? plan.settled_cents : live.cents;
  const target = plan.target_cents;
  const percent = target > 0 ? Math.round((settled / target) * 1000) / 10 : 0;
  const remaining = Math.max(0, target - settled);
  const over = Math.max(0, settled - target);
  const saved =
    plan.kind === 'spend' && plan.status === 'done' && settled < target ? asCents(target - settled) : null;
  return {
    linked_cents: asCents(settled),
    target_cents: target,
    percent,
    reached: settled >= target,
    remaining_cents: asCents(remaining),
    over_cents: asCents(over),
    linked_count: live.counted,
    skipped_count: live.skipped,
    saved_cents: saved,
  };
}

/** 一句话结论，列表里直接显示，不用用户自己算。 */
export function progressSummary(plan: Plan, progress: PlanProgress): string {
  if (plan.status === 'done') {
    if (progress.saved_cents !== null && progress.saved_cents > 0) {
      return `预算内完成，省下 ${formatCents(progress.saved_cents, { symbol: false })} 元`;
    }
    if (progress.over_cents > 0) return `超支 ${formatCents(progress.over_cents, { symbol: false })} 元完成`;
    return '已按计划完成';
  }
  if (progress.reached) {
    return plan.kind === 'save' ? '攒够了，可以准备消费了' : '达到计划金额，可以打勾完成';
  }
  const tail = `还差 ${formatCents(progress.remaining_cents, { symbol: false })} 元`;
  return plan.kind === 'save' ? `${tail}攒够` : `${tail}到计划金额`;
}

/** 把一批关联流水按计划 id 分组，供列表页一次算完。 */
export function groupEntriesByPlan(
  entries: readonly { plan_id: string; tx_id: string }[],
  txById: ReadonlyMap<string, Transaction>,
): Map<string, Transaction[]> {
  const map = new Map<string, Transaction[]>();
  for (const entry of entries) {
    const tx = txById.get(entry.tx_id);
    if (!tx) continue;
    const list = map.get(entry.plan_id);
    if (list) list.push(tx);
    else map.set(entry.plan_id, [tx]);
  }
  return map;
}
