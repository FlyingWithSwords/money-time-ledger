import { ThemeProvider } from '@mui/material';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../ui/components/ConfirmDialog';
import { useUiStore } from '../store/uiStore';
import { buildTheme } from '../ui/theme';

/**
 * UI 基础组件的回归测试。
 *
 * 为什么需要：确认框是「误删」的最后一道防线，Snackbar 队列是「写了没反应」的
 * 最后一道防线，两者都不能只靠 tsc 证明。另外钉住 theme 里的触屏可用性配置——
 * index.css 里的元素选择器覆盖不住 MUI 的 emotion class，这个坑容易反复踩。
 */

async function waitFrames(ms = 30): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function renderConfirm(options: {
  busy?: boolean;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ThemeProvider theme={buildTheme('light')}>
        <ConfirmDialog
          open
          title="确认删除？"
          message="这一步不可撤销"
          destructive={options.destructive}
          busy={options.busy}
          onConfirm={options.onConfirm}
          onClose={options.onClose}
        />
      </ThemeProvider>,
    );
  });
  await waitFrames();
  const buttons = (): HTMLButtonElement[] => Array.from(document.body.querySelectorAll('button'));
  return {
    find: (label: string) => buttons().find((btn) => (btn.textContent ?? '').includes(label)),
    buttons,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function click(button: HTMLButtonElement | undefined): Promise<void> {
  if (!button) throw new Error('找不到目标按钮');
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

beforeEach(() => {
  useUiStore.setState({ snack: null, snackQueue: [], themeMode: 'system' });
});

describe('ConfirmDialog：破坏性操作的最后一道防线', () => {
  it('点取消不执行操作，只关闭弹窗', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const dialog = await renderConfirm({ onConfirm, onClose });
    await click(dialog.find('取消'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    await dialog.unmount();
  });

  it('点确定才真正执行', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const dialog = await renderConfirm({ onConfirm, onClose, destructive: true });
    await click(dialog.find('确定'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await dialog.unmount();
  });

  it('busy 期间两个按钮都禁用，连点不会重复提交', async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const dialog = await renderConfirm({ onConfirm, onClose, busy: true });
    const cancel = dialog.find('取消');
    const confirm = dialog.find('处理中');
    expect(cancel?.disabled).toBe(true);
    expect(confirm?.disabled).toBe(true);
    await click(cancel);
    await click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await dialog.unmount();
  });
});

describe('全局提示队列：连续操作不互相顶掉', () => {
  it('第二条排队，第一条关闭后接着显示', () => {
    const store = useUiStore.getState();
    store.showSnack({ message: '已保存', severity: 'success' });
    store.showSnack({ message: '已删除', severity: 'info' });
    expect(useUiStore.getState().snack?.message).toBe('已保存');
    expect(useUiStore.getState().snackQueue).toHaveLength(1);
    useUiStore.getState().clearSnack();
    expect(useUiStore.getState().snack?.message).toBe('已删除');
    useUiStore.getState().clearSnack();
    expect(useUiStore.getState().snack).toBeNull();
  });

  it('撤销动作与文案原样保留给 Snackbar 渲染', () => {
    const undo = vi.fn();
    useUiStore.getState().showSnack({
      message: '已删除',
      severity: 'success',
      actionLabel: '撤销',
      onAction: undo,
    });
    expect(useUiStore.getState().snack?.actionLabel).toBe('撤销');
    expect(useUiStore.getState().snack?.onAction).toBe(undo);
  });
});

describe('主题：首屏不闪 + 触屏可用', () => {
  it('切换主题时写 localStorage 镜像（供首屏同步读取）', () => {
    useUiStore.getState().setThemeMode('dark');
    expect(useUiStore.getState().themeMode).toBe('dark');
    expect(localStorage.getItem('ledger.theme')).toBe('dark');
  });

  it('触屏下 small 输入框 16px、图标按钮 44px', () => {
    const theme = buildTheme('dark');
    const components = theme.components as unknown as Record<
      string,
      { styleOverrides?: Record<string, Record<string, unknown>> }
    >;
    const input = components.MuiInputBase?.styleOverrides?.sizeSmall?.[
      '@media (pointer: coarse)'
    ] as Record<string, unknown> | undefined;
    const icon = components.MuiIconButton?.styleOverrides?.sizeSmall?.[
      '@media (pointer: coarse)'
    ] as Record<string, unknown> | undefined;
    expect(input?.fontSize).toBe(16);
    expect(icon?.padding).toBe(10);
  });
});
