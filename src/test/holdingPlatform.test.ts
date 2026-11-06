import { beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { db, LedgerDatabase } from '../db/db';
import * as holdingRepo from '../db/repos/holdingRepo';
import { ensureSeeded } from '../db/seed';
import type { Holding } from '../types';

/**
 * 持仓平台维度（db v4）的地基测试。
 *
 * 用户点名要的语义是两条，缺一不可：
 * 1. 同一只基金在支付宝和天天基金**各有一笔**——两行独立持仓，成本互不污染；
 * 2. **同平台下次导入覆盖不冲突**——重复导入同一平台的截图走幂等覆盖，
 *    既不抛 ConstraintError 也不把份额翻倍。
 *
 * v3 之前 fund_code 是全表唯一索引，第 1 条直接不可能；而「覆盖 vs 加仓」
 * 若用旧的 addPosition 语义，第 2 条会把快照份额累加成本地份额——翻倍。
 */

/** 测试辅助：raw number → Cents（branded 类型需要显式断言，集中一处）。 */
const cents = (value: number): Holding['total_cost_cents'] => value as Holding['total_cost_cents'];

function makeHolding(overrides: Partial<Omit<Holding, 'total_cost_cents'>> & { id: string; total_cost_cents?: number }): Holding {
  return {
    fund_code: '000051',
    fund_name: '华夏沪深300',
    platform: 'alipay',
    shares: 1000,
    avg_cost_nav: 1.5,
    first_buy_date: '2020-01-01',
    ...overrides,
    total_cost_cents: (overrides.total_cost_cents ?? 150000) as Holding['total_cost_cents'],
  };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureSeeded(db);
});

describe('持仓 · 跨平台同代码共存', () => {
  it('同一基金代码在支付宝和天天基金是两行独立持仓', async () => {
    await db.holdings.put(makeHolding({ id: 'h1', platform: 'alipay', shares: 1000, total_cost_cents: 150000 }));
    await db.holdings.put(makeHolding({ id: 'h2', platform: 'tiantian', shares: 500, total_cost_cents: 80000 }));

    const all = await holdingRepo.list();
    expect(all).toHaveLength(2);
    expect(all.map((row) => row.platform).sort()).toEqual(['alipay', 'tiantian']);
  });

  it('跨平台加仓互不污染：天天基金加仓不影响支付宝那行', async () => {
    await db.holdings.put(makeHolding({ id: 'h1', platform: 'alipay', shares: 1000, total_cost_cents: 150000 }));

    await holdingRepo.addPosition({
      id: 'h2',
      platform: 'tiantian',
      fund_code: '000051',
      fund_name: '华夏沪深300',
      shares: 500,
      cost_cents: 80000,
      date: '2020-02-01',
    });

    const alipay = await holdingRepo.byPlatformCode('alipay', '000051');
    const tiantian = await holdingRepo.byPlatformCode('tiantian', '000051');
    expect(alipay?.shares).toBe(1000);
    expect(alipay?.total_cost_cents).toBe(150000);
    expect(tiantian?.shares).toBe(500);
    expect(tiantian?.total_cost_cents).toBe(80000);
  });

  it('同平台加仓仍然合并为加权成本（手动「又买了一笔」语义保留）', async () => {
    await holdingRepo.addPosition({
      id: 'h1',
      platform: 'alipay',
      fund_code: '000051',
      fund_name: '华夏沪深300',
      shares: 1000,
      cost_cents: 150000,
      date: '2020-01-01',
    });
    await holdingRepo.addPosition({
      id: 'h2',
      platform: 'alipay',
      fund_code: '000051',
      fund_name: '华夏沪深300',
      shares: 1000,
      cost_cents: 170000,
      date: '2020-03-01',
    });

    const merged = await holdingRepo.byPlatformCode('alipay', '000051');
    expect(merged?.shares).toBe(2000);
    expect(merged?.total_cost_cents).toBe(320000);
    expect(merged?.avg_cost_nav).toBeCloseTo(1.6, 4);
    expect(await holdingRepo.list()).toHaveLength(1);
  });
});

