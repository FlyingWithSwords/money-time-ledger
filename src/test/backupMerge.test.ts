import { describe, expect, it, beforeAll } from 'vitest';
import type { Cents } from '../types';
import {
  decideMerge,
  dedupeIndexKey,
  emptyStats,
  planMerge,
  sumStats,
  versionOf,
  type MergeDecisionOptions,
  type Row,
} from '../backup/merge';
import { SEED_SETTING_DEFAULTS_RECORD } from '../db/settingDefaults';

/**
 * jsdom 的 Blob/File 没有实现 `arrayBuffer()`（探针确认：Blob.arrayBuffer/File.arrayBuffer 都是
 * undefined，但 FileReader 可用）。生产浏览器都有，这里用 FileReader 兜住，**不跳过用例**——
 * 往返用例是唯一能证明"合并真的不丢账"的证据。
 */
function readBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('读取备份内容失败'));
    reader.readAsArrayBuffer(blob);
  });
}

async function makeBackupFile(blob: Blob, name = 'backup.mtlbk'): Promise<File> {
  const buffer = await readBlobArrayBuffer(blob);
  // restoreFromFile 只用到 name/size/arrayBuffer，构造一个等价对象即可
  return {
    name,
    size: buffer.byteLength,
    type: 'application/octet-stream',
    arrayBuffer: async () => buffer,
  } as unknown as File;
}

/**
 * 备份合并的纯逻辑单测（不碰 Dexie）。
 *
 * 这一组用例存在的理由：合并是**唯一会同时改写大量既有数据**的路径，
 * 一旦判错，用户不会看到报错，只会发现"账少了/账重了"。
 * 所以每条用例都钉一个具体的失效场景，而不是复述实现。
 */

const TX: MergeDecisionOptions = { useDedupe: true, hasVersion: true };
const NO_VERSION: MergeDecisionOptions = { useDedupe: false, hasVersion: false };
const SETTINGS: MergeDecisionOptions = { useDedupe: false, hasVersion: false, idField: 'key' };
/** 走"出厂默认值豁免"的那条路径：只有 settings 会传 defaults */
const SETTINGS_WITH_DEFAULTS: MergeDecisionOptions = {
  ...SETTINGS,
  defaults: SEED_SETTING_DEFAULTS_RECORD,
};

function tx(overrides: Row = {}): Row {
  return {
    id: 't1',
    source: 'wechat',
    dedupe_key: 'K1',
    amount_cents: 1500 as Cents,
    direction: 'expense',
    occurred_at: '2026-10-01T12:00:00',
    created_at: '2026-10-01T12:00:00',
    updated_at: '2026-10-01T12:00:00',
    ...overrides,
  };
}

