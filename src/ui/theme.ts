import { createTheme, type Theme } from '@mui/material/styles';

/** 深色模式必须支持（用户深夜记账，与 M2 深夜规则呼应）。金额字号最大的原则在组件里用 sx 落地。 */
export function buildTheme(mode: 'light' | 'dark'): Theme {
  const isDark = mode === 'dark';
  return createTheme({
    palette: {
      mode,
      primary: { main: isDark ? '#7bd0a8' : '#1f7a5a', contrastText: isDark ? '#0f1115' : '#ffffff' },
      secondary: { main: isDark ? '#f0b25e' : '#9a5b00' },
      success: { main: isDark ? '#5fbf85' : '#2f7d4f' },
      warning: { main: isDark ? '#f0b25e' : '#a35a00' },
      error: { main: isDark ? '#ef8a86' : '#b3261e' },
      background: {
        default: isDark ? '#0f1115' : '#f7f7f5',
        paper: isDark ? '#171a20' : '#ffffff',
      },
      text: {
        primary: isDark ? '#e8eaed' : '#1a1c1f',
        secondary: isDark ? '#9aa0a6' : '#5f6368',
      },
      divider: isDark ? 'rgba(232,234,237,0.12)' : 'rgba(0,0,0,0.08)',
    },
    shape: { borderRadius: 14 },
    typography: {
      fontFamily:
        'system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
      button: { textTransform: 'none', fontWeight: 600 },
      h6: { fontWeight: 700 },
      subtitle2: { fontWeight: 600 },
    },
    components: {
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
      MuiButton: { defaultProps: { disableElevation: true } },
      MuiChip: { styleOverrides: { root: { fontWeight: 600 } } },
      MuiListItemButton: { styleOverrides: { root: { borderRadius: 10 } } },
      MuiInputBase: {
        styleOverrides: {
          // iOS Safari 聚焦 <16px 的输入框会整页自动放大；MUI 的 sizeSmall 默认约 14px。
          // index.css 的元素选择器优先级低于 emotion class，覆盖不住，必须在这里改。
          // 只在粗指针（触屏）设备生效，桌面保持紧凑排版。
          sizeSmall: {
            '@media (pointer: coarse)': { fontSize: 16 },
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          // 触屏上 small IconButton 只有约 34px，低于 44px 的最小触控目标，容易误触。
          // 24px 图标 + 10px×2 padding = 44px。
          sizeSmall: {
            '@media (pointer: coarse)': { padding: 10 },
          },
        },
      },
    },
  });
}

/** 金额展示：超大字号，等宽数字，不换行。 */
export const moneySx = {
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 700,
  letterSpacing: '-0.02em',
} as const;
