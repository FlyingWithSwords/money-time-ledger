import { db } from '../db';
import type { Transaction } from '../types';
import { centsToYuan } from '../domain/money';
import { DIRECTION_LABEL, SOURCE_LABEL } from '../types';
import { SETTING_KEYS } from '../db/settingKeys';
import { SEED_SETTING_DEFAULTS_RECORD } from '../db/settingDefaults';
import * as settingsRepo from '../db/repos/settingsRepo';
import { planMerge, sumStats, versionOf, type MergeTableStats, type Row } from './merge';

/**
 * 加密备份（WebCrypto：PBKDF2-SHA256 600k + AES-256-GCM）。
 * - 口令错误必然解密失败（GCM 自带完整性校验），可验收；
 * - **无服务器，口令不可找回**；
 * - 次级逃生通道：导出未加密 CSV（明确告知会泄露明文）。
 *
 * v2 起支持**合并恢复**：原来的"清空再写入"会把本机已有的账冲掉，
 * 导致手机↔电脑来回导一次丢一次。合并规则见 `backup/merge.ts`。
 */

const MAGIC = 'MTLBK1';
const ITERATIONS = 600000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const BACKUP_VERSION = 2;
const SUPPORTED_VERSIONS = [1, 2];

const TABLE_NAMES = [
  'transactions',
  'accounts',
  'categories',
  'rules',
  'holdings',
  'quotes',
  'goals',
  'budgets',
  'batches',
  'settings',
  'reviews',
] as const;

type TableName = (typeof TABLE_NAMES)[number];

/**
 * 属于「这台机器」而不是「这个人的账」的设置键：**绝不允许跨设备传播**。
 *
 * - device_label：从别的设备带进来会让两台机器同名，多设备就再也分不清谁是谁，
 *   而且这台机器下次导出的备份也会顶着别人的名字继续传播；
 * - last_backup_at：本机的备份提醒，被别人的时间覆盖只会误导用户；
 * - ocr_pack_downloaded：OCR 语言包是本机下载的二十几兆文件，从别的设备带个 true 过来，
 *   OCR 会去加载并不存在的资源，直接报错且用户看不出原因；
 * - seeded_version：seed 幂等标记，被改错会重新灌一遍种子数据。
 *
 * 合并模式过滤 incoming 就够；覆盖模式会整表 clear，所以要先捞出来、写完再放回。
 * 两个分支共用这一个常量——上次就是因为只在合并分支写了过滤，覆盖一次设备名就丢了。
 */
const SYNC_EXCLUDED_SETTING_KEYS: readonly string[] = [
  SETTING_KEYS.deviceLabel,
  SETTING_KEYS.lastBackupAt,
  SETTING_KEYS.ocrPackDownloaded,
  SETTING_KEYS.seededVersion,
];

function isExcludedSettingKey(key: unknown): boolean {
  return typeof key === 'string' && SYNC_EXCLUDED_SETTING_KEYS.includes(key);
}

function withoutExcludedSettingRows(rows: Row[]): Row[] {
  return rows.filter((row) => !isExcludedSettingKey(row.key));
}

export interface BackupPayload {
  version: number;
  exported_at: string;
  /** 导出设备（用户自取的名字），多设备来回导时用来判断哪份更新 */
  device_label?: string;
  /** 各表行数，仅用于展示与校验，不参与合并 */
  counts?: Partial<Record<TableName, number>>;
  /** 明文 JSON 的 SHA-256，用于完整性校验（v2 起） */
  checksum?: string;
  tables: Partial<Record<TableName, unknown[]>>;
}

export type RestoreMode = 'merge' | 'replace';

export interface MergeReport {
  mode: RestoreMode;
  stats: MergeTableStats;
  /** 冲突行 id（时间戳相同但内容不同），交用户核对 */
  conflictIds: string[];
  /** 备份文件里的设备名与导出时间 */
  sourceDevice: string | null;
  exportedAt: string | null;
  /** 校验和不一致时的提示（不阻断恢复） */
  checksumWarning: string | null;
}

export async function collectTables(): Promise<BackupPayload> {
  const tables: Partial<Record<TableName, unknown[]>> = {};
  const counts: Partial<Record<TableName, number>> = {};
  for (const name of TABLE_NAMES) {
    // Dexie 的动态表访问在这里是必要的（逐表导出）
    const table = db.table(name);
    const rows = await table.toArray();
    tables[name] = rows;
    counts[name] = rows.length;
  }
  return {
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    device_label: await getDeviceLabel(),
    counts,
    tables,
  };
}

