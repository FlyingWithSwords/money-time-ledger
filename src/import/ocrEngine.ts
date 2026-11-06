/**
 * 识别引擎实现（当前只有 tesseract）。
 *
 * 为什么单独一层：OCR 的参数（OEM / PSM / 语言组合）散落在业务代码里会失控，
 * 换成 PP-OCR 时要动的地方也会到处漏。这里只暴露 `OcrEngine`，
 * 引擎相关的参数全部收在这一层，UI 与解析器都只认接口。
 *
 * 注意：tesseract.js 只在这里被**动态** import，首屏 chunk 不含它。
 */
import type {
  OcrEngine,
  OcrLine,
  OcrMode,
  OcrProgressHandler,
  OcrRecognizeOptions,
  OcrResult,
} from './ocrTypes';

export const OCR_LANGS = ['chi_sim', 'eng'] as const;

/**
 * 首次加载参考耗时。best 语言包比 fast 大一个量级，
 * 冷启动（还要编译 wasm）确实要十几秒，UI 必须说清楚"首次约 N 秒"，
 * 否则用户会以为卡死。第二次起走 IndexedDB 缓存，通常 1–3 秒。
 */
export const FIRST_RUN_SECONDS = 15;

/** 引擎进度文案 */
const STATUS_LABELS: Record<string, string> = {
  'loading tesseract core': '加载识别内核（wasm）',
  'initializing tesseract': '初始化识别内核',
  'loading language traineddata': '加载中英文语言包',
  'initializing api': '初始化识别引擎',
  'recognizing text': '识别文字',
};

export function describeOcrStatus(status: string): string {
  return STATUS_LABELS[status] ?? '准备识别引擎';
}

export interface TesseractEngineConfig {
  /** 同源 engine worker 路径（必须显式给，否则回落 CDN） */
  workerPath: string;
  /** 同源 wasm 核心路径（必须显式给） */
  corePath: string;
  /** 同源语言包目录 */
  langPath: string;
  langs?: readonly string[];
  gzip?: boolean;
}

/** 只声明我们真正用到的 worker 方法，避免依赖 tesseract 类型声明的细节 */
interface WorkerLike {
  setParameters(params: Record<string, string>): Promise<unknown>;
  recognize(
    image: Blob,
    options?: Record<string, unknown>,
    output?: Record<string, boolean>,
  ): Promise<{ data: unknown }>;
  terminate(): Promise<unknown>;
}

/** tesseract.js 模块类型（只用于从动态 import 里取 PSM/OEM 常量） */
type TesseractModule = typeof import('tesseract.js');

interface RawBbox {
  x0?: number;
  y0?: number;
  x1?: number;
  y1?: number;
}

interface RawLine {
  text?: string | null;
  confidence?: number | null;
  bbox?: RawBbox | null;
}

interface RawParagraph {
  lines?: RawLine[] | null;
}

interface RawBlock {
  paragraphs?: RawParagraph[] | null;
}

interface RawPage {
  text?: string | null;
  confidence?: number | null;
  blocks?: RawBlock[] | null;
  lines?: RawLine[] | null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function toBbox(bbox: RawBbox | null | undefined): OcrLine['bbox'] | null {
  if (!bbox) return null;
  const x0 = Number(bbox.x0);
  const y0 = Number(bbox.y0);
  const x1 = Number(bbox.x1);
  const y1 = Number(bbox.y1);
  if (![x0, y0, x1, y1].every((value) => Number.isFinite(value))) return null;
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

/**
 * 把 tesseract 的 blocks → paragraphs → lines 摊平成带 bbox 的行。
 * 层级顺序就是阅读顺序（block/para/line 都是按版面排好的），不要重新排序。
 */
export function flattenOcrLines(page: RawPage): OcrLine[] {
  const lines: OcrLine[] = [];
  const pushLine = (line: RawLine): void => {
    const text = String(line.text ?? '').replace(/\s+$/, '');
    if (!text.trim()) return;
    const bbox = toBbox(line.bbox);
    if (!bbox) return;
    lines.push({
      text,
      confidence: Number.isFinite(Number(line.confidence)) ? Number(line.confidence) : 0,
      bbox,
    });
  };

  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) pushLine(line);
    }
  }
  // dump 目前只在 blocks 里给行；这里保留 page.lines 兜底（换版本/换引擎时不至于全空）
  if (lines.length === 0) {
    for (const line of page.lines ?? []) pushLine(line);
  }
  return lines;
}