describe('backupMerge: 单行决策', () => {
  it('本机没有同 id → insert（新账必须能进来）', () => {
    const plan = planMerge([], [tx()], TX);
    expect(plan.stats.inserted).toBe(1);
    expect(plan.puts).toHaveLength(1);
  });

  it('同 id 且备份 updated_at 更晚 → update（另一台设备改过的账要同步过来）', () => {
    const plan = planMerge([tx()], [tx({ updated_at: '2026-10-05T00:00:00', amount_cents: 2000 as Cents })], TX);
    expect(plan.stats.updated).toBe(1);
    expect(plan.puts[0].amount_cents).toBe(2000);
  });

  it('同 id 且本机 updated_at 更晚 → skip，且 puts 为空（不能被旧备份打回去）', () => {
    const plan = planMerge([tx({ updated_at: '2026-10-09T00:00:00' })], [tx({ updated_at: '2026-10-02T00:00:00' })], TX);
    expect(plan.stats.skipped).toBe(1);
    expect(plan.puts).toHaveLength(0);
  });

  it('同 id 时间戳相同且内容一致 → skip，理由必须是「内容一致」而不是冲突', () => {
    const decision = decideMerge(tx(), tx(), TX);
    expect(decision.action).toBe('skip');
    expect(decision.reason).toContain('内容一致');
  });

  it('同 id 时间戳相同但内容不同 → conflict，且不进 puts（保留本机，交用户裁决）', () => {
    const plan = planMerge([tx()], [tx({ amount_cents: 9900 as Cents })], TX);
    expect(plan.stats.conflict).toBe(1);
    expect(plan.puts).toHaveLength(0);
    expect(plan.conflictIds).toEqual(['t1']);
  });

  it('本机已删除且更晚、备份是未删除的旧版本 → skip（绝不复活已删的账）', () => {
    const plan = planMerge(
      [tx({ deleted_at: '2026-10-08T00:00:00', updated_at: '2026-10-08T00:00:00' })],
      [tx({ updated_at: '2026-10-02T00:00:00' })],
      TX,
    );
    expect(plan.stats.skipped).toBe(1);
    expect(plan.puts).toHaveLength(0);
  });

  it('本机未删除、备份 deleted_at 更晚 → update（把删除同步过来）', () => {
    const plan = planMerge(
      [tx({ updated_at: '2026-10-02T00:00:00' })],
      [tx({ deleted_at: '2026-10-08T00:00:00', updated_at: '2026-10-08T00:00:00' })],
      TX,
    );
    expect(plan.stats.updated).toBe(1);
    expect(plan.puts[0].deleted_at).toBe('2026-10-08T00:00:00');
  });

  it('跨设备重复：id 不同但 source+dedupe_key 相同 → duplicate，不计 insert（同一份账单两台设备各导一次会走到这里）', () => {
    const local = [tx({ id: 'A' })];
    const remote = [tx({ id: 'B' })];
    expect(dedupeIndexKey(local[0])).toBe(dedupeIndexKey(remote[0]));
    const plan = planMerge(local, remote, TX);
    expect(plan.stats.duplicate).toBe(1);
    expect(plan.stats.inserted).toBe(0);
    expect(plan.puts).toHaveLength(0);
  });

  it('无版本表：本机已有 → skip；本机没有 → insert（分类/目标本地优先，缺的才补）', () => {
    const existing = [{ id: 'c1', name: '餐饮' }];
    const incoming = [{ id: 'c1', name: '吃饭' }, { id: 'c2', name: '交通' }];
    const plan = planMerge(existing, incoming, NO_VERSION);
    expect(plan.stats.skipped).toBe(1);
    expect(plan.stats.inserted).toBe(1);
    expect(plan.puts.map((row) => row.id)).toEqual(['c2']);
  });

  it('settings 用 idField:"key" → 同 key 不覆盖本机、缺的 key 才补（时薪口径不能被别的设备冲掉）', () => {
    const existing = [{ key: 'hourly_wage_mode', value: 'manual' }];
    const incoming = [
      { key: 'hourly_wage_mode', value: 'from_salary' },
      { key: 'theme', value: 'dark' },
    ];
    const plan = planMerge(existing, incoming, SETTINGS);
    expect(plan.stats.skipped).toBe(1);
    expect(plan.stats.inserted).toBe(1);
    expect(plan.puts).toEqual([{ key: 'theme', value: 'dark' }]);
  });

  it('行没有主键（或主键为空串）→ skipped，绝不写进库', () => {
    const plan = planMerge([], [{ amount_cents: 100 as Cents }, { id: '', amount_cents: 200 as Cents }], TX);
    expect(plan.stats.skipped).toBe(2);
    expect(plan.puts).toHaveLength(0);
  });
});

describe('backupMerge: 版本与统计细节', () => {
  it('generated_at 参与版本比较（复盘卡只有这个字段，漏了它就永远补不进备份里的复盘）', () => {
    expect(versionOf({ generated_at: '2026-11-01T00:00:00' })).toBe(Date.parse('2026-11-01T00:00:00'));
    const plan = planMerge(
      [{ id: 'r1', month_key: '2026-10', generated_at: '2026-11-01T00:00:00', schema_version: 1 }],
      [{ id: 'r1', month_key: '2026-10', generated_at: '2026-11-03T00:00:00', schema_version: 2 }],
      { useDedupe: false, hasVersion: true },
    );
    expect(plan.stats.updated).toBe(1);
  });

  it('sumStats 只是加法，不能被写成"取最后一张表"', () => {
    const a = { ...emptyStats(), inserted: 2, skipped: 1 };
    const b = { ...emptyStats(), updated: 3, conflict: 1 };
    expect(sumStats([a, b])).toEqual({ inserted: 2, updated: 3, skipped: 1, duplicate: 0, conflict: 1 });
  });
});

