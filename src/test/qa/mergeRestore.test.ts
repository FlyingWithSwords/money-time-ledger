import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/db';
import { ensureSeeded, SEED_EPOCH } from '../../db/seed';
import { SETTING_KEYS } from '../../db/settingKeys';
import * as settingsRepo from '../../db/repos/settingsRepo';
import { exportCsv, exportEncrypted, restoreFromFile, setDeviceLabel } from '../../backup/backup';
import { runImport } from '../../import/pipeline';
import type { ImportFile } from '../../import/base';
import type { Cents, Transaction } from '../../types';

/**
 * QA-R4：备份「合并恢复」独立验证。
 *
 * 这一组用例不复述实现，只回答一个问题：**合并恢复会不会丢账/翻倍/复活已删的账**。
 * 全部走公开 API（exportEncrypted → restoreFromFile），不直接调 planMerge，
 * 因为用户走的是这条路，不是纯函数。
 *
 * 六个攻击面：
 *  一 合并不丢账（真实旧表 399 笔 + 合成 400 笔）
 *  二 已删除的账不被旧备份复活（双向 + 边界）
 *  三 跨设备重复导入不翻倍
 *  四 设置/配置跨设备迁移与 replace 模式的设备名污染
 *  五 UI 是否真的把结果呈现出来（静态断言 + tsc）
 *  六 既有功能：exportCsv / 版本兼容 / 口令错误
 */

const REAL_XLSX = process.env.QA_REAL_XLSX ?? 'C:/Users/Memphis/Desktop/账单例子.xlsx';
const HAS_REAL = existsSync(REAL_XLSX);
const PASS = 'test123456';

// ---------------------------------------------------------------- 基础设施

/** jsdom 的 Blob/File 没有 arrayBuffer()，用 FileReader 兜住，绝不因此跳过用例。 */
function readBlob(blob: Blob, as: 'text' | 'buffer'): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string | ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('读取备份内容失败'));
    if (as === 'text') reader.readAsText(blob);
    else reader.readAsArrayBuffer(blob);
  });
}

/** restoreFromFile 只用到 name/size/arrayBuffer，构造等价 File 即可。 */
async function toFile(blob: Blob, name = 'ledger-backup.mtlbk'): Promise<File> {
  const buffer = (await readBlob(blob, 'buffer')) as ArrayBuffer;
  return {
    name,
    size: buffer.byteLength,
    type: 'application/octet-stream',
    arrayBuffer: async () => buffer,
  } as unknown as File;
}

async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
}

function tx(input: {
  id: string;
  at: string;
  amount: number;
  source?: Transaction['source'];
  dedupeKey?: string;
  direction?: Transaction['direction'];
  deletedAt?: string;
  updatedAt?: string;
  note?: string;
}): Transaction {
  const date = input.at.slice(0, 10);
  return {
    id: input.id,
    external_id: `ext_${input.id}`,
    dedupe_key: input.dedupeKey ?? `K_${input.id}`,
    source: input.source ?? 'manual',
    direction: input.direction ?? 'expense',
    amount_cents: input.amount as Cents,
    occurred_at: input.at,
    occurred_date: date,
    month_key: date.slice(0, 7),
    category_l1: 'food',
    category_l2: 'food.lunch',
    account_id: 'acc_wechat',
    payment_channel: 'wechat',
    note: input.note ?? '',
    flags: [],
    manual_edited: false,
    category_locked: false,
    dedupe_status: 'clean',
    imported_at: input.at,
    created_at: input.at,
    updated_at: input.updatedAt ?? input.at,
    ...(input.deletedAt ? { deleted_at: input.deletedAt } : {}),
  };
}

async function expenseSum(monthKey?: string): Promise<number> {
  const rows = await db.transactions.toArray();
  return rows
    .filter((row) => !row.deleted_at && row.direction === 'expense')
    .filter((row) => (monthKey ? row.month_key === monthKey : true))
    .reduce((sum, row) => sum + row.amount_cents, 0);
}

/** 自己封一份备份信封（用于构造 v1/v3/坏校验和这些 exportEncrypted 造不出来的形态）。 */
const MAGIC = 'MTLBK1';

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function seal(payload: unknown, passphrase: string, checksumOverride?: string): Promise<File> {
  const cryptoObj = globalThis.crypto;
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const checksum = checksumOverride ?? (await sha256Hex(plaintext));
  const salt = cryptoObj.getRandomValues(new Uint8Array(16));
  const iv = cryptoObj.getRandomValues(new Uint8Array(12));
  const baseKey = await cryptoObj.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  const key = await cryptoObj.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: 600000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const cipher = await cryptoObj.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    plaintext as unknown as BufferSource,
  );
  const magic = new TextEncoder().encode(MAGIC);
  const checksumBytes = new TextEncoder().encode(checksum);
  const total = magic.length + 1 + checksumBytes.length + salt.length + iv.length + cipher.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  out.set(magic, offset);
  offset += magic.length;
  out[offset] = checksumBytes.length;
  offset += 1;
  out.set(checksumBytes, offset);
  offset += checksumBytes.length;
  out.set(salt, offset);
  offset += salt.length;
  out.set(iv, offset);
  offset += iv.length;
  out.set(new Uint8Array(cipher), offset);
  return toFile(new Blob([out], { type: 'application/octet-stream' }), 'sealed.mtlbk');
}

