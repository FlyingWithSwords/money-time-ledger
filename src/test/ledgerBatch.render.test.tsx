import { ThemeProvider } from '@mui/material';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import * as planRepo from '../db/repos/planRepo';
import * as transactionRepo from '../db/repos/transactionRepo';
import { ensureSeeded } from '../db/seed';
import { useUiStore } from '../store/uiStore';
import { buildTheme } from '../ui/theme';
import { Ledger } from '../ui/pages/Ledger';
import type { Cents } from '../types';
import { makeTx } from './txFixture';

/**
 * 流水页批量模式的接线护栏。
 *
 * 批量这条路的价值全在「一次落地」，所以真正要守住的是三件事：
 * 1. 进得去 —— 「批量」按钮存在，点了操作条真的出现；
 * 2. 落得下 —— 分类 chip 与计划 chip 都挂了 data-drop-key，
 *    拖拽才有地方可落（少一个 data 属性，拖过去就是静默失败）；
 * 3. 数得清 —— 勾选后计数跟着变，用户知道自己在操作几笔。
 */

const SAMPLE = [
  makeTx({ id: 'tx1', at: '2026-11-02T12:00:00+08:00', amount: 1500, counterparty: '美团', l1: 'food', l2: 'lunch' }),
  makeTx({ id: 'tx2', at: '2026-11-03T12:00:00+08:00', amount: 3200, counterparty: '京东', l1: 'shopping', l2: 'digital' }),
  makeTx({ id: 'tx3', at: '2026-11-04T09:00:00+08:00', amount: 800000, direction: 'income', l1: 'salary', l2: 'monthly', counterparty: 'XX科技' }),
];

interface Mounted {
  text: () => string;
  buttons: () => HTMLButtonElement[];
  checkboxes: () => HTMLInputElement[];
  dropKeys: () => string[];
  unmount: () => Promise<void>;
}

async function waitFrames(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mount(): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      <ThemeProvider theme={buildTheme('light')}>
        <MemoryRouter>
          <Ledger />
        </MemoryRouter>
      </ThemeProvider>,
    );
  });
  await waitFrames(150);
  return {
    text: () => document.body.textContent ?? '',
    buttons: () => Array.from(container.querySelectorAll('button')) as HTMLButtonElement[],
    checkboxes: () => Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[],
    dropKeys: () =>
      Array.from(container.querySelectorAll('[data-drop-key]')).map(
        (item) => (item as HTMLElement).dataset.dropKey ?? '',
      ),
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

let page: Mounted | null = null;

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureSeeded(db);
  await transactionRepo.addMany(SAMPLE);
  // 数据都在 2026-11，默认本月区间刚好覆盖；筛选项必须回到初始状态
  useUiStore.getState().resetFilter();
});

afterEach(async () => {
  if (page) {
    await page.unmount();
    page = null;
  }
  await db.delete();
});

async function enterBatch(): Promise<void> {
  const button = page?.buttons().find((item) => item.textContent?.trim() === '批量');
  await act(async () => {
    button?.click();
  });
  await waitFrames(80);
}

describe('流水页：批量模式入口', () => {
  it('默认没有操作条与勾选框，界面和以前一样', async () => {
    page = await mount();
    expect(page.text()).toContain('流水');
    expect(page.checkboxes()).toHaveLength(0);
    expect(page.buttons().some((item) => item.textContent?.includes('全选本页'))).toBe(false);
  });

  it('流水行显示二级分类的中文名，而不是 digital 这种 ID', async () => {
    page = await mount();
    const text = page.text();
    expect(text).toContain('数码');
    expect(text).not.toContain('digital');
  });

  it('点「批量」后出现勾选框与底部操作条', async () => {
    page = await mount();
    await enterBatch();

    expect(page.checkboxes().length).toBeGreaterThan(0);
    const text = page.text();
    expect(text).toContain('全选本页');
    expect(text).toContain('加备注');
    expect(text).toContain('删除');
    // 按钮文字改成「退出批量」，用户随时能退
    expect(page.buttons().some((item) => item.textContent?.includes('退出批量'))).toBe(true);
  });

  it('勾选一笔后计数变化', async () => {
    page = await mount();
    await enterBatch();

    const first = page.checkboxes()[0];
    await act(async () => {
      first.click();
    });
    await waitFrames(60);

    expect(page.text()).toContain('1 笔');
  });
});

describe('流水页：拖拽落点', () => {
  it('批量模式下每个一级分类都是投放区', async () => {
    page = await mount();
    await enterBatch();

    const keys = page.dropKeys();
    expect(keys).toContain('ledger:l1:food');
    expect(keys).toContain('ledger:l1:shopping');
    // 收入侧也要能拖：工资、补贴的归类全在这条路径上
    expect(keys).toContain('ledger:l1:salary');
  });

  it('有进行中的计划时出现「加入计划」投放区，没有则不出现', async () => {
    page = await mount();
    await enterBatch();
    expect(page.dropKeys().some((key) => key.startsWith('ledger:plan:'))).toBe(false);
    await page.unmount();
    page = null;

    await planRepo.create({ id: 'plan_a', title: '台式主机', kind: 'save', target_cents: 800000 as Cents });
    page = await mount();
    await enterBatch();

    expect(page.dropKeys()).toContain('ledger:plan:plan_a');
    expect(page.text()).toContain('台式主机');
  });
});