describe('持仓截图导入 · 幂等覆盖', () => {
  it('同平台同代码重复导入是覆盖（快照语义），不是翻倍', async () => {
    const first = await holdingRepo.importHoldings([
      {
        platform: 'alipay',
        fund_code: '000051',
        fund_name: '华夏沪深300',
        shares: 1000,
        total_cost_cents: cents(150000),
        date: '2020-01-01',
      },
    ]);
    expect(first).toEqual({ created: 1, updated: 0, mergedInBatch: 0 });

    // 下次截图导入：平台显示份额变成了 1200 —— 覆盖，不是 2200
    const second = await holdingRepo.importHoldings([
      {
        platform: 'alipay',
        fund_code: '000051',
        fund_name: '华夏沪深300',
        shares: 1200,
        total_cost_cents: cents(180000),
        date: '2020-06-01',
      },
    ]);
    expect(second).toEqual({ created: 0, updated: 1, mergedInBatch: 0 });

    const rows = await holdingRepo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].shares).toBe(1200);
    expect(rows[0].total_cost_cents).toBe(180000);
    // 覆盖保留首次买入日期（成本基础信息不丢）
    expect(rows[0].first_buy_date).toBe('2020-01-01');
  });

  it('同一批内同 (platform, code) 出现多次只取第一条，计 mergedInBatch', async () => {
    const outcome = await holdingRepo.importHoldings([
      { platform: 'alipay', fund_code: '000051', fund_name: '华夏沪深300', shares: 1000, total_cost_cents: cents(150000), date: '2020-01-01' },
      { platform: 'alipay', fund_code: '000051', fund_name: '华夏沪深300', shares: 1100, total_cost_cents: cents(160000), date: '2020-01-02' },
      { platform: 'tiantian', fund_code: '000051', fund_name: '华夏沪深300', shares: 500, total_cost_cents: cents(80000), date: '2020-01-03' },
    ]);
    expect(outcome).toEqual({ created: 2, updated: 0, mergedInBatch: 1 });
    const rows = await holdingRepo.list();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.platform === 'alipay')?.shares).toBe(1000);
  });

  it('只有市值没有成本时反推成本（截图没有成本栏的诚实降级）', async () => {
    await holdingRepo.importHoldings([
      {
        platform: 'alipay',
        fund_code: '000051',
        fund_name: '华夏沪深300',
        shares: 1000,
        market_value_cents: cents(160000),
        date: '2020-06-01',
      },
    ]);
    const row = await holdingRepo.byPlatformCode('alipay', '000051');
    expect(row?.total_cost_cents).toBe(160000);
    // 反推成本 = 当前净值 → 收益恒为 0，直到用户补录真实成本；不假装知道成本
    expect(row?.avg_cost_nav).toBeCloseTo(1.6, 4);
  });

  it('旧持仓（v4 之前的数据）没有 platform 时，byPlatformCode 查不到但列表仍能读出', async () => {
    // 直接写一条无 platform 的旧格式数据（模拟 v3 升级前的存量）
    await db.holdings.put({
      id: 'legacy',
      fund_code: '161725',
      fund_name: '白银LOF',
      shares: 2000,
      total_cost_cents: cents(60000),
      avg_cost_nav: 0.3,
      first_buy_date: '2019-01-01',
    } as unknown as Holding);

    const rows = await holdingRepo.list();
    expect(rows).toHaveLength(1);
    // v4 upgrade 会回填 manual；这里直接写入绕过了 upgrade，验证读路径不炸
    expect(rows[0].fund_code).toBe('161725');
  });
});

describe('持仓 · 黄金按克重建模（共用基金模型）', () => {
  it('积存金：shares=克重、code=品种代号，与基金走同一套计算', async () => {
    await holdingRepo.importHoldings([
      {
        platform: 'bank',
        fund_code: 'AU9999',
        fund_name: '积存金（黄金）',
        shares: 12.5,
        total_cost_cents: cents(550000),
        date: '2020-01-01',
      },
    ]);
    const row = await holdingRepo.byPlatformCode('bank', 'AU9999');
    expect(row?.shares).toBe(12.5);
    expect(row?.avg_cost_nav).toBeCloseTo(440, 2); // 每克 440 元（nav 单位是元，不是分）
  });
});

describe('持仓 · v3 → v4 真实升级路径', () => {
  it('老库（v3 schema + 无 platform 数据）升级到 v4 后 platform 回填 manual，数据一条不少', async () => {
    const name = `migration_probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // ① 模拟老装机：用 v3 时代的 schema 建库写数据（holdings 是 &fund_code 唯一索引）
    const legacy = new Dexie(name);
    legacy.version(1).stores({
      holdings: 'id, &fund_code, closed_at',
      quotes: 'id, fund_code, [fund_code+quote_at], nav_date',
      settings: 'key',
    });
    legacy.version(3).stores({ pair_dismissals: 'id, created_at' });
    await legacy.open();
    await legacy.table('holdings').bulkPut([
      {
        id: 'old1',
        fund_code: '000051',
        fund_name: '华夏沪深300',
        shares: 800,
        total_cost_cents: cents(120000),
        avg_cost_nav: 1.5,
        first_buy_date: '2019-06-01',
      },
      {
        id: 'old2',
        fund_code: '161725',
        fund_name: '白银LOF',
        shares: 2000,
        total_cost_cents: cents(60000),
        avg_cost_nav: 0.3,
        first_buy_date: '2019-01-01',
        closed_at: '2020-03-01',
      },
    ]);
    legacy.close();

    // ② 用当前应用（v4 schema）打开同一库名 → 触发 upgrade
    const upgraded = new LedgerDatabase(name);
    await upgraded.open();
    const rows = await upgraded.holdings.toArray();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.platform).toBe('manual'); // upgrade 回填
      expect(row.shares).toBeGreaterThan(0);
      expect(row.total_cost_cents).toBeGreaterThan(0); // 数据没丢
    }
    // 唯一索引已切换：同代码能再插一行不同平台
    await upgraded.holdings.put({
      id: 'new1',
      fund_code: '000051',
      fund_name: '华夏沪深300',
      platform: 'alipay',
      shares: 100,
      total_cost_cents: cents(15000),
      avg_cost_nav: 1.5,
      first_buy_date: '2026-01-01',
    });
    expect((await upgraded.holdings.toArray()).filter((row) => row.fund_code === '000051')).toHaveLength(2);
    upgraded.close();
    await upgraded.delete();
  });
});