/**
 * 从实现里读「本机独占、不跨设备传播」的设置键清单。
 * 不在用例里写死键名：清单本身是要被验证的契约之一，写死就等于自己给自己出题。
 */
function excludedSettingKeysFromSource(): string[] {
  const source = readFileSync('src/backup/backup.ts', 'utf8');
  const start = source.indexOf('const SYNC_EXCLUDED_SETTING_KEYS');
  expect(start, 'backup.ts 里找不到 SYNC_EXCLUDED_SETTING_KEYS，说明实现结构调整了').toBeGreaterThan(-1);
  const block = source.slice(start, source.indexOf('];', start));
  return [...block.matchAll(/SETTING_KEYS\.(\w+)/g)].map(
    (match) => (SETTING_KEYS as Record<string, string>)[match[1]],
  );
}

function fileFromPath(path: string): ImportFile {
  const buffer = readFileSync(path);
  return {
    name: basename(path),
    size: buffer.byteLength,
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    readArrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    readText: async () => '',
  };
}

beforeAll(async () => {
  // jsdom 的 crypto 可能没有 subtle；用 Node 的 webcrypto 顶上，而不是跳过用例
  if (typeof globalThis.crypto?.subtle?.encrypt !== 'function') {
    const { webcrypto } = await import('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
  }
});

beforeEach(async () => {
  await resetDb();
});

// ------------------------------------------------------ 攻击面一：不丢账

describe.skipIf(!HAS_REAL)('QA-R4a 攻击面一：真实旧表 399 笔，合并恢复一笔不少', () => {
  it('导出 → 再记 5 笔 → 合并恢复：404 笔、无重复、2023 支出合计不变', async () => {
    await ensureSeeded(db);
    const imported = await runImport(fileFromPath(REAL_XLSX), { defaultYear: 2023 });
    expect(imported.insertedRows).toBe(399);

    const countBefore = await db.transactions.count();
    const totalBefore = await expenseSum();
    const aprilBefore = await expenseSum('2023-04');
    const mayBefore = await expenseSum('2023-05');
    expect(countBefore).toBe(399);
    // 真值：支出明细 20791.81
    expect(totalBefore).toBe(2079181);
    expect(aprilBefore).toBe(134790);

    const backupFile = await toFile(await exportEncrypted(PASS));

    // 导出之后这台机器继续记账
    const extra = [1, 2, 3, 4, 5].map((index) =>
      tx({ id: `new-${index}`, at: `2023-05-0${index}T12:00:00`, amount: 1000 + index, note: `备份后新增 ${index}` }),
    );
    await db.transactions.bulkAdd(extra);

    const report = await restoreFromFile(backupFile, PASS, { mode: 'merge' });

    const rows = await db.transactions.toArray();
    expect(rows, 'N + 5，既不丢也不翻倍').toHaveLength(404);
    expect(rows.filter((row) => row.id.startsWith('new-'))).toHaveLength(5);
    expect(new Set(rows.map((row) => row.id)).size, 'id 不得重复').toBe(404);

    // 第二口径：月合计（不信 stats，只信数据）
    expect(await expenseSum()).toBe(totalBefore + 5015);
    expect(await expenseSum('2023-04'), '4 月合计不能被合并打乱').toBe(aprilBefore);
    expect(await expenseSum('2023-05'), '只有新记的 5 笔叠加到 5 月').toBe(mayBefore + 5015);

    expect(report.mode).toBe('merge');
    expect(report.stats.duplicate, '同一批账不得被当成跨设备重复').toBe(0);
    expect(report.stats.inserted).toBe(0);
  }, 120000);
});

describe('QA-R4a 攻击面一：合成 400 笔体量', () => {
  it('400 笔 + 5 笔 → 405 笔，唯一 dedupe 指纹也是 405', async () => {
    await ensureSeeded(db);
    const bulk: Transaction[] = [];
    for (let index = 0; index < 400; index += 1) {
      const month = (index % 12) + 1;
      const day = (Math.floor(index / 12) % 28) + 1;
      const mm = String(month).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      bulk.push(tx({ id: `bulk-${index}`, at: `2023-${mm}-${dd}T12:00:00`, amount: 100 + index }));
    }
    expect(bulk).toHaveLength(400);
    await db.transactions.bulkAdd(bulk);
    const before = await expenseSum();

    const backupFile = await toFile(await exportEncrypted(PASS));
    await db.transactions.bulkAdd(
      [1, 2, 3, 4, 5].map((index) =>
        tx({ id: `after-${index}`, at: `2026-10-0${index}T12:00:00`, amount: 900 + index }),
      ),
    );

    await restoreFromFile(backupFile, PASS, { mode: 'merge' });

    const rows = await db.transactions.toArray();
    expect(rows).toHaveLength(405);
    const fingerprints = new Set(rows.map((row) => `${row.source}::${row.dedupe_key}`));
    expect(fingerprints.size, '同一笔账不能变成两条').toBe(405);
    expect(await expenseSum('2023-01')).toBe(
      bulk.filter((row) => row.month_key === '2023-01').reduce((sum, row) => sum + row.amount_cents, 0),
    );
    expect(before).toBe(bulk.reduce((sum, row) => sum + row.amount_cents, 0));
  }, 120000);
});

// ------------------------------------------- 攻击面二：已删除的账不复活

describe('QA-R4b 攻击面二：删除墓碑双向生效', () => {
  it('本机删了、备份里还是未删的旧版本 → 合并后仍然是删除状态', async () => {
    await ensureSeeded(db);
    await db.transactions.add(tx({ id: 'del-1', at: '2026-10-01T09:00:00', amount: 1500 }));
    const backupFile = await toFile(await exportEncrypted(PASS));

    // 导出后本机删除（softDelete 同时抬 updated_at）
    await db.transactions.update('del-1', { deleted_at: '2026-10-08T10:00:00', updated_at: '2026-10-08T10:00:00' });

    const report = await restoreFromFile(backupFile, PASS, { mode: 'merge' });

    const row = await db.transactions.get('del-1');
    expect(row?.deleted_at, '旧备份绝不能把删掉的账复活').toBe('2026-10-08T10:00:00');
    expect(await db.transactions.count()).toBe(1);
    expect(report.stats.updated).toBe(0);
  }, 60000);

  it('备份里删除更晚 → 本机同步删除（另一台设备的删除动作要传过来）', async () => {
    await ensureSeeded(db);
    await db.transactions.add(tx({ id: 'del-2', at: '2026-10-02T09:00:00', amount: 2000 }));
    const backupFile = await toFile(await exportEncrypted(PASS));

    // 备份侧（导出之后）在另一台设备上删了这笔，时间更晚；本机把它恢复成未删
    await db.transactions.update('del-2', { deleted_at: undefined, updated_at: '2026-10-03T00:00:00' });

    const synthetic = await seal(
      {
        version: 2,
        exported_at: '2026-10-09T00:00:00',
        device_label: '我的手机',
        tables: {
          transactions: [
            tx({
              id: 'del-2',
              at: '2026-10-02T09:00:00',
              amount: 2000,
              deletedAt: '2026-10-09T00:00:00',
              // 真实的 softDelete 会同时抬 updated_at（见 transactionRepo.softDelete）
              updatedAt: '2026-10-09T00:00:00',
            }),
          ],
        },
      },
      PASS,
    );
    await restoreFromFile(synthetic, PASS, { mode: 'merge' });

    const row = await db.transactions.get('del-2');
    expect(row?.deleted_at, '更晚的删除必须同步到本机').toBe('2026-10-09T00:00:00');
    void backupFile;
  }, 60000);

  it('边界：两端都已删除 → skip，不写回、不复活', async () => {
    await ensureSeeded(db);
    await db.transactions.add(
      tx({ id: 'del-3', at: '2026-10-03T09:00:00', amount: 3000, deletedAt: '2026-10-05T00:00:00' }),
    );
    const backupFile = await toFile(await exportEncrypted(PASS));
    await db.transactions.update('del-3', { deleted_at: '2026-10-07T00:00:00', updated_at: '2026-10-07T00:00:00' });

    await restoreFromFile(backupFile, PASS, { mode: 'merge' });
    const row = await db.transactions.get('del-3');
    expect(row?.deleted_at).toBe('2026-10-07T00:00:00');
  }, 60000);

  it('删除过的账不会被另一台设备的同指纹副本以新行复活（按指纹传播删除意图）', async () => {
    await ensureSeeded(db);
    // 手机：一笔微信账单，id=A
    await db.transactions.add(tx({ id: 'phone-A', at: '2026-10-01T12:00:00', amount: 1500, source: 'wechat', dedupeKey: 'W-SAME' }));
    const backupFile = await toFile(await exportEncrypted(PASS));

    // 电脑：同一笔（指纹相同、id 不同），用户随后把它删了
    await db.transactions.clear();
    await db.transactions.add(
      tx({
        id: 'pc-B',
        at: '2026-10-01T12:00:00',
        amount: 1500,
        source: 'wechat',
        dedupeKey: 'W-SAME',
        deletedAt: '2026-10-05T00:00:00',
      }),
    );

    await restoreFromFile(backupFile, PASS, { mode: 'merge' });

    const rows = await db.transactions.toArray();
    const alive = rows.filter((row) => !row.deleted_at);
    // 删除是用户的明确动作，不能因为"另一台设备还留着同指纹的副本"就自己回来
    expect(alive.map((row) => row.id), '删掉的账不许以新 id 复活').toEqual([]);
    expect(rows.every((row) => Boolean(row.deleted_at))).toBe(true);
  }, 60000);

  it('边界：本机删过同一笔，但备份那条是删除之后的新记录 → 允许进来（不能一律封死）', async () => {
    await ensureSeeded(db);
    // 本机：这笔在 10-01 记过，10-05 删了
    await db.transactions.add(
      tx({
        id: 'pc-B',
        at: '2026-10-01T12:00:00',
        amount: 1500,
        source: 'wechat',
        dedupeKey: 'W-SAME',
        deletedAt: '2026-10-05T00:00:00',
      }),
    );
    // 备份：同一笔（指纹相同、id 不同），但记录时间晚于删除
    const synthetic = await seal(
      {
        version: 2,
        exported_at: '2026-10-10T00:00:00',
        tables: {
          transactions: [
            tx({ id: 'phone-A', at: '2026-10-09T12:00:00', amount: 1500, source: 'wechat', dedupeKey: 'W-SAME' }),
          ],
        },
      },
      PASS,
    );

    await restoreFromFile(synthetic, PASS, { mode: 'merge' });

    const alive = (await db.transactions.toArray()).filter((row) => !row.deleted_at);
    expect(alive.map((row) => row.id), '删除之后的新记录必须能进来').toEqual(['phone-A']);
  }, 60000);

  it('边界探测：备份侧 deleted_at 更晚、但 updated_at 没抬高 → 删除不会同步（版本只看 updated_at）', async () => {
    await ensureSeeded(db);
    await db.transactions.add(tx({ id: 'del-4', at: '2026-10-04T09:00:00', amount: 4000, updatedAt: '2026-10-04T09:00:00' }));

    // 备份里 deleted_at 明显更晚，但 updated_at 仍是原值（模拟某些客户端只写 deleted_at）
    const synthetic = await seal(
      {
        version: 2,
        exported_at: '2026-10-12T00:00:00',
        tables: {
          transactions: [
            tx({
              id: 'del-4',
              at: '2026-10-04T09:00:00',
              amount: 4000,
              deletedAt: '2026-10-12T00:00:00',
              updatedAt: '2026-10-04T09:00:00',
            }),
          ],
        },
      },
      PASS,
    );
    await restoreFromFile(synthetic, PASS, { mode: 'merge' });

    const row = await db.transactions.get('del-4');
    // 记录真实行为：本实现 versionOf() 优先 updated_at，不看 deleted_at，
    // 因此 deleted_at 更晚但 updated_at 未抬高时，删除**不会**同步过来。
    expect(row?.deleted_at, '本实现的已知边界：deleted_at 不参与版本比较').toBeUndefined();
  }, 60000);
});

// --------------------------------------- 攻击面三：跨设备重复导入不翻倍

describe('QA-R4c 攻击面三：跨设备同一份账单', () => {
  it('10 笔 source+dedupe_key 相同、id 不同 → 计 duplicate，count 不翻倍', async () => {
    await ensureSeeded(db);
    const phone = Array.from({ length: 10 }, (_, index) =>
      tx({
        id: `phone-${index}`,
        at: `2026-10-0${(index % 9) + 1}T12:00:00`,
        amount: 1000 + index,
        source: 'wechat',
        dedupeKey: `W${index}`,
      }),
    );
    await db.transactions.bulkAdd(phone);
    const backupFile = await toFile(await exportEncrypted(PASS));

    // 电脑从同一份微信账单又导了一次：id 不同，source+dedupe_key 相同
    await db.transactions.clear();
    await db.transactions.bulkAdd(
      phone.map((row, index) => ({ ...row, id: `pc-${index}`, imported_at: '2026-10-10T00:00:00' })),
    );
    expect(await db.transactions.count()).toBe(10);

    const report = await restoreFromFile(backupFile, PASS, { mode: 'merge' });

    expect(await db.transactions.count(), '同一份账单导两次不能变成 20 笔').toBe(10);
    expect(report.stats.duplicate).toBe(10);
    expect(report.stats.inserted).toBe(0);
  }, 60000);

  it('dedupe_key 相同但 source 不同（微信 vs 支付宝）→ 合法两笔，不许当重复', async () => {
    await ensureSeeded(db);
    await db.transactions.add(tx({ id: 'wx-1', at: '2026-10-01T12:00:00', amount: 1500, source: 'wechat', dedupeKey: 'SAME' }));
    const backupFile = await toFile(await exportEncrypted(PASS));

    await db.transactions.add(
      tx({ id: 'ali-1', at: '2026-10-02T12:00:00', amount: 1500, source: 'alipay', dedupeKey: 'SAME' }),
    );
    const report = await restoreFromFile(backupFile, PASS, { mode: 'merge' });

    const rows = await db.transactions.toArray();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.source).sort()).toEqual(['alipay', 'wechat']);
    expect(report.stats.duplicate).toBe(0);
  }, 60000);
});

