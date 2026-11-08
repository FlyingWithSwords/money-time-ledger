import { describe, expect, it } from 'vitest';
import { groupEntriesByPlan, linkedCents, planProgress, progressSummary } from '../domain/planProgress';
import type { Cents, Plan } from '../types';
import { makeTx } from './txFixture';

function makePlan(patch: Partial<Plan> = {}): Plan {
  return {
    id: 'p1',
    title: '台式主机',
    kind: 'save',
    target_cents: 800000 as Cents,
    status: 'active',
    created_at: '2026-09-01T00:00:00+08:00',
    sort: 0,
    ...patch,
  };
}

const income = (id: string, amount: number, at = '2026-10-01T09:00:00+08:00') =>
  makeTx({ id, at, amount, direction: 'income', l1: 'salary', l2: 'monthly' });

const expense = (id: string, amount: number, at = '2026-10-02T09:00:00+08:00') =>
  makeTx({ id, at, amount, direction: 'expense', l1: 'shopping', l2: 'digital' });

describe('计划进度：攒钱只认收入，消费只认支出', () => {
  it('攒钱计划累计收入，支出被忽略并单独计数', () => {
    const result = linkedCents(makePlan({ kind: 'save' }), [
      income('a', 300000),
      income('b', 200000),
      expense('c', 9999),
    ]);
    expect(result.cents).toBe(500000);
    expect(result.counted).toBe(2);
    // 不报 skipped 的话进度条不动而界面不说原因，用户会以为功能坏了
    expect(result.skipped).toBe(1);
  });

  it('消费计划累计支出，退款按负额冲减', () => {
    const result = linkedCents(makePlan({ kind: 'spend' }), [
      expense('a', 120000),
      makeTx({ id: 'b', at: '2026-10-03T09:00:00+08:00', amount: 20000, direction: 'refund' }),
      income('c', 500000),
    ]);
    expect(result.cents).toBe(100000);
    expect(result.counted).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it('已软删的流水不计入，也不计 skipped', () => {
    const result = linkedCents(makePlan(), [
      income('a', 300000),
      makeTx({
        id: 'b',
        at: '2026-10-01T09:00:00+08:00',
        amount: 500000,
        direction: 'income',
        deleted_at: '2026-10-02T00:00:00.000Z',
      }),
    ]);
    expect(result.cents).toBe(300000);
    expect(result.counted).toBe(1);
    expect(result.skipped).toBe(0);
  });
});

describe('计划进度：目标换算', () => {
  it('未达标时算还差多少，超额时算超支多少', () => {
    const plan = makePlan({ target_cents: 800000 as Cents });
    const partial = planProgress(plan, [income('a', 300000)]);
    expect(partial.reached).toBe(false);
    expect(partial.remaining_cents).toBe(500000);
    expect(partial.over_cents).toBe(0);
    expect(partial.percent).toBe(37.5);

    const over = planProgress(plan, [income('a', 900000)]);
    expect(over.reached).toBe(true);
    expect(over.remaining_cents).toBe(0);
    expect(over.over_cents).toBe(100000);
    expect(over.percent).toBe(112.5);
  });

  it('目标金额为 0 时不除零，percent 记 0 而不是 NaN', () => {
    const result = planProgress(makePlan({ target_cents: 0 as Cents }), [income('a', 100)]);
    expect(result.percent).toBe(0);
    expect(Number.isNaN(result.percent)).toBe(false);
  });
});

describe('计划进度：完成后冻结结论', () => {
  const spentPlan = makePlan({ kind: 'spend', target_cents: 500000 as Cents });

  it('未完成时 saved_cents 是 null——还没定论，不能先报省了多少', () => {
    const result = planProgress(spentPlan, [expense('a', 300000)]);
    expect(result.saved_cents).toBeNull();
  });

  it('预算内完成：省下的钱 = 目标 − 实付', () => {
    const result = planProgress(
      { ...spentPlan, status: 'done', settled_cents: 380000 as Cents },
      [expense('a', 380000)],
    );
    expect(result.saved_cents).toBe(120000);
  });

  it('完成后改账不影响结论：读的是冻结值而不是实时累计', () => {
    const frozen = { ...spentPlan, status: 'done' as const, settled_cents: 380000 as Cents };
    const afterEdits = planProgress(frozen, [expense('a', 460000)]);
    expect(afterEdits.linked_cents).toBe(380000);
    expect(afterEdits.saved_cents).toBe(120000);
  });

  it('超支完成不报「省下」，saved_cents 为 null（不是负数）', () => {
    const result = planProgress(
      { ...spentPlan, status: 'done', settled_cents: 620000 as Cents },
      [expense('a', 620000)],
    );
    expect(result.saved_cents).toBeNull();
    expect(result.over_cents).toBe(120000);
  });

  it('攒钱计划即使完成也不报「省下」——攒得多不是省得多', () => {
    const result = planProgress(
      { ...makePlan(), status: 'done', settled_cents: 900000 as Cents },
      [income('a', 900000)],
    );
    expect(result.saved_cents).toBeNull();
  });
});

describe('计划进度：一句话结论', () => {
  it('攒钱达标提示可以准备消费', () => {
    const plan = makePlan({ target_cents: 100 as Cents });
    expect(progressSummary(plan, planProgress(plan, [income('a', 100)]))).toContain('攒够了');
  });

  it('消费达标提示可以打勾', () => {
    const plan = makePlan({ kind: 'spend', target_cents: 100 as Cents });
    expect(progressSummary(plan, planProgress(plan, [expense('a', 120)]))).toContain('可以打勾');
  });

  it('预算内完成的文案带出省下多少', () => {
    const plan = makePlan({ kind: 'spend', target_cents: 50000 as Cents, status: 'done', settled_cents: 38000 as Cents });
    expect(progressSummary(plan, planProgress(plan, [expense('a', 38000)]))).toBe('预算内完成，省下 120.00 元');
  });

  it('未达标时给出还差多少', () => {
    const plan = makePlan({ target_cents: 50000 as Cents });
    expect(progressSummary(plan, planProgress(plan, [income('a', 12000)]))).toContain('还差 380.00');
  });
});

describe('计划关联分组', () => {
  it('按 plan_id 分组，找不到的流水直接跳过（关联被删不会让页面崩）', () => {
    const a = income('a', 100);
    const grouped = groupEntriesByPlan(
      [
        { plan_id: 'p1', tx_id: 'a' },
        { plan_id: 'p2', tx_id: 'ghost' },
      ],
      new Map([['a', a]]),
    );
    expect(grouped.get('p1')).toEqual([a]);
    expect(grouped.has('p2')).toBe(false);
  });
});
