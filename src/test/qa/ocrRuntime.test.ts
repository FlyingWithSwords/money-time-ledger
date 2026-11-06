import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QA-R2 OCR 隐私 + 参数：**运行时**验证（不是静态 grep）。
 *
 * 工程师的说法是"bundle 里的 CDN 是死默认值"。本文件不接受这个说法，而是把
 * tesseract.js mock 掉、记录 createWorker 实际收到的参数与探测实际打的 URL，
 * 证明覆盖真的生效。顺带把这次新增的三件事钉住：
 * - 语言必须是 chi_sim + eng（只加载中文会把英文商户名识别成乱码）；
 * - PSM 必须按场景切换（整块 6 / 表格 11），且 preserve_interword_spaces=1；
 * - 缺 eng 时是"降级可用 + 明确提示"，不是静默变差也不是整体失败。
 */

interface MockBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

let pageData: Record<string, unknown> = {};

const recognize = vi.fn(async () => ({ data: pageData }));
const setParameters = vi.fn(async (_params: Record<string, string>) => ({}));
const terminate = vi.fn(async () => ({}));
const createWorker = vi.fn(async () => ({ recognize, setParameters, terminate }));

vi.mock('tesseract.js', () => ({
  createWorker: (...args: unknown[]) => createWorker(...(args as [])),
  OEM: { LSTM_ONLY: 1 },
  PSM: { SINGLE_BLOCK: '6', SPARSE_TEXT: '11' },
}));

const fetchedUrls: string[] = [];
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  fetchedUrls.push(String(input));
  return { ok: true, status: 200 } as unknown as Response;
});

function pageWithLines(lines: Array<{ text: string; confidence: number; bbox: MockBbox }>, confidence: number) {
  return {
    text: lines.map((line) => line.text).join('\n'),
    confidence,
    blocks: [{ paragraphs: [{ lines }] }],
  };
}