// ------------------------------- 攻击面四：设置与配置跨设备迁移

describe('QA-R4d 攻击面四：设置迁移', () => {
  /** 造一份含"用户真实时薪口径"和设备名的备份（模拟电脑 A 导出）。 */
  async function makeSettingsBackup(): Promise<File> {
    await resetDb();
    await ensureSeeded(db);
    await settingsRepo.setWageSettings({
      hourly_wage_mode: 'manual',
      monthly_salary_cents: 1234500 as Cents,
      // 出厂默认是 null 的键：专门用来验"null 与 undefined 不能混同"那条
      hourly_wage_manual_cents: 5000 as Cents,
      time_cost_threshold_cents: 500 as Cents,
      workday_hours: 7,
    });
    await setDeviceLabel('我的电脑');
    await settingsRepo.setThemeMode('dark');
    await settingsRepo.markBackupDone('2026-10-01T08:00:00');
    await settingsRepo.markOcrPackDownloaded();
    await settingsRepo.set(SETTING_KEYS.lastCategory, 'food');
    await db.transactions.add(tx({ id: 'keep', at: '2026-10-01T12:00:00', amount: 1500 }));
    return toFile(await exportEncrypted(PASS));
  }

  it('settings 表完全为空（未 seed）→ 时薪口径能补进来（机制本身是通的）', async () => {
    const backupFile = await makeSettingsBackup();
    await resetDb(); // 完全空白，不跑 ensureSeeded
    expect(await db.settings.count()).toBe(0);

    await restoreFromFile(backupFile, PASS, { mode: 'merge' });

    const wage = await settingsRepo.getWageSettings();
    expect(wage.hourly_wage_mode).toBe('manual');
    expect(wage.monthly_salary_cents).toBe(1234500);
    expect(wage.time_cost_threshold_cents).toBe(500);
  }, 60000);

  it('真实新设备（首次打开已 seed 默认值）→ 时薪口径必须来自备份，而不是停在默认值', async () => {
    const backupFile = await makeSettingsBackup();

    await resetDb();
    await ensureSeeded(db); // ← 真实场景：用户还没进设置页，默认值已经写进库了
    const seeded = await settingsRepo.getWageSettings();
    expect(seeded.hourly_wage_mode).toBe('salary_div_hours');
    expect(seeded.monthly_salary_cents).toBe(800000);

    await restoreFromFile(backupFile, PASS, { mode: 'merge' });

    const wage = await settingsRepo.getWageSettings();
    // 一次性把"整张 settings 表都没进来"摊开，避免只看到第一个字段的差异
    expect(
      {
        hourly_wage_mode: wage.hourly_wage_mode,
        monthly_salary_cents: wage.monthly_salary_cents,
        hourly_wage_manual_cents: wage.hourly_wage_manual_cents,
        time_cost_threshold_cents: wage.time_cost_threshold_cents,
        workday_hours: wage.workday_hours,
        theme: await settingsRepo.getThemeMode(),
      },
      '换设备后「一小时值多少钱」不能回落到出厂口径（备份里的设置必须补进来）',
    ).toEqual({
      hourly_wage_mode: 'manual',
      monthly_salary_cents: 1234500,
      hourly_wage_manual_cents: 5000,
      time_cost_threshold_cents: 500,
      workday_hours: 7,
      theme: 'dark',
    });
  }, 60000);

  it('本机已有不同设置 → 本机值必须保留，不被备份覆盖', async () => {
    const backupFile = await makeSettingsBackup();

    await resetDb();
    await ensureSeeded(db);
    await settingsRepo.setWageSettings({ monthly_salary_cents: 999900 as Cents, hourly_wage_mode: 'manual' });

    await restoreFromFile(backupFile, PASS, { mode: 'merge' });

    const wage = await settingsRepo.getWageSettings();
    expect(wage.monthly_salary_cents, '本机口径优先').toBe(999900);
  }, 60000);

  it('本机独占键（4 个）全部不跨设备传播，且没有误伤别的键', async () => {
    const backupFile = await makeSettingsBackup();

    await resetDb();
    await ensureSeeded(db);
    await setDeviceLabel('我的手机');
    await settingsRepo.markBackupDone('2026-10-20T20:00:00');
    await db.settings.delete(SETTING_KEYS.lastCategory);
    // 备份里 ocr_pack_downloaded=true（那台机器下载过语言包），本机没下过。
    // 若这条被带过来，本机 OCR 会去加载并不存在的 20MB 资源 —— 直接报错且用户查不出原因。
    expect(await settingsRepo.isOcrPackDownloaded(), '本机没下过语言包').toBe(false);
    // seeded_version 也换成本机专属值，用来观察它是否被备份覆盖
    await db.settings.put({ key: SETTING_KEYS.seededVersion, value: 99 });

    await restoreFromFile(backupFile, PASS, { mode: 'merge' });

    expect(await settingsRepo.get(SETTING_KEYS.deviceLabel, '')).toBe('我的手机');
    expect(await settingsRepo.get<string | null>(SETTING_KEYS.lastBackupAt, null)).toBe('2026-10-20T20:00:00');
    expect(await settingsRepo.isOcrPackDownloaded(), 'OCR 资产状态绝不能从别的设备带过来').toBe(false);
    expect(await settingsRepo.get(SETTING_KEYS.seededVersion, 0), 'seed 幂等标记不跨设备').toBe(99);
    // 对照：过滤不能连普通键一起滤掉
    expect(await settingsRepo.get<string | null>(SETTING_KEYS.lastCategory, null), '本机缺的键必须补进来').toBe('food');
  }, 60000);

  it('replace 模式：本机 device_label 是否被冲成备份里那台设备的名字（预判缺陷复核）', async () => {
    const backupFile = await makeSettingsBackup();

    await resetDb();
    await ensureSeeded(db);
    await setDeviceLabel('我的手机');
    await settingsRepo.markBackupDone('2026-10-20T20:00:00');

    const report = await restoreFromFile(backupFile, PASS, { mode: 'replace' });

    const label = await settingsRepo.get(SETTING_KEYS.deviceLabel, '');
    const lastBackup = await settingsRepo.get<string | null>(SETTING_KEYS.lastBackupAt, null);
    // 这两条断言的期望值是"应该保留本机值"。若失败，即 team-lead 预判的 UX 缺陷成立。
    expect(
      { device_label: label, last_backup_at: lastBackup },
      '覆盖模式把本机设备名/备份时间冲成了备份那台设备的',
    ).toEqual({ device_label: '我的手机', last_backup_at: '2026-10-20T20:00:00' });

    // 顺带钉死"过滤掉的行不许多报"：stats.inserted 必须等于真正从备份写进来的行数。
    // 本机独占键的清单从实现里读，避免我在用例里把键名写死（清单变了用例自动跟着变）。
    const excluded = excludedSettingKeysFromSource();
    expect(excluded.length, '本机独占键清单不该为空').toBeGreaterThan(0);
    const kept = (await db.settings.toArray()).filter((row) => excluded.includes(row.key));
    const totals = await Promise.all(db.tables.map((table) => table.count()));
    expect(totals.reduce((sum, value) => sum + value, 0), 'stats.inserted 不能把保留下来的本机行也算进去').toBe(
      report.stats.inserted + kept.length,
    );
  }, 60000);
});

