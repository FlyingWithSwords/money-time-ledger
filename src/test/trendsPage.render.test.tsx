import { ThemeProvider } from '@mui/material';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import * as holdingRepo from '../db/repos/holdingRepo';
import * as transactionRepo from '../db/repos/transactionRepo';
import { ensureSeeded } from '../db/seed';
import { useUiStore } from '../store/uiStore';
import { buildTheme } from '../ui/theme';
import { Trends } from '../ui/pages/Trends';
import type { Cents } from '../types';
import { makeTx } from './txFixture';

/**
 * 趋势页「整体收益走势」的接线护栏。
 *
 * 这张图的数字由 `overallProfitSeries` 算，而它和下面三张图的零点口径**故意不同**
 * （一个从记账第一天、一个从区间起点），最容易出的错不是算错数，而是：
 * 卡片根本没被渲染出来、或者 lazy 分包漏了 import、或者口径文案被顺手改回
 * 「从区间起点起算」。这三点 tsc 都看不出来，只有真挂载页面才能发现。
 */

const SAMPLE = [
  makeTx({ id: 'jan-exp', at: '2026-01-05T12:00:00+08:00', amount: 300000 }),
  makeTx({ id: 'jan-income', at: '2026-01-10T12:00:00+08:00', amount: 500000, direction: 'income', l1: 'salary' }),
  makeTx({ id: 'mar-exp', at: '2026-03-02T12:00:00+08:00', amount: 400000 }),
];

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

/**
 * 等图表懒加载落地。
 *
 * 固定 sleep 在多文件并行跑时会偶发失败（分包编译耗时随 worker 负载浮动），
 * 所以改成轮询到目标文案出现为止，2.5s 兜底。
 */
async function waitForText(page: Mounted, needle: string, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.text().includes(needle)) return;
    await waitFrames(50);
  }
}

async function mount(): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(
      <ThemeProvider theme={buildTheme('light')}>
        <MemoryRouter>
          <Trends />
        </MemoryRouter>
      </ThemeProvider>,
    );
  });
  // liveQuery 首次取数 + 图表懒加载分包，都要等落地
  await waitFrames(150);
  return {
    text: () => container.textContent ?? '',
    buttons: () => Array.from(container.querySelectorAll('button')) as HTMLButtonElement[],
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
  // 只选 3 月：累计必须承接 1 月的历史，而不是归零
  useUiStore.getState().setDateRange({ from: '2026-03-01', to: '2026-03-31' });
});

afterEach(async () => {
  if (page) {
    await page.unmount();
    page = null;
  }
  await db.delete();
});

