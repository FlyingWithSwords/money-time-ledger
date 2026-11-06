# OCR 引擎资产（不入库，同源自托管）

`npm run fetch:tessdata` 会把两个文件从 `node_modules` 复制到本目录：

| 文件 | 来源 | 大约 |
| --- | --- | --- |
| `worker.min.js` | `node_modules/tesseract.js/dist/worker.min.js` | 120 KB |
| `tesseract-core-simd-lstm.wasm.js` | `node_modules/tesseract.js-core/`（wasm 已内嵌为单文件） | 4 MB |

语言包 `chi_sim.traineddata.gz` 在隔壁 `public/tessdata/`。

## 为什么必须自托管

tesseract.js v5 的 `workerPath` / `corePath` / `langPath` 默认全部指向一个公共 CDN
（第三方域名）。那会产生**第三个外部域名**（本项目只允许两个行情域名），
而且断网时 OCR 必然失败——离线可用是这个应用的卖点。

因此 `src/import/parsers/ocr.ts` 显式传入：

```ts
workerPath: '/tesseract/worker.min.js'
corePath:   '/tesseract/tesseract-core-simd-lstm.wasm.js'
langPath:   '/tessdata'
```

`worker.min.js` 内部还内嵌了两条 CDN 默认地址，那是死代码（我们总是显式传值），
`scripts/fetch-tessdata.mjs` 在复制时会一并改写成同源相对路径，
保证**产物层面也 grep 不到第三方域名**。

## 缺失时会发生什么

`src/import/ocrPack.ts` 会并发 HEAD 探测三个资产，缺任何一个都返回
「缺少 xxx：运行 npm run fetch:tessdata」，并**拒绝启动识别引擎**，
不会静默失败，也不会偷偷回退到 CDN。

这些文件不提交进 git（见 `.gitignore`），`dist/` 里由 PWA 的 `/tesseract/` 运行时缓存按需缓存，
不占首次安装的 precache。
