/**
 * 准备 OCR 的全部本地资产（三条硬约束的落地脚本）。
 *
 * 1. public/tesseract/worker.min.js                    ← 从 node_modules/tesseract.js/dist 复制
 * 2. public/tesseract/tesseract-core-simd-lstm.wasm.js ← 从 node_modules/tesseract.js-core 复制
 * 3. public/tessdata/chi_sim.traineddata.gz            ← tessdata_best（默认）
 * 4. public/tessdata/eng.traineddata.gz                ← tessdata_best（默认，中英混排必需）
 *
 * 为什么必须自托管：tesseract.js v5 的 `workerPath` 默认指向公共 CDN，
 * core 的 wasm 同样走 CDN。那会产生第三方域名请求（隐私红线只允许两个行情域名），
 * 且断网时 OCR 必然失败。所以运行时（src/import/parsers/ocr.ts）显式把
 * workerPath / corePath / langPath 全部指向同源，由本脚本把文件放到同源目录下。
 *
 * 为什么从 fast 换成 best：fast 档的 chi_sim 只有 2.4MB，精度明显低于 best。
 * 代价是体积（best chi_sim 12.5MB / eng 14.7MB）与首次加载时间，
 * 换来的是中文小字识别准确率提升——对"截图记账"这个场景值。
 * 需要小体积时用 `--fast`（chi_sim 2.4MB、eng 3.9MB）。
 *
 * 上游 best 仓库**只提供未压缩的 .traineddata**（没有 .gz，也没有 .gz 镜像），
 * 所以这里下载后本地 gzip 成 `*.traineddata.gz`，运行时保持 `gzip: true` 不变。
 * 别去猜一个 `tessdata_best/.../chi_sim.traineddata.gz` 的 URL —— 它不存在。
 *
 * 这些文件都不提交进仓库（.gitignore 已排除），缺失时运行时 HEAD 探测会给出明确提示，
 * 不会静默失败，也不会退回第三方 CDN。
 *
 * 用法：
 *   npm run fetch:tessdata            # 默认 best（精度优先）
 *   npm run fetch:tessdata -- --fast  # 全部 fast（体积优先，约 1/5）
 *   npm run fetch:tessdata -- --eng=fast   # 只把英文包降级成 fast
 */
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';

/** 上游仓库（tesseract-ocr 官方发布档，只放 .traineddata，没有 .gz） */
const UPSTREAM = {
  best: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_best/main',
  fast: 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main',
};
/** 镜像（同一份文件；只在 raw.githubusercontent 不通时兜底） */
const MIRROR = {
  best: 'https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_best@main',
  fast: 'https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main',
};

const VARIANT_LABEL = {
  best: 'best（精度优先，体积大、首次加载慢）',
  fast: 'fast（体积小、精度低）',
};

/**
 * minBytes 用来判断"文件是不是下坏了/被截断"。
 * 数值来自上游文件的真实大小（best chi_sim 13077423、best eng 15400601、
 * fast chi_sim 2469156、fast eng 4113088），取一半做下限，留出上游更新导致体积波动的余量。
 */
const LANG_SPECS = [
  { lang: 'chi_sim', variant: 'best', minBytes: 5 * 1024 * 1024, note: '中文（必需）' },
  { lang: 'eng', variant: 'best', minBytes: 5 * 1024 * 1024, note: '英文（中英混排必需，缺了会降级提示）' },
];

/** 引擎资产：核心只 LSTM（oem=1）+ SIMD，单文件内嵌 wasm，不额外请求 .wasm */
const ENGINE_ASSETS = [
  { from: 'node_modules/tesseract.js/dist/worker.min.js', to: 'public/tesseract/worker.min.js', minKb: 50, sanitize: true },
  {
    from: 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
    to: 'public/tesseract/tesseract-core-simd-lstm.wasm.js',
    minKb: 1000,
    sanitize: false,
  },
];

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const langDir = resolve(root, 'public', 'tessdata');
const engineDir = resolve(root, 'public', 'tesseract');
/** 记录"当前装的是哪一档"，避免 best 与 fast 混装后无法判断 */
const MARKER_FILE = resolve(langDir, '.pack.json');