describe('backupMerge: 出厂默认值豁免（防"换设备后设置静默回出厂"）', () => {
  it('设置仍是出厂默认 + 备份里是用户设过的值 → update，最终拿到的是备份值', () => {
    const plan = planMerge(
      [{ key: 'hourly_wage_mode', value: 'salary_div_hours' }],
      [{ key: 'hourly_wage_mode', value: 'manual' }],
      SETTINGS_WITH_DEFAULTS,
    );
    expect(plan.stats.updated).toBe(1);
    expect(plan.stats.skipped).toBe(0);
    expect(plan.puts).toEqual([{ key: 'hourly_wage_mode', value: 'manual' }]);
  });

  it('设置已被用户改过（本机值不等于出厂默认）+ 备份不同 → skip，本机值不变', () => {
    const plan = planMerge(
      [{ key: 'hourly_wage_mode', value: 'manual' }],
      [{ key: 'hourly_wage_mode', value: 'salary_div_hours' }],
      SETTINGS_WITH_DEFAULTS,
    );
    expect(plan.stats.skipped).toBe(1);
    expect(plan.stats.updated).toBe(0);
    expect(plan.puts).toHaveLength(0);
  });

  it('没传 defaults 的表（分类/持仓/预算）不受影响：仍然一律本地优先，豁免不能外溢', () => {
    const plan = planMerge([{ id: 'c1', name: '餐饮' }], [{ id: 'c1', name: '吃饭' }], NO_VERSION);
    expect(plan.stats.skipped).toBe(1);
    expect(plan.puts).toHaveLength(0);
  });

  it('默认值是 null 的设置也要能识别「没人动过」——JSON.stringify(undefined) 会让 null 与 undefined 混同', () => {
    // 严格等于 null：默认值就是 null，不是 undefined，也不是"没有这个键"
    expect(SEED_SETTING_DEFAULTS_RECORD['hourly_wage_manual_cents']).toBeNull();
    expect('hourly_wage_manual_cents' in SEED_SETTING_DEFAULTS_RECORD).toBe(true);
    // 不存在的键不能因为"取出来是 undefined"就被当成有一个 undefined 默认值
    expect('不存在的键' in SEED_SETTING_DEFAULTS_RECORD).toBe(false);
    const plan = planMerge(
      [{ key: 'hourly_wage_manual_cents', value: null }],
      [{ key: 'hourly_wage_manual_cents', value: 2500000 }],
      SETTINGS_WITH_DEFAULTS,
    );
    expect(plan.stats.updated).toBe(1);
    expect(plan.puts).toEqual([{ key: 'hourly_wage_manual_cents', value: 2500000 }]);
  });

  it('备份值与出厂默认相同 → 没有必要写回（skip，不制造无意义的写入）', () => {
    const plan = planMerge(
      [{ key: 'workday_hours', value: 8 }],
      [{ key: 'workday_hours', value: 8 }],
      SETTINGS_WITH_DEFAULTS,
    );
    expect(plan.stats.skipped).toBe(1);
    expect(plan.puts).toHaveLength(0);
  });
});

describe('backupMerge: 删掉的账不能被同指纹的新 id 复活', () => {
  it('本机已删除同一笔（同指纹、id 不同）、备份是未删的旧版本 → skip 不复活', () => {
    const local = [tx({ id: 'pc-B', dedupe_key: 'W', deleted_at: '2026-10-08T00:00:00', updated_at: '2026-10-08T00:00:00' })];
    const older = [tx({ id: 'phone-A', dedupe_key: 'W', updated_at: '2026-10-02T00:00:00' })];
    const plan = planMerge(local, older, TX);
    expect(plan.stats.skipped).toBe(1);
    expect(plan.stats.inserted).toBe(0);
    expect(plan.puts).toHaveLength(0);
  });

  it('本机已删除同一笔，但备份是删除之后的新记录 → insert（视为删除后又记了一笔）', () => {
    const local = [tx({ id: 'pc-B', dedupe_key: 'W', deleted_at: '2026-10-08T00:00:00', updated_at: '2026-10-08T00:00:00' })];
    const newer = [tx({ id: 'phone-A2', dedupe_key: 'W', updated_at: '2026-10-20T00:00:00', amount_cents: 3300 as Cents })];
    const plan = planMerge(local, newer, TX);
    expect(plan.stats.inserted).toBe(1);
    expect(plan.puts.map((row) => row.id)).toEqual(['phone-A2']);
  });

  it('本机那条活着时照旧判重复：不能因为新增了"已删索引"把正常去重弄丢', () => {
    const plan = planMerge([tx({ id: 'A' })], [tx({ id: 'B' })], TX);
    expect(plan.stats.duplicate).toBe(1);
    expect(plan.stats.inserted).toBe(0);
  });
});

