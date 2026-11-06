import { ThemeProvider } from '@mui/material';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import * as transactionRepo from '../db/repos/transactionRepo';
import { ensureSeeded } from '../db/seed';
import { useUiStore } from '../store/uiStore';
import { buildTheme } from '../ui/theme';
import { ReconcilePage } from '../ui/pages/Reconcile';
import { makeTx } from './txFixture';

/**
 * 对账页渲染测试。
 *
 * 为什么需要它：这个页面的核心承诺是「每一条候选都给出可验证的判定依据，
 * 且两条裁决路径都由用户点」。tsc 只能证明类型对，证明不了 useLiveQuery
 * 的数据流（交易 → 候选 → 卡片 → 点击 → 数据变化 → 卡片消失）在运行时
 * 真的转得起来——任何一环断了，用户面对的都是一个「看着能点但点了没反应」
 * 的死页面。
 */

interface Mounted {
  text: () => string;
  buttons: () => HTMLButtonElement[];
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
          <ReconcilePage />
        </MemoryRouter>
      </ThemeProvider>,
    );
  });
  // liveQuery 首次取数是异步的，等它落地再读文本
  await waitFrames(80);
  return {
    text: () => container.textContent ?? '',
    buttons: () => Array.from(container.querySelectorAll('button')),
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** 按可见文案找按钮并点击，等 liveQuery 刷新完再返回。 */
async function clickButton(page: Mounted, label: string): Promise<void> {
  const button = page.buttons().find((btn) => (btn.textContent ?? '').includes(label));
  if (!button) throw new Error(`页面上找不到按钮：${label}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  await waitFrames(120);
}

/**
 * MUI Dialog 通过 Portal 挂到 document.body，不在页面 container 内，
 * 所以确认框里的按钮得单独从 body 找。破坏性操作加了二次确认后，
 * 「点合并 → 立即生效」的旧路径变成「点合并 → 确认合并 → 生效」。
 */
async function clickDialogButton(label: string): Promise<void> {
  const button = Array.from(document.body.querySelectorAll('button')).find((btn) =>
    (btn.textContent ?? '').includes(label),
  );
  if (!button) throw new Error(`确认框里找不到按钮：${label}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  await waitFrames(120);
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureSeeded(db);
  useUiStore.setState({ snack: null });
});

describe('对账页 · 候选渲染与裁决', () => {
  it('有候选时渲染判定依据文案与两个裁决按钮', async () => {
    await transactionRepo.addMany([
      { ...makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 3500, source: 'wechat' }), counterparty: '美团外卖' },
      {
        ...makeTx({ id: 'a', at: '2020-06-10T13:00:00+08:00', amount: 3500, source: 'alipay' }),
        counterparty: '财付通-美团外卖',
      },
    ]);

    const page = await mount();
    const text = page.text();
    // 判定依据逐条可见：金额、日期、对手方三个维度都要给用户核对材料
    expect(text).toContain('发现 1 组疑似同一笔');
    expect(text).toContain('金额完全一致 ¥35.00');
    expect(text).toContain('同一天交易');
    expect(text).toContain('对手方吻合（一方包含另一方）');
    // 两条裁决路径都必须摆在用户面前，不能只给「合并」
    expect(text).toContain('是同一笔，合并来源');
    expect(text).toContain('不是，记住这个判断');
    await page.unmount();
  });

  it('点「不是」后该组从列表消失，snack 确认判断已被记住', async () => {
    await transactionRepo.addMany([
      { ...makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 3500, source: 'wechat' }), counterparty: '美团外卖' },
      {
        ...makeTx({ id: 'a', at: '2020-06-10T13:00:00+08:00', amount: 3500, source: 'alipay' }),
        counterparty: '财付通-美团外卖',
      },
    ]);

    const page = await mount();
    expect(page.text()).toContain('是同一笔，合并来源');

    await clickButton(page, '不是，记住这个判断');

    // 数据驱动刷新：dismissedKeys 落库 → liveQuery 重跑 → 该组消失、空态出现
    expect(page.text()).toContain('没有发现疑似重复的跨平台记录');
    expect(page.text()).not.toContain('是同一笔，合并来源');
    expect(useUiStore.getState().snack?.message).toBe('已记住，不会再提示这一对');
    await page.unmount();
  });

  it('点「是同一笔」后组消失，另一笔软删进已删除区', async () => {
    await transactionRepo.addMany([
      { ...makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 3500, source: 'wechat' }), counterparty: '美团外卖' },
      {
        ...makeTx({ id: 'a', at: '2020-06-10T13:00:00+08:00', amount: 3500, source: 'alipay' }),
        counterparty: '财付通-美团外卖',
      },
    ]);

    const page = await mount();
    await clickButton(page, '是同一笔，合并来源');
    // 破坏性操作现在要先过确认框（Portal 到 body，不在页面 container 内）
    await clickDialogButton('确认合并');

    expect(page.text()).toContain('没有发现疑似重复的跨平台记录');
    expect(useUiStore.getState().snack?.message).toBe('已合并，另一笔进了已删除区');
    // keep 原样健在且并入了另一边来源；drop 只是软删，数据没丢
    const keep = await db.transactions.get('w');
    expect(keep?.source_refs).toEqual(['wechat', 'alipay']);
    const drop = await db.transactions.get('a');
    expect(drop?.deleted_at).toBeTruthy();
    expect(drop?.dedupe_status).toBe('duplicate');
    await page.unmount();
  });

  it('没有候选时渲染空态，不出裁决按钮', async () => {
    const page = await mount();
    const text = page.text();
    expect(text).toContain('发现 0 组疑似同一笔');
    expect(text).toContain('没有发现疑似重复的跨平台记录');
    expect(text).not.toContain('是同一笔，合并来源');
    await page.unmount();
  });
});
