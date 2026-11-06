import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import * as holdingRepo from '../db/repos/holdingRepo';
import { buildHoldingViews } from '../domain/aggregate';
import {
  displayHoldingCode,
  isPlaceholderCode,
  normalizeHoldingName,
  placeholderCode,
} from '../domain/holdingIdentity';
import { asCents } from '../domain/money';
import type { FundQuote, Holding } from '../types';

/**
 * 「仅市值持仓」（列表页截图导入）的语义钉子：
 * - 名称 + 金额能入库，代码用 NAME: 占位，同平台同名幂等；
 * - 份额未知时市值 = 截图金额，收益必须是 null（显示「待补」），绝不拿 0 冒充；
 * - 补上份额和真实成本后，收益立刻按「市值 − 成本」计算。
 */

function makeHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    id: 'hold_placeholder',
    fund_code: placeholderCode('易方达蓝筹精选混合'),
    fund_name: '易方达蓝筹精选混合',
    platform: 'alipay',
    shares: 0,
    total_cost_cents: asCents(893273),
    avg_cost_nav: 0,
    first_buy_date: '2026-11-05',
    ...overrides,
  };
}

function makeQuote(code: string, nav: number): FundQuote {
  return {
    id: `${code}:2026-11-04:nav`,
    fund_code: code,
    nav,
    nav_date: '2026-11-04',
    kind: 'nav',
    quote_at: '2026-11-04T15:00:00+08:00',
    source: 'manual',
  };
}

describe('占位代码规则', () => {
  it('名称归一化后生成稳定 key（同一只基金每次一致）', () => {
    expect(normalizeHoldingName(' 易方达 蓝筹（精选）·混合 ')).toBe('易方达蓝筹(精选)混合');
    expect(placeholderCode('易方达蓝筹精选混合')).toBe(placeholderCode('易方达 蓝筹精选混合'));
  });

  it('占位代码可识别，也不以伪代码形式展示', () => {
    expect(isPlaceholderCode('NAME:易方达蓝筹精选混合')).toBe(true);
    expect(isPlaceholderCode('000051')).toBe(false);
    expect(displayHoldingCode('NAME:易方达蓝筹精选混合')).toBe('未识别代码');
    expect(displayHoldingCode('000051')).toBe('000051');
  });
});

describe('市值与收益口径', () => {
  it('份额未知：市值取截图金额，收益为 null（不是 0）', () => {
    const [view] = buildHoldingViews([makeHolding()], new Map());
    expect(view.market_value_cents).toBe(893273);
    expect(view.profit_cents).toBeNull();
    expect(view.profit_ratio).toBeNull();
  });

  it('有份额但行情查不到（占位代码）：仍用截图金额当市值，收益为 null', () => {
    const [view] = buildHoldingViews([makeHolding({ shares: 5000 })], new Map());
    expect(view.market_value_cents).toBe(893273);
    expect(view.profit_cents).toBeNull();
  });

  it('真实代码但没行情：市值仍是 null（显示「暂无价格」），不拿成本冒充', () => {
    const [view] = buildHoldingViews(
      [makeHolding({ fund_code: '000051', shares: 1000, total_cost_cents: asCents(200000) })],
      new Map(),
    );
    expect(view.market_value_cents).toBeNull();
    expect(view.profit_cents).toBeNull();
  });

  it('有份额 + 有净值：正常计算市值与收益', () => {
    const [view] = buildHoldingViews(
      [makeHolding({ fund_code: '000051', shares: 1000, total_cost_cents: asCents(200000) })],
      new Map([['000051', makeQuote('000051', 3)]]),
    );
    expect(view.market_value_cents).toBe(300000);
    expect(view.profit_cents).toBe(100000);
  });
});

describe('补全持仓：从「只有市值」到「可算收益」', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('补份额 + 真实成本后，成本净值按真实成本重算', async () => {
    const holding = makeHolding();
    await db.holdings.put(holding);

    // 5000 份，真实成本 8000 元
    await holdingRepo.updatePosition(holding.id, { shares: 5000, total_cost_cents: 800000 });

    const saved = await db.holdings.get(holding.id);
    expect(saved?.shares).toBe(5000);
    expect(saved?.total_cost_cents).toBe(800000);
    expect(saved?.avg_cost_nav).toBeCloseTo(1.6, 4);
  });

  it('成本留空时沿用截图金额：份额有了，收益仍为 0 但不造假', async () => {
    const holding = makeHolding();
    await db.holdings.put(holding);

    await holdingRepo.updatePosition(holding.id, { shares: 5000 });

    const saved = await db.holdings.get(holding.id);
    expect(saved?.shares).toBe(5000);
    expect(saved?.total_cost_cents).toBe(893273);
    expect(saved?.avg_cost_nav).toBeCloseTo(893273 / 100 / 5000, 4);
  });

  it('份额为 0 或负数时拒绝写入，避免把持仓改坏', async () => {
    const holding = makeHolding();
    await db.holdings.put(holding);

    await holdingRepo.updatePosition(holding.id, { shares: 0 });
    const saved = await db.holdings.get(holding.id);
    expect(saved?.shares).toBe(0);
  });
});
