import { useTheme } from '@mui/material/styles';
import type { CSSProperties } from 'react';

/**
 * 图表语义色板。
 *
 * 语义不随主题漂移：green=收入/正向、red=支出/负向、orange=提醒、
 * blue/purple=中性序列、gray=参考线。深色版只把这些颜色**提亮**（不改含义），
 * 使它们在 #171a20 纸面上仍有足够对比度；浅色版沿用产品既定的中等偏暗色。
 * 两套色板用同一个 Record 类型约束，键集合在编译期即保证一致。
 */
export type ChartColorKey = 'green' | 'blue' | 'orange' | 'purple' | 'red' | 'gray';

/** 图表主题模式（与 MUI palette.mode 对齐）。 */
export type ChartMode = 'light' | 'dark';

/** 语义色板：每个键都必须存在，浅深两套结构一致。 */
export type ChartPalette = Readonly<Record<ChartColorKey, string>>;

/** 浅色语义色板（保留历史导出名，外部引用不会断）。 */
export const CHART_COLORS: ChartPalette = {
  green: '#2f7d4f',
  blue: '#3f8fbf',
  orange: '#c98a2e',
  purple: '#8a5fbf',
  red: '#b85450',
  gray: '#9aa0a6',
};

/** 深色语义色板：在 #171a20 上把亮度提到浅色版的 2～3 倍。 */
export const CHART_COLORS_DARK: ChartPalette = {
  green: '#6fd39a',
  blue: '#6fb6e8',
  orange: '#f5b25e',
  purple: '#c39aef',
  red: '#f08b84',
  gray: '#b8bec6',
};

/** 按模式取语义色板。纯函数，可在非 React 环境调用。 */
export function chartPalette(mode: ChartMode): ChartPalette {
  return mode === 'dark' ? CHART_COLORS_DARK : CHART_COLORS;
}

/**
 * 分类环形图用的多色序列（最多 10 类）。
 * 与语义色板分开：这里追求的是「相邻扇区可区分」，而语义色板追求「颜色=含义」。
 * 深色版逐一提亮，浅色版完全沿用旧 COLORS 数组，保证浅色下视觉不变。
 */
export const CHART_SERIES_COLORS: readonly string[] = [
  '#2f7d4f', '#3f8fbf', '#c98a2e', '#8a5fbf', '#b85450',
  '#4f9d8a', '#8a8f3f', '#bf6f9a', '#5f7fa8', '#7a7a7a',
];

/** 深色分类序列（逐位对应 CHART_SERIES_COLORS）。 */
export const CHART_SERIES_COLORS_DARK: readonly string[] = [
  '#6fd39a', '#6fb6e8', '#f5b25e', '#c39aef', '#f08b84',
  '#6fd6bd', '#c2c96a', '#f0a0cd', '#8fb4de', '#b8bec6',
];

/** 按模式取分类序列。 */
export function chartSeriesPalette(mode: ChartMode): readonly string[] {
  return mode === 'dark' ? CHART_SERIES_COLORS_DARK : CHART_SERIES_COLORS;
}

/**
 * Y 轴紧凑刻度（单位：元）。
 * 超过 1 万元走「万」，否则保留到整元 —— 轴宽只有 50px 左右，
 * '12,340.00' 会把 tick 撑爆并压到绘图区上。
 */
export function compactYuan(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 10000) {
    const wan = abs / 10000;
    // 1 万～10 万留 1 位小数（1.2万），10 万以上取整（12万）避免刻度过长
    return `${sign}${wan >= 10 ? Math.round(wan).toString() : wan.toFixed(1).replace(/\.0$/, '')}万`;
  }
  if (abs >= 100) return `${sign}${Math.round(abs).toString()}`;
  return `${sign}${Number(abs.toFixed(1)).toString()}`;
}

/** buildChartTheme 的输入：MUI palette 的最小子集，便于测试直接喂字面量。 */
export interface ChartPaletteInputs {
  text: { primary: string; secondary: string };
  background: { paper: string };
  divider: string;
}

/** 一套完整的图表样式取值，供所有图表组件消费。 */
export interface ChartTheme {
  /** 语义色（绿/红/橙/蓝/紫/灰），随模式切换。 */
  colors: ChartPalette;
  /** 分类扇区/多序列配色，随模式切换。 */
  series: readonly string[];
  axis: {
    tick: { fill: string; fontSize: number };
    stroke: string;
  };
  grid: { stroke: string };
  tooltip: {
    contentStyle: CSSProperties;
    labelStyle: CSSProperties;
    itemStyle: CSSProperties;
  };
  legend: { wrapperStyle: CSSProperties };
}

/**
 * 纯函数版主题构造器：给定模式 + MUI 调色板取值，产出整套图表样式。
 * 不依赖 React，测试/SSR/工具函数可直接调用；useChartTheme 内部也走这里。
 */
export function buildChartTheme(mode: ChartMode, palette: ChartPaletteInputs): ChartTheme {
  const primary: string = palette.text.primary;
  const secondary: string = palette.text.secondary;
  const border: string = `1px solid ${palette.divider}`;
  const shadow: string =
    mode === 'dark' ? '0 4px 18px rgba(0, 0, 0, 0.55)' : '0 4px 18px rgba(0, 0, 0, 0.12)';

  const contentStyle: CSSProperties = {
    backgroundColor: palette.background.paper,
    color: primary,
    border,
    borderRadius: 10,
    fontSize: 12,
    boxShadow: shadow,
  };
  const labelStyle: CSSProperties = { color: primary, fontSize: 12 };
  const itemStyle: CSSProperties = { color: primary, fontSize: 12 };
  const wrapperStyle: CSSProperties = { color: secondary, fontSize: 12 };

  return {
    colors: chartPalette(mode),
    series: chartSeriesPalette(mode),
    axis: {
      tick: { fill: secondary, fontSize: 11 },
      stroke: palette.divider,
    },
    // 组件里的 CartesianGrid 自带 opacity=0.25，所以这里给**实色**文字次级色；
    // 直接用半透明 divider 再乘 0.25 会几乎看不见。
    grid: { stroke: secondary },
    tooltip: { contentStyle, labelStyle, itemStyle },
    legend: { wrapperStyle },
  };
}

/**
 * React hook：从 MUI ThemeProvider 读取当前模式与配色，生成图表主题。
 * 只能在函数组件（或自定义 hook）顶层调用，不能在模块顶层或普通工具函数里调用。
 * 无 ThemeProvider 时 MUI 返回默认浅色主题，不会抛错。
 */
export function useChartTheme(): ChartTheme {
  const theme = useTheme();
  const mode: ChartMode = theme.palette.mode === 'dark' ? 'dark' : 'light';
  return buildChartTheme(mode, theme.palette);
}

/** 与 buildTheme('light') 一致的默认调色板，用于生成兼容导出 TOOLTIP_STYLE。 */
const LIGHT_DEFAULT_PALETTE: ChartPaletteInputs = {
  text: { primary: '#1a1c1f', secondary: '#5f6368' },
  background: { paper: '#ffffff' },
  divider: 'rgba(0, 0, 0, 0.08)',
};

/**
 * 图表统一的 tooltip 容器样式（保留历史导出名，避免破坏外部引用）。
 * 现在由 buildChartTheme 生成，因此也带上了背景色/文字色/边框；
 * 组件内部一律改用 useChartTheme().tooltip.contentStyle 以跟随深浅色。
 */
export const TOOLTIP_STYLE: CSSProperties = buildChartTheme(
  'light',
  LIGHT_DEFAULT_PALETTE,
).tooltip.contentStyle;
