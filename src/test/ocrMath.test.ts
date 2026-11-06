import { describe, expect, it } from 'vitest';
import {
  applyLut,
  binarize,
  buildContrastLut,
  buildHistogram,
  otsuThreshold,
  percentileLevel,
  planImageScale,
  rgbToGray,
} from '../import/ocrMath';

/**
 * 预处理链里的纯算法。
 *
 * 为什么不测 preprocessImage 本身：jsdom 没有 canvas，像素结果无从断言
 * （写出来的"测试"只会断言 skip 分支，等于没测）。真正的风险点其实是
 * 缩放规则 / 分位点 / Otsu 这三块数组运算，它们完全可以精确验证。
 */

function histogramOf(entries: Array<[level: number, count: number]>): Uint32Array {
  const histogram = new Uint32Array(256);
  for (const [level, count] of entries) histogram[level] = count;
  return histogram;
}

describe('planImageScale 缩放规则', () => {
  it('手机截图（750×1334）短边放大到 1000，长边不超上限', () => {
    const plan = planImageScale(750, 1334);
    expect(plan.width).toBe(1000);
    expect(plan.height).toBe(1779);
    expect(plan.reason).toBe('up');
    expect(plan.scale).toBeCloseTo(1.3333, 3);
  });

  it('超大图按长边 2400 缩下来，避免 canvas 撑爆手机内存', () => {
    const plan = planImageScale(4000, 3000);
    expect(plan).toMatchObject({ width: 2400, height: 1800, reason: 'down' });
  });

  it('已经很清晰的图不动', () => {
    const plan = planImageScale(2400, 1800);
    expect(plan).toMatchObject({ width: 2400, height: 1800, scale: 1, reason: 'none' });
  });

  it('超长截图：长边上限优先，宁可短边不足也不卡死', () => {
    const plan = planImageScale(750, 6000);
    expect(plan.height).toBe(2400);
    expect(plan.width).toBe(300);
    expect(plan.reason).toBe('down');
  });

  it('非法尺寸直接返回空计划，不抛错', () => {
    expect(planImageScale(0, 0)).toMatchObject({ width: 0, height: 0, scale: 1 });
  });
});

describe('灰度与直方图', () => {
  it('亮度权重按人眼敏感度（绿 > 红 > 蓝）', () => {
    expect(rgbToGray(255, 255, 255)).toBe(255);
    expect(rgbToGray(0, 0, 0)).toBe(0);
    expect(rgbToGray(255, 0, 0)).toBe(76);
    expect(rgbToGray(0, 255, 0)).toBe(150);
    expect(rgbToGray(0, 0, 255)).toBe(29);
  });

  it('直方图只统计合法灰度级', () => {
    const histogram = buildHistogram([0, 0, 255, 300, -1]);
    expect(histogram[0]).toBe(2);
    expect(histogram[255]).toBe(1);
    expect(histogram.reduce((acc, value) => acc + value, 0)).toBe(3);
  });
});

describe('百分位对比度拉伸', () => {
  const histogram = histogramOf([
    [100, 50],
    [150, 50],
  ]);

  it('取到 2% / 98% 分位点', () => {
    expect(percentileLevel(histogram, 2)).toBe(100);
    expect(percentileLevel(histogram, 98)).toBe(150);
    expect(percentileLevel(histogram, 0)).toBe(100);
    expect(percentileLevel(histogram, 100)).toBe(150);
  });

  it('拉伸后 100→0、150→255、125→128', () => {
    const lut = buildContrastLut(histogram);
    expect(lut[100]).toBe(0);
    expect(lut[150]).toBe(255);
    expect(lut[125]).toBe(128);
    // 分位点之外一律压到端点，不再放大噪点
    expect(lut[0]).toBe(0);
    expect(lut[255]).toBe(255);
  });

  it('纯色图（无可用对比度）返回恒等表，不做无意义的拉伸', () => {
    const lut = buildContrastLut(histogramOf([[200, 500]]));
    for (const level of [0, 100, 200, 255]) expect(lut[level]).toBe(level);
  });

  it('空直方图不崩', () => {
    const lut = buildContrastLut(histogramOf([]));
    expect(lut[0]).toBe(0);
    expect(lut[255]).toBe(255);
  });

  it('applyLut 可以复用外部缓冲，且对越界值兜底为 0', () => {
    const out = new Uint8ClampedArray(3);
    const result = applyLut([100, 150, 999], buildContrastLut(histogram), out);
    expect(result).toBe(out);
    expect(Array.from(result)).toEqual([0, 255, 0]);
  });
});

describe('Otsu 二值化', () => {
  it('双峰直方图的阈值落在两峰之间，二值化后前景数正确', () => {
    const histogram = histogramOf([
      [40, 80],
      [220, 20],
    ]);
    const threshold = otsuThreshold(histogram);
    expect(threshold).toBeGreaterThanOrEqual(40);
    expect(threshold).toBeLessThan(220);

    const gray = new Uint8ClampedArray(100);
    for (let i = 0; i < 80; i += 1) gray[i] = 40;
    for (let i = 80; i < 100; i += 1) gray[i] = 220;
    const binary = binarize(gray, threshold);
    const foreground = binary.reduce((acc, value) => acc + (value === 255 ? 1 : 0), 0);
    expect(foreground).toBe(20);
    expect(binary[0]).toBe(0);
    expect(binary[99]).toBe(255);
  });

  it('空直方图返回中位阈值而不是 0（0 会把整图判成前景）', () => {
    expect(otsuThreshold(histogramOf([]))).toBe(127);
  });
});
