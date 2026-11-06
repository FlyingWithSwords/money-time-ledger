# OCR 语言包（不入库）

`chi_sim.traineddata.gz` 与 `eng.traineddata.gz` 由 `npm run fetch:tessdata` 下载到本目录。

- 默认 **tessdata_best** 档：`chi_sim` 约 11.4 MB、`eng` 约 12.2 MB（gzip 后）。
  best 的中文精度明显高于 fast，代价是体积与首次加载时间（首次约 15 秒，之后走浏览器缓存）。
- 体积敏感时用 `npm run fetch:tessdata -- --fast`：`chi_sim` 约 2 MB、`eng` 约 3 MB。
- 上游 best 仓库**只提供未压缩的 `.traineddata`**，脚本会下载后本地 gzip 成 `.traineddata.gz`
  （运行时保持 `gzip: true`，文件名规则不变）。别去猜 `*.traineddata.gz` 的上游地址——不存在。
- `eng` 是**推荐**而不是必需：缺失时导入页会显示「缺少 eng 语言包，英文可能识别不准」，
  功能仍可用（降级而不是失败）；`chi_sim` 缺失则完全不可用。
- 仓库里不提交这些文件（`.gitignore` 已排除），避免把几十 MB 二进制塞进版本库。
- 运行时 `src/import/ocrPack.ts` 会 HEAD 探测同源资产：
  缺失时给出明确提示并拒绝启动识别引擎，**不会静默失败，也不会退回第三方 CDN**（那会产生第三方请求）。
- 当前安装的档位记录在同目录的 `.pack.json`（本地文件，不入库），
  切换 best/fast 时脚本据此判断要不要重新下载。
