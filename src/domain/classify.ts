import type { Category, CategoryRule, Cents, Direction } from '../types';
import { nowIso } from './date';
import { isIncomeL1, isKnownL1, OTHER_PENDING } from './categoryTree';

/**
 * 判定链（按序短路，见 02-arch.md §2.3-c）：
 * 0. category_locked → 直接采用
 * 1. source='user' 规则（priority 升序，同值取 updated_at 新者）
 * 2. source='learned'（confidence↓ → hit_count↓ → updated_at↓）
 * 3. 内置 keyword（关键词长度↓ 即更具体者胜 → 表序↑）
 * 4. time_window（仅用于 ①一级全无命中时兜底 ②二级缺失时补全）
 * 5. 兜底 other.pending
 * 组合语义：一级由 0–3 步最高命中决定；二级为空交给时间窗口补全；仍为空落该一级的「其他」。
 */

export type ClassifyBy = 'locked' | 'user' | 'learned' | 'keyword' | 'time' | 'fallback';

export interface ClassifyInput {
  counterparty?: string;
  note?: string;
  amount_cents: Cents;
  direction: Direction;
  occurred_at: string;
  channel?: string;
  /** 已锁定的分类：手工改过之后，后续导入不得覆盖。 */
  locked?: { l1: string; l2: string };
}

export interface ClassifyContext {
  rules: CategoryRule[];
  categories: Category[];
}

export interface ClassifyResult {
  l1: string;
  l2: string;
  by: ClassifyBy;
  ruleId?: string;
  confidence: number;
}

const KEYWORD_MIN_CONFIDENCE = 0.5;