async function sizeOf(path) {
  try {
    const info = await stat(path);
    return info.size;
  } catch {
    return 0;
  }
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function parseArgs(argv) {
  const override = { chi_sim: null, eng: null };
  let forceFast = false;
  for (const arg of argv) {
    if (arg === '--fast') forceFast = true;
    const match = /^--(chi_sim|eng)=(best|fast)$/.exec(arg);
    if (match) override[match[1]] = match[2];
  }
  return { forceFast, override };
}

/**
 * worker.min.js 里内嵌了两条"默认地址"（corePath / langPath），指向公共 CDN。
 * 运行时我们总是显式传 corePath / langPath，这两条是**死代码**；
 * 但"产物里不得出现第三方域名"是可验收的红线，这里把它们改写成同源相对路径。
 */
async function sanitizeWorker(target) {
  const text = await readFile(target, 'utf8');
  if (!/cdn\.jsdelivr\.net|unpkg\.com/.test(text)) return false;
  let cleaned = text
    .split('"https://cdn.jsdelivr.net/npm/tesseract.js-core@v"')
    .join('"./"')
    .split('"https://cdn.jsdelivr.net/npm/@tesseract.js-data/"')
    .join('"./"')
    // 兜底：任何零散残留
    .replace(/https:\/\/cdn\.jsdelivr\.net\/[^"'\s)]*/g, './')
    .replace(/https:\/\/unpkg\.com\/[^"'\s)]*/g, './');
  await writeFile(target, cleaned, 'utf8');
  return true;
}

async function prepareEngine() {
  await mkdir(engineDir, { recursive: true });
  for (const asset of ENGINE_ASSETS) {
    const source = resolve(root, asset.from);
    const target = resolve(root, asset.to);
    const existing = await sizeOf(target);
    if (existing > asset.minKb * 1024) {
      if (asset.sanitize && (await sanitizeWorker(target))) {
        console.log(`[ocr] 引擎已就位并清理 CDN 默认值：${asset.to}`);
      } else {
        console.log(`[ocr] 引擎已就位：${asset.to}（${mb(existing)}）`);
      }
      continue;
    }
    const sourceSize = await sizeOf(source);
    if (sourceSize === 0) {
      throw new Error(`找不到 ${asset.from}：请先 npm install（tesseract.js / tesseract.js-core 随依赖安装）`);
    }
    await copyFile(source, target);
    if (asset.sanitize) await sanitizeWorker(target);
    console.log(`[ocr] 已复制引擎资产：${asset.to}（${mb(sourceSize)}）`);
  }
}

async function readMarker() {
  try {
    const raw = await readFile(MARKER_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 下载 → 本地 gzip → *.traineddata.gz。只落最终文件，失败就清掉半成品 */
async function downloadAsGzip(url, target) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const partial = `${target}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), createGzip({ level: 9 }), createWriteStream(partial));
    const size = await sizeOf(partial);
    if (size === 0) throw new Error('下载内容为空');
    await copyFile(partial, target);
    return size;
  } finally {
    await unlink(partial).catch(() => {});
  }
}

async function prepareLanguage(spec, variant) {
  await mkdir(langDir, { recursive: true });
  const target = resolve(langDir, `${spec.lang}.traineddata.gz`);
  const marker = await readMarker();
  const existing = await sizeOf(target);
  const installedVariant = marker[spec.lang]?.variant ?? null;

  if (existing > spec.minBytes && installedVariant === variant) {
    console.log(`[ocr] ${spec.lang} 已就位（${variant}，${mb(existing)}），跳过`);
    return { lang: spec.lang, variant, bytes: existing, skipped: true };
  }
  if (existing > 0 && installedVariant === null) {
    console.log(`[ocr] ${spec.lang} 存在旧文件（${mb(existing)}）但来源未知，按 ${variant} 重新下载以保证版本一致`);
  }

  const attempts = [
    `${UPSTREAM[variant]}/${spec.lang}.traineddata`,
    `${MIRROR[variant]}/${spec.lang}.traineddata`,
  ];
  let lastError = null;
  for (const url of attempts) {
    try {
      console.log(`[ocr] 下载 ${spec.lang}（${VARIANT_LABEL[variant]}）：${url}`);
      const started = Date.now();
      const bytes = await downloadAsGzip(url, target);
      if (bytes < spec.minBytes) throw new Error(`压缩后只有 ${mb(bytes)}，可能不是有效的识别包`);
      console.log(`[ocr] ${spec.lang} 完成：${mb(bytes)}（${((Date.now() - started) / 1000).toFixed(1)}s）`);
      return { lang: spec.lang, variant, bytes, skipped: false };
    } catch (error) {
      lastError = error;
      console.warn(`[ocr] ${spec.lang} 下载失败：${error instanceof Error ? error.message : String(error)}`);
      await unlink(target).catch(() => {});
    }
  }
  throw lastError ?? new Error(`${spec.lang} 下载失败`);
}

async function main() {
  const { forceFast, override } = parseArgs(process.argv.slice(2));
  await prepareEngine();

  const marker = await readMarker();
  const results = [];
  let failed = false;
  for (const spec of LANG_SPECS) {
    const variant = override[spec.lang] ?? (forceFast ? 'fast' : spec.variant);
    try {
      const result = await prepareLanguage(spec, variant);
      results.push({ ...result, note: spec.note });
      marker[spec.lang] = { variant, bytes: result.bytes, updatedAt: new Date().toISOString() };
    } catch (error) {
      failed = true;
      console.error(`[ocr] ${spec.lang} 准备失败：请手动把 ${spec.lang}.traineddata 放到 public/tessdata/ 并 gzip 成 ${spec.lang}.traineddata.gz`);
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
  await writeFile(MARKER_FILE, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');

  const total = results.reduce((acc, item) => acc + item.bytes, 0);
  console.log('[ocr] 语言包汇总：');
  for (const item of results) {
    console.log(`  - ${item.lang.padEnd(8)} ${item.variant.padEnd(4)} ${mb(item.bytes).padStart(8)}  ${item.note}`);
  }
  console.log(`[ocr] 合计 ${mb(total)}；gzip 后由 Service Worker 缓存，第二次起不再下载。`);

  const files = await readdir(engineDir).catch(() => []);
  console.log(`[ocr] public/tesseract/ 现有 ${files.length} 个文件；该目录与 tessdata 都不提交进 git。`);
  if (failed) process.exitCode = 1;
}

await main();
