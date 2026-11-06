import { ThemeProvider } from '@mui/material';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { describe, expect, it } from 'vitest';
import { TimeCostBanner } from '../ui/components/TimeCostBanner';
import { buildTheme } from '../ui/theme';
import type { Cents } from '../types';

const yuan = (value: number): Cents => value * 100 as Cents;

/**
 * 横幅是「总量压迫」的唯一载体，纯函数算对不等于界面写对。
 * 这里真渲染一遍，确保文案、百分比、超支提示都真的出现在 DOM 里。
 */
async function render(element: JSX.Element): Promise<string> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ThemeProvider theme={buildTheme('light')}>{element}</ThemeProvider>);
  });
  const text = container.textContent ?? '';
  await act(async () => {
    root.unmount();
  });
  container.remove();
  return text;
}

describe('TimeCostBanner 可渲染', () => {
  it('超支时显示已用百分比、超支提示，且提到「挣来」的总量', async () => {
    const text = await render(
      <TimeCostBanner
        expenseCents={yuan(21120)}
        prevExpenseCents={yuan(15000)}
        scopeLabel="2026年11月"
        wageCents={yuan(100)}
        workdayHours={8}
        monthlyHours={174}
      />,
    );
    expect(text).toContain('2026年11月的代价');
    expect(text).toContain('26.4');
    expect(text).toContain('个工作日');
    // 174 / 8 = 21.7 个工作日预算，26.4 已经超了
    expect(text).toContain('21.7');
    expect(text).toContain('已经花超了');
    expect(text).toContain('多花');
  });

  it('未超支时显示剩余工天，不出现超支措辞', async () => {
    const text = await render(
      <TimeCostBanner
        expenseCents={yuan(5000)}
        prevExpenseCents={yuan(6000)}
        scopeLabel="所选区间"
        wageCents={yuan(100)}
        workdayHours={8}
        monthlyHours={174}
      />,
    );
    expect(text).toContain('还剩');
    expect(text).not.toContain('已经花超了');
    expect(text).toContain('少花');
  });

  it('没有时薪时整块不渲染，不留空壳', async () => {
    const text = await render(
      <TimeCostBanner
        expenseCents={yuan(5000)}
        prevExpenseCents={yuan(0)}
        scopeLabel="所选区间"
        wageCents={null}
        workdayHours={8}
        monthlyHours={174}
      />,
    );
    expect(text.trim()).toBe('');
  });

  it('没有任何支出时给一句中性文案，不显示 0 个工作日', async () => {
    const text = await render(
      <TimeCostBanner
        expenseCents={yuan(0)}
        prevExpenseCents={yuan(0)}
        scopeLabel="所选区间"
        wageCents={yuan(100)}
        workdayHours={8}
        monthlyHours={174}
      />,
    );
    expect(text).toContain('还没有支出');
    expect(text).not.toContain('0 个工作日');
  });
});
