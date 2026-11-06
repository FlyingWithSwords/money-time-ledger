import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { db } from './db/db';
import { ensureSeeded } from './db/seed';
import { probeStorage, type StorageProbeFailure } from './db/storage';
import { StorageBlocked } from './ui/components/StorageBlocked';
import { requestPersistentStorage } from './pwa/registerSW';

/**
 * 启动占位：开库 + 写种子期间先给一个可感知的界面，
 * 避免用户盯着纯白屏分不清「正在启动」和「卡死」。
 * 不依赖 MUI（此时 ThemeProvider 还没挂载），只用内联样式。
 */
function BootSplash(): JSX.Element {
  const dark =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches &&
    localStorage.getItem('ledger.theme') !== 'light';
  const bg = dark ? '#0f1115' : '#f7f7f5';
  const fg = dark ? '#e8eaed' : '#1a1c1f';
  const muted = dark ? '#9aa0a6' : '#5f6368';
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        background: bg,
        color: fg,
        fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 16,
          background: '#1f7a5a',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 28,
          fontWeight: 700,
        }}
      >
        快
      </div>
      <strong style={{ fontSize: 18 }}>快记账</strong>
      <span style={{ fontSize: 13, color: muted }}>正在打开本机账本…</span>
      <div style={{ width: 160, height: 3, borderRadius: 3, overflow: 'hidden', background: dark ? '#2a2f38' : '#e3e6e2' }}>
        <i
          style={{
            display: 'block',
            width: '32%',
            height: '100%',
            borderRadius: 3,
            background: '#1f7a5a',
            animation: 'boot-indeterminate 1.2s ease-in-out infinite',
          }}
        />
      </div>
    </div>
  );
}

/**
 * 首屏 10 秒内可记第一笔：先探测存储 → 开库 → 幂等种子 → 渲染。
 *
 * 为什么先探测：数据全在本机 IndexedDB，某些环境（受限 iframe / webview、
 * 无痕模式、禁用站点数据）会拒绝存储。那种情况下 Dexie 能构造、界面能显示，
 * 直到第一次写入才抛 `UnknownError: The user denied permission to access the database.`
 * —— 用户以为记上了，其实一条没存。所以宁可在门口拦住。
 */
async function bootstrap(): Promise<void> {
  const container = document.getElementById('root');
  if (!container) throw new Error('#root 不存在');

  const root = createRoot(container);
  root.render(<BootSplash />);

  const renderBlocked = (failure: StorageProbeFailure): void => {
    root.render(
      <StrictMode>
        <StorageBlocked failure={failure} onRetry={() => void bootstrap()} />
      </StrictMode>,
    );
  };

  const probe = await probeStorage();
  if (!probe.ok) {
    console.error('[ledger] 本地存储不可用', probe.reason, probe.detail);
    renderBlocked(probe);
    return;
  }

  try {
    await db.open();
    await ensureSeeded(db);
    requestPersistentStorage();
  } catch (error) {
    // 探测通过但仍开不了库：多半是多标签页版本冲突或存储被中途收回。
    console.error('[ledger] 数据库初始化失败', error);
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    renderBlocked({ ok: false, reason: 'unknown', detail });
    return;
  }

  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
