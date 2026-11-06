import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import * as transactionRepo from '../db/repos/transactionRepo';
import { ensureSeeded } from '../db/seed';
import { makeTx } from './txFixture';

/**
 * 流水页任意日期区间查询 + 来源筛选 + 裁决合并来源。
 *
 * 这里要防的具体故障：原来的流水页只能按月取（`where('month_key').equals(...)`），
 * 且月份下拉只生成「当前月往前 11 个月」。账一多、跨度一长，用户就点不到目标月份。
 * 改成区间查询后，最该被钉住的是**边界**——闭区间两端都要含进去，
 * 否则「2020-06 到 2019-07」这种跨越一年的区间会少一天，而少一天不报错。
 */

async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
  await ensureSeeded(db);
}

beforeEach(async () => {
  await resetDb();
});

describe('流水筛选 · 任意日期区间', () => {
  it('闭区间两端都包含，区间外一天都不多取', async () => {
    await transactionRepo.addMany([
      makeTx({ id: 'may', at: '2020-05-31T23:00:00+08:00', amount: 100 }),
      makeTx({ id: 'first', at: '2020-06-01T00:00:00+08:00', amount: 200 }),
      makeTx({ id: 'mid', at: '2020-06-15T12:00:00+08:00', amount: 300 }),
      makeTx({ id: 'last', at: '2020-06-30T23:59:00+08:00', amount: 400 }),
      makeTx({ id: 'jul', at: '2020-07-01T00:00:00+08:00', amount: 500 }),
    ]);

    const rows = await transactionRepo.search({ fromDate: '2020-06-01', toDate: '2020-06-30' });
    expect(rows.map((row) => row.id).sort()).toEqual(['first', 'last', 'mid']);
  });

  it('跨年长区间（2019-07-01 ~ 2020-06-30）能一次取全，不再受「12 个月窗口」限制', async () => {
    await transactionRepo.addMany([
      makeTx({ id: 'a', at: '2018-06-30T12:00:00+08:00', amount: 100 }),
      makeTx({ id: 'b', at: '2019-07-01T12:00:00+08:00', amount: 200 }),
      makeTx({ id: 'c', at: '2019-12-31T12:00:00+08:00', amount: 300 }),
      makeTx({ id: 'd', at: '2020-06-30T12:00:00+08:00', amount: 400 }),
      makeTx({ id: 'e', at: '2020-07-01T12:00:00+08:00', amount: 500 }),
    ]);

    const rows = await transactionRepo.search({ fromDate: '2019-07-01', toDate: '2020-06-30' });
    expect(rows.map((row) => row.id).sort()).toEqual(['b', 'c', 'd']);
  });

  it('软删的记录不出现在流水里，但 includeDeleted 能取到（已删除折叠区要用）', async () => {
    await transactionRepo.addMany([
      makeTx({ id: 'alive', at: '2020-06-10T12:00:00+08:00', amount: 100 }),
      makeTx({ id: 'gone', at: '2020-06-11T12:00:00+08:00', amount: 200 }),
    ]);
    await transactionRepo.softDelete('gone');

    const active = await transactionRepo.search({ fromDate: '2020-06-01', toDate: '2020-06-30' });
    expect(active.map((row) => row.id)).toEqual(['alive']);

    const withDeleted = await transactionRepo.listByDateRange('2020-06-01', '2020-06-30', true);
    expect(withDeleted.map((row) => row.id).sort()).toEqual(['alive', 'gone']);
  });

  it('区间过滤之外的其他条件仍然生效（日期 + 来源 + 方向叠加）', async () => {
    await transactionRepo.addMany([
      makeTx({ id: 'w1', at: '2020-06-10T12:00:00+08:00', amount: 100, source: 'wechat' }),
      makeTx({ id: 'w2', at: '2020-06-11T12:00:00+08:00', amount: 200, source: 'wechat', direction: 'income' }),
      makeTx({ id: 'a1', at: '2020-06-12T12:00:00+08:00', amount: 300, source: 'alipay' }),
      makeTx({ id: 'a2', at: '2020-06-13T12:00:00+08:00', amount: 400, source: 'alipay' }),
    ]);

    const rows = await transactionRepo.search({
      fromDate: '2020-06-01',
      toDate: '2020-06-30',
      source: 'alipay',
      direction: 'expense',
    });
    expect(rows.map((row) => row.id).sort()).toEqual(['a1', 'a2']);
  });

  it('来源筛选按「主来源」而不是「来源集合」：多来源记录只归属首次入库那个来源', async () => {
    await transactionRepo.addMany([
      makeTx({ id: 'multi', at: '2020-06-10T12:00:00+08:00', amount: 100, source: 'wechat', source_refs: ['wechat', 'alipay'] }),
    ]);

    // 按微信筛得到它
    expect((await transactionRepo.search({ source: 'wechat' })).map((row) => row.id)).toEqual(['multi']);
    // 按支付宝筛**不该**再出现一次，否则来回切筛选会看到同一笔账重复
    expect((await transactionRepo.search({ source: 'alipay' }))).toEqual([]);
  });
});

describe('重复裁决 · 保留一方时合并来源', () => {
  it('keep 后把被丢弃那条的来源并进来，界面才能显示「微信+支付宝」', async () => {
    await transactionRepo.addMany([
      makeTx({ id: 'kept', at: '2020-06-10T12:00:00+08:00', amount: 100, source: 'wechat', dedupe_status: 'suspected' }),
      makeTx({
        id: 'dropped',
        at: '2020-06-10T12:00:00+08:00',
        amount: 100,
        source: 'alipay',
        dedupe_status: 'suspected',
      }),
    ]);
    await db.transactions.update('dropped', { duplicate_of: 'kept' });

    await transactionRepo.resolveDuplicate('kept', 'keep');

    const kept = await db.transactions.get('kept');
    expect(kept?.dedupe_status).toBe('clean');
    expect(kept?.duplicate_of).toBeUndefined();
    expect(kept?.source_refs).toEqual(['wechat', 'alipay']);
    // 被丢弃那条保持原状，等用户单独 discard（keep 不代表替它做决定）
    expect((await db.transactions.get('dropped'))?.dedupe_status).toBe('suspected');
  });

  it('discard 时不合并来源：这条被判为重复，不该污染保留方的来源集合', async () => {
    await transactionRepo.addMany([
      makeTx({ id: 'kept', at: '2020-06-10T12:00:00+08:00', amount: 100, source: 'wechat' }),
      makeTx({
        id: 'dropped',
        at: '2020-06-10T12:00:00+08:00',
        amount: 100,
        source: 'alipay',
        dedupe_status: 'suspected',
      }),
    ]);
    await db.transactions.update('dropped', { duplicate_of: 'kept' });

    await transactionRepo.resolveDuplicate('dropped', 'discard');

    expect((await db.transactions.get('kept'))?.source_refs).toBeUndefined();
    const dropped = await db.transactions.get('dropped');
    expect(dropped?.dedupe_status).toBe('duplicate');
    expect(dropped?.deleted_at).toBeTruthy();
  });
});