/**
 * 端到端往返：这是**唯一能证明"合并真的不丢账"**的证据，
 * 纯逻辑单测只能证明"决策函数返回了正确的 action"。
 */
describe('backupMerge: 端到端往返（真加密真解密真写库）', () => {
  beforeAll(async () => {
    // jsdom 下 crypto.subtle 不一定可用；用 Node 的 webcrypto 顶上，而不是跳过用例
    const hasSubtle = typeof globalThis.crypto?.subtle?.encrypt === 'function';
    if (!hasSubtle) {
      const { webcrypto } = await import('node:crypto');
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
    }
  });

  it('导出 → 本机新增+改一笔 → 合并恢复：本机的账一笔不少，备份里新增的也进来了', async () => {
    const { db } = await import('../db');
    const { ensureSeeded } = await import('../db/seed');
    const { exportEncrypted, restoreFromFile } = await import('../backup/backup');

    await db.delete();
    await db.open();
    await ensureSeeded(db);

    const base = {
      external_id: 'ext',
      source: 'wechat' as const,
      direction: 'expense' as const,
      account_id: 'acc_wechat',
      payment_channel: 'wechat' as const,
      category_l1: 'food',
      category_l2: 'food.lunch',
      flags: [],
      manual_edited: false,
      category_locked: false,
      dedupe_status: 'clean' as const,
      imported_at: '2026-10-01T12:00:00',
      created_at: '2026-10-01T12:00:00',
      updated_at: '2026-10-01T12:00:00',
    };

    // 备份时的状态：两笔
    await db.transactions.bulkAdd([
      {
        ...base,
        id: 'tx-a',
        dedupe_key: 'DA',
        amount_cents: 1500 as Cents,
        occurred_at: '2026-10-01T12:00:00',
        occurred_date: '2026-10-01',
        month_key: '2026-10',
        note: '备份里的第一笔',
      },
      {
        ...base,
        id: 'tx-b',
        dedupe_key: 'DB',
        amount_cents: 2500 as Cents,
        occurred_at: '2026-10-02T12:00:00',
        occurred_date: '2026-10-02',
        month_key: '2026-10',
        note: '备份里的第二笔',
      },
    ]);
    const blob = await exportEncrypted('passphrase123');
    const backupFile = await makeBackupFile(blob);

    // 导出之后本机继续用：新增一笔 tx-c，并改掉 tx-b 的金额
    await db.transactions.add({
      ...base,
      id: 'tx-c',
      dedupe_key: 'DC',
      amount_cents: 800 as Cents,
      occurred_at: '2026-10-03T12:00:00',
      occurred_date: '2026-10-03',
      month_key: '2026-10',
      note: '备份之后才记的一笔',
    });
    await db.transactions.update('tx-b', { amount_cents: 3000 as Cents, updated_at: '2026-10-20T00:00:00' });

    const report = await restoreFromFile(backupFile, 'passphrase123', { mode: 'merge' });
    const rows = await db.transactions.toArray();
    const byId = new Map(rows.map((row) => [row.id, row]));

    // 本机原有的三笔全在
    expect(rows).toHaveLength(3);
    expect(byId.has('tx-a')).toBe(true);
    expect(byId.has('tx-b')).toBe(true);
    expect(byId.has('tx-c')).toBe(true);
    // 本机改过的 tx-b 没被旧备份打回去
    expect(byId.get('tx-b')?.amount_cents).toBe(3000);
    // 备份后新增的 tx-c 也没被清掉（这是"覆盖式恢复"会丢的那笔）
    expect(byId.get('tx-c')?.amount_cents).toBe(800);

    expect(report.mode).toBe('merge');
    expect(report.stats.conflict).toBe(0);
    expect(report.stats.duplicate).toBe(0);
    // 两笔都命中"本机版本更新"→ skip；没有任何一条被重新写入
    expect(report.stats.skipped).toBeGreaterThanOrEqual(2);
    expect(report.stats.inserted).toBe(0);
  }, 60000);

  it('合并会把备份里"本机缺的那笔"补进来（不是只跳过）', async () => {
    const { db } = await import('../db');
    const { ensureSeeded } = await import('../db/seed');
    const { exportEncrypted, restoreFromFile } = await import('../backup/backup');

    await db.delete();
    await db.open();
    await ensureSeeded(db);

    const base = {
      external_id: 'ext',
      source: 'alipay' as const,
      direction: 'expense' as const,
      account_id: 'acc_alipay',
      payment_channel: 'alipay' as const,
      category_l1: 'food',
      category_l2: 'food.lunch',
      flags: [],
      manual_edited: false,
      category_locked: false,
      dedupe_status: 'clean' as const,
      imported_at: '2026-10-01T12:00:00',
      created_at: '2026-10-01T12:00:00',
      updated_at: '2026-10-01T12:00:00',
    };
    await db.transactions.add({
      ...base,
      id: 'only-in-backup',
      dedupe_key: 'DX',
      amount_cents: 4200 as Cents,
      occurred_at: '2026-10-05T12:00:00',
      occurred_date: '2026-10-05',
      month_key: '2026-10',
      note: '只有备份里有',
    });
    const blob = await exportEncrypted('passphrase123');
    const backupFile = await makeBackupFile(blob);

    // 本机清空（模拟换了一台设备）
    await db.transactions.clear();
    expect(await db.transactions.count()).toBe(0);

    const report = await restoreFromFile(backupFile, 'passphrase123', { mode: 'merge' });
    const rows = await db.transactions.toArray();
    expect(rows.map((row) => row.id)).toEqual(['only-in-backup']);
    // stats 是全表汇总（分类/设置/规则也会各自计数），所以这里只断言"确实有新增、没有误判重复"
    expect(report.stats.inserted).toBeGreaterThanOrEqual(1);
    expect(report.stats.duplicate).toBe(0);
  }, 60000);
});

