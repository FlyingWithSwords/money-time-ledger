/**
 * 备份合并（纯逻辑，不碰 Dexie，可单测）。
 *
 * 为什么需要它：原实现是「清空再写入」，把手机备份恢复到电脑上，
 * 电脑上原有的账会整片消失。多设备来回导一次，数据就丢一次。
 *
 * 合并规则（顺序即优先级）：
 * 1. 同一 id：比 `updated_at`（退化到 imported_at / created_at）。新的赢。
 * 2. 删除墓碑优先：一端已删除（`deleted_at`），只有更晚的变更才能把它改回来，
 *    否则旧备份会把删掉的账「复活」。
 * 3. 交易跨设备重复：`dedupe_key + source` 相同但 id 不同 —— 两台设备各自导入
 *    同一份微信账单时会出现。此时**跳过并计入 duplicate**，不是新增。
 *    本机已经把那条删掉时不算重复而是"已删除"：删除版本不早于备份就 skip（不复活），
 *    备份更新才 insert（视为删除之后又重新记了一笔）。
 * 4. 无时间戳的表（分类、设置、目标）：**本机动过的值优先，备份绝不覆盖**。
 *    但"本机有这条"不等于"用户设过"——`seed.ts` 首次打开就写满了 11 个出厂默认值，
 *    一律 skip 会让换设备合并后时薪、配色、门槛全部静默回出厂。所以对 settings 这类
 *    给了 `defaults` 的表再加一条豁免：本机值仍等于出厂默认（没人动过）而备份不同 → 采用备份。
 * 5. 时间戳相同但内容不同：计为 conflict，保留本地，交用户裁决，不静默覆盖。
 *
 * ## 已知限制（明确不修，不是遗漏）
 *
 * 1. **分类 / 账户 / 规则 / 目标的"改名"不会跨设备同步。** 这几张表要么没有时间戳
 *    （分类、账户、目标），要么出厂行的时间戳是远古常量（内置规则），所以合并时只保证
 *    "本机缺的那条整条补进来"，用户 A 在旧设备把「餐饮」改成「吃饭」，新设备上看还是「餐饮」。
 *    要修得给这几张表加时间戳并做 schema 迁移，风险和收益不成比例，这一轮刻意不做。
 * 2. **判断新旧依赖各设备自己的系统时钟。** 手机与电脑时差大（或某台机器时间被手动改过）时，
 *    较新的修改可能被判成"本机更新"而 skip。没有引入向量时钟 / 逻辑时钟是刻意取舍：
 *    那会带来一套设备间因果追踪，复杂度远超这个单人记账应用的实际收益。
 * 3. **`duplicate` 命中的行只计数丢弃，不写 `duplicate_of` 回指。** 用户看不到"这条被判重复了，
 *    原先是哪一条"，属于 UI 增值项，排在正确性收敛之后。
 * 4. **本机设置恰好被手动设成与出厂默认相同的值时，无法与"从未设置过"区分。**
 *    豁免机制只能比"值是否等于默认值"，所以用户 A 上刻意设成 8000 元（正好等于默认），
 *    B 上是 9000 元，合并会采用 B 的 9000。这是豁免机制的固有代价：影响面小
 *    （只有"刻意设成默认值"这一种情况），但属于"明确的用户选择被静默覆盖"，必须写明。
 * 5. **`last_category` 属于本机使用习惯，刻意不同步。** 它不是账目数据，而是"这台机器上次点了哪一类"；
 *    跨设备同步会让新设备手动记账时默认选中一个莫名其妙的分类。这一条不是缺陷，是取舍。
 */

export type MergeAction = 'insert' | 'update' | 'skip' | 'duplicate' | 'conflict';

export interface MergeDecision {
  action: MergeAction;
  reason: string;
}

export type Row = Record<string, unknown>;