// ------------------------------ 攻击面四·同族：seed 默认值占坑的其他表

describe('QA-R4d2 同族缺陷：seed 写过且带时间戳的表，备份永远赢不过首启', () => {
  it('观察：用户刻意设成"恰好等于出厂默认"的值，无法与"没动过"区分，合并时会被备份覆盖', async () => {
    // 设备A：用户手动把月薪设成 8000 元 —— 正好等于出厂默认 800000
    await ensureSeeded(db);
    await settingsRepo.setWageSettings({ monthly_salary_cents: 800000 as Cents });
    await db.transactions.add(tx({ id: 'x', at: '2026-10-01T12:00:00', amount: 100 }));
    const backupFile = await toFile(await exportEncrypted(PASS));

    // 设备B：用户设成 9000 元
    await resetDb();
    await ensureSeeded(db);
    await settingsRepo.setWageSettings({ monthly_salary_cents: 900000 as Cents });

    await restoreFromFile(backupFile, PASS, { mode: 'merge' });

    const wage = await settingsRepo.getWageSettings();
    // 记录真实行为："值等于默认"被当作"用户没动过"，于是 A 刻意设的 8000 被 B 的 9000 覆盖。
    // 这是豁免机制的固有代价（无法区分"刻意设成默认"和"从没设过"），影响面小，记录备查。
    expect(wage.monthly_salary_cents, '已知行为：刻意等于默认值的设置会被覆盖').toBe(900000);
  }, 60000);

  it('观察：分类改名仍不跨设备（Category/Account 没有时间戳字段，整表本地优先）', async () => {
    await ensureSeeded(db);
    const target = (await db.categories.toArray())[0];
    const originalName = target.l1_name;
    await db.categories.update(target.id, { l1_name: '改名后的分类' });
    await db.transactions.add(tx({ id: 'c', at: '2026-10-01T12:00:00', amount: 100 }));
    const backupFile = await toFile(await exportEncrypted(PASS));

    await resetDb();
    await ensureSeeded(db);
    await restoreFromFile(backupFile, PASS, { mode: 'merge' });

    const after = await db.categories.get(target.id);
    // 记录真实行为：分类表没有版本字段 → hasVersion=false → 本机优先，改名不会同步过来。
    // 影响比规则小（不丢条目、只是名字），但用户会看到同一笔账在两台设备上分类名不同。
    expect(after?.l1_name, '已知行为：分类改名不跨设备').toBe(originalName);
  }, 60000);

  it('内置规则的禁用状态能跨设备传播（出厂时间戳改成了固定远古值，不再压过备份）', async () => {
    // 设备A：用户把「美团 / 外卖」这条内置规则关了
    await ensureSeeded(db);
    await db.rules.update('kw_meituan', { enabled: false, updated_at: '2026-10-01T00:00:00' });
    const backupFile = await toFile(await exportEncrypted(PASS));

    // 设备B：全新首启 → seed 用 SEED_EPOCH 写回 builtin 规则（enabled:true），时间戳是 2000 年
    await resetDb();
    await ensureSeeded(db);
    const seeded = await db.rules.get('kw_meituan');
    expect(seeded?.enabled, '本机首启是启用状态').toBe(true);
    expect(seeded?.updated_at, '出厂时间戳必须是固定远古值').toBe(SEED_EPOCH);

    await restoreFromFile(backupFile, PASS, { mode: 'merge' });

    const after = await db.rules.get('kw_meituan');
    expect(after?.enabled, '用户关掉的规则不能换设备后自己又打开').toBe(false);
  }, 60000);
});

