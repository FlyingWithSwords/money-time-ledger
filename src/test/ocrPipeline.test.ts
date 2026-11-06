import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recognizeLongImage, type LongOcrProgress } from '../import/ocrPipeline';
import { planTiles } from '../import/ocrTiles';
import { decodeImage, preprocessImage, sliceImage, type SlicedTile } from '../import/ocrPreprocess';
import { recognizeImage } from '../import/parsers/ocr';
import type { OcrLine, OcrResult } from '../import/ocrTypes';

/**
 * 长截图 OCR 编排测试（mock 引擎与 canvas 层）。
 *
 * 为什么 mock：jsdom 没有 canvas/wasm，真实链路跑不起来；而这一层要锁的
 * 恰恰是**编排契约**——分了几片、每片喂给引擎的是什么、合并后的坐标是否
 * 回到了原图坐标系。坐标换算（bbox / scaled + offsetY）是整个方案里最
 * 容易错的一步，必须用具体数字钉死。
 *
 * 注意：vitest 用 esbuild 剥类型，绿不代表 tsc 绿——两边的断言都要过。
 */
vi.mock('../import/ocrPreprocess', () => ({
  decodeImage: vi.fn(),
  preprocessImage: vi.fn(),
  sliceImage: vi.fn(),
}));
vi.mock('../import/parsers/ocr', () => ({
  recognizeImage: vi.fn(),
}));

const mockedDecode = vi.mocked(decodeImage);
const mockedPreprocess = vi.mocked(preprocessImage);
const mockedSlice = vi.mocked(sliceImage);
const mockedRecognize = vi.mocked(recognizeImage);

function makeLine(text: string, confidence: number, y0: number, y1: number): OcrLine {
  return { text, confidence, bbox: { x0: 10, y0, x1: 500, y1 } };
}

function makeBlob(tag: string): Blob {
  return new Blob([tag], { type: 'image/png' });
}

function mockDecodeAs(width: number, height: number): void {
  mockedDecode.mockResolvedValue({
    source: {} as CanvasImageSource,
    width,
    height,
    release: vi.fn(),
  });
}

/** 按真实 planTiles 的规划造一批切片（sliceImage 的 mock 返回值） */
function makeTiles(width: number, height: number): SlicedTile[] {
  return planTiles(width, height).map((piece) => ({
    index: piece.index,
    offsetY: piece.offsetY,
    blob: makeBlob(`tile-${piece.index}`),
    width,
    height: piece.height,
  }));
}