/** 归一化文本：去空白与常见标点，全角转半角，避免"美团 外卖"匹配不到"美团外卖"。 */
export function normalizeText(raw: string | undefined | null): string {
  if (!raw) return '';
  return String(raw)
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000]/g, '')
    .replace(/[·、,，.。:：;；"'`~!@#$%^&*()\[\]{}<>?/\\|_\-+=]/g, '')
    .toLowerCase();
}

function haystackOf(input: ClassifyInput): string {
  return normalizeText(`${input.counterparty ?? ''} ${input.note ?? ''}`);
}

function minutesOfDay(iso: string): number {
  const hh = Number(iso.slice(11, 13));
  const mm = Number(iso.slice(14, 16));
  return (Number.isFinite(hh) ? hh : 0) * 60 + (Number.isFinite(mm) ? mm : 0);
}

interface MatchOutcome {
  matched: boolean;
  /** 命中的最长关键词长度，用于"更具体者胜" */
  specificity: number;
}

/** 单条规则是否命中；返回命中的关键词长度用于排序。 */
export function matchRule(rule: CategoryRule, input: ClassifyInput): MatchOutcome {
  const { match } = rule;
  let matched = true;
  let specificity = 0;

  if (match.keywords && match.keywords.length > 0) {
    const hay = haystackOf(input);
    let best = 0;
    for (const keyword of match.keywords) {
      const needle = normalizeText(keyword);
      if (needle && hay.includes(needle) && needle.length > best) best = needle.length;
    }
    if (best === 0) matched = false;
    specificity = Math.max(specificity, best);
  }

  if (matched && match.merchant_pattern) {
    const hay = haystackOf(input);
    const needle = normalizeText(match.merchant_pattern);
    if (!needle || !hay.includes(needle)) matched = false;
    else specificity = Math.max(specificity, needle.length);
  }

  if (matched && match.amount_max_cents !== undefined) {
    if (Math.abs(input.amount_cents) > match.amount_max_cents) matched = false;
  }

  if (matched && (match.time_from || match.time_to)) {
    const minutes = minutesOfDay(input.occurred_at);
    const from = match.time_from ? hhmm(match.time_from) : 0;
    const to = match.time_to ? hhmm(match.time_to) : 24 * 60;
    // 跨零点窗口（23:00–05:00）用分裂区间判断
    if (from <= to) {
      if (minutes < from || minutes > to) matched = false;
    } else if (minutes < from && minutes > to) {
      matched = false;
    }
  }

  if (matched && match.weekday && match.weekday.length > 0) {
    const [y, m, d] = input.occurred_at.slice(0, 10).split('-').map(Number);
    const weekday = new Date(y, (m || 1) - 1, d || 1).getDay();
    if (!match.weekday.includes(weekday)) matched = false;
  }

  if (matched && match.channel && match.channel.length > 0) {
    if (!input.channel || !match.channel.includes(input.channel)) matched = false;
  }

  return { matched, specificity };
}

function hhmm(text: string): number {
  const [h, m] = text.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function scopeAllows(rule: CategoryRule, direction: Direction): boolean {
  // 退款冲正沿用支出侧规则（冲减原分类）
  const incomeSide = direction === 'income';
  const ruleIncomeSide = isIncomeL1(rule.target_l1);
  if (incomeSide) return ruleIncomeSide;
  if (direction === 'transfer') return true;
  return !ruleIncomeSide;
}

function byPriority(a: CategoryRule, b: CategoryRule): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.updated_at < b.updated_at ? 1 : -1;
}

function byLearned(a: CategoryRule, b: CategoryRule): number {
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  if (b.hit_count !== a.hit_count) return b.hit_count - a.hit_count;
  return a.updated_at < b.updated_at ? 1 : -1;
}

function hasCategory(ctx: ClassifyContext, id: string): boolean {
  return ctx.categories.some((category) => category.id === id && !category.archived);
}

/** 把 (l1, l2) 收敛到库里真实存在的分类；二级缺失落该一级的「其他」。 */
export function ensureCategory(
  l1: string,
  l2: string | undefined,
  ctx: ClassifyContext,
): { l1: string; l2: string } | null {
  if (!isKnownL1(l1) || !hasCategory(ctx, `${l1}.other`)) return null;
  if (l2 && hasCategory(ctx, `${l1}.${l2}`)) return { l1, l2 };
  return { l1, l2: 'other' };
}

export function classify(input: ClassifyInput, ctx: ClassifyContext): ClassifyResult {
  const enabled = ctx.rules.filter((rule) => rule.enabled);

  // 0. 已锁定
  if (input.locked && input.locked.l1) {
    const locked = ensureCategory(input.locked.l1, input.locked.l2, ctx);
    if (locked) {
      return { l1: locked.l1, l2: locked.l2, by: 'locked', confidence: 1 };
    }
  }

  const scoped = enabled.filter((rule) => scopeAllows(rule, input.direction));

  // 1. 用户规则
  const userHit = scoped
    .filter((rule) => rule.source === 'user' && matchRule(rule, input).matched)
    .sort(byPriority)[0];
  if (userHit) return finish(userHit, 'user', input, ctx);

  // 2. 学习规则（时间窗口规则不参与"一级"判定）
  const learnedHit = scoped
    .filter((rule) => rule.source === 'learned' && rule.kind !== 'time_window')
    .filter((rule) => rule.confidence >= KEYWORD_MIN_CONFIDENCE && matchRule(rule, input).matched)
    .sort(byLearned)[0];
  if (learnedHit) return finish(learnedHit, 'learned', input, ctx);

  // 3. 内置关键词：命中最长关键词者胜，长度相同按表序（priority）
  const keywordHits = scoped
    .filter((rule) => rule.kind === 'keyword' && rule.source === 'builtin')
    .map((rule) => ({ rule, ...matchRule(rule, input) }))
    .filter((hit) => hit.matched)
    .sort((a, b) => {
      if (b.specificity !== a.specificity) return b.specificity - a.specificity;
      return a.rule.priority - b.rule.priority;
    });
  if (keywordHits.length > 0) {
    return finish(keywordHits[0].rule, 'keyword', input, ctx);
  }

  // 4. 时间窗口兜底
  const timeHit = scoped
    .filter((rule) => rule.kind === 'time_window')
    .filter((rule) => matchRule(rule, input).matched)
    .sort(byPriority)[0];
  if (timeHit) {
    const target = ensureCategory(timeHit.target_l1, timeHit.target_l2, ctx);
    if (target) {
      return { l1: target.l1, l2: target.l2, by: 'time', ruleId: timeHit.id, confidence: timeHit.confidence };
    }
  }

  // 5. 兜底
  if (input.direction === 'income') {
    return { l1: 'income_other', l2: 'other', by: 'fallback', confidence: 0.1 };
  }
  const [l1, l2] = OTHER_PENDING.split('.');
  return { l1, l2, by: 'fallback', confidence: 0.1 };
}

/** 命中规则的收口：一级取规则目标，二级缺失时交给时间窗口补全。 */
function finish(
  rule: CategoryRule,
  by: ClassifyBy,
  input: ClassifyInput,
  ctx: ClassifyContext,
): ClassifyResult {
  let l2 = rule.target_l2;
  if (!l2) {
    l2 = fillL2FromTime(rule.target_l1, input, ctx);
  }
  const target = ensureCategory(rule.target_l1, l2, ctx);
  if (!target) {
    if (input.direction === 'income') {
      return { l1: 'income_other', l2: 'other', by: 'fallback', confidence: 0.1 };
    }
    const [l1, plain] = OTHER_PENDING.split('.');
    return { l1, l2: plain, by: 'fallback', confidence: 0.1 };
  }
  return { l1: target.l1, l2: target.l2, by, ruleId: rule.id, confidence: rule.confidence };
}

/** 二级缺失时用同为该一级的时间窗口规则补全（"美团/饿了么 → 餐饮，按时间落午/晚餐"）。 */
function fillL2FromTime(l1: string, input: ClassifyInput, ctx: ClassifyContext): string | undefined {
  const rule = ctx.rules
    .filter((item) => item.enabled && item.kind === 'time_window' && item.target_l1 === l1 && item.target_l2)
    .filter((item) => matchRule(item, input).matched)
    .sort(byPriority)[0];
  return rule?.target_l2;
}

export interface LearnInput {
  counterparty?: string;
  note?: string;
  direction: Direction;
}

/**
 * 用户手改一次分类 → upsert 一条 source='learned' 的规则。
 * 同目标再命中 +0.05（上限 0.99）；目标互斥 −0.1；低于 0.5 自动停用。
 */
export function learn(
  input: LearnInput,
  target: { l1: string; l2: string },
  existing?: CategoryRule,
): CategoryRule {
  const merchant = normalizeText(input.counterparty ?? input.note ?? '');
  if (!merchant) {
    throw new Error('learn: 缺少可学习的商户关键词');
  }
  const now = nowIso();
  if (existing) {
    const sameTarget = existing.target_l1 === target.l1 && (existing.target_l2 ?? '') === target.l2;
    const nextConfidence = sameTarget
      ? Math.min(0.99, existing.confidence + 0.05)
      : Math.max(0, existing.confidence - 0.1);
    return {
      ...existing,
      target_l1: target.l1,
      target_l2: target.l2,
      confidence: nextConfidence,
      hit_count: existing.hit_count + 1,
      enabled: nextConfidence >= KEYWORD_MIN_CONFIDENCE,
      updated_at: now,
    };
  }
  return {
    id: `rule_learned_${merchant.slice(0, 16)}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'learned',
    source: 'learned',
    priority: 0,
    match: { merchant_pattern: merchant },
    target_l1: target.l1,
    target_l2: target.l2,
    confidence: 0.9,
    hit_count: 1,
    enabled: true,
    updated_at: now,
  };
}

/** 冲突裁决单独暴露，便于设置页展示"为什么是这条规则生效"。 */
export function resolveConflict(rules: CategoryRule[], input: ClassifyInput): CategoryRule | undefined {
  const scoped = rules.filter((rule) => rule.enabled && scopeAllows(rule, input.direction));
  const userHit = scoped
    .filter((rule) => rule.source === 'user' && matchRule(rule, input).matched)
    .sort(byPriority)[0];
  if (userHit) return userHit;
  const learnedHit = scoped
    .filter((rule) => rule.source === 'learned' && matchRule(rule, input).matched)
    .sort(byLearned)[0];
  if (learnedHit) return learnedHit;
  return scoped
    .filter((rule) => rule.kind === 'keyword')
    .map((rule) => ({ rule, ...matchRule(rule, input) }))
    .filter((hit) => hit.matched)
    .sort((a, b) => {
      if (b.specificity !== a.specificity) return b.specificity - a.specificity;
      return a.rule.priority - b.rule.priority;
    })[0]?.rule;
}