// ------------------------- 终验定向攻击：规则双向 / data_version / 旧数据兼容

describe('QA-R4g 终验定向攻击', () => {
  it('规则启用状态·反向：本机明确启用更晚、备份是更早的禁用 → 保持启用', async () => {
    // 设备A（手机）：10-01 把规则关了
    await ensureSeeded(db);
    await db.rules.update('kw_meituan', { enabled: false, updated_at: '2026-10-01T00:00:00' });
    const backupFile = await toFile(await exportEncrypted(PASS));

    // 设备B（电脑）：10-05 又把它打开（明确动作，比备份里的禁用更晚）
    await resetDb();
    await ensureSeeded(db);
    await db.rules.update('kw_meituan', { enabled: true, updated_at: '2026-10-05T00:00:00' });

    await restoreFromFile(backupFile, PASS, { mode: 'merge' });

    const after = await db.rules.get('kw_meituan');
    expect(after?.enabled, '本机更晚的明确启用不能被更早的禁用覆盖回去').toBe(true);
  }, 60000);

  it('规则·本机从未动过（SEED_EPOCH）时，备份里任何真实动作都算更新 → 采用备份', async () => {
    // 设备A：10-01 禁用
    await ensureSeeded(db);
    await db.rules.update('kw_meituan', { enabled: false, updated_at: '2026-10-01T00:00:00' });
    const backupFile = await toFile(await exportEncrypted(PASS));

    // 设备B：首启后从没碰过这条规则（updated_at 仍是 SEED_EPOCH）
    await resetDb();
    await ensureSeeded(db);
    expect((await db.rules.get('kw_meituan'))?.updated_at).toBe(SEED_EPOCH);

    await restoreFromFile(backupFile, PASS, { mode: 'merge' });

    // 「出厂默认」在语义上就是"用户没表过态"，所以备份里用户的任何动作都该生效。
    // 注意：这意味着 team-lead 提问里"电脑上那条是 SEED_EPOCH，所以应该还是启用"的前提是反的——
    // SEED_EPOCH 比备份的禁用时间早，版本比较会让备份赢，结论应是「禁用」。这里钉住的正是这条语义。
    expect(
      (await db.rules.get('kw_meituan'))?.enabled,
      '出厂默认不代表用户意见，备份里的真实动作应当生效',
    ).toBe(false);
  }, 60000);

  it('data_version 不回退：合并更低/更高的备份后，仍以本机当前值为准并继续递增', async () => {
    // 备份 A：data_version = 3
    await ensureSeeded(db);
    await settingsRepo.set(SETTING_KEYS.dataVersion, 3);
    await db.transactions.add(tx({ id: 'dv-a', at: '2026-10-01T12:00:00', amount: 100 }));
    const lower = await toFile(await exportEncrypted(PASS));

    // 备份 B：data_version = 99
    await resetDb();
    await ensureSeeded(db);
    await settingsRepo.set(SETTING_KEYS.dataVersion, 99);
    await db.transactions.add(tx({ id: 'dv-b', at: '2026-10-01T12:00:00', amount: 100 }));
    const higher = await toFile(await exportEncrypted(PASS));

    // 本机：57，合并更低的备份
    await resetDb();
    await ensureSeeded(db);
    await settingsRepo.set(SETTING_KEYS.dataVersion, 57);
    await restoreFromFile(lower, PASS, { mode: 'merge' });
    expect(await settingsRepo.getDataVersion(), '合并更低版本号的备份不能把计数器打回去').toBe(57);
    expect(await settingsRepo.bumpDataVersion(), '递增必须从当前值算，不能写死初值').toBe(58);

    // 本机：57，合并更高的备份 → 也不该被抬高（本机≠出厂默认，本地优先）
    await resetDb();
    await ensureSeeded(db);
    await settingsRepo.set(SETTING_KEYS.dataVersion, 57);
    await restoreFromFile(higher, PASS, { mode: 'merge' });
    expect(await settingsRepo.getDataVersion(), '本机已用过的计数器不被备份带走').toBe(57);
    expect(await settingsRepo.bumpDataVersion()).toBe(58);
  }, 120000);

  it('旧数据兼容：本机规则是上一版 seed 写的真实旧时间戳（非 2000 年）→ 仍被更新的备份覆盖', async () => {
    // 模拟"老装机升级"：本机行带 2025 年的真实时间戳，不是 SEED_EPOCH
    await ensureSeeded(db);
    await db.rules.update('kw_meituan', { enabled: true, updated_at: '2025-06-01T00:00:00' });
    await db.transactions.add(tx({ id: 'legacy', at: '2025-06-01T12:00:00', amount: 100 }));

    const synthetic = await seal(
      {
        version: 2,
        exported_at: '2026-10-10T00:00:00',
        tables: {
          rules: [
            {
              ...(await db.rules.get('kw_meituan')),
              enabled: false,
              updated_at: '2026-10-01T00:00:00',
            },
          ],
        },
      },
      PASS,
    );

    await restoreFromFile(synthetic, PASS, { mode: 'merge' });

    const after = await db.rules.get('kw_meituan');
    expect(after?.enabled, '老装机的真实旧时间戳仍应输给更新的备份').toBe(false);
    expect(after?.updated_at).toBe('2026-10-01T00:00:00');
  }, 60000);
});

