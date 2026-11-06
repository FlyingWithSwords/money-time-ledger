import { describe, expect, it } from 'vitest';
import { alignOcrLines, classifyOcrQuality, LOW_IMAGE_CONFIDENCE, LOW_LINE_CONFIDENCE } from '../import/ocrQuality';
import type { OcrLine } from '../import/ocrTypes';

/**
 * 置信度分级 + 行与 bbox 的对齐规则。
 * 这两件事直接决定"哪一行标黄"和"定位按钮点了会不会指错地方"，
 * 必须能在没有真实截图的环境里被验证。
 */

describe('classifyOcrQuality', () => {
  it('没有任何行时是 unknown，不报警（没内容 ≠ 质量差）', () => {
    const report = classifyOcrQuality([]);
    expect(report).toMatchObject({ meanConfidence: 0, lowConfidenceIndexes: [], warnOverall: false, overall: 'unknown' });
  });

  it('均值 66 → poor 并报警，低于 60 的行被列出', () => {
    const report = classifyOcrQuality([{ confidence: 90 }, { confidence: 55 }, { confidence: 59 }, { confidence: 60 }]);
    expect(report.meanConfidence).toBeCloseTo(66, 1);
    expect(report.meanConfidence).toBeLessThan(LOW_IMAGE_CONFIDENCE);
    expect(report.warnOverall).toBe(true);
    expect(report.overall).toBe('poor');
    // 60 是边界，不算低置信
    expect(report.lowConfidenceIndexes).toEqual([1, 2]);
    expect(LOW_LINE_CONFIDENCE).toBe(60);
  });

  it('均值 80 → fair，不报警', () => {
    const report = classifyOcrQuality([{ confidence: 80 }, { confidence: 80 }]);
    expect(report.overall).toBe('fair');
    expect(report.warnOverall).toBe(false);
  });

  it('均值 90 → good', () => {
    const report = classifyOcrQuality([{ confidence: 95 }, { confidence: 85 }]);
    expect(report.overall).toBe('good');
    expect(report.meanConfidence).toBe(90);
  });

  it('非法置信度被忽略，不会把均值拉成 NaN', () => {
    const report = classifyOcrQuality([{ confidence: Number.NaN }, { confidence: 70 }]);
    expect(report.meanConfidence).toBe(70);
  });

  it('整图均值优先于逐行平均（按钮上的百分比和报警阈值必须是同一个数）', () => {
    // 两行平均是 71，但 tesseract 的加权均值是 66.5 → 应该按 66.5 报警
    const report = classifyOcrQuality([{ confidence: 91 }, { confidence: 51 }], 66.5);
    expect(report.meanConfidence).toBe(66.5);
    expect(report.warnOverall).toBe(true);
    expect(report.overall).toBe('poor');
    // 低置信行依然按逐行算出来
    expect(report.lowConfidenceIndexes).toEqual([1]);
  });
});

const BBOX_A = { x0: 10, y0: 10, x1: 200, y1: 40 };
const BBOX_B = { x0: 10, y0: 50, x1: 220, y1: 80 };
const BBOX_C = { x0: 10, y0: 90, x1: 240, y1: 120 };

const OCR_LINES: OcrLine[] = [
  { text: '2026-11-04 午餐 32.00', confidence: 90, bbox: BBOX_A },
  { text: '2026-11-04 星巴克 45.00', confidence: 55, bbox: BBOX_B },
  { text: '合计 77.00', confidence: 80, bbox: BBOX_C },
];

describe('alignOcrLines', () => {
  it('顺序与文本都一致时逐行对上', () => {
    const indexes = alignOcrLines(['2026-11-04 午餐 32.00', '2026-11-04 星巴克 45.00', '合计 77.00'], OCR_LINES);
    expect(indexes).toEqual([0, 1, 2]);
  });

  it('OCR 在字间插了空格也能对上（去空白后比较）', () => {
    const indexes = alignOcrLines(['2026-11-04午餐32.00'], OCR_LINES);
    expect(indexes).toEqual([0]);
  });

  it('顺序错位时按文本匹配，不会张冠李戴', () => {
    const indexes = alignOcrLines(['合计 77.00', '2026-11-04 午餐 32.00'], OCR_LINES);
    expect(indexes).toEqual([2, 0]);
  });

  it('唯一包含关系可以接受（行里少了标点）', () => {
    const indexes = alignOcrLines(['星巴克'], OCR_LINES);
    expect(indexes).toEqual([1]);
  });

  it('对不上就返回 null，绝不硬凑', () => {
    const indexes = alignOcrLines(['完全无关的一行'], OCR_LINES);
    expect(indexes).toEqual([null]);
  });

  it('包含关系有多个候选时放弃（错定位比没定位更糟）', () => {
    const indexes = alignOcrLines(['店'], [
      { text: '便利店 10.00', confidence: 80, bbox: BBOX_A },
      { text: '书店 20.00', confidence: 80, bbox: BBOX_B },
    ]);
    expect(indexes).toEqual([null]);
  });

  it('同一行文本重复出现时不会两次指向同一段 bbox', () => {
    const indexes = alignOcrLines(['合计 77.00', '合计 77.00'], OCR_LINES);
    expect(indexes).toEqual([2, null]);
  });
});