describe('趋势页：整体收益走势卡', () => {
  it('渲染出「整体收益走势」卡，且口径文案写明从记账第一天起算', async () => {
    page = await mount();
    const text = page.text();
    expect(text).toContain('整体收益走势');
    expect(text).toContain('现金流 + 基金/股票浮盈，从记账第一天累计');
    expect(text).toContain('整体收益从记账第一天起算，其余累计从区间起点起算');
    // 下面那张「从区间起点归零」的图仍在，两张图并存才需要区分口径
    expect(text).toContain('累计利润统计图');
    // 口径说明必须写明"只算浮盈、不含本金"，否则用户会以为本金也算收益
    expect(text).toContain('只算赚到的钱、不含本金');
  });

  it('没有持仓时整体收益就等于现金流，且提示去刷新行情', async () => {
    page = await mount();
    await waitForText(page, '截至');
    const text = page.text();
    expect(text).toContain('截至 2026年3月');
    // 1 月 +200000 与 3 月 −400000 累加 = −200000 分 → 2,000.00；
    // 若口径错成「从区间起点归零」，这里会显示 3 月单月的 4,000.00
    expect(text).toContain('2,000.00');
    expect(text).not.toContain('4,000.00');
    // 区间只有 1 个月时会向前补足，UI 必须说明白，不能悄悄改掉区间
    expect(text).toContain('已铺满账本全部历史（共 3 个月）');
    // 没有持仓时要说清"整体收益=现金流"，而不是画两条重合的线让人猜
    expect(text).toContain('还没有持仓记录');
  });

  it('有持仓和净值时把浮盈叠加进去：3 月 −1,400.00（现金流 −2,000 + 浮盈 600）', async () => {
    await holdingRepo.upsert({
      id: 'hold_test',
      fund_code: '000051',
      fund_name: '华夏盛世混合',
      platform: 'alipay',
      shares: 1000,
      total_cost_cents: 90000 as Cents,
      avg_cost_nav: 0.9,
      first_buy_date: '2026-01-10',
    });
    await holdingRepo.putQuotes([
      { id: '1', fund_code: '000051', nav: 1.0, nav_date: '2026-01-20', kind: 'nav', quote_at: '2026-01-20T10:00:00+08:00', source: 't' },
      { id: '2', fund_code: '000051', nav: 1.2, nav_date: '2026-02-27', kind: 'nav', quote_at: '2026-02-27T10:00:00+08:00', source: 't' },
      { id: '3', fund_code: '000051', nav: 1.5, nav_date: '2026-03-10', kind: 'nav', quote_at: '2026-03-10T10:00:00+08:00', source: 't' },
    ]);

    page = await mount();
    await waitForText(page, '截至');
    const text = page.text();

    // 3 月末：1000 份 × 1.5 = 1500 元，成本 900 → 浮盈 +600 元
    expect(text).toContain('其中持仓浮盈');
    expect(text).toContain('+600.00');
    // 整体 = 现金流 −2,000 + 浮盈 600 = −1,400 元（不是 −2,000）
    expect(text).toContain('1,400.00');
    expect(text).toContain('整体收益（含投资）');
    expect(text).toContain('纯现金流累计');
    // 有净值数据时不该再出现"去刷新行情"的兜底提示
    expect(text).not.toContain('还没有净值历史');
  });

  it('有持仓但没净值时不编数：曲线只画现金流，并明确让用户去刷新行情', async () => {
    await holdingRepo.upsert({
      id: 'hold_nav_missing',
      fund_code: '000051',
      fund_name: '华夏盛世混合',
      platform: 'alipay',
      shares: 1000,
      total_cost_cents: 90000 as Cents,
      avg_cost_nav: 0.9,
      first_buy_date: '2026-01-10',
    });

    page = await mount();
    await waitForText(page, '截至');
    const text = page.text();
    expect(text).toContain('有持仓但还没有净值历史');
    // 有持仓但没行情时给一个就地按钮，别把用户支使去别的页面找
    expect(page.buttons().some((item) => item.textContent?.includes('刷新行情，补上投资部分'))).toBe(true);
    // 投资部分未知 → 整体收益退回现金流数字，绝不显示 0 元浮盈
    expect(text).toContain('2,000.00');
    expect(text).not.toContain('其中持仓浮盈');
  });

  it('占位持仓（只有名称和市值）不给「刷新行情」，而是引导去补份额', async () => {
    await holdingRepo.upsert({
      id: 'hold_placeholder',
      fund_code: 'NAME:易方达蓝筹精选混合',
      fund_name: '易方达蓝筹精选混合',
      platform: 'alipay',
      shares: 0,
      total_cost_cents: 893273 as Cents,
      avg_cost_nav: 0,
      first_buy_date: '2026-01-10',
    });

    page = await mount();
    await waitForText(page, '截至');
    const text = page.text();
    // 占位持仓没有代码，刷新行情永远刷不到东西 —— 不能给刷新按钮
    expect(text).toContain('还没补份额');
    expect(page.buttons().some((item) => item.textContent?.includes('刷新行情'))).toBe(false);
    expect(page.buttons().some((item) => item.textContent?.includes('去基金页补份额'))).toBe(true);
  });

  it('账本里还有被记成支出的投资本金时，图下方提示并给改正入口', async () => {
    await transactionRepo.addMany([
      { ...makeTx({ id: 'inv-old', at: '2026-02-10T10:00:00+08:00', amount: 50000 }), counterparty: '蚂蚁财富' },
    ]);

    page = await mount();
    await waitForText(page, '截至');
    const text = page.text();
    expect(text).toContain('还有 1 笔买基金/理财的钱记在「支出」里');
    expect(page.buttons().some((item) => item.textContent?.includes('去改正'))).toBe(true);
  });

  it('「看全部历史」把区间拉回首笔账至今', async () => {
    page = await mount();
    const button = page.buttons().find((item) => item.textContent?.includes('看全部历史'));
    expect(button).toBeTruthy();
    await act(async () => {
      button?.click();
    });
    await waitFrames(80);

    const range = useUiStore.getState().dateRange;
    expect(range.from).toBe('2026-01-05');
    expect(range.to >= '2026-03-31').toBe(true);
    // 已经覆盖全历史后按钮不再出现（避免反复点击无反馈）
    expect(page.buttons().some((item) => item.textContent?.includes('看全部历史'))).toBe(false);
  });
});
