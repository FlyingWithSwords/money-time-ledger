import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import * as dismissalRepo from '../db/repos/dismissalRepo';
import * as transactionRepo from '../db/repos/transactionRepo';
import { findCrossSourcePairs } from '../domain/crossMatch';
import { ensureSeeded } from '../db/seed';
import { makeTx } from './txFixture';

/**
 * 跨平台对账的写路径（真实 fake-indexeddb）。
 *
 * 这里钉的是**两个裁决动作的副作用边界**：
 * - confirmPairMatch 必须在单事务里同时软删一边、合并来源另一边——只做一半
 *   就是「合并了一半」的中间态，流水页会直接算错；
 * - dismissPair 只写裁决表，交易本体一个字节都不动。
 */

async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
  await ensureSeeded(db);
}

beforeEach(async () => {
  await resetDb();
});

describe('跨平台对账 · confirmPairMatch', () => {
  it('确认后：drop 软删 + duplicate + duplicate_of 指向 keep；keep 的来源并成两边并集', async () => {
    await transactionRepo.addMany([
      makeTx({ id: 'kept', at: '2020-06-10T12:00:00+08:00', amount: 3500, source: 'wechat' }),
      makeTx({ id: 'dropped', at: '2020-06-10T13:00:00+08:00', amount: 3500, source: 'alipay' }),
    ]);

    await transactionRepo.confirmPairMatch('kept', 'dropped');

    const drop = await db.transactions.get('dropped');
    expect(drop?.dedupe_status).toBe('duplicate');
    expect(drop?.duplicate_of).toBe('kept');
    expect(drop?.deleted_at).toBeTruthy();

    const keep = await db.transactions.get('kept');
    expect(keep?.deleted_at).toBeUndefined();
    expect(keep?.source_refs).toEqual(['wechat', 'alipay']);
  });

  it('确认后该对不再出现在候选里（drop 已软删，isActiveTx 把它挡在门外）', async () => {
    await transactionRepo.addMany([
      makeTx({ id: 'kept', at: '2020-06-10T12:00:00+08:00', amount: 3500, source: 'wechat' }),
      makeTx({ id: 'dropped', at: '2020-06-10T13:00:00+08:00', amount: 3500, source: 'alipay' }),
      // 另一组无关候选：证明引擎还在工作，只是确认过的那对消失了
      makeTx({ id: 'other_w', at: '2020-06-11T12:00:00+08:00', amount: 1200, source: 'wechat' }),
      makeTx({ id: 'other_a', at: '2020-06-11T13:00:00+08:00', amount: 1200, source: 'alipay' }),
    ]);
    await transactionRepo.confirmPairMatch('kept', 'dropped');

    const rows = await transactionRepo.listAll();
    const pairs = findCrossSourcePairs(rows, new Set(await dismissalRepo.listDismissedKeys()));

    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.a).toBe('other_w');
    expect(pairs[0]?.b).toBe('other_a');
  });

  it('传不存在的 id 抛错且一个字都不写', async () => {
    await transactionRepo.addMany([
      makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 100, source: 'wechat' }),
    ]);

    await expect(transactionRepo.confirmPairMatch('w', 'ghost')).rejects.toThrow('交易记录不存在');
    await expect(transactionRepo.confirmPairMatch('ghost', 'w')).rejects.toThrow('交易记录不存在');

    // 库里还是原来那一笔，且没被改过任何字段
    expect(await db.transactions.count()).toBe(1);
    const unchanged = await db.transactions.get('w');
    expect(unchanged?.dedupe_status).toBe('clean');
    expect(unchanged?.deleted_at).toBeUndefined();
    expect(unchanged?.source_refs).toBeUndefined();
  });
});

describe('跨平台对账 · dismissPair', () => {
  it('dismissPair + listDismissedKeys 往返，key 与 [a,b].sort().join("|") 格式一致', async () => {
    await dismissalRepo.dismissPair('w-tx', 'a-tx');
    // (a,b) 与 (b,a) 是同一个 key：put 幂等，不会写出两条
    await dismissalRepo.dismissPair('a-tx', 'w-tx');

    const keys = await dismissalRepo.listDismissedKeys();
    expect(keys).toEqual([['w-tx', 'a-tx'].sort().join('|')]);
    expect(keys[0]).toBe('a-tx|w-tx');
  });

  it('否定后该对被引擎过滤，交易本体不受任何影响', async () => {
    const wechat = makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 3500, source: 'wechat' });
    const alipay = makeTx({ id: 'a', at: '2020-06-10T13:00:00+08:00', amount: 3500, source: 'alipay' });
    await transactionRepo.addMany([wechat, alipay]);

    // 过滤前能配上，排除「本来就配不上」的假绿
    expect(findCrossSourcePairs(await transactionRepo.listAll(), new Set())).toHaveLength(1);

    await dismissalRepo.dismissPair('w', 'a');
    const keys = await dismissalRepo.listDismissedKeys();
    expect(findCrossSourcePairs(await transactionRepo.listAll(), new Set(keys))).toEqual([]);

    // 交易两笔都原样健在
    expect(await db.transactions.count()).toBe(2);
    expect((await db.transactions.get('w'))?.deleted_at).toBeUndefined();
    expect((await db.transactions.get('a'))?.deleted_at).toBeUndefined();
  });
});
