import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from '@mui/material';
import { describe, expect, it, vi } from 'vitest';
import { buildTheme } from '../ui/theme';
import type { Cents } from '../types';
import type { FlowPoint } from '../domain/aggregate';
import {
  CHART_COLORS,
  CHART_COLORS_DARK,
  CHART_SERIES_COLORS,
  CHART_SERIES_COLORS_DARK,
  TOOLTIP_STYLE,
  buildChartTheme,
  chartPalette,
  chartSeriesPalette,
  compactYuan,
} from '../ui/charts/chartTokens';
import CategoryDonut from '../ui/charts/CategoryDonut';
import CumulativeFlow from '../ui/charts/CumulativeFlow';
import CumulativeProfit from '../ui/charts/CumulativeProfit';
import ExpenseTrend from '../ui/charts/ExpenseTrend';
import FlowLines from '../ui/charts/FlowLines';
import MonthlyBars from '../ui/charts/MonthlyBars';
import NavLine from '../ui/charts/NavLine';
import TimeCostBars from '../ui/charts/TimeCostBars';

/**
 * WCAG 相对亮度：先把 sRGB 通道线性化，再按 0.2126 / 0.7152 / 0.0722 加权。
 * 不引入任何依赖，纯计算，用来证明深色版确实「提亮」而不是只换了个色相。
 */
function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((start) => parseInt(value.slice(start, start + 2), 16) / 255);
  const linear = channels.map((channel: number) =>
    channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4),
  );
  const [r, g, b] = linear;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function averageLuminance(list: readonly string[]): number {
  return list.reduce((sum: number, color: string) => sum + relativeLuminance(color), 0) / list.length;
}

const lightPalette = buildTheme('light').palette;
const darkPalette = buildTheme('dark').palette;

describe('图表语义色板', () => {
  it('浅色/深色两套色板键集合完全一致', () => {
    expect(Object.keys(CHART_COLORS).sort()).toEqual(Object.keys(CHART_COLORS_DARK).sort());
    expect(Object.keys(chartPalette('light')).sort()).toEqual(Object.keys(chartPalette('dark')).sort());
    expect(Object.keys(CHART_COLORS).sort()).toEqual(['blue', 'gray', 'green', 'orange', 'purple', 'red']);
  });

  it('深色版 green / red 的相对亮度显著高于浅色版（≥1.5 倍）', () => {
    for (const key of ['green', 'red'] as const) {
      const light = relativeLuminance(CHART_COLORS[key]);
      const dark = relativeLuminance(CHART_COLORS_DARK[key]);
      expect(dark, `${key} 深色版应明显更亮`).toBeGreaterThan(light * 1.5);
    }
  });

  it('深色版每个语义色都比浅色版亮', () => {
    for (const key of Object.keys(CHART_COLORS) as Array<keyof typeof CHART_COLORS>) {
      expect(
        relativeLuminance(CHART_COLORS_DARK[key]),
        `${key} 深色版应更亮`,
      ).toBeGreaterThan(relativeLuminance(CHART_COLORS[key]));
    }
  });

  it('分类序列两套长度一致，且深色版平均亮度更高', () => {
    expect(CHART_SERIES_COLORS_DARK).toHaveLength(CHART_SERIES_COLORS.length);
    expect(chartSeriesPalette('dark')).toHaveLength(chartSeriesPalette('light').length);
    expect(averageLuminance(CHART_SERIES_COLORS_DARK)).toBeGreaterThan(
      averageLuminance(CHART_SERIES_COLORS),
    );
  });
});

