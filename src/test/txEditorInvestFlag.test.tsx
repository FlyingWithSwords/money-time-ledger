import { ThemeProvider } from '@mui/material';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import * as transactionRepo from '../db/repos/transactionRepo';
import { ensureSeeded } from '../db/seed';
import { INVEST_PRINCIPAL_FLAG } from '../domain/investPrincipal';
import { useUiStore } from '../store/uiStore';
import { TxEditorDialog } from '../ui/components/TxEditorDialog';
import { buildTheme } from '../ui/theme';
import { makeTx } from './txFixture';

/**
 * 「投资本金」标记与方向的联动。
 *
 * 标记的语义是「这笔不算支出」；用户在流水里把它改回「支出」，
 * 标记必须同时摘掉。否则流水里会出现一个「投资本金」却算在支出里的自相矛盾记录，
 * 而且它还会被设置页的扫描当成"已经处理过"而漏掉。
 */

async function waitFrames(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function findByText(selector: string, text: string): HTMLElement | undefined {
  return Array.from(document.body.querySelectorAll<HTMLElement>(selector)).find((item) =>
    item.textContent?.includes(text),
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ThemeProvider theme={buildTheme('light')}>
        <TxEditorDialog />
      </ThemeProvider>,
    );
  });
  await waitFrames(100);
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureSeeded(db);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  useUiStore.getState().setEditingTxId(null);
  await db.delete();
});

describe('编辑框：把投资本金改回支出时摘掉标记', () => {
  it('方向改回支出后保存，flag 被移除且记录回到支出侧', async () => {
    await transactionRepo.addMany([
      {
        ...makeTx({ id: 'inv', at: '2026-10-03T10:00:00+08:00', amount: 50000 }),
        counterparty: '蚂蚁财富',
        direction: 'transfer',
        flags: [INVEST_PRINCIPAL_FLAG, 'most_worthless'],
      },
    ]);
    act(() => {
      useUiStore.getState().setEditingTxId('inv');
    });
    await mount();

    const expenseToggle = findByText('button', '支出');
    expect(expenseToggle).toBeTruthy();
    await act(async () => {
      expenseToggle?.click();
    });
    await waitFrames(50);

    const save = findByText('button', '保存');
    expect(save).toBeTruthy();
    await act(async () => {
      save?.click();
    });
    await waitFrames(150);

    const saved = await transactionRepo.getById('inv');
    expect(saved?.direction).toBe('expense');
    expect(saved?.flags).not.toContain(INVEST_PRINCIPAL_FLAG);
    // 其它主观标记不能被顺手清掉
    expect(saved?.flags).toContain('most_worthless');
    // 金额不变：改的是口径，不是账
    expect(saved?.amount_cents).toBe(50000);
  });
});