describe('QA-R4e 攻击面五：Backup.tsx 呈现（源码静态断言）', () => {
  const SOURCE = readFileSync('src/ui/pages/Settings/Backup.tsx', 'utf8');

  it('doRestore 真的传了 mode，不是走默认值', () => {
    expect(SOURCE).toContain('restoreFromFile(restoreTarget, restorePass, { mode: restoreMode })');
    expect(SOURCE).not.toMatch(/restoreFromFile\(\s*restoreTarget,\s*restorePass\s*\)/);
  });

  it('没有残留旧 API 的 result.restored，也没有 as any 绕过类型', () => {
    expect(SOURCE).not.toMatch(/\.restored\b/);
    expect(SOURCE).not.toMatch(/\bas\s+any\b/);
    expect(SOURCE).toContain('type MergeReport');
  });

  it('五个统计数字逐个绑对，没有错位（按 DOM 顺序核对「标签→取值」配对）', () => {
    // 只取统计网格本身：用最近的闭合 </Box> 收尾，避免把网格下方的说明文案也算进 token 序列
    const gridStart = SOURCE.indexOf("gridTemplateColumns: '1fr 1fr'");
    const grid = SOURCE.slice(gridStart, SOURCE.indexOf('</Box>', gridStart));
    expect(grid.length, '找不到统计网格，说明结构变了，需要人工复核').toBeGreaterThan(200);
    const tokens = [
      ...grid.matchAll(/\{report\.stats\.(\w+)\}|>\s*\n\s*([\u4e00-\u9fa5（）]+)\s*\n\s*<\/Typography>/g),
    ].map((match) => match[1] ?? match[2]);
    expect(tokens, '标签与数值必须一一对应，错位就会把 conflict 显示成 duplicate').toEqual([
      '新增',
      'inserted',
      '更新',
      'updated',
      '跳过',
      'skipped',
      '重复（已存在）',
      'duplicate',
      '冲突',
      'conflict',
    ]);
  });

  it('checksumWarning 非空时真的渲染出来', () => {
    expect(SOURCE).toMatch(/\{report\.checksumWarning && <Alert severity="error">\{report\.checksumWarning\}<\/Alert>\}/);
  });

  it('设备名 onBlur 写的是 SETTING_KEYS.deviceLabel 对应键', () => {
    expect(SOURCE).toContain('onBlur={saveDeviceLabel}');
    expect(SOURCE).toContain('await setDeviceLabel(deviceName)');
    // setDeviceLabel 内部必须落到 device_label 这个键上
    const backupSource = readFileSync('src/backup/backup.ts', 'utf8');
    expect(backupSource).toMatch(/setDeviceLabel[\s\S]{0,200}SETTING_KEYS\.deviceLabel/);
  });

  it('覆盖模式有红字警告，合并模式有"不会覆盖本机"的说明', () => {
    expect(SOURCE).toContain('覆盖不可撤销');
    expect(SOURCE).toContain('分类、设置、目标以本机为准');
  });
});

