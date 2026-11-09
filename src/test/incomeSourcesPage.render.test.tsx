import { ThemeProvider } from '@mui/material';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import * as settingsRepo from '../db/repos/settingsRepo';
import * as transactionRepo from '../db/repos/transactionRepo';
import { ensureSeeded } from '../db/seed';
import { useUiStore } from '../store/uiStore';
import { IncomeSourcesPage } from '../ui/pages/Settings/IncomeSources';
import { buildTheme } from '../ui/theme';
import type { Cents } from '../types';
import { makeTx } from './txFixture';

/**
 * 工资与补贴来源页的接线护栏。
 *
 * 这里要守住三件事，每一件都对应一次真实的不愉快：
 * 1. **存量误判要有出口** —— 判定改对了，但已经写成收入的那 15,000 不会自己回来，
 *    页面上必须能看见并一键改回，否则用户只能手动翻流水找。
 * 2. **高级条件是可选填的** —— 默认收起，点开才出现；填错要报错，
 *    不能静默忽略（用户以为加了「金额 ≥ 3000」，实际规则是全放的）。
 * 3. **条件真的落进了设置** —— 界面上填了、保存时丢了，这种 bug 最难发现。
 */

const SAMPLE = [
  makeTx({
    id: 'closed_income',
    at: '2026-01-30T16:16:00+08:00',
    amount: 1500000,
    direction: 'income',
    l1: 'salary',
    l2: 'monthly',
    counterparty: '余额宝',
    note: '余额宝-单次转入（交易关闭）',
  }),
];

interface Mounted {
  text: () => string;
  buttons: () => HTMLButtonElement[];
  inputs: () => HTMLInputElement[];
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
          <IncomeSourcesPage />
        </MemoryRouter>
      </ThemeProvider>,
    );
  });
  await waitFrames(200);
  return {
    text: () => document.body.textContent ?? '',
    buttons: () => Array.from(document.querySelectorAll('button')) as HTMLButtonElement[],
    inputs: () => Array.from(document.querySelectorAll('input')) as HTMLInputElement[],
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** React 受控输入：改 value 必须走原型上的 setter，再派发 input 事件。 */
function typeInto(input: HTMLInputElement | undefined, value: string): void {
  if (!input) throw new Error('找不到输入框');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function byPlaceholder(page: Mounted, placeholder: string): HTMLInputElement | undefined {
  return page.inputs().find((item) => item.placeholder === placeholder);
}

let page: Mounted | null = null;

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureSeeded(db);
  await transactionRepo.addMany(SAMPLE);
  useUiStore.setState({ snack: null, snackQueue: [] });
});

afterEach(async () => {
  if (page) {
    await page.unmount();
    page = null;
  }
  await db.delete();
});

describe('工资与补贴来源：存量误判的出口', () => {
  it('发现「交易关闭」被算成收入时给出告警，并说清金额', async () => {
    page = await mount();
    const text = page.text();
    expect(text).toContain('交易关闭');
    expect(text).toContain('15,000.00');
    expect(page.buttons().some((item) => item.textContent?.includes('改回不计收支'))).toBe(true);
  });

  it('点「改回不计收支」后，这笔真的回到转账，不再是收入', async () => {
    page = await mount();
    const button = page.buttons().find((item) => item.textContent?.includes('改回不计收支'));
    await act(async () => {
      button?.click();
    });
    await waitFrames(250);

    const row = await db.transactions.get('closed_income');
    expect(row?.direction).toBe('transfer');
    expect(row?.category_l2).toBe('pending');
    // 修完之后告警就该消失
    expect(page.text()).not.toContain('改回不计收支');
  });
});

describe('工资与补贴来源：高级条件', () => {
  it('默认收起，点开后才出现金额与摘要输入框', async () => {
    const view = await mount();
    page = view;
    expect(byPlaceholder(view, '例如：3000')).toBeUndefined();

    const toggle = view.buttons().find((item) => item.textContent?.includes('高级条件'));
    await act(async () => {
      toggle?.click();
    });
    await waitFrames(120);

    expect(byPlaceholder(view, '例如：3000')).toBeDefined();
    expect(byPlaceholder(view, '留空表示不限')).toBeDefined();
    expect(byPlaceholder(view, '例如：转入 / 代发')).toBeDefined();
    expect(byPlaceholder(view, '例如：转出 / 收益')).toBeDefined();
  });

  it('填了条件后加进设置，并原样存成 filter', async () => {
    const view = await mount();
    page = view;
    const toggle = view.buttons().find((item) => item.textContent?.includes('高级条件'));
    await act(async () => {
      toggle?.click();
    });
    await waitFrames(120);

    await act(async () => {
      typeInto(byPlaceholder(view, '例如：XX 科技有限公司'), '余额宝');
      typeInto(byPlaceholder(view, '例如：3000'), '3000');
      typeInto(byPlaceholder(view, '例如：转入 / 代发'), '转入');
    });
    await waitFrames(120);

    const add = view.buttons().find((item) => item.textContent?.trim() === '添加');
    await act(async () => {
      add?.click();
    });
    await waitFrames(300);

    const [source] = await settingsRepo.getIncomeSources();
    expect(source.keyword).toBe('余额宝');
    expect(source.filter).toEqual({ min_cents: 300000 as Cents, include: '转入' });
    // 列表上要能看出这条来源带了条件
    expect(view.text()).toContain('有筛选');
  });

  it('金额填错时报错并且不写设置——静默忽略会让人以为条件生效了', async () => {
    const view = await mount();
    page = view;
    const toggle = view.buttons().find((item) => item.textContent?.includes('高级条件'));
    await act(async () => {
      toggle?.click();
    });
    await waitFrames(120);

    await act(async () => {
      typeInto(byPlaceholder(view, '例如：XX 科技有限公司'), '余额宝');
      typeInto(byPlaceholder(view, '例如：3000'), '很多钱');
    });
    await waitFrames(120);

    const add = view.buttons().find((item) => item.textContent?.trim() === '添加');
    await act(async () => {
      add?.click();
    });
    await waitFrames(200);

    expect(useUiStore.getState().snack?.message).toContain('不是金额');
    expect(await settingsRepo.getIncomeSources()).toHaveLength(0);
  });
});