function meanOf(lines: readonly OcrLine[]): number {
  if (lines.length === 0) return 0;
  const sum = lines.reduce((acc, line) => acc + line.confidence, 0);
  return Math.round((sum / lines.length) * 10) / 10;
}

function meanFromPage(page: RawPage, lines: readonly OcrLine[]): number {
  const value = Number(page.confidence);
  // MeanTextConf 是整图加权均值，比逐行平均更可信；拿不到（或为 0）才退回逐行
  if (Number.isFinite(value) && value > 0) return Math.round(Math.min(100, value) * 10) / 10;
  return meanOf(lines);
}

/**
 * 创建 tesseract 引擎。同一个实例复用同一个 worker（初始化极慢，不能每张图重来）。
 * 并发调用会串行化：worker 里的 PSM 参数是全局状态，并发改参数会互相污染。
 */
export function createTesseractEngine(config: TesseractEngineConfig): OcrEngine {
  const langs = config.langs && config.langs.length > 0 ? [...config.langs] : [...OCR_LANGS];
  let workerPromise: Promise<{ worker: WorkerLike; module: TesseractModule }> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;

  async function boot(onProgress?: OcrProgressHandler): Promise<{ worker: WorkerLike; module: TesseractModule }> {
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
      const module = await import('tesseract.js');
      const worker = (await module.createWorker(langs, module.OEM.LSTM_ONLY, {
        workerPath: config.workerPath,
        corePath: config.corePath,
        langPath: config.langPath,
        gzip: config.gzip ?? true,
        logger: (message: { status: string; progress: number }) => {
          onProgress?.({
            stage: 'engine',
            label: describeOcrStatus(message.status),
            progress: clamp01(message.progress),
          });
        },
        errorHandler: (error: unknown) => {
          // 只记录不抛出：worker 内部错误会通过 recognize 的 reject 传回来
          console.warn('[ocr] 识别引擎报错', error);
        },
      })) as unknown as WorkerLike;
      return { worker, module };
    })();
    try {
      return await workerPromise;
    } catch (error) {
      workerPromise = null;
      throw error;
    }
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  async function run(blob: Blob, options: OcrRecognizeOptions): Promise<OcrResult> {
    const { worker, module } = await boot(options.onProgress);
    const mode: OcrMode = options.mode ?? 'block';

    // PSM：整块文字用 6，多行多列的表格截图必须用 11（稀疏），
    // 用 6 去读表格会把相邻两列粘成一行，金额和商户名直接串味。
    // preserve_interword_spaces：不开的话「午饭 32.00」会变成「午饭32.00」，后处理正则更难切。
    await worker.setParameters({
      tessedit_pageseg_mode: String(mode === 'sparse' ? module.PSM.SPARSE_TEXT : module.PSM.SINGLE_BLOCK),
      preserve_interword_spaces: '1',
    });

    options.onProgress?.({ stage: 'recognize', label: '识别文字', progress: 0 });
    const { data } = await worker.recognize(
      blob,
      {},
      // hocr/tsv 对我们没用，开着只会让 worker 多传几 MB 字符串回来
      { text: true, blocks: true, hocr: false, tsv: false },
    );
    const page = (data ?? {}) as RawPage;
    const lines = flattenOcrLines(page);
    return {
      text: String(page.text ?? ''),
      lines,
      meanConfidence: meanFromPage(page, lines),
    };
  }

  return {
    id: 'tesseract',
    label: `本机识别引擎（${langs.join(' + ')}）`,
    recognize(blob: Blob, options: OcrRecognizeOptions = {}): Promise<OcrResult> {
      if (disposed) {
        return Promise.reject(new Error('识别引擎已释放，请重新发起识别'));
      }
      return enqueue(() => run(blob, options));
    },
    async dispose(): Promise<void> {
      disposed = true;
      const pending = workerPromise;
      workerPromise = null;
      if (!pending) return;
      try {
        const { worker } = await pending;
        await worker.terminate();
      } catch {
        // 释放失败不影响调用方：进程/页面卸载时浏览器会自己回收
      }
    },
  };
}