/**
 * 设置迁移：这一组是缺陷 A 唯一的回归防线。
 * 「seed 过的本机」是关键现场——首次打开应用时 11 个出厂默认值已经把 settings 表填满，
 * 若合并时一律"本地优先"，用户在旧设备上设的时薪口径会在新设备上静默消失。
 */
describe('backupMerge: 设置跨设备迁移（端到端，seed 过的本机 + 真实备份文件）', () => {
  beforeAll(async () => {
    const hasSubtle = typeof globalThis.crypto?.subtle?.encrypt === 'function';
    if (!hasSubtle) {
      const { webcrypto } = await import('node:crypto');
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
    }
  });

  it('seed 过的本机 + 合并备份 → 时薪口径必须变成备份里的值，不是停在出厂 8000/174', async () => {
    const { db } = await import('../db');
    const { ensureSeeded } = await import('../db/seed');
    const { exportEncrypted, restoreFromFile } = await import('../backup/backup');
    const settingsRepo = await import('../db/repos/settingsRepo');
    const { SETTING_KEYS } = await import('../db/settingKeys');

    // 旧手机：用户手填过时薪口径
    await db.delete();
    await db.open();
    await ensureSeeded(db);
    await settingsRepo.set(SETTING_KEYS.hourlyWageMode, 'manual');
    await settingsRepo.set(SETTING_KEYS.hourlyWageManualCents, 2500000);
    await settingsRepo.set(SETTING_KEYS.monthlySalaryCents, 1234500);
    await settingsRepo.set(SETTING_KEYS.timeCostThresholdCents, 500);
    await settingsRepo.set(SETTING_KEYS.workdayHours, 7);
    await settingsRepo.set(SETTING_KEYS.theme, 'dark');
    const blob = await exportEncrypted('passphrase123');
    const backupFile = await makeBackupFile(blob);

    // 新手机：首次打开，settings 已被 seed 写满出厂默认值（缺陷现场）
    await db.delete();
    await db.open();
    await ensureSeeded(db);
    expect(await settingsRepo.get(SETTING_KEYS.hourlyWageMode, '')).toBe('salary_div_hours');
    expect(await settingsRepo.get(SETTING_KEYS.monthlySalaryCents, 0)).toBe(800000);

    const report = await restoreFromFile(backupFile, 'passphrase123', { mode: 'merge' });

    const wage = await settingsRepo.getWageSettings();
    expect(wage.hourly_wage_mode).toBe('manual');
    expect(wage.monthly_salary_cents).toBe(1234500);
    expect(wage.hourly_wage_manual_cents).toBe(2500000);
    expect(wage.time_cost_threshold_cents).toBe(500);
    expect(wage.workday_hours).toBe(7);
    expect(await settingsRepo.get(SETTING_KEYS.theme, '')).toBe('dark');
    expect(report.stats.updated).toBeGreaterThanOrEqual(6);
    expect(report.stats.conflict).toBe(0);
  }, 60000);

  it('本机亲手改过的设置不会被备份反推：本机 manual 时薪，备份里是默认口径的旧备份 → 保留本机', async () => {
    const { db } = await import('../db');
    const { ensureSeeded } = await import('../db/seed');
    const { exportEncrypted, restoreFromFile } = await import('../backup/backup');
    const settingsRepo = await import('../db/repos/settingsRepo');
    const { SETTING_KEYS } = await import('../db/settingKeys');

    // 旧备份：全是出厂口径
    await db.delete();
    await db.open();
    await ensureSeeded(db);
    const blob = await exportEncrypted('passphrase123');
    const backupFile = await makeBackupFile(blob);

    // 本机：用户自己设过，且和默认值不同
    await settingsRepo.set(SETTING_KEYS.hourlyWageMode, 'manual');
    await settingsRepo.set(SETTING_KEYS.monthlySalaryCents, 1234500);

    await restoreFromFile(backupFile, 'passphrase123', { mode: 'merge' });

    expect(await settingsRepo.get(SETTING_KEYS.hourlyWageMode, '')).toBe('manual');
    expect(await settingsRepo.get(SETTING_KEYS.monthlySalaryCents, 0)).toBe(1234500);
  }, 60000);

  it('device_label / last_backup_at / ocr_pack_downloaded / seeded_version 四个键都不跨设备传播（合并）', async () => {
    const { db } = await import('../db');
    const { ensureSeeded } = await import('../db/seed');
    const { exportEncrypted, restoreFromFile } = await import('../backup/backup');
    const settingsRepo = await import('../db/repos/settingsRepo');
    const { SETTING_KEYS, SEED_VERSION } = await import('../db/settingKeys');

    await db.delete();
    await db.open();
    await ensureSeeded(db);

    // 备份那台机器（我的电脑）：10-01 备份过、OCR 包没下、seed 标记正常
    await settingsRepo.set(SETTING_KEYS.deviceLabel, '我的电脑');
    await settingsRepo.set(SETTING_KEYS.lastBackupAt, '2026-10-01T08:00:00');
    await settingsRepo.set(SETTING_KEYS.ocrPackDownloaded, false);
    await settingsRepo.set(SETTING_KEYS.seededVersion, SEED_VERSION);
    const blob = await exportEncrypted('passphrase123');
    const backupFile = await makeBackupFile(blob);

    // 本机（我的手机）：10-20 备份过、OCR 包已下
    await settingsRepo.set(SETTING_KEYS.deviceLabel, '我的手机');
    await settingsRepo.set(SETTING_KEYS.lastBackupAt, '2026-10-20T20:00:00');
    await settingsRepo.set(SETTING_KEYS.ocrPackDownloaded, true);
    await settingsRepo.set(SETTING_KEYS.seededVersion, 7);

    await restoreFromFile(backupFile, 'passphrase123', { mode: 'merge' });

    expect(await settingsRepo.get(SETTING_KEYS.deviceLabel, '')).toBe('我的手机');
    expect(await settingsRepo.get(SETTING_KEYS.lastBackupAt, '')).toBe('2026-10-20T20:00:00');
    expect(await settingsRepo.get(SETTING_KEYS.ocrPackDownloaded, null)).toBe(true);
    expect(await settingsRepo.get(SETTING_KEYS.seededVersion, null)).toBe(7);
  }, 60000);

  it('覆盖模式：本机 device_label="我的手机"、备份是"我的电脑" → 恢复后仍是"我的手机"，last_backup_at 同理', async () => {
    const { db } = await import('../db');
    const { ensureSeeded } = await import('../db/seed');
    const { exportEncrypted, restoreFromFile } = await import('../backup/backup');
    const settingsRepo = await import('../db/repos/settingsRepo');
    const { SETTING_KEYS } = await import('../db/settingKeys');

    await db.delete();
    await db.open();
    await ensureSeeded(db);
    await settingsRepo.set(SETTING_KEYS.deviceLabel, '我的电脑');
    await settingsRepo.set(SETTING_KEYS.lastBackupAt, '2026-10-01T08:00:00');
    const blob = await exportEncrypted('passphrase123');
    const backupFile = await makeBackupFile(blob);

    await settingsRepo.set(SETTING_KEYS.deviceLabel, '我的手机');
    await settingsRepo.set(SETTING_KEYS.lastBackupAt, '2026-10-20T20:00:00');

    await restoreFromFile(backupFile, 'passphrase123', { mode: 'replace' });

    expect(await settingsRepo.get(SETTING_KEYS.deviceLabel, '')).toBe('我的手机');
    expect(await settingsRepo.get(SETTING_KEYS.lastBackupAt, '')).toBe('2026-10-20T20:00:00');
  }, 60000);
});

