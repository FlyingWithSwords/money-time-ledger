/**
 * 存储可用性探测。
 *
 * 为什么要单独探一次：本应用的全部数据都存在浏览器 IndexedDB 里（隐私红线 R1 的落地方式）。
 * 某些环境会直接拒绝存储权限 —— 受限 iframe / 嵌入式 webview、无痕模式、
 * 浏览器设置「阻止所有 Cookie 和站点数据」、或从 file:// 打开页面。
 *
 * 这些环境下 Dexie 会照常构造，直到第一次写入才抛
 * `UnknownError: The user denied permission to access the database.`
 * 用户会以为账记上了，其实一条都没存 —— 必须提前拦下来。
 */

export type StorageProbeFailure =
  | { ok: false; reason: 'unsupported'; detail: string }
  | { ok: false; reason: 'denied'; detail: string }
  | { ok: false; reason: 'quota'; detail: string }
  | { ok: false; reason: 'unknown'; detail: string };

export type StorageProbe = { ok: true } | StorageProbeFailure;

const PROBE_DB = '__ledger_storage_probe__';
const PROBE_TIMEOUT_MS = 2500;

function classify(error: unknown): StorageProbeFailure {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (/denied permission|not allowed|access is denied|SecurityError|InvalidStateError/i.test(raw)) {
    return { ok: false, reason: 'denied', detail: raw };
  }
  if (/quota|QuotaExceeded/i.test(raw)) {
    return { ok: false, reason: 'quota', detail: raw };
  }
  return { ok: false, reason: 'unknown', detail: raw };
}

/**
 * 真开一个一次性数据库再删掉。
 * 只有真的 open 成功，才能证明这个环境允许读写 —— 仅判断 `typeof indexedDB`
 * 不够（受限环境里对象存在但一切操作都被拒）。
 */
export async function probeStorage(): Promise<StorageProbe> {
  if (typeof indexedDB === 'undefined' || indexedDB === null) {
    return { ok: false, reason: 'unsupported', detail: '当前环境没有 IndexedDB' };
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new Error('打开数据库超时（环境可能冻结了存储请求）')));
      }, PROBE_TIMEOUT_MS);

      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(PROBE_DB, 1);
      } catch (error) {
        clearTimeout(timer);
        finish(() => reject(error));
        return;
      }

      request.onupgradeneeded = () => {
        request.result.createObjectStore('probe');
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        try {
          request.result.close();
          indexedDB.deleteDatabase(PROBE_DB);
        } catch {
          // 探测库删不掉不影响结论
        }
        finish(resolve);
      };
      request.onerror = () => {
        clearTimeout(timer);
        finish(() => reject(request.error ?? new Error('打开数据库失败')));
      };
      request.onblocked = () => {
        clearTimeout(timer);
        finish(() => reject(new Error('数据库被其他标签页占用，或存储被阻止')));
      };
    });
    return { ok: true };
  } catch (error) {
    return classify(error);
  }
}
