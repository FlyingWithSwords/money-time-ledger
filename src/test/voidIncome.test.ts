import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import * as settingsRepo from '../db/repos/settingsRepo';
import * as transactionRepo from '../db/repos/transactionRepo';
import { ensureSeeded } from '../db/seed';
import { SETTING_KEYS } from '../db/settingKeys';
import { makeTx } from './txFixture';

/**
 * 存量数据的修正通道 + 高级条件的持久化。
 *
 * 判定层不认「交易关闭」只是一半：用户在设置里加了「余额宝」之后，
 * 那笔 15,000 元已经被写成了收入。如果只改规则，这笔钱会永远留在收入里，
 * 而且用户完全不知道 —— 所以必须有一条「把已误判的捞出来改回」的路径。
 */

async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
  await ensureSeeded(db);
}

const closedIncome = makeTx({
  id: 'closed',
  at: '2026-01-30T16:16:00+08:00',
  amount: 1500000,
  direction: 'income',
  l1: 'salary',
  l2: 'monthly',
  counterparty: '余额宝',
  note: '余额宝-单次转入（交易关闭）',
});

const realIncome = makeTx({
  id: 'real',
  at: '2026-01-31T16:16:00+08:00',
  amount: 800000,
  direction: 'income',
  l1: 'salary',
  l2: 'monthly',
  counterparty: 'XX科技有限公司',
  note: '代发工资',
});

const closedTransfer = makeTx({
  id: 'closed_transfer',
  at: '2026-02-01T16:16:00+08:00',
  amount: 1500000,
  direction: 'transfer',
  l1: 'other',
  l2: 'pending',
  counterparty: '余额宝',
  note: '余额宝-单次转入（交易关闭）',
});

beforeEach(async () => {
  await resetDb();
});

describe('存量修正：被误判成收入的「交易关闭」', () => {
  it('只捞「方向是收入 + 文案像关闭」的记录', async () => {
    await transactionRepo.addMany([closedIncome, realIncome, closedTransfer]);
    const rows = await transactionRepo.listVoidIncome();
    expect(rows.map((row) => row.id)).toEqual(['closed']);
  });

  it('已删除的不出现——撤销过一次就不用再修', async () => {
    await transactionRepo.addMany([{ ...closedIncome, deleted_at: '2026-02-02T00:00:00.000Z' }]);
    expect(await transactionRepo.listVoidIncome()).toHaveLength(0);
  });

  it('改回不计收支：方向变 transfer，分类退回待分类并解锁', async () => {
    await transactionRepo.addMany([closedIncome]);
    expect(await transactionRepo.revertVoidIncome(['closed'])).toBe(1);

    const row = await db.transactions.get('closed');
    expect(row?.direction).toBe('transfer');
    expect(row?.category_l1).toBe('other');
    expect(row?.category_l2).toBe('pending');
    expect(row?.category_locked).toBe(false);
  });

  it('不碰同批里的正常收入', async () => {
    await transactionRepo.addMany([closedIncome, realIncome]);
    expect(await transactionRepo.revertVoidIncome(['closed', 'real'])).toBe(1);
    expect((await db.transactions.get('real'))?.direction).toBe('income');
  });

  it('markIncome 是第三道闸门：关闭交易即使被点名也不改判', async () => {
    await transactionRepo.addMany([closedTransfer]);
    expect(await transactionRepo.markIncome(['closed_transfer'], 'salary', 'monthly')).toBe(0);
    const row = await db.transactions.get('closed_transfer');
    expect(row?.direction).toBe('transfer');
    expect(row?.category_l2).toBe('pending');
  });

  it('正常转账仍然可以被改成收入——闸门只拦关闭交易', async () => {
    const normal = { ...closedTransfer, id: 'normal', note: '余额宝-单次转入' };
    await transactionRepo.addMany([normal]);
    expect(await transactionRepo.markIncome(['normal'], 'salary', 'monthly')).toBe(1);
    expect((await db.transactions.get('normal'))?.direction).toBe('income');
  });
});

describe('收入来源设置：高级条件', () => {
  it('条件写进设置后能原样读回来', async () => {
    await settingsRepo.setIncomeSources([
      {
        keyword: '余额宝',
        label: '余额宝',
        l1: 'salary',
        l2: 'monthly',
        filter: { min_cents: 100000, include: '转入', exclude: '转出' },
      },
    ]);
    const [source] = await settingsRepo.getIncomeSources();
    expect(source.filter).toEqual({ min_cents: 100000, include: '转入', exclude: '转出' });
  });

  it('老数据没有 filter 也照样读出来——不能让已勾过的来源集体失效', async () => {
    await settingsRepo.set(SETTING_KEYS.incomeSources, [
      { keyword: 'xx科技有限公司', label: 'XX科技有限公司', l1: 'salary', l2: 'monthly' },
    ]);
    const [source] = await settingsRepo.getIncomeSources();
    expect(source.keyword).toBe('xx科技有限公司');
    expect(source.filter).toBeUndefined();
  });

  it('脏条件字段被丢掉，但整条来源仍然可用', async () => {
    await settingsRepo.set(SETTING_KEYS.incomeSources, [
      { keyword: '余额宝', label: '余额宝', l1: 'salary', l2: 'monthly', filter: { min_cents: '很多', include: 42, exclude: ' 转出 ' } },
    ]);
    const [source] = await settingsRepo.getIncomeSources();
    expect(source.filter).toEqual({ exclude: '转出' });
  });

  it('一条来源都没有时返回空数组，导入退化成「不自动改判」', async () => {
    await settingsRepo.set(SETTING_KEYS.incomeSources, 'not-an-array');
    expect(await settingsRepo.getIncomeSources()).toEqual([]);
  });
});
