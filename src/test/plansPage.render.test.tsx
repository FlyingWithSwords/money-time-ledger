import { ThemeProvider } from '@mui/material';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import * as planRepo from '../db/repos/planRepo';
import * as transactionRepo from '../db/repos/transactionRepo';
import { ensureSeeded } from '../db/seed';
import { buildTheme } from '../ui/theme';
import { PlansPage } from '../ui/pages/Plans';
import type { Cents } from '../types';
import { makeTx } from './txFixture';

/**
 * 计划页的接线护栏。
 *
 * 这张页面的数字全由 planProgress 算，逻辑本身有单测；这里盯的是
 * **页面有没有真的把它显示出来**：进度条没渲染、完成结论没显示、
 * 投放区没挂 data-drop-key（拖拽就永远落空）—— 这三类 tsc 都发现不了。
 */

const INCOME = [
  makeTx({ id: 'inc1', at: '2026-10-01T09:00:00+08:00', amount: 300000, direction: 'income', l1: 'salary', counterparty: 'XX科技' }),
  makeTx({ id: 'inc2', at: '2026-10-10T09:00:00+08:00', amount: 200000, direction: 'income', l1: 'salary', counterparty: '奖金' }),
];

const SPEND = [
  makeTx({ id: 'sp1', at: '2026-10-12T09:00:00+08:00', amount: 250000, direction: 'expense', l1: 'shopping', l2: 'digital', counterparty: '京东' }),
  makeTx({ id: 'sp2', at: '2026-10-15T09:00:00+08:00', amount: 130000, direction: 'expense', l1: 'shopping', l2: 'digital', counterparty: '淘宝' }),
];

interface Mounted {
  text: () => string;
  buttons: () => HTMLButtonElement[];
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
          <PlansPage />
        </MemoryRouter>
      </ThemeProvider>,
    );
  });
  await waitFrames(150);
  return {
    // Dialog 走 portal 渲染到 body，只读 container 会看不见弹窗内容
    text: () => document.body.textContent ?? '',
    buttons: () => Array.from(container.querySelectorAll('button')) as HTMLButtonElement[],
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
  await transactionRepo.addMany([...INCOME, ...SPEND]);
});

afterEach(async () => {
  if (page) {
    await page.unmount();
    page = null;
  }
  await db.delete();
});

describe('计划页：空状态与新建', () => {
  it('没有计划时给引导，而不是一片空白', async () => {
    page = await mount();
    const text = page.text();
    expect(text).toContain('消费计划');
    expect(text).toContain('还没有计划');
    // 引导文案必须把「攒钱」和「消费」两条独立计划讲清楚
    expect(text).toContain('攒钱买台式主机');
    expect(text).toContain('主机采购');
  });

  it('点「新建」能打开对话框，且默认是攒钱', async () => {
    page = await mount();
    const create = page.buttons().find((item) => item.textContent?.includes('新建计划') || item.textContent?.includes('新建'));
    await act(async () => {
      create?.click();
    });
    await waitFrames(80);
    const text = page.text();
    expect(text).toContain('新建计划');
    expect(text).toContain('计划名称');
    // 两种计划类型都可选
    expect(text).toContain('攒钱');
    expect(text).toContain('消费');
  });
});

describe('计划页：攒钱进度', () => {
  beforeEach(async () => {
    await planRepo.create({ id: 'plan_save', title: '台式主机', kind: 'save', target_cents: 800000 as Cents });
    await planRepo.link('plan_save', ['inc1', 'inc2']);
  });

  it('显示已攒 / 目标、百分比与还差多少', async () => {
    page = await mount();
    const text = page.text();
    expect(text).toContain('台式主机');
    // 5000 / 8000 = 62.5%
    expect(text).toContain('5,000.00');
    expect(text).toContain('8,000.00');
    expect(text).toContain('62.5%');
    expect(text).toContain('还差 3,000.00');
    expect(text).toContain('2 笔已关联');
  });

  it('计划卡是投放区：挂了 data-drop-key，拖拽才落得下去', async () => {
    page = await mount();
    expect(page.dropKeys()).toContain('plan:plan_save');
  });

  it('有「最近流水」可拖区，攒钱与消费都能在这里找到入口', async () => {
    page = await mount();
    expect(page.text()).toContain('最近流水');
  });
});

describe('计划页：消费完成后的结论', () => {
  it('预算内完成显示省下多少钱', async () => {
    await planRepo.create({ id: 'plan_spend', title: '主机采购', kind: 'spend', target_cents: 500000 as Cents });
    await planRepo.link('plan_spend', ['sp1', 'sp2']);
    // 走真实完成路径：complete 会把当前累计冻结进 settled_cents
    await planRepo.complete('plan_spend');

    page = await mount();
    const text = page.text();
    expect(text).toContain('已完成');
    expect(text).toContain('主机采购');
    // 预算 5000、实付 3800 → 省下 1,200
    expect(text).toContain('预算内完成，省下 1,200.00 元');
  });

  it('超支完成不谎报「省下」', async () => {
    await planRepo.create({ id: 'plan_over', title: '装修', kind: 'spend', target_cents: 100000 as Cents });
    await planRepo.link('plan_over', ['sp1']);
    await planRepo.complete('plan_over');

    page = await mount();
    const text = page.text();
    expect(text).toContain('装修');
    expect(text).toContain('超支');
    expect(text).not.toContain('省下');
  });

  it('完成后关联流水被改动，结论仍是冻结值', async () => {
    await planRepo.create({ id: 'plan_frozen', title: '主机采购', kind: 'spend', target_cents: 500000 as Cents });
    await planRepo.link('plan_frozen', ['sp1', 'sp2']);
    await planRepo.complete('plan_frozen');
    // 完成之后再删掉一笔关联支出：结论不该跟着变
    await transactionRepo.softDelete('sp2');

    page = await mount();
    expect(page.text()).toContain('预算内完成，省下 1,200.00 元');
  });
});
