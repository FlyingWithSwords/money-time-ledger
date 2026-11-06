/**
 * OCR 资产的同源地址与就位探测（**不引入 tesseract**）。
 * 单独成模块，是为了让导入页可以「提示识别包是否就位」而不把 OCR 引擎拉进首屏 chunk。
 *
 * 三条硬约束的落点：
 * - tesseract.js v5 的 workerPath / corePath 默认指向第三方 CDN；
 *   这里一律返回**同源**路径，由 scripts/fetch-tessdata.mjs 把文件铺到 public/ 下；
 * - 只允许请求自己部署的静态文件，任何情况下都不回退第三方 CDN；
 * - 文件缺失时明确报缺哪一个，而不是扔一个看不懂的 worker 报错。
 *
 * 多语言：中文账单里 ¥、数字、英文商户名（STARBUCKS / Luckin）很常见，
 * 只加载 chi_sim 会把英文识别成乱码。所以要求 chi_sim + eng 两个包：
 * - chi_sim 缺失 → 完全不可用；
 * - eng 缺失 → 可用但**降级**，UI 必须提示"英文可能识别不准"，不能静默。
 */

/** 必需语言包：缺了就无法识别 */
export const OCR_REQUIRED_LANGS = ['chi_sim'] as const;
/** 推荐语言包：缺了仍能跑，但中英混排会明显变差 */
export const OCR_RECOMMENDED_LANGS = ['eng'] as const;
/** 引擎实际加载的语言顺序（chi_sim 在前，主语言优先参与语言模型） */
export const OCR_LANGS: readonly string[] = [...OCR_REQUIRED_LANGS, ...OCR_RECOMMENDED_LANGS];

export interface OcrPackInfo {
  available: boolean;
  url: string;
  hint: string;
  /** 缺失的资产（用于提示"还差什么"），全部就位时为空数组 */
  missing: string[];
  /** 必需包齐了、但推荐包缺失：功能可用但质量下降 */
  degraded: boolean;
  /** 缺失的推荐包（目前只有 eng） */
  missingOptional: string[];
  /** 已就位的语言代码 */
  languages: string[];
}

function sameOrigin(relativePath: string): string {
  const base = import.meta.env.BASE_URL ?? '/';
  return new URL(`${base}${relativePath}`, document.baseURI).href;
}

/** 语言包目录（同源） */
export function tessdataBaseUrl(): string {
  return sameOrigin('tessdata').replace(/\/$/, '');
}

/** 引擎资产目录（同源）：worker.min.js 与 core wasm 都在这里 */
export function ocrEngineBaseUrl(): string {
  return sameOrigin('tesseract').replace(/\/$/, '');
}

export function ocrWorkerPath(): string {
  return `${ocrEngineBaseUrl()}/worker.min.js`;
}

export function ocrCorePath(): string {
  return `${ocrEngineBaseUrl()}/tesseract-core-simd-lstm.wasm.js`;
}

/**
 * 语言包地址。运行时一律以 `.traineddata.gz` 命名（gzip: true），
 * 即使上游 best 仓库只提供未压缩的 .traineddata，也由 fetch 脚本本地压缩成 .gz，
 * 这样"换模型"不影响运行时逻辑，只改下载源。
 */
export function ocrLangUrl(lang: string): string {
  return `${tessdataBaseUrl()}/${lang}.traineddata.gz`;
}

/** 兼容旧调用点：中文包地址 */
export function ocrLangPath(): string {
  return ocrLangUrl('chi_sim');
}

interface AssetProbe {
  label: string;
  url: string;
  lang?: string;
  required: boolean;
}

/** 延迟到调用时再拼地址：模块加载阶段不碰 document（便于在 node 环境里静态审阅） */
function assets(): AssetProbe[] {
  return [
    { label: '识别引擎 worker.min.js', url: ocrWorkerPath(), required: true },
    { label: '识别引擎 wasm 核心', url: ocrCorePath(), required: true },
    { label: '中文语言包 chi_sim（best 约 5MB）', url: ocrLangUrl('chi_sim'), lang: 'chi_sim', required: true },
    { label: '英文语言包 eng（best 约 7MB）', url: ocrLangUrl('eng'), lang: 'eng', required: false },
  ];
}

const PACK_COMMAND = '运行 npm run fetch:tessdata（只存本机，之后离线可用）';

async function probe(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

/** 同源 HEAD 探测，不发任何数据；缺失时给出可执行提示。 */
export async function checkLangPack(): Promise<OcrPackInfo> {
  const probes = assets();
  const url = ocrLangUrl('chi_sim');
  if (typeof fetch !== 'function') {
    return {
      available: false,
      url,
      hint: '当前环境不支持 fetch，无法加载识别包',
      missing: probes.map((asset) => asset.label),
      degraded: false,
      missingOptional: [],
      languages: [],
    };
  }
  const results = await Promise.all(probes.map((asset) => probe(asset.url)));
  const missingProbes = probes.filter((_, index) => !results[index]);
  const missing = missingProbes.map((asset) => asset.label);
  const missingLangs = missingProbes.map((asset) => asset.lang).filter((lang): lang is string => Boolean(lang));
  const missingRequired = missingProbes.filter((asset) => asset.required);
  const languages = probes
    .filter((asset, index) => asset.lang && results[index])
    .map((asset) => String(asset.lang));

  if (missingRequired.length > 0) {
    return {
      available: false,
      url,
      hint: `缺少 ${missingRequired.map((asset) => asset.label).join('、')}：${PACK_COMMAND}`,
      missing,
      degraded: false,
      missingOptional: missingLangs.filter((lang) => lang !== 'chi_sim'),
      languages,
    };
  }

  if (missingLangs.includes('eng')) {
    return {
      available: true,
      url,
      // 明确说"英文可能不准"，而不是假装一切正常：中英混排的账单会因此漏行
      hint: `缺少 eng 语言包，英文商户名与金额可能识别不准：${PACK_COMMAND}`,
      missing,
      degraded: true,
      missingOptional: ['eng'],
      languages,
    };
  }

  return {
    available: true,
    url,
    hint: '识别包已就位（中文 + 英文），断网也能识别',
    missing,
    degraded: false,
    missingOptional: [],
    languages,
  };
}