// --------------------------- 攻击面六：既有功能没被碰坏

describe('QA-R4f 攻击面六：exportCsv / 版本兼容 / 口令', () => {
  it('exportCsv 仍然正常：BOM + 13 列表头 + 排除已删 + 逗号转义', async () => {
    await ensureSeeded(db);
    await db.transactions.bulkAdd([
      tx({ id: 'csv-1', at: '2026-10-01T09:00:00', amount: 1500, note: '带,逗号' }),
      tx({ id: 'csv-2', at: '2026-10-02T09:00:00', amount: 2500, deletedAt: '2026-10-03T00:00:00' }),
    ]);

    // FileReader 的文本解码会吞掉 BOM，所以按字节验，别按字符串验
    const bytes = new Uint8Array((await readBlob(await exportCsv(), 'buffer')) as ArrayBuffer);
    expect([bytes[0], bytes[1], bytes[2]], 'BOM 必须在，否则 Excel 乱码').toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes).replace(/^\uFEFF/, '');
    const lines = csv.split('\r\n');
    expect(lines[0].split(',')).toHaveLength(13);
    expect(lines).toHaveLength(2); // 表头 + 1 笔（已删的不导）
    expect(csv).toContain('"带,逗号"');
  }, 30000);

  it('version:1 的旧备份能走合并，不因版本抛错', async () => {
    await ensureSeeded(db);
    const file = await seal(
      {
        version: 1,
        exported_at: '2026-09-01T00:00:00',
        tables: { transactions: [tx({ id: 'v1-row', at: '2026-09-01T12:00:00', amount: 777 })] },
      },
      PASS,
    );
    const report = await restoreFromFile(file, PASS, { mode: 'merge' });
    expect(report.mode).toBe('merge');
    expect(await db.transactions.get('v1-row')).toBeTruthy();
  }, 60000);

  it('version:3 明确报「版本不支持」，不是静默跳过', async () => {
    await ensureSeeded(db);
    const file = await seal({ version: 3, exported_at: '2027-01-01T00:00:00', tables: { transactions: [] } }, PASS);
    await expect(restoreFromFile(file, PASS, { mode: 'merge' })).rejects.toThrow(/版本不支持/);
  }, 60000);

  it('口令错误必须抛错，不能"解不开就当空备份"', async () => {
    await ensureSeeded(db);
    await db.transactions.add(tx({ id: 'pw-1', at: '2026-10-01T12:00:00', amount: 1500 }));
    const file = await toFile(await exportEncrypted(PASS));
    await expect(restoreFromFile(file, 'wrong-pass-999', { mode: 'merge' })).rejects.toThrow('口令不对');
    expect(await db.transactions.count(), '失败的恢复不能动到本机数据').toBe(1);
  }, 60000);

  it('不是本应用导出的文件 → 明确报错', async () => {
    const junk = new Uint8Array(200).fill(7);
    const file = await toFile(new Blob([junk]), 'random.bin');
    await expect(restoreFromFile(file, PASS, { mode: 'merge' })).rejects.toThrow('这不是本应用导出的备份文件');
  }, 30000);

  it('校验和被改过 → checksumWarning 有值，但恢复不被阻断', async () => {
    await ensureSeeded(db);
    const file = await seal(
      { version: 2, exported_at: '2026-10-01T00:00:00', tables: { transactions: [tx({ id: 'tamper-1', at: '2026-10-01T12:00:00', amount: 1234 })] } },
      PASS,
      'a'.repeat(64),
    );
    const report = await restoreFromFile(file, PASS, { mode: 'merge' });
    expect(report.checksumWarning, '校验和不一致必须提示用户').toBeTruthy();
    expect(report.checksumWarning).toContain('校验和');
    expect(await db.transactions.get('tamper-1'), '只是警告，不阻断').toBeTruthy();
  }, 60000);
});
