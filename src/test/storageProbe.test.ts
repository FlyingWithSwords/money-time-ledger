import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeStorage } from '../db/storage';
import { describeError } from '../domain/errors';

/**
 * 存储探测的行为锁定。
 * 起因：在受限容器里打开应用，Dexie 能构造、界面正常，直到第一次写入才抛
 * `UnknownError: The user denied permission to access the database.`
 * —— 用户以为记上了，其实一条没存。这些用例保证那个场景现在会被挡在门口。
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('probeStorage', () => {
  it('环境没有 indexedDB → unsupported', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const result = await probeStorage();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unsupported');
  });

  it('浏览器拒绝权限 → denied，且不会误判为可用', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('The user denied permission to access the database.', 'UnknownError');
      },
    });
    const result = await probeStorage();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('denied');
      expect(result.detail).toContain('denied permission');
    }
  });

  it('open 请求异步失败 → denied', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        const request: Record<string, unknown> = {};
        setTimeout(() => {
          (request.onerror as (() => void) | undefined)?.();
        }, 0);
        Object.defineProperty(request, 'error', {
          value: new DOMException('The user denied permission to access the database.', 'UnknownError'),
        });
        return request;
      },
    });
    const result = await probeStorage();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('denied');
  });

  it('配额耗尽 → quota', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('Quota exceeded.', 'QuotaExceededError');
      },
    });
    const result = await probeStorage();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('quota');
  });

  it('真的能开库时才返回 ok', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        const request: Record<string, unknown> = {};
        const store = { createObjectStore: () => undefined };
        setTimeout(() => {
          Object.defineProperty(request, 'result', {
            value: { ...store, close: () => undefined },
          });
          (request.onupgradeneeded as (() => void) | undefined)?.();
          (request.onsuccess as (() => void) | undefined)?.();
        }, 0);
        return request;
      },
      deleteDatabase: () => undefined,
    });
    await expect(probeStorage()).resolves.toEqual({ ok: true });
  });
});

describe('describeError 对存储异常的处理', () => {
  it('把英文 DOMException 翻成能指导行动的中文', () => {
    const message = describeError(
      new DOMException('The user denied permission to access the database.', 'UnknownError'),
    );
    expect(message).toContain('系统浏览器');
    expect(message).not.toContain('denied permission');
  });

  it('配额异常给出导出备份的指引', () => {
    const message = describeError(new DOMException('Quota exceeded.', 'QuotaExceededError'));
    expect(message).toContain('导出备份');
  });

  it('普通业务异常原样透出，不被误改', () => {
    expect(describeError(new Error('分类不存在'))).toBe('分类不存在');
  });
});
