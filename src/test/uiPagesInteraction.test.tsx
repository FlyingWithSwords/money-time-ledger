import { ThemeProvider } from '@mui/material';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import * as holdingRepo from '../db/repos/holdingRepo';
import * as transactionRepo from '../db/repos/transactionRepo';
import { ensureSeeded } from '../db/seed';
import { generateReviewCard } from '../services/reviewService';
import { EMPTY_FILTER, useUiStore } from '../store/uiStore';
import { buildTheme } from '../ui/theme';
import { Funds } from '../ui/pages/Funds';
import { Insight } from '../ui/pages/Insight';
import { Ledger } from '../ui/pages/Ledger';
import { ReconcilePage } from '../ui/pages/Reconcile';
import { makeTx } from './txFixture';

/**
 * 主页面交互回归：二次确认框、异步写防连点、纯 pointer 项的键盘可达。
 *
 * 渲染方式与既有页面测试一致（createRoot + act + MemoryRouter，不引入 Testing Library）。
 * 注意 MUI Dialog 是 Portal，按钮落在 document.body 而不是挂载容器里，
 * 所以确认框里的按钮必须全局查，不能只查 container。
 */

interface Mounted {
  container: HTMLDivElement;
  text: () => string;
  bodyButtons: () => HTMLButtonElement[];
  unmount: () => Promise<void>;
}

const mountedPages: Mounted[] = [];

async function waitFrames(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mount(element: JSX.Element): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<ThemeProvider theme={buildTheme('light')}>{element}</ThemeProvider>);
  });
  // useLiveQuery 首轮取数 + MUI 弹窗进场都需要时间落地
  await waitFrames(100);
  const page: Mounted = {
    container,
    text: () => container.textContent ?? '',
    bodyButtons: () => Array.from(document.body.querySelectorAll('button')),
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
  mountedPages.push(page);
  return page;
}

async function click(element: Element | null | undefined, label: string): Promise<void> {
  if (!element) throw new Error(`找不到目标元素：${label}`);
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  await waitFrames(120);
}

async function clickByText(page: Mounted, label: string, scope: 'container' | 'body' = 'container'): Promise<void> {
  const buttons =
    scope === 'container' ? Array.from(page.container.querySelectorAll('button')) : page.bodyButtons();
  const target = buttons.find((button) => (button.textContent ?? '').includes(label));
  await click(target, label);
}

/** 在目标元素本身（而非子元素）上派发按键，满足 ButtonBase 的 target === currentTarget 判定。 */
async function pressKey(element: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  await waitFrames(80);
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureSeeded(db);
  useUiStore.setState({ snack: null, snackQueue: [], filter: { ...EMPTY_FILTER } });
});

afterEach(async () => {
  for (const page of mountedPages.splice(0)) await page.unmount();
  // 弹窗退场动画期间 DOM 仍在 body 上，等它彻底卸载，避免污染下一条用例
  await waitFrames(260);
});

function seedLedgerTx(id: string): Promise<void> {
  return transactionRepo
    .addMany([makeTx({ id, at: '2020-06-10T12:00:00+08:00', amount: 1234 })])
    .then(() => undefined);
}

function useJuneFilter(): void {
  useUiStore.setState({
    filter: { ...EMPTY_FILTER, fromDate: '2020-06-01', toDate: '2020-06-30' },
  });
}

describe('流水页 · 删除二次确认', () => {
  it('点删除先弹确认框，点「取消」不执行删除', async () => {
    await seedLedgerTx('tx-cancel');
    useJuneFilter();
    const page = await mount(
      <MemoryRouter>
        <Ledger />
      </MemoryRouter>,
    );

    await click(page.container.querySelector('button[aria-label="删除"]'), '删除图标按钮');
    expect(document.body.textContent, '删除前必须弹确认框').toContain('删除这笔账？');
    expect(document.body.textContent).toContain('已删除');

    await clickByText(page, '取消', 'body');

    const row = await db.transactions.get('tx-cancel');
    expect(row?.deleted_at, '取消后这笔账必须还在').toBeFalsy();
    expect(useUiStore.getState().snack?.message).not.toBe('已删除，可撤销');
  });

  it('点「删除」确认后走原有软删逻辑，并保留撤销入口', async () => {
    await seedLedgerTx('tx-confirm');
    useJuneFilter();
    const page = await mount(
      <MemoryRouter>
        <Ledger />
      </MemoryRouter>,
    );

    await click(page.container.querySelector('button[aria-label="删除"]'), '删除图标按钮');
    expect(document.body.textContent).toContain('删除这笔账？');

    await clickByText(page, '删除', 'body');

    const row = await db.transactions.get('tx-confirm');
    expect(row?.deleted_at, '确认后应软删').toBeTruthy();
    expect(useUiStore.getState().snack?.message).toBe('已删除，可撤销');
    expect(page.text(), '常驻撤销 Alert 要保留').toContain('撤销');
  });
});