describe('QA-R2 OCR 运行时验证', () => {
  beforeEach(() => {
    pageData = {};
    fetchedUrls.length = 0;
    vi.stubGlobal('fetch', fetchMock);
  });

  it('createWorker 收到的路径全部同源，语言为 chi_sim + eng', async () => {
    pageData = pageWithLines([{ text: '2026-11-04 午餐 32.00', confidence: 90, bbox: { x0: 0, y0: 0, x1: 100, y1: 20 } }], 90);
    const { recognizeImage } = await import('../../import/parsers/ocr');
    await recognizeImage(new Blob(['fake'], { type: 'image/png' }));

    expect(createWorker).toHaveBeenCalledTimes(1);
    const [langs, oem, options] = createWorker.mock.calls[0] as unknown as [
      string[],
      number,
      Record<string, unknown>,
    ];
    // 只加载 chi_sim 会把英文商户名识别成乱码，必须带上 eng
    expect(langs).toEqual(['chi_sim', 'eng']);
    expect(oem).toBe(1);

    const workerPath = String(options.workerPath ?? '');
    const corePath = String(options.corePath ?? '');
    const langPath = String(options.langPath ?? '');
    // 三个都必须显式给出（否则 tesseract.js 回落到第三方 CDN 默认值）
    expect(workerPath, 'workerPath 必须显式传入').not.toBe('');
    expect(corePath, 'corePath 必须显式传入').not.toBe('');
    expect(langPath, 'langPath 必须显式传入').not.toBe('');

    const origin = window.location.origin;
    for (const url of [workerPath, corePath, langPath]) {
      expect(url, `不得指向第三方 CDN: ${url}`).not.toMatch(/jsdelivr|unpkg|cdnjs|googleapis/);
      expect(new URL(url, document.baseURI).origin, `${url} 应同源`).toBe(origin);
    }
    expect(workerPath).toMatch(/\/tesseract\/worker\.min\.js$/);
    expect(corePath).toMatch(/\/tesseract\/tesseract-core-simd-lstm\.wasm\.js$/);
    expect(langPath).toMatch(/\/tessdata$/);
    expect(options.gzip).toBe(true);

    // 启动前必须探测两个语言包，缺哪个都要能说出来
    expect(fetchedUrls.some((url) => url.endsWith('/tessdata/chi_sim.traineddata.gz'))).toBe(true);
    expect(fetchedUrls.some((url) => url.endsWith('/tessdata/eng.traineddata.gz'))).toBe(true);
  });

  it('PSM 按场景切换：默认整块 6，表格截图 11；preserve_interword_spaces 恒为 1', async () => {
    const { recognizeImage, analyzeImage } = await import('../../import/parsers/ocr');
    await recognizeImage(new Blob(['x']));
    expect(setParameters).toHaveBeenLastCalledWith({
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
    });

    pageData = pageWithLines([{ text: '2026-11-04 A 10.00', confidence: 80, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }], 80);
    await analyzeImage(new Blob(['x']), { mode: 'sparse' });
    expect(setParameters).toHaveBeenLastCalledWith({
      tessedit_pageseg_mode: '11',
      preserve_interword_spaces: '1',
    });
    // 同一个 worker 复用，不能每张图重新初始化（best 模型初始化十几秒）
    expect(createWorker).toHaveBeenCalledTimes(1);
  });

  it('扫描结果带回 bbox / 行置信度 / 平均置信度，并对齐到表格行', async () => {
    pageData = pageWithLines(
      [
        { text: '2026-11-04 午餐 32.00', confidence: 91, bbox: { x0: 10, y0: 20, x1: 300, y1: 50 } },
        { text: '2026-11-04 星巴克 45.00', confidence: 51, bbox: { x0: 10, y0: 60, x1: 320, y1: 90 } },
      ],
      66.5,
    );
    const { analyzeImage } = await import('../../import/parsers/ocr');
    const analysis = await analyzeImage(new Blob(['x']));

    expect(analysis.rows).toHaveLength(2);
    expect(analysis.scan.meanConfidence).toBe(66.5);
    // 51 分那一行要标黄，整图均值 66.5 要报警
    expect(analysis.scan.quality.lowConfidenceIndexes).toEqual([1]);
    expect(analysis.scan.quality.warnOverall).toBe(true);
    expect(analysis.scan.rows[1]).toMatchObject({
      rowIndex: 2,
      lineIndex: 1,
      confidence: 51,
      bbox: { x0: 10, y0: 60, x1: 320, y1: 90 },
    });
    expect(analysis.scan.rows[0].rawText).toBe('2026-11-04 午餐 32.00');
    // jsdom 没有 canvas：预处理如实标记为跳过，预览退化成原图（bbox 仍按原图像素对齐）
    expect(analysis.scan.image.skipped).toBe(true);
  });
});

describe('OCR 语言包探测', () => {
  beforeEach(() => {
    fetchedUrls.length = 0;
    vi.stubGlobal('fetch', fetchMock);
  });

  it('探测 4 个同源资产，齐全时可用且不降级', async () => {
    const { checkLangPack } = await import('../../import/ocrPack');
    const info = await checkLangPack();
    expect(info.available).toBe(true);
    expect(info.degraded).toBe(false);
    expect(info.languages).toEqual(['chi_sim', 'eng']);
    expect(fetchedUrls).toHaveLength(4);
    for (const url of fetchedUrls) {
      expect(url).not.toMatch(/jsdelivr|unpkg|googleapis|eastmoney/);
      expect(new URL(url, document.baseURI).origin).toBe(window.location.origin);
    }
  });

  it('资产缺失时明确报缺哪一个，而不是静默回退 CDN', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response));
    const { checkLangPack } = await import('../../import/ocrPack');
    const info = await checkLangPack();
    expect(info.available).toBe(false);
    expect(info.missing.length).toBe(4);
    expect(info.hint).toContain('fetch:tessdata');
  });

  it('只缺 eng 时降级：仍可用，但明确提示英文可能识别不准', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const ok = !url.endsWith('/tessdata/eng.traineddata.gz');
        return { ok, status: ok ? 200 : 404 } as unknown as Response;
      }),
    );
    const { checkLangPack } = await import('../../import/ocrPack');
    const info = await checkLangPack();
    expect(info.available).toBe(true);
    expect(info.degraded).toBe(true);
    expect(info.missingOptional).toEqual(['eng']);
    expect(info.hint).toContain('eng');
    expect(info.hint).toContain('fetch:tessdata');
  });
});
