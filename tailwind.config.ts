import type { Config } from 'tailwindcss';

/**
 * 与 MUI 共存：必须关掉 preflight，否则 MUI 的按钮/输入基线样式被重置。
 * 深色模式走 class 策略（由 MUI 主题与 <html class="dark"> 同步）。
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      fontFamily: {
        numeric: ['"SF Mono"', 'ui-monospace', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        ink: '#0f1115',
        paper: '#f7f7f5',
      },
      spacing: {
        'safe-b': 'env(safe-area-inset-bottom, 0px)',
      },
    },
  },
  plugins: [],
};

export default config;