/**
 * 墓碑的跨设备一致：纯逻辑只能证明"决策返回 skip"，这里要证明**库里真的没有多出一条活的**。
 * 中间隔着 bulkPut / 索引，纯函数对一个、落库对另一个，是两回事。
 */
describe('backupMerge: 删除墓碑（端到端，按指纹判断）', () => {
  const BASE = {
    external_id: 'ext',
    source: 'wechat' as const,
    direction: 'expense' as const,
    account_id: 'acc_wechat',
    payment_channel: 'wechat' as const,
    category_l1: 'food',
    category_l2: 'food.lunch',
    flags: [] as string[],
    manual_edited: false,
    category_locked: false,
    dedupe_status: 'clean' as const,
    imported_at: '2026-10-01T12:00:00',
    created_at: '2026-10-01T12:00:00',
    updated_at: '2026-10-01T12:00:00',
    occurred_at: '2026-10-01T12:00:00',
    occurred_date: '2026-10-01',
    month_key: '2026-10',
  };

  beforeAll(async () => {
    const hasSubtle = typeof globalThis.crypto?.subtle?.encrypt === 'function';
    if (!hasSubtle) {
      const { webcrypto } = await import('node:crypto');
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
    }
  });

  it('本机已删除同一笔、备份是更旧的未删记录 → skip：库里仍是那一条删除状态，没有多出活的', async () => {
    const { db } = await import('../db');
    const { ensureSeeded } = await import('../db/seed');
    const { exportEncrypted, restoreFromFile } = await import('../backup/backup');

    // 备份那台（phone）：这笔还没被删
    await db.delete();
    await db.open();
    await ensureSeeded(db);
    await db.transactions.add({
      ...BASE,
      id: 'phone-A',
      dedupe_key: 'W',
      amount_cents: 1500 as Cents,
      updated_at: '2026-10-02T00:00:00',
    });
    const blob = await exportEncrypted('passphrase123');
    const backupFile = await makeBackupFile(blob);

    // 本机（pc）：同一笔（同指纹）换了个 id，并且已被用户删除
    await db.transactions.clear();
    await db.transactions.add({
      ...BASE,
      id: 'pc-B',
      dedupe_key: 'W',
      amount_cents: 1500 as Cents,
      deleted_at: '2026-10-08T00:00:00',
      updated_at: '2026-10-08T00:00:00',
    });

    await restoreFromFile(backupFile, 'passphrase123', { mode: 'merge' });

    const rows = await db.transactions.toArray();
    expect(await db.transactions.count()).toBe(1);
    expect(rows[0].id).toBe('pc-B');
    expect(rows[0].deleted_at).toBe('2026-10-08T00:00:00');
    // 活的记录必须为 0：删掉的账不能自己回来
    expect(rows.filter((row) => !row.deleted_at)).toHaveLength(0);
  }, 60000);

  it('本机已删除同一笔、但备份是删除之后的新记录 → insert：这笔重新出现，且只有一条活的', async () => {
    const { db } = await import('../db');
    const { ensureSeeded } = await import('../db/seed');
    const { exportEncrypted, restoreFromFile } = await import('../backup/backup');

    await db.delete();
    await db.open();
    await ensureSeeded(db);
    await db.transactions.add({
      ...BASE,
      id: 'phone-A2',
      dedupe_key: 'W',
      amount_cents: 3300 as Cents,
      updated_at: '2026-10-20T00:00:00',
      occurred_at: '2026-10-20T12:00:00',
      occurred_date: '2026-10-20',
    });
    const blob = await exportEncrypted('passphrase123');
    const backupFile = await makeBackupFile(blob);

    await db.transactions.clear();
    await db.transactions.add({
      ...BASE,
      id: 'pc-B',
      dedupe_key: 'W',
      amount_cents: 1500 as Cents,
      deleted_at: '2026-10-08T00:00:00',
      updated_at: '2026-10-08T00:00:00',
    });

    await restoreFromFile(backupFile, 'passphrase123', { mode: 'merge' });

    const rows = await db.transactions.toArray();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => !row.deleted_at)).toHaveLength(1);
    expect(rows.find((row) => !row.deleted_at)?.id).toBe('phone-A2');
  }, 60000);
});