export async function getDeviceLabel(): Promise<string> {
  const label = await settingsRepo.get<string>(SETTING_KEYS.deviceLabel, '');
  return label.trim() || '未命名设备';
}

export async function setDeviceLabel(label: string): Promise<void> {
  await settingsRepo.set(SETTING_KEYS.deviceLabel, label.trim());
}

function requireCrypto(): Crypto {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle) {
    throw new Error('当前浏览器不支持 WebCrypto，无法加密备份');
  }
  return cryptoObj;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const cryptoObj = requireCrypto();
  const baseKey = await cryptoObj.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return cryptoObj.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await requireCrypto().subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function exportEncrypted(passphrase: string): Promise<Blob> {
  if (passphrase.length < 6) {
    throw new Error('口令至少 6 位');
  }
  const cryptoObj = requireCrypto();
  const payload = await collectTables();
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const checksum = await sha256Hex(plaintext);
  // 校验和放在明文之外会泄露不可逆指纹，放在包尾但参与一次性展示即可；
  // 这里写进文件头部的扩展区，恢复时用于发现传输损坏。
  const salt = cryptoObj.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = cryptoObj.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const cipher = await cryptoObj.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    plaintext as unknown as BufferSource,
  );

  const magicBytes = new TextEncoder().encode(MAGIC);
  const checksumBytes = new TextEncoder().encode(checksum);
  const out = new Uint8Array(
    magicBytes.length + 1 + checksumBytes.length + SALT_BYTES + IV_BYTES + cipher.byteLength,
  );
  let offset = 0;
  out.set(magicBytes, offset);
  offset += magicBytes.length;
  out[offset] = checksumBytes.length;
  offset += 1;
  out.set(checksumBytes, offset);
  offset += checksumBytes.length;
  out.set(salt, offset);
  offset += SALT_BYTES;
  out.set(iv, offset);
  offset += IV_BYTES;
  out.set(new Uint8Array(cipher), offset);
  return new Blob([out], { type: 'application/octet-stream' });
}

interface ParsedEnvelope {
  salt: Uint8Array;
  iv: Uint8Array;
  cipher: Uint8Array;
  checksum: string | null;
}

function parseEnvelope(buffer: Uint8Array): ParsedEnvelope {
  const magicBytes = new TextEncoder().encode(MAGIC);
  if (buffer.length <= magicBytes.length + SALT_BYTES + IV_BYTES) {
    throw new Error('这不是本应用导出的备份文件');
  }
  for (let i = 0; i < magicBytes.length; i += 1) {
    if (buffer[i] !== magicBytes[i]) throw new Error('这不是本应用导出的备份文件');
  }
  const checksumLength = buffer[magicBytes.length];
  let offset = magicBytes.length + 1;
  let checksum: string | null = null;
  if (checksumLength > 0 && checksumLength < 128) {
    checksum = new TextDecoder().decode(buffer.slice(offset, offset + checksumLength));
    offset += checksumLength;
  }
  const salt = buffer.slice(offset, offset + SALT_BYTES);
  offset += SALT_BYTES;
  const iv = buffer.slice(offset, offset + IV_BYTES);
  offset += IV_BYTES;
  return { salt, iv, cipher: buffer.slice(offset), checksum };
}

export interface RestoreOptions {
  mode?: RestoreMode;
}

