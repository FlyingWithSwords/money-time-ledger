import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/db';
import * as transactionRepo from '../db/repos/transactionRepo';
import { ensureSeeded } from '../db/seed';
import { makeTx } from './txFixture';

/**
 * 删除与撤销的护栏。
 *
 * 要防的具体故障：撤销原先只拿「选择时的 id 列表」去 restore，而 id 列表在
 * 「删」与「撤销」之间会变旧——同一毫秒的另一次删除、期间被别处改判删除的行、
 * 或用户已在「已删除」里手动恢复过的行，都会被一起捞回来。
 * 界面上看就是「撤销删错了东西」，而且不报错、不提示，只能事后自己发现。
 *
 * 所以这里钉三件事：撤销只认那一次的时间戳、它是幂等的、两次删除的戳不会撞。
 */

async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
  await ensureSeeded(db);
}

async function seed(ids: readonly string[]): Promise<void> {
  await transactionRepo.addMany(
    ids.map((id, index) => makeTx({ id, at: `2026-11-0${index + 1}T12:00:00+08:00`, amount: 100 * (index + 1) })),
  );
}

async function deletedFlag(id: string): Promise<string | undefined> {
  const row = await db.transactions.get(id);
  return row?.deleted_at;
}

beforeEach(async () => {
  await resetDb();
});

afterEach(async () => {
  vi.restoreAllMocks();
});

describe('撤销删除：只回滚这一次操作', () => {
  it('批量删除后撤销，这几笔全部回来', async () => {
    await seed(['a', 'b', 'c']);

    const receipt = await transactionRepo.bulkSoftDelete(['a', 'b']);
    expect(receipt.ids.sort()).toEqual(['a', 'b']);
    expect(await deletedFlag('a')).toBe(receipt.stamp);
    expect(await deletedFlag('c')).toBeUndefined();

    expect(await transactionRepo.undoDelete(receipt)).toBe(2);
    expect(await deletedFlag('a')).toBeUndefined();
    expect(await deletedFlag('b')).toBeUndefined();
  });

  it('本来就已删除的行不会被撤销带出来', async () => {
    await seed(['a', 'b']);
    // 更早的一次删除（比如去重裁决把重复行判成删除），戳与本次不同
    const older = await transactionRepo.softDelete('b');

    // 选择里混进了这一笔（开着「显示已删除」时可能发生）
    const receipt = await transactionRepo.bulkSoftDelete(['a', 'b']);
    expect(receipt.ids).toEqual(['a']);

    expect(await transactionRepo.undoDelete(receipt)).toBe(1);
    expect(await deletedFlag('a')).toBeUndefined();
    // 关键：b 仍保持删除状态，且时间戳还是更早那一次
    expect(await deletedFlag('b')).toBe(older);
  });

  it('期间被恢复过又删掉的行，撤销旧回执不动它', async () => {
    await seed(['a']);
    const first = await transactionRepo.bulkSoftDelete(['a']);
    expect(await transactionRepo.undoDelete(first)).toBe(1);

    // 用户又删了一次：这是另一次操作，戳已经变了
    const second = await transactionRepo.bulkSoftDelete(['a']);
    expect(second.stamp).not.toBe(first.stamp);

    // 点的是旧提示条上的「撤销」
    expect(await transactionRepo.undoDelete(first)).toBe(0);
    expect(await deletedFlag('a')).toBe(second.stamp);
  });

  it('撤销是幂等的：连点两次，第二次什么都不做', async () => {
    await seed(['a']);
    const receipt = await transactionRepo.bulkSoftDelete(['a']);

    expect(await transactionRepo.undoDelete(receipt)).toBe(1);
    expect(await transactionRepo.undoDelete(receipt)).toBe(0);
    expect(await deletedFlag('a')).toBeUndefined();
  });

  it('空回执不写库', async () => {
    await seed(['a']);
    const receipt = await transactionRepo.bulkSoftDelete([]);
    expect(receipt).toEqual({ ids: [], stamp: '' });
    expect(await transactionRepo.undoDelete(receipt)).toBe(0);
    expect(await deletedFlag('a')).toBeUndefined();
  });
});

describe('删除时间戳：同毫秒也不串台', () => {
  it('时钟停在同一毫秒，两次删除的时间戳仍然不同', async () => {
    await seed(['a', 'b']);
    // 精确复现最坏情况：连点两下删除落在同一毫秒
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);

    const first = await transactionRepo.bulkSoftDelete(['a']);
    const second = await transactionRepo.bulkSoftDelete(['b']);

    expect(first.stamp).not.toBe(second.stamp);
    // 撤销先删的那一次，只能带回 a，不能把 b 一起捞出来
    expect(await transactionRepo.undoDelete(first)).toBe(1);
    expect(await deletedFlag('a')).toBeUndefined();
    expect(await deletedFlag('b')).toBe(second.stamp);
  });
});

describe('单笔删除', () => {
  it('返回的时间戳能撤销，但改过之后就不再认', async () => {
    await seed(['a']);
    const stamp = await transactionRepo.softDelete('a');
    expect(typeof stamp).toBe('string');

    expect(await transactionRepo.undoDelete({ ids: ['a'], stamp })).toBe(1);
    expect(await deletedFlag('a')).toBeUndefined();

    // 删第二遍后，第一条回执失效
    const again = await transactionRepo.softDelete('a');
    expect(await transactionRepo.undoDelete({ ids: ['a'], stamp })).toBe(0);
    expect(await deletedFlag('a')).toBe(again);
  });
});