/**
 * 出厂默认行的时间戳必须是"远古"而不是"现在"。
 * 否则新设备首启 seed 出来的默认规则在时间上永远比备份新，用户改过的启用状态永远进不来。
 */
describe('backupMerge: 内置规则的启用状态（端到端，SEED_EPOCH 的回归防线）', () => {
  beforeAll(async () => {
    const hasSubtle = typeof globalThis.crypto?.subtle?.encrypt === 'function';
    if (!hasSubtle) {
      const { webcrypto } = await import('node:crypto');
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
    }
  });

  it('新设备首启 seed 出来的内置规则（updated_at 是远古值），合并一个「用户已禁用该规则」的备份后，该规则必须是 disabled', async () => {
    const { db } = await import('../db');
    const { ensureSeeded, SEED_EPOCH } = await import('../db/seed');
    const { exportEncrypted, restoreFromFile } = await import('../backup/backup');

    // 旧手机：用户显式禁用了「美团/外卖」这条内置关键词规则
    await db.delete();
    await db.open();
    await ensureSeeded(db);
    expect((await db.rules.get('kw_meituan'))?.enabled).toBe(true);
    await db.rules.update('kw_meituan', { enabled: false, updated_at: '2026-10-05T00:00:00' });
    const blob = await exportEncrypted('passphrase123');
    const backupFile = await makeBackupFile(blob);

    // 新电脑：首次打开，内置规则被 seed 回来（默认启用）
    await db.delete();
    await db.open();
    await ensureSeeded(db);
    const seeded = await db.rules.get('kw_meituan');
    expect(seeded?.enabled).toBe(true);
    expect(seeded?.updated_at).toBe(SEED_EPOCH);

    await restoreFromFile(backupFile, 'passphrase123', { mode: 'merge' });

    const merged = await db.rules.get('kw_meituan');
    expect(merged?.enabled).toBe(false);
    expect(merged?.updated_at).toBe('2026-10-05T00:00:00');
  }, 60000);
});

describe('backupMerge: 口令与篡改（安全边界不能被"合并"软化）', () => {
  it('口令错误必须抛错，不允许"解不开就跳过"', async () => {
    const { db } = await import('../db');
    const { exportEncrypted, restoreFromFile } = await import('../backup/backup');
    await db.delete();
    await db.open();
    const blob = await exportEncrypted('passphrase123');
    const backupFile = await makeBackupFile(blob);
    await expect(restoreFromFile(backupFile, 'wrong-passphrase', { mode: 'merge' })).rejects.toThrow('口令不对');
  }, 60000);
});