describe('对账页 · 合并二次确认与可操作空态', () => {
  async function seedPair(): Promise<void> {
    await transactionRepo.addMany([
      { ...makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 3500, source: 'wechat' }), counterparty: '美团外卖' },
      {
        ...makeTx({ id: 'a', at: '2020-06-10T13:00:00+08:00', amount: 3500, source: 'alipay' }),
        counterparty: '财付通-美团外卖',
      },
    ]);
  }

  it('取消不合并；确认后才把另一笔标记为重复并隐藏', async () => {
    await seedPair();
    const page = await mount(
      <MemoryRouter>
        <ReconcilePage />
      </MemoryRouter>,
    );
    expect(page.text()).toContain('发现 1 组疑似同一笔');

    await clickByText(page, '是同一笔，合并来源');
    expect(document.body.textContent).toContain('确认这两笔是同一笔？');
    expect(document.body.textContent).toContain('另一笔会被标记为重复并隐藏');

    await clickByText(page, '取消', 'body');
    await waitFrames(260);
    expect((await db.transactions.get('a'))?.deleted_at, '取消后不能软删').toBeFalsy();
    expect(page.text()).toContain('是同一笔，合并来源');

    await clickByText(page, '是同一笔，合并来源');
    await clickByText(page, '确认合并', 'body');

    expect((await db.transactions.get('a'))?.deleted_at, '确认后另一笔软删').toBeTruthy();
    expect((await db.transactions.get('a'))?.dedupe_status).toBe('duplicate');
    expect(useUiStore.getState().snack?.message).toBe('已合并，另一笔进了已删除区');
  });

  it('没有候选时给可操作的紧凑空态，而不只是一行「暂无」', async () => {
    const page = await mount(
      <MemoryRouter>
        <ReconcilePage />
      </MemoryRouter>,
    );
    expect(page.text()).toContain('没有发现疑似重复的跨平台记录');
    expect(page.text()).toContain('去导入账单');
    expect(page.text()).toContain('导入微信、支付宝等账单后');
  });
});

describe('纯 pointer 项 · 键盘可达', () => {
  it('基金持仓项可用 Enter / Space 选中，且带 role 与 tabIndex', async () => {
    await holdingRepo.addPosition({
      id: 'h1',
      platform: 'manual',
      fund_code: '000001',
      fund_name: '华夏成长',
      shares: 100,
      cost_cents: 100000,
      date: '2020-06-01',
    });
    await holdingRepo.addPosition({
      id: 'h2',
      platform: 'alipay',
      fund_code: '000002',
      fund_name: '易方达稳健',
      shares: 200,
      cost_cents: 200000,
      date: '2020-06-02',
    });

    const page = await mount(
      <MemoryRouter>
        <Funds />
      </MemoryRouter>,
    );
    const items = Array.from(page.container.querySelectorAll<HTMLElement>('[aria-label^="查看 "]'));
    expect(items, '两只持仓都要可聚焦').toHaveLength(2);
    for (const item of items) {
      expect(item.getAttribute('role')).toBe('button');
      expect(item.tabIndex).toBe(0);
    }

    // 净值曲线卡片副标题是选中态的唯一可观测点：初始锚定第一只
    expect(page.text()).toMatch(/000001 · (交易|非交易)时段/);
    expect(page.text()).not.toMatch(/000002 · (交易|非交易)时段/);

    await pressKey(items[1], 'Enter');
    expect(page.text(), 'Enter 应选中第二只').toMatch(/000002 · (交易|非交易)时段/);

    await pressKey(items[0], ' ');
    expect(page.text(), 'Space 应切回第一只').toMatch(/000001 · (交易|非交易)时段/);
  });

  it('洞察页复盘卡项可用 Enter 打开对应月份', async () => {
    await transactionRepo.addMany([makeTx({ id: 'insight-tx', at: '2020-06-10T12:00:00+08:00', amount: 2500 })]);
    await generateReviewCard('2020-06');

    const page = await mount(
      <MemoryRouter initialEntries={['/insight']}>
        <Routes>
          <Route path="/insight" element={<Insight />} />
          <Route path="/review/:month" element={<div>复盘详情命中</div>} />
        </Routes>
      </MemoryRouter>,
    );
    const item = page.container.querySelector<HTMLElement>('[aria-label^="查看 "]');
    expect(item, '复盘卡项应可聚焦').not.toBeNull();
    expect(item?.getAttribute('role')).toBe('button');
    expect(item?.tabIndex).toBe(0);
    expect(page.text()).not.toContain('复盘详情命中');

    await pressKey(item as HTMLElement, 'Enter');
    expect(page.text(), 'Enter 应跳到复盘详情').toContain('复盘详情命中');
  });
});