function makeOcrResult(text: string, lines: OcrLine[]): OcrResult {
  const meanConfidence =
    lines.length === 0 ? 0 : lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length;
  return { text, lines, meanConfidence };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recognizeLongImage 编排', () => {
  it('非长图：tileCount=1，识别路径与单片完全一致，bbox 不偏移', async () => {
    const source = makeBlob('whole');
    mockDecodeAs(1080, 2200);
    const preBlob = makeBlob('preprocessed');
    mockedPreprocess.mockResolvedValue({
      blob: preBlob,
      width: 1080,
      height: 2200,
      scaled: 1,
      originalWidth: 1080,
      originalHeight: 2200,
      skipped: false,
    });
    const lines = [makeLine('华夏成长混合 000051', 91, 100, 130)];
    mockedRecognize.mockResolvedValue(makeOcrResult('华夏成长混合 000051', lines));

    const result = await recognizeLongImage(source, { mode: 'sparse' });

    expect(result.tileCount).toBe(1);
    // 单片不切图：直接用原图 blob 预处理，保证与旧路径零差异
    expect(mockedSlice).not.toHaveBeenCalled();
    expect(mockedPreprocess).toHaveBeenCalledTimes(1);
    expect(mockedPreprocess).toHaveBeenCalledWith(source);
    // 喂引擎的是预处理后的图，模式透传
    expect(mockedRecognize).toHaveBeenCalledTimes(1);
    expect(mockedRecognize).toHaveBeenCalledWith(preBlob, undefined, 'sparse');
    // scaled=1 → bbox 原样返回，不引入任何偏移
    expect(result.lines).toEqual(lines);
    expect(result.width).toBe(1080);
    expect(result.height).toBe(2200);
    expect(result.meanConfidence).toBe(91);
  });

  it('长图：按 planTiles 分片逐段识别，合并后行 y 单调递增且落在原图坐标', async () => {
    const width = 1080;
    const height = 13000;
    mockDecodeAs(width, height);
    const tiles = makeTiles(width, height);
    expect(tiles.length).toBeGreaterThan(1);
    mockedSlice.mockResolvedValue(tiles);
    mockedPreprocess.mockImplementation(async (blob: Blob) => {
      const tile = tiles.find((candidate) => candidate.blob === blob);
      if (!tile) throw new Error('未知的切片 blob');
      return {
        blob,
        width,
        height: tile.height,
        scaled: 1,
        originalWidth: width,
        originalHeight: tile.height,
        skipped: false,
      };
    });
    mockedRecognize.mockImplementation(async (blob: Blob) => {
      const tile = tiles.find((candidate) => candidate.blob === blob);
      if (!tile) throw new Error('未知的切片 blob');
      // 每片认一行，行在片内坐标 y0=100
      return makeOcrResult(`行${tile.index}`, [makeLine(`行${tile.index}`, 80, 100, 130)]);
    });

    const result = await recognizeLongImage(makeBlob('long'), { mode: 'sparse' });

    expect(result.tileCount).toBe(tiles.length);
    expect(mockedSlice).toHaveBeenCalledTimes(1);
    expect(mockedRecognize).toHaveBeenCalledTimes(tiles.length);
    expect(result.lines).toHaveLength(tiles.length);
    // y0 = 片内 y0 + offsetY：既不是片坐标（100），也不是漏加 offsetY 的裸值
    for (let i = 0; i < tiles.length; i += 1) {
      expect(result.lines[i].bbox.y0).toBe(100 + tiles[i].offsetY);
    }
    // 合并后按 y0 升序
    const ys = result.lines.map((line) => line.bbox.y0);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it('每片缩放换算：scaled=2 的片，bbox 先除以 2 再加 offsetY 回到原图坐标', async () => {
    const width = 1000;
    const height = 5000;
    mockDecodeAs(width, height);
    const tiles = makeTiles(width, height);
    mockedSlice.mockResolvedValue(tiles);
    mockedPreprocess.mockImplementation(async (blob: Blob) => {
      const tile = tiles.find((candidate) => candidate.blob === blob);
      if (!tile) throw new Error('未知的切片 blob');
      // 片 0 不缩放，其余片被 preprocessImage 放大 2 倍（模拟 750px 宽的截图）
      const scaled = tile.index === 0 ? 1 : 2;
      return {
        blob,
        width: width * scaled,
        height: tile.height * scaled,
        scaled,
        originalWidth: width,
        originalHeight: tile.height,
        skipped: false,
      };
    });
    mockedRecognize.mockImplementation(async (blob: Blob) => {
      const tile = tiles.find((candidate) => candidate.blob === blob);
      if (!tile) throw new Error('未知的切片 blob');
      // 引擎看到的行在「预处理后」坐标里 y0=100
      return makeOcrResult(`第${tile.index}行`, [makeLine(`第${tile.index}行`, 85, 100, 160)]);
    });

    const result = await recognizeLongImage(makeBlob('scaled'), {});

    const y0s = result.lines.map((line) => line.bbox.y0);
    // 片 0（offsetY=0, scaled=1）：100/1 + 0 = 100
    expect(y0s[0]).toBe(100);
    // 片 1（offsetY=1472, scaled=2）：100/2 + 1472 = 1522
    // —— 不是预处理后坐标（1472+100），也不是片原始坐标（100），更不是漏加 offsetY（50）
    expect(y0s[1]).toBe(1522);
    expect(result.tileCount).toBe(tiles.length);
  });

  it('某片返回空 lines 不影响其他片', async () => {
    const width = 1080;
    const height = 13000;
    mockDecodeAs(width, height);
    const tiles = makeTiles(width, height);
    mockedSlice.mockResolvedValue(tiles);
    mockedPreprocess.mockImplementation(async (blob: Blob) => {
      const tile = tiles.find((candidate) => candidate.blob === blob);
      if (!tile) throw new Error('未知的切片 blob');
      return {
        blob,
        width,
        height: tile.height,
        scaled: 1,
        originalWidth: width,
        originalHeight: tile.height,
        skipped: false,
      };
    });
    mockedRecognize.mockImplementation(async (blob: Blob) => {
      const tile = tiles.find((candidate) => candidate.blob === blob);
      if (!tile) throw new Error('未知的切片 blob');
      // 第 2 片（index=1）整段没认出任何行
      if (tile.index === 1) return makeOcrResult('', []);
      return makeOcrResult(`行${tile.index}`, [makeLine(`行${tile.index}`, 80, 100, 130)]);
    });

    const result = await recognizeLongImage(makeBlob('partial'), {});

    expect(result.tileCount).toBe(tiles.length);
    expect(result.lines).toHaveLength(tiles.length - 1);
    expect(result.meanConfidence).toBeGreaterThan(0);
    expect(result.lines.every((line) => line.text !== '行1')).toBe(true);
  });

  it('解码失败（无 canvas 环境）退回整图单次识别，与旧路径一致', async () => {
    mockedDecode.mockResolvedValue(null);
    const rawBlob = makeBlob('raw');
    mockedPreprocess.mockResolvedValue({
      blob: rawBlob,
      width: 0,
      height: 0,
      scaled: 1,
      originalWidth: 0,
      originalHeight: 0,
      skipped: true,
      reason: 'no canvas',
    });
    const lines = [makeLine(' fallback ', 50, 12, 34)];
    mockedRecognize.mockResolvedValue(makeOcrResult('fallback', lines));

    const result = await recognizeLongImage(makeBlob('bad'), {});

    expect(result.tileCount).toBe(1);
    expect(mockedSlice).not.toHaveBeenCalled();
    expect(mockedPreprocess).toHaveBeenCalledTimes(1);
    // skipped 时 scaled=1 → bbox 原样
    expect(result.lines).toEqual(lines);
    expect(result.meanConfidence).toBe(50);
  });

  it('分片识别时进度汇报「第 N/M 段」，让用户知道为什么慢', async () => {
    const width = 1080;
    const height = 13000;
    mockDecodeAs(width, height);
    const tiles = makeTiles(width, height);
    mockedSlice.mockResolvedValue(tiles);
    mockedPreprocess.mockImplementation(async (blob: Blob) => {
      const tile = tiles.find((candidate) => candidate.blob === blob);
      if (!tile) throw new Error('未知的切片 blob');
      return {
        blob,
        width,
        height: tile.height,
        scaled: 1,
        originalWidth: width,
        originalHeight: tile.height,
        skipped: false,
      };
    });
    mockedRecognize.mockImplementation(async (blob: Blob) => {
      const tile = tiles.find((candidate) => candidate.blob === blob);
      if (!tile) throw new Error('未知的切片 blob');
      return makeOcrResult(`行${tile.index}`, [makeLine(`行${tile.index}`, 80, 100, 130)]);
    });

    const events: LongOcrProgress[] = [];
    await recognizeLongImage(makeBlob('progress'), { onProgress: (info) => events.push(info) });

    // 裁切段 → 逐段识别 → 合并段，三段进度都要有
    expect(events.some((e) => e.stage === 'preprocess' && e.label.includes('裁切'))).toBe(true);
    expect(events.some((e) => e.stage === 'tile' && e.label === `识别第 1/${tiles.length} 段`)).toBe(true);
    expect(events.some((e) => e.stage === 'tile' && e.label === `识别第 ${tiles.length}/${tiles.length} 段`)).toBe(
      true,
    );
    expect(events.some((e) => e.stage === 'merge')).toBe(true);
    // 进度值单调不减（进度条不能倒跳）
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i].progress).toBeGreaterThanOrEqual(events[i - 1].progress);
    }
  });
});
