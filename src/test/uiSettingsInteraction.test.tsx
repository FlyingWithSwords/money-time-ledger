import { ThemeProvider } from '@mui/material';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import * as transactionRepo from '../db/repos/transactionRepo';
import { ensureSeeded } from '../db/seed';
import { asCents } from '../domain/money';
import { useUiStore } from '../store/uiStore';
import { TxEditorDialog } from '../ui/components/TxEditorDialog';
import { SettingsPage } from '../ui/pages/Settings';
import { buildTheme } from '../ui/theme';
import type { Transaction } from '../types';

/**
 * 设置页 / 编辑弹窗层的交互回归测试。
 *
 * 只测「用户能观察到、且改坏了会真丢数据」的三件事：
 * 1. 破坏性操作点「取消」不能写库；
 * 2. 只有点「确认」才写库（打开弹窗本身绝对不能删数据）；
 * 3. 删除后的 Snackbar 必须带一个**真的能恢复**的「撤销」，而不是假按钮。
 *
 * 用 createRoot + act 直接渲染（不引 Testing Library）：这里的临界点是
 * MUI Dialog 的 portal 与 Zustand 的 showSnack，两者都不需要额外查询库。
 */

const TX_ID = 'tx-ui-interaction-1';
const OCCURRED_AT = '2024-06-15T12:30:00+08:00';

/** Cents 是 branded 类型，金额一律经 asCents() 构造，不写裸 number。 */
function makeFixture(): Transaction {
  return {
    id: TX_ID,
    external_id: `ext_${TX_ID}`,
    dedupe_key: `key_${TX_ID}`,
    source: 'manual',
    direction: 'expense',
    amount_cents: asCents(1250),
    occurred_at: OCCURRED_AT,
    occurred_date: '2024-06-15',
    month_key: '2024-06',
    category_l1: 'food',
    category_l2: 'lunch',
    account_id: 'acc_huabei',
    payment_channel: 'huabei',
    flags: [],
    manual_edited: false,
    category_locked: false,
    dedupe_status: 'clean',
    imported_at: OCCURRED_AT,
    created_at: OCCURRED_AT,
    updated_at: OCCURRED_AT,
  };
}

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

async function settle(ms = 60): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** 与既有 render 测试一致：ThemeProvider 包住，留一拍给 MUI 的弹窗进出场与 liveQuery。 */
async function render(node: ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  containers.push(container);
  roots.push(root);
  await act(async () => {
    root.render(<ThemeProvider theme={buildTheme('light')}>{node}</ThemeProvider>);
  });
  await settle();
  return container;
}

function buttonByText(label: string): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll('button'));
  const found = buttons.find((button) => (button.textContent ?? '').trim() === label);
  if (!found) {
    throw new Error(`找不到按钮「${label}」，当前按钮：${buttons.map((b) => b.textContent?.trim()).join(' / ')}`);
  }
  return found;
}

async function clickButton(label: string): Promise<void> {
  const button = buttonByText(label);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

function resetUiStore(): void {
  useUiStore.setState({
    snack: null,
    snackQueue: [],
    quickAddOpen: false,
    editingTxId: null,
  });
}

describe('设置页 / 编辑弹窗层的破坏性操作交互', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await ensureSeeded(db);
    await transactionRepo.add(makeFixture());
    resetUiStore();
  });

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await act(async () => {
        root.unmount();
      });
    }
    for (const container of containers.splice(0)) container.remove();
    resetUiStore();
  });

  it('清空账目：点「取消」不执行任何删除', async () => {
    await render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    await clickButton('清空账目数据');
    // 确认框必须说明后果与不可撤销，用户才知道自己在取消什么
    expect(document.body.textContent).toContain('清空全部账目？');
    expect(document.body.textContent).toContain('此操作不可撤销');

    await clickButton('取消');
    expect(await db.transactions.count()).toBe(1);
    expect((await transactionRepo.getById(TX_ID))?.deleted_at).toBeUndefined();
    // 取消不应产生任何「操作成功」提示
    expect(useUiStore.getState().snack?.message).not.toBe('账目已清空');
  });

  it('清空账目：只有点「确认」才真正清空，并给出结果提示', async () => {
    await render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    await clickButton('清空账目数据');
    // 打开弹窗本身绝不写库
    expect(await db.transactions.count()).toBe(1);

    await clickButton('确认清空');
    expect(await db.transactions.count()).toBe(0);
    expect(useUiStore.getState().snack?.message).toBe('账目已清空');
  });

  it('删除交易：确认后 Snackbar 带「撤销」，点击真的恢复这一笔', async () => {
    useUiStore.setState({ editingTxId: TX_ID });
    await render(<TxEditorDialog />);

    await clickButton('删除');
    expect(document.body.textContent).toContain('删除这一笔？');

    await clickButton('确认删除');
    const snack = useUiStore.getState().snack;
    expect(snack?.message).toBe('已删除');
    expect(snack?.actionLabel).toBe('撤销');
    expect(typeof snack?.onAction).toBe('function');
    expect((await transactionRepo.getById(TX_ID))?.deleted_at).toBeTruthy();

    // 回调不能是假的：真的调用 transactionRepo.restore 把软删抹掉
    await act(async () => {
      snack?.onAction?.();
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    const restored = await transactionRepo.getById(TX_ID);
    expect(restored).toBeDefined();
    expect(restored?.deleted_at).toBeUndefined();
    // 弹窗退场与 Dexie liveQuery 的后续重渲染都留在 act 内，避免测试外更新
    await settle(300);
  });
});
