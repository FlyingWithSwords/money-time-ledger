import { describe, expect, it } from 'vitest';
import { buildBuiltinRules } from '../db/seed';
import { classify } from '../domain/classify';
import { asCents } from '../domain/money';
import type { CategoryRule } from '../types';
import { buildCategories } from './fixtures';

const categories = buildCategories();
const builtinRules = buildBuiltinRules();

function run(input: {
  counterparty?: string;
  amount: number;
  at: string;
  direction?: 'expense' | 'income' | 'refund' | 'transfer';
  rules?: CategoryRule[];
  locked?: { l1: string; l2: string };
}) {
  return classify(
    {
      counterparty: input.counterparty,
      amount_cents: asCents(input.amount),
      direction: input.direction ?? 'expense',
      occurred_at: input.at,
      channel: 'huabei',
      locked: input.locked,
    },
    { rules: input.rules ?? builtinRules, categories },
  );
}

describe('classify: 判定链优先级', () => {
  it('关键词定一级，时间窗口补二级（美团 12:30 → 餐饮/午餐）', () => {
    const result = run({ counterparty: '美团', amount: 1500, at: '2026-10-01T12:30:00+08:00' });
    expect(result.by).toBe('keyword');
    expect(result.l1).toBe('food');
    expect(result.l2).toBe('lunch');
  });

  it('同一关键词换时间 → 晚餐', () => {
    const result = run({ counterparty: '美团外卖', amount: 2500, at: '2026-10-01T19:10:00+08:00' });
    expect(result.l1).toBe('food');
    expect(result.l2).toBe('dinner');
  });

  it('具体关键词胜出（青桔 → 交通/共享单车）', () => {
    const result = run({ counterparty: '青桔单车', amount: 4, at: '2026-10-01T08:00:00+08:00' });
    expect(result.l1).toBe('transport');
    expect(result.l2).toBe('bike');
  });

  it('锁定分类优先于一切规则', () => {
    const result = run({
      counterparty: '美团',
      amount: 1500,
      at: '2026-10-01T12:30:00+08:00',
      locked: { l1: 'shopping', l2: 'daily' },
    });
    expect(result.by).toBe('locked');
    expect(result.l1).toBe('shopping');
    expect(result.l2).toBe('daily');
  });

  it('自定义规则优先于内置关键词', () => {
    const userRule: CategoryRule = {
      id: 'user_1',
      kind: 'keyword',
      source: 'user',
      priority: 0,
      match: { keywords: ['美团'] },
      target_l1: 'shopping',
      target_l2: 'daily',
      confidence: 1,
      hit_count: 0,
      enabled: true,
      updated_at: '2026-10-01T00:00:00.000Z',
    };
    const result = run({
      counterparty: '美团',
      amount: 1500,
      at: '2026-10-01T12:30:00+08:00',
      rules: [...builtinRules, userRule],
    });
    expect(result.by).toBe('user');
    expect(result.l1).toBe('shopping');
  });

  it('学习规则优先于内置关键词，但低于自定义规则', () => {
    const learned: CategoryRule = {
      id: 'learned_1',
      kind: 'learned',
      source: 'learned',
      priority: 0,
      match: { merchant_pattern: '美团' },
      target_l1: 'entertainment',
      target_l2: 'other',
      confidence: 0.9,
      hit_count: 3,
      enabled: true,
      updated_at: '2026-10-02T00:00:00.000Z',
    };
    const result = run({
      counterparty: '美团',
      amount: 1500,
      at: '2026-10-01T12:30:00+08:00',
      rules: [...builtinRules, learned],
    });
    expect(result.by).toBe('learned');
    expect(result.l1).toBe('entertainment');
  });

  it('低于 0.5 置信度的学习规则自动失效', () => {
    const learned: CategoryRule = {
      id: 'learned_2',
      kind: 'learned',
      source: 'learned',
      priority: 0,
      match: { merchant_pattern: '美团' },
      target_l1: 'entertainment',
      target_l2: 'other',
      confidence: 0.4,
      hit_count: 9,
      enabled: true,
      updated_at: '2026-10-02T00:00:00.000Z',
    };
    const result = run({
      counterparty: '美团',
      amount: 1500,
      at: '2026-10-01T12:30:00+08:00',
      rules: [...builtinRules, learned],
    });
    expect(result.by).toBe('keyword');
    expect(result.l1).toBe('food');
  });

  it('全无命中 → 兜底 other.pending（凌晨 500 元陌生商户）', () => {
    const result = run({ counterparty: '某某不知名商户', amount: 50000, at: '2026-10-01T03:10:00+08:00' });
    expect(result.by).toBe('fallback');
    expect(result.l1).toBe('other');
    expect(result.l2).toBe('pending');
  });

  it('收入侧走收入树（工资关键词）', () => {
    const result = run({
      counterparty: '实习工资',
      amount: 220000,
      at: '2026-10-10T10:00:00+08:00',
      direction: 'income',
    });
    expect(result.l1).toBe('salary');
    expect(result.l2).toBe('monthly');
  });

  it('退款冲正沿用支出侧规则', () => {
    const result = run({
      counterparty: '美团',
      amount: 1500,
      at: '2026-10-01T12:30:00+08:00',
      direction: 'refund',
    });
    expect(result.l1).toBe('food');
  });
});