/**
 * 版本字段的优先级：updated_at > imported_at > created_at > generated_at。
 * `generated_at` 是「月度复盘卡」独有的字段（ReviewCard 只有它没有 created_at），
 * 漏掉它会让复盘卡恒判"无版本"，全部走本地优先，等于备份里的复盘永远补不进来。
 */
const VERSION_FIELDS = ['updated_at', 'imported_at', 'created_at', 'generated_at'] as const;

/** 取行的时间版本；都没有则返回 0（视为最旧）。 */
export function versionOf(row: Row): number {
  for (const field of VERSION_FIELDS) {
    const value = row[field];
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return 0;
}

function isDeleted(row: Row): boolean {
  return typeof row.deleted_at === 'string' && row.deleted_at.length > 0;
}

/** 交易去重索引键：source + dedupe_key。 */
export function dedupeIndexKey(row: Row): string | null {
  const key = row.dedupe_key;
  const source = row.source;
  if (typeof key !== 'string' || typeof source !== 'string') return null;
  return `${source}::${key}`;
}

export interface MergeDecisionOptions {
  /** 该表是否用 dedupe_key 做跨设备去重（仅 transactions） */
  useDedupe: boolean;
  /** 该表是否自带时间戳（交易/批次/复盘有；分类/设置/目标没有） */
  hasVersion: boolean;
  /**
   * 主键字段名。绝大多数表是 `id`，**settings 表是 `key`**（见 types.ts 的 Setting）。
   * 早期实现硬编码 `row.id`，导致 settings 每行都被判成"没有主键 → 跳过"，
   * 换设备恢复时时薪口径、自定义开关全丢。
   */
  idField?: 'id' | 'key';
  /**
   * 该表的**出厂默认值**（键 → 值），只有 settings 会传（来源见 `db/settingDefaults.ts` 的
   * `SEED_SETTING_DEFAULTS`）。传了它才启用"本机这条没人动过就采用备份值"的豁免；
   * 其它无时间戳的表（分类/持仓/预算）不传，行为保持"本地优先"不变。
   */
  defaults?: Readonly<Record<string, unknown>>;
}

/**
 * 本机同指纹的那条：活着的只管判重复，已删的要带删除版本判"该不该复活"。
 *
 * 做成判别联合而不是 `{ id, version, deleted }`，是因为活行根本没有版本概念：
 * 用 `version: 0` 占位也能编译、也能跑，但如果后来有人写一句
 * `duplicateOwner.version > incomingVersion`，活行就会拿到 0（等于"极其古老"）并判反，
 * 而且不报错。这类"能编译、能跑、结果算错、还不报错"的缺陷在这个模块里已经出现过四次，
 * 所以让"活行没有 version"成为**类型事实**，而不是靠注释约定。
 */
export type DuplicateOwner =
  | { kind: 'live'; id: string }
  | { kind: 'deleted'; id: string; version: number };

/** 取行主键；主键缺失或为空串时返回 null（调用方计 skipped，绝不写入）。 */
function idOf(row: Row, options: MergeDecisionOptions): string | null {
  const field = options.idField ?? 'id';
  const value = row[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

const CONTENT_IGNORED_FIELDS = new Set(['updated_at', 'imported_at']);

function sameContent(a: Row, b: Row): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (CONTENT_IGNORED_FIELDS.has(key)) continue;
    const left = a[key];
    const right = b[key];
    if (JSON.stringify(left) !== JSON.stringify(right)) return false;
  }
  return true;
}

/**
 * 比较两个**设置值**是否相同。
 *
 * 不能直接 `JSON.stringify(a) === JSON.stringify(b)`：`JSON.stringify(undefined)`
 * 返回的是 `undefined` 而不是字符串，两边都 undefined 时它会"相等"，
 * `null` 与 `undefined` 就分不开了。而 `hourly_wage_manual_cents` 的出厂默认值
 * 正是 `null`，把它误判成"没这个键"，豁免就永远不生效。
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 设置行是 `{ key, value }`；拿不到 value 字段就不做豁免（宁可不改，也不误改）。 */
function settingValueOf(row: Row): { found: boolean; value: unknown } {
  if (!Object.prototype.hasOwnProperty.call(row, 'value')) return { found: false, value: undefined };
  return { found: true, value: row.value };
}

/**
 * 决定一行存量数据该怎么处理。
 * @param existing 本机同 id 的行（没有则 undefined）
 * @param incoming 备份里的行
 * @param duplicateOwner 若该行的 dedupe_key 在本机已属于别的行（活的或已删的），传入那一行
 */
export function decideMerge(
  existing: Row | undefined,
  incoming: Row,
  options: MergeDecisionOptions,
  duplicateOwner?: DuplicateOwner,
): MergeDecision {
  if (!existing) {
    const incomingId = idOf(incoming, options);
    const owner = options.useDedupe && duplicateOwner && duplicateOwner.id !== incomingId ? duplicateOwner : undefined;
    if (owner?.kind === 'deleted') {
      /**
       * 本机删过同一笔（指纹相同、id 不同）。删除是用户的明确动作，
       * 绝不能被另一台设备的旧记录悄悄撤销——否则"两台各导同一份账单、其中一台删掉重复那笔"
       * 之后，删掉的账会在下次合并时自己回来。
       */
      const incomingVersion = versionOf(incoming);
      if (owner.version >= incomingVersion) {
        return { action: 'skip', reason: '本机已删除同一笔，且删除时间不早于备份，不复活' };
      }
      return { action: 'insert', reason: '本机删过同一笔，但备份是删除之后的新记录' };
    }
    if (owner) {
      return { action: 'duplicate', reason: '本机已有同一笔（来源+去重指纹相同），跳过' };
    }
    return { action: 'insert', reason: '本机没有这条' };
  }

  /**
   * 没有版本字段的表：默认本地优先，避免备份覆盖用户亲手设的值。
   * 但「本机有这条」不等于「用户设过这条」——seed 会把出厂默认值写满整张 settings 表，
   * 一刀切 skip 等于让出厂值永久占坑（换设备后时薪静默回 8000/174）。
   * 所以给了 `defaults` 的表再判一次：本机值仍等于出厂默认且备份不同 → 采用备份。
   */
  if (!options.hasVersion) {
    const key = idOf(incoming, options);
    const defaults = options.defaults;
    if (key !== null && defaults !== undefined && Object.prototype.hasOwnProperty.call(defaults, key)) {
      const local = settingValueOf(existing);
      const remote = settingValueOf(incoming);
      const fallback = defaults[key];
      if (local.found && remote.found && sameValue(local.value, fallback) && !sameValue(remote.value, fallback)) {
        return { action: 'update', reason: '本机仍是出厂默认值（没人动过），采用备份里用户设置过的值' };
      }
    }
    return { action: 'skip', reason: '该表无时间戳，保留本机配置' };
  }

  const existingVersion = versionOf(existing);
  const incomingVersion = versionOf(incoming);

  if (isDeleted(existing) && !isDeleted(incoming)) {
    if (incomingVersion > existingVersion) {
      return { action: 'update', reason: '备份里这条是更晚的恢复（本机侧曾删除）' };
    }
    return { action: 'skip', reason: '本机已删除且备份更旧，不复活' };
  }

  if (!isDeleted(existing) && isDeleted(incoming)) {
    if (incomingVersion > existingVersion) {
      return { action: 'update', reason: '备份侧已删除，同步删除本机这条' };
    }
    return { action: 'skip', reason: '备份侧删除时间更早，保留本机' };
  }

  if (isDeleted(existing) && isDeleted(incoming)) {
    return { action: 'skip', reason: '两端都已删除' };
  }

  if (incomingVersion > existingVersion) {
    return { action: 'update', reason: '备份里的版本更新' };
  }
  if (incomingVersion < existingVersion) {
    return { action: 'skip', reason: '本机版本更新' };
  }
  if (sameContent(existing, incoming)) {
    return { action: 'skip', reason: '内容一致' };
  }
  return { action: 'conflict', reason: '时间戳相同但内容不同，保留本机，请人工核对' };
}

export interface MergeTableStats {
  inserted: number;
  updated: number;
  skipped: number;
  duplicate: number;
  conflict: number;
}

export interface MergePlan {
  puts: Row[];
  stats: MergeTableStats;
  /** 冲突行 id，UI 用来提示"这几条需要你核对" */
  conflictIds: string[];
}

export function emptyStats(): MergeTableStats {
  return { inserted: 0, updated: 0, skipped: 0, duplicate: 0, conflict: 0 };
}

/**
 * 对一张表规划合并。
 * @param existingRows 本机该表全部行
 * @param incomingRows 备份该表全部行
 */
export function planMerge(
  existingRows: Row[],
  incomingRows: Row[],
  options: MergeDecisionOptions,
): MergePlan {
  const byId = new Map<string, Row>();
  /** 指纹 → 活着的那条的 id */
  const byDedupe = new Map<string, string>();
  /** 指纹 → 已删的那条的 id 与删除版本（用来判"该不该复活"，不能和活行混在一张表里） */
  const byDedupeDeleted = new Map<string, { id: string; version: number }>();
  for (const row of existingRows) {
    const id = idOf(row, options);
    if (id) byId.set(id, row);
    if (options.useDedupe) {
      const key = dedupeIndexKey(row);
      if (key && id) {
        if (isDeleted(row)) byDedupeDeleted.set(key, { id, version: versionOf(row) });
        else byDedupe.set(key, id);
      }
    }
  }

  /** 同指纹的本机归属：活行优先（活行才是真正"重复"的那条），其次才看已删行。 */
  const ownerOf = (key: string): DuplicateOwner | undefined => {
    const liveId = byDedupe.get(key);
    if (liveId) return { kind: 'live', id: liveId };
    const removed = byDedupeDeleted.get(key);
    return removed ? { kind: 'deleted', ...removed } : undefined;
  };

  /** 写入成功后更新两张索引，保证同一批备份里的多行也能互相去重。 */
  const register = (key: string, row: Row, id: string): void => {
    if (isDeleted(row)) {
      byDedupe.delete(key);
      byDedupeDeleted.set(key, { id, version: versionOf(row) });
      return;
    }
    byDedupeDeleted.delete(key);
    byDedupe.set(key, id);
  };

  const puts: Row[] = [];
  const stats = emptyStats();
  const conflictIds: string[] = [];

  for (const incoming of incomingRows) {
    const incomingId = idOf(incoming, options);
    if (!incomingId) {
      stats.skipped += 1;
      continue;
    }
    const key = options.useDedupe ? dedupeIndexKey(incoming) : null;
    const owner = key ? ownerOf(key) : undefined;
    const decision = decideMerge(byId.get(incomingId), incoming, options, owner);

    switch (decision.action) {
      case 'insert':
        puts.push(incoming);
        stats.inserted += 1;
        if (key) register(key, incoming, incomingId);
        break;
      case 'update':
        puts.push(incoming);
        stats.updated += 1;
        if (key) register(key, incoming, incomingId);
        break;
      case 'duplicate':
        stats.duplicate += 1;
        break;
      case 'conflict':
        stats.conflict += 1;
        conflictIds.push(incomingId);
        break;
      default:
        stats.skipped += 1;
        break;
    }
  }

  return { puts, stats, conflictIds };
}

/** 汇总多表统计。 */
export function sumStats(list: MergeTableStats[]): MergeTableStats {
  return list.reduce(
    (acc, item) => ({
      inserted: acc.inserted + item.inserted,
      updated: acc.updated + item.updated,
      skipped: acc.skipped + item.skipped,
      duplicate: acc.duplicate + item.duplicate,
      conflict: acc.conflict + item.conflict,
    }),
    emptyStats(),
  );
}