export async function restoreFromFile(
  file: File,
  passphrase: string,
  options: RestoreOptions = {},
): Promise<MergeReport> {
  const mode: RestoreMode = options.mode ?? 'merge';
  const cryptoObj = requireCrypto();
  const envelope = parseEnvelope(new Uint8Array(await file.arrayBuffer()));
  const key = await deriveKey(passphrase, envelope.salt);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await cryptoObj.subtle.decrypt(
      { name: 'AES-GCM', iv: envelope.iv as unknown as BufferSource },
      key,
      envelope.cipher as unknown as BufferSource,
    );
  } catch {
    // 口令错误在这里必然失败（GCM 认证标签校验不过）—— 绝不"容错"放过
    throw new Error('口令不对，无法打开这份备份');
  }

  const rawBytes = new Uint8Array(plaintext);
  let checksumWarning: string | null = null;
  if (envelope.checksum) {
    const actual = await sha256Hex(rawBytes);
    if (actual !== envelope.checksum) {
      checksumWarning = '备份文件的校验和与内容不一致，文件可能损坏或被改动过。请谨慎使用。';
    }
  }

  const payload = JSON.parse(new TextDecoder().decode(rawBytes)) as BackupPayload;
  if (!SUPPORTED_VERSIONS.includes(payload.version)) {
    throw new Error(`备份版本不支持（文件 ${payload.version}，应用支持 ${SUPPORTED_VERSIONS.join('/')}）`);
  }

  if (mode === 'replace') {
    let restored = 0;
    await db.transaction('rw', db.tables, async () => {
      /**
       * 覆盖模式要整表 clear，但这 4 个键是「这台机器」的状态，不是「这个人的账」。
       * 先捞出来，等备份行全部写完再放回，覆盖语义只作用于真正的用户数据。
       */
      const keptLocal = ((await db.table('settings').toArray()) as Row[]).filter((row) =>
        isExcludedSettingKey(row.key),
      );
      for (const name of TABLE_NAMES) {
        const rows = payload.tables[name] as Row[] | undefined;
        if (!rows) continue;
        const next = name === 'settings' ? withoutExcludedSettingRows(rows) : rows;
        await db.table(name).clear();
        if (next.length > 0) await db.table(name).bulkPut(next);
        restored += next.length;
      }
      for (const row of keptLocal) await db.table('settings').put(row);
    });
    return {
      mode,
      stats: { inserted: restored, updated: 0, skipped: 0, duplicate: 0, conflict: 0 },
      conflictIds: [],
      sourceDevice: payload.device_label ?? null,
      exportedAt: payload.exported_at ?? null,
      checksumWarning,
    };
  }

  const perTable: MergeTableStats[] = [];
  const allConflicts: string[] = [];

  await db.transaction('rw', db.tables, async () => {
    for (const name of TABLE_NAMES) {
      const rawIncoming = (payload.tables[name] as Row[] | undefined) ?? [];
      // 合并模式下 device_label / last_backup_at 直接丢掉就够（本机那两行不参与合并）
      const incoming = name === 'settings' ? withoutExcludedSettingRows(rawIncoming) : rawIncoming;
      if (incoming.length === 0) continue;
      const existing = (await db.table(name).toArray()) as Row[];
      const hasVersion = incoming.some((row) => versionOf(row) > 0);
      const plan = planMerge(existing, incoming, {
        useDedupe: name === 'transactions',
        hasVersion,
        // settings 的主键是 key，不是 id —— 不传这个参数，整张表都会被当成"没有主键"跳过
        idField: name === 'settings' ? 'key' : 'id',
        // 只有 settings 有出厂默认值可依：用来区分"用户改过的值"和"seed 占坑的默认值"
        defaults: name === 'settings' ? SEED_SETTING_DEFAULTS_RECORD : undefined,
      });
      if (plan.puts.length > 0) await db.table(name).bulkPut(plan.puts);
      perTable.push(plan.stats);
      allConflicts.push(...plan.conflictIds);
    }
  });

  return {
    mode,
    stats: sumStats(perTable),
    conflictIds: allConflicts,
    sourceDevice: payload.device_label ?? null,
    exportedAt: payload.exported_at ?? null,
    checksumWarning,
  };
}

/** 导出未加密 CSV：次级本地逃生通道（明确提示是明文）。 */
export async function exportCsv(): Promise<Blob> {
  const rows = await db.transactions.toArray();
  const header = [
    '日期',
    '时间',
    '方向',
    '金额(元)',
    '一级分类',
    '二级分类',
    '账户',
    '渠道',
    '交易对方',
    '备注',
    '来源',
    '标记',
    '导入批次',
  ];
  const lines = [header.join(',')];
  for (const row of rows.filter((tx) => !tx.deleted_at)) {
    lines.push(
      [
        row.occurred_date,
        row.occurred_at.slice(11, 16),
        DIRECTION_LABEL[row.direction],
        centsToYuan(row.amount_cents),
        row.category_l1,
        row.category_l2,
        row.account_id,
        row.payment_channel,
        escapeCsv(row.counterparty ?? ''),
        escapeCsv(row.note ?? ''),
        SOURCE_LABEL[row.source],
        (row.flags ?? []).join('|'),
        row.import_batch_id ?? '',
      ].join(','),
    );
  }
  // BOM 让 Excel 正确识别 UTF-8
  return new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
}

function escapeCsv(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function countAllRows(): Promise<number> {
  return db.transactions.count();
}

export type { Transaction };
