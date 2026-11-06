import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';
import type { Plugin } from 'vite';

/**
 * 把第三方 CDN 域名从产物里抹掉。
 *
 * tesseract.js 把三个默认地址编译进了自己的 bundle（workerPath / corePath / langPath），
 * 全部指向 cdn.jsdelivr.net。我们在 `src/import/parsers/ocr.ts` 里已经把三条路径
 * 显式覆盖成同源，那三个字符串是**死默认值**，运行时永远不会被读取。
 * 但"构建产物里不得出现第三方域名"是可验收的红线（客户 R1 / 离线可用 R3），
 * 所以这里在出包时把它们替换成同源路径：产物干净，语义不变。
 */
function stripThirdPartyCdn(): Plugin {
  return {
    name: 'strip-third-party-cdn',
    apply: 'build',
    enforce: 'post',
    renderChunk(code) {
      if (!/jsdelivr|unpkg/.test(code)) return null;
      const replaced = code
        // 先长后短：tesseract.js-core 的默认地址也以 "tesseract.js" 开头
        .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/tesseract\.js-core@[^`"']*/g, './tesseract/tesseract-core-simd-lstm.wasm.js')
        .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/@tesseract\.js-data\/[^`"']*/g, './tessdata')
        .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/tesseract\.js@[^`"']*/g, './tesseract/worker.min.js')
        .replace(/https:\/\/cdn\.jsdelivr\.net\/[^`"']*/g, './tesseract/')
        .replace(/https:\/\/unpkg\.com\/[^`"']*/g, './tesseract/');
      return { code: replaced, map: null };
    },
  };
}

/**
 * 构建配置。
 * - PWA：应用壳 precache；基金行情 network-first 短 TTL；OCR 语言包 cache-first。
 * - 拆包：xlsx / tesseract / recharts 全部只在业务需要时动态 import，首屏不含。
 */
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icons/icon.svg'],
      manifest: {
        name: '快记账',
        short_name: '快记账',
        description: '把每笔支出换算成还要工作多久。数据只存本机，无账号、无上传。',
        lang: 'zh-CN',
        start_url: './index.html',
        scope: './',
        display: 'standalone',
        background_color: '#0f1115',
        theme_color: '#0f1115',
        orientation: 'portrait',
        icons: [
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        // OCR 引擎与语言包动辄几 MB：不进安装期 precache，改由下面的运行时缓存按需取
        globIgnores: ['**/tesseract/**', '**/tessdata/**'],
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            // 基金净值脚本：只允许这一个行情域名，且 URL 只含 6 位代码
            urlPattern: /^https:\/\/fund\.eastmoney\.com\/pingzhongdata\/.*/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'fund-quotes',
              networkTimeoutSeconds: 8,
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/push2\.eastmoney\.com\/api\/qt\/stock\/get.*/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'fund-push2',
              networkTimeoutSeconds: 8,
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 6 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // OCR 语言包：同源自托管，首次下载后离线可识别
            urlPattern: /\/tessdata\/.*\.(gz|traineddata)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tessdata',
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // OCR 引擎（worker + wasm 核心）：同样是同源静态文件，取一次就离线可用
            urlPattern: /\/tesseract\/.*\.(js|wasm)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tesseract-engine',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
    stripThirdPartyCdn(),
  ],
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.replace(/\\/g, '/');
          if (!path.includes('/node_modules/')) return undefined;
          // 只把「首屏必需」的框架层归组；recharts / xlsx / tesseract / papaparse
          // 交给 Rollup 跟着动态 import 自动成块（手动拆反而会成环，把图表拉回首屏）
          if (
            path.includes('/node_modules/react/') ||
            path.includes('/node_modules/react-dom/') ||
            path.includes('/node_modules/scheduler/') ||
            path.includes('/node_modules/react-router') ||
            path.includes('/node_modules/@mui/') ||
            path.includes('/node_modules/@emotion/') ||
            path.includes('/node_modules/dexie') ||
            path.includes('/node_modules/dayjs/') ||
            path.includes('/node_modules/zustand/') ||
            path.includes('/node_modules/nanoid/')
          ) {
            return 'vendor';
          }
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/test/**/*.test.ts', 'src/test/**/*.test.tsx'],
    css: false,
    // 用例里每个文件都独立开一个 fake-indexeddb，并行 worker 会争抢系统临时目录
    // （Windows 沙箱下表现为 EPERM，个别文件被静默丢弃）。串行执行保证「跑了几条 = 报了几条」。
    fileParallelism: false,
  },
});