describe('buildChartTheme 纯函数', () => {
  it('深色 tooltip 背景不是白色，且含 color / border / borderRadius / fontSize', () => {
    const dark = buildChartTheme('dark', darkPalette).tooltip;
    expect(dark.contentStyle.backgroundColor).toBe(darkPalette.background.paper);
    expect(dark.contentStyle.backgroundColor).not.toBe('#ffffff');
    expect(dark.contentStyle.backgroundColor).not.toBe('#fff');
    expect(dark.contentStyle.backgroundColor).not.toBe('white');
    expect(dark.contentStyle.color).toBeTruthy();
    expect(dark.contentStyle.border).toBeTruthy();
    expect(dark.contentStyle.borderRadius).toBe(10);
    expect(dark.contentStyle.fontSize).toBe(12);
    expect(dark.contentStyle.backgroundColor).not.toBe(dark.contentStyle.color);
  });

  it('labelStyle / itemStyle 都给了 color，浅色 tooltip 用白底', () => {
    const dark = buildChartTheme('dark', darkPalette).tooltip;
    const light = buildChartTheme('light', lightPalette).tooltip;
    expect(dark.labelStyle.color).toBeTruthy();
    expect(dark.itemStyle.color).toBeTruthy();
    expect(light.labelStyle.color).toBeTruthy();
    expect(light.itemStyle.color).toBeTruthy();
    expect(light.contentStyle.backgroundColor).toBe(lightPalette.background.paper);
    expect(light.contentStyle.backgroundColor).toBe('#ffffff');
    expect(dark.contentStyle.backgroundColor).not.toBe(light.contentStyle.backgroundColor);
  });

  it('轴刻度 / 轴线条 / 网格 / 图例都取自 MUI palette，深浅色不同', () => {
    const light = buildChartTheme('light', lightPalette);
    const dark = buildChartTheme('dark', darkPalette);
    expect(dark.axis.tick.fill).toBe(darkPalette.text.secondary);
    expect(dark.axis.stroke).toBe(darkPalette.divider);
    expect(dark.grid.stroke).toBe(darkPalette.text.secondary);
    expect(dark.legend.wrapperStyle.color).toBe(darkPalette.text.secondary);
    expect(dark.axis.tick.fill).not.toBe(light.axis.tick.fill);
    expect(dark.axis.stroke).not.toBe(light.axis.stroke);
    expect(dark.legend.wrapperStyle.color).not.toBe(light.legend.wrapperStyle.color);
  });

  it('mode 决定色板来源', () => {
    expect(buildChartTheme('dark', darkPalette).colors.green).toBe(CHART_COLORS_DARK.green);
    expect(buildChartTheme('light', lightPalette).colors.green).toBe(CHART_COLORS.green);
    expect(buildChartTheme('dark', darkPalette).series).toBe(CHART_SERIES_COLORS_DARK);
    expect(buildChartTheme('light', lightPalette).series).toBe(CHART_SERIES_COLORS);
  });
});

describe('深色模式下真实渲染', () => {
  const cents = (value: number): Cents => value as Cents;

  const flowPoint: FlowPoint = {
    month_key: '2024-01',
    label: '2024年1月',
    income_cents: cents(200000),
    expense_cents: cents(80000),
    net_cents: cents(120000),
    cum_income_cents: cents(200000),
    cum_expense_cents: cents(80000),
    cum_net_cents: cents(120000),
  };

  /** 把全部 8 个图表挂到 dark ThemeProvider 下，验证 hook 与 recharts 组合不炸。 */
  function allCharts(): ReactElement {
    return createElement(
      ThemeProvider,
      { theme: buildTheme('dark') },
      createElement(
        'div',
        null,
        createElement(CategoryDonut, {
          shares: [{ l1: '餐饮', name: '餐饮', icon: '餐饮', cents: cents(80000), ratio: 1 }],
          hasPending: false,
          totalCents: cents(80000),
        }),
        createElement(MonthlyBars, {
          points: [
            {
              month_key: '2024-01',
              label: '1月',
              expense_cents: cents(80000),
              net_expense_cents: cents(80000),
              income_cents: cents(200000),
            },
          ],
          averageCents: cents(80000),
        }),
        createElement(ExpenseTrend, {
          current: [{ date: '2024-01-01', label: '1月1日', income_cents: cents(0), expense_cents: cents(1000) }],
          previous: [{ date: '2023-12-01', label: '12月1日', income_cents: cents(0), expense_cents: cents(900) }],
          currentLabel: '本区间',
          previousLabel: '上一区间',
        }),
        createElement(TimeCostBars, { items: [{ name: '餐饮', hours: 2.5 }] }),
        createElement(NavLine, { points: [{ nav_date: '2024-01-01', nav: 1.2345 }] }),
        createElement(FlowLines, { points: [flowPoint] }),
        createElement(CumulativeProfit, { points: [flowPoint] }),
        createElement(CumulativeFlow, { points: [flowPoint] }),
      ),
    );
  }

  it('全部 8 个图表在 dark ThemeProvider 内调用 useChartTheme 都能渲染', async () => {
    // jsdom 没有布局，ResponsiveContainer 会打印 width(0)/height(0) 提示；这是预期噪声，静音。
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(allCharts());
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(container).toBeTruthy();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      warn.mockRestore();
    }
  });
});

describe('历史导出保持可用', () => {
  it('compactYuan 与 TOOLTIP_STYLE 没被删，且 TOOLTIP_STYLE 现在也带颜色', () => {
    expect(compactYuan(12340)).toBe('1.2万');
    expect(compactYuan(123456)).toBe('12万');
    expect(compactYuan(99)).toBe('99');
    expect(TOOLTIP_STYLE.borderRadius).toBe(10);
    expect(TOOLTIP_STYLE.fontSize).toBe(12);
    expect(TOOLTIP_STYLE.backgroundColor).toBeTruthy();
    expect(TOOLTIP_STYLE.color).toBeTruthy();
    expect(TOOLTIP_STYLE.border).toBeTruthy();
  });
});
