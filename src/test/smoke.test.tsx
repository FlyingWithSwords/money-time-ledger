import { ThemeProvider } from '@mui/material';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import { ensureSeeded } from '../db/seed';
import { Overview } from '../ui/pages/Overview';
import { Ledger } from '../ui/pages/Ledger';
import { Insight } from '../ui/pages/Insight';
import { buildTheme } from '../ui/theme';

/**
 * 冒烟测试：把三个主页面真渲染一遍，确保没有「模块能编译但一渲染就炸」的问题。
 * 不用 Testing Library —— 只关心不抛异常 + 给出预期的关键文案。
 */
async function renderPage(element: JSX.Element): Promise<string> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ThemeProvider theme={buildTheme('light')}>{element}</ThemeProvider>);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  const text = container.textContent ?? '';
  await act(async () => {
    root.unmount();
  });
  container.remove();
  return text;
}

describe('smoke: 页面可渲染', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await ensureSeeded(db);
  });

  it('空数据时总览给引导，而不是空白', async () => {
    const text = await renderPage(
      <MemoryRouter>
        <Overview />
      </MemoryRouter>,
    );
    expect(text).toContain('快记账');
    expect(text).toContain('先记第一笔');
  });

  it('流水页在空数据时给筛选与引导', async () => {
    const text = await renderPage(
      <MemoryRouter>
        <Ledger />
      </MemoryRouter>,
    );
    expect(text).toContain('流水');
    expect(text).toContain('这个筛选下没有记录');
  });

  it('洞察页在空数据时给引导', async () => {
    const text = await renderPage(
      <MemoryRouter>
        <Insight />
      </MemoryRouter>,
    );
    expect(text).toContain('还没有可分析的数据');
  });
});
