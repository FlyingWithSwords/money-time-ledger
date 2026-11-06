/**
 * 识别质量判定 + 行与图上位置的对应关系（纯函数，可单测）。
 *
 * 这两个东西是「图片预览校对」的地基：
 * - classifyOcrQuality 决定哪些行要标黄、整图要不要报警；
 * - alignOcrLines 决定表格行能不能定位到图上的框——对不上就留空，**不硬凑**，
 *   因为错误的对齐比没有对齐更误导人（用户会盯着错的位置看，反而漏掉真错的行）。
 */
import type { OcrLine } from './ocrTypes';

/** 单行低于这个置信度就标黄 */
export const LOW_LINE_CONFIDENCE = 60;
/** 整图均值低于这个就报警 */
export const LOW_IMAGE_CONFIDENCE = 70;
/** 低于这个算「一般」，高于则是好 */
export const GOOD_IMAGE_CONFIDENCE = 85;

export type OcrOverallQuality = 'good' | 'fair' | 'poor' | 'unknown';

export interface OcrQualityReport {
  /** 0–100，保留一位小数 */
  meanConfidence: number;
  /** 低置信行在传入数组里的下标（不是物理行号） */
  lowConfidenceIndexes: number[];
  /** 整图均值过低，需要在表格上方提示 */
  warnOverall: boolean;
  overall: OcrOverallQuality;
}

export interface ConfidenceInput {
  confidence: number;
}

/**
 * 置信度分级。
 *
 * 空数组返回 unknown 而不是 poor：一个字都没识别出来是"没找到内容"，
 * 该提示换图/换模式，而不是提示"识别质量差"。
 *
 * overallMean：整图均值（tesseract 的 MeanTextConf，按词加权）。
 * 有就优先用它——逐行平均会把"很多短行"和"几行长文本"等同看待，
 * 而且 UI 上按钮旁边显示的百分比和报警阈值必须来自同一个数，
 * 否则会出现"显示平均 67% 却不报警"的怪现象。
 */
export function classifyOcrQuality(
  lines: readonly ConfidenceInput[],
  overallMean?: number,
): OcrQualityReport {
  const scores: number[] = [];
  const indexes: number[] = [];
  lines.forEach((line, index) => {
    const value = line.confidence;
    if (!Number.isFinite(value)) return;
    scores.push(Math.min(100, Math.max(0, value)));
    if (value < LOW_LINE_CONFIDENCE) indexes.push(index);
  });

  const providedMean = Number.isFinite(overallMean) ? Math.min(100, Math.max(0, Number(overallMean))) : null;
  // 一行都没有、也没有整图均值 → 什么都没识别出来：不报警，让上层提示换图
  if (scores.length === 0 && (providedMean === null || providedMean === 0)) {
    return { meanConfidence: 0, lowConfidenceIndexes: [], warnOverall: false, overall: 'unknown' };
  }
  const meanConfidence =
    providedMean !== null && providedMean > 0
      ? Math.round(providedMean * 10) / 10
      : Math.round((scores.reduce((acc, value) => acc + value, 0) / Math.max(1, scores.length)) * 10) / 10;
  const overall: OcrOverallQuality =
    meanConfidence < LOW_IMAGE_CONFIDENCE ? 'poor' : meanConfidence < GOOD_IMAGE_CONFIDENCE ? 'fair' : 'good';
  return {
    meanConfidence,
    lowConfidenceIndexes: indexes,
    warnOverall: meanConfidence < LOW_IMAGE_CONFIDENCE,
    overall,
  };
}

/** 比较用归一化：去掉所有空白（OCR 常在数字与汉字之间插空格）、大小写统一 */
function normalizeForMatch(text: string): string {
  return text.replace(/[\s\u3000]+/g, '').toLowerCase();
}

/**
 * 把「文本行」对上「带 bbox 的行」，返回每行在 ocrLines 里的**下标**（对不上为 null）。
 *
 * 三条规则，从确定到不确定：
 * 1. 同一下标且文本相同 —— 绝大多数情况；
 * 2. 文本完全相同（分栏导致顺序错位）；
 * 3. 包含关系且**只有唯一候选**（多一个空格/标点）。
 * 其余返回 null。宁可少一个定位按钮，也不要指错地方。
 *
 * 返回下标而不是对象：调用方要用它去索引 OcrScan.lines（渲染高亮框按 index 取），
 * 传对象再 indexOf 会退化成 O(n²) 且遇到重复文本会指错。
 */
export function alignOcrLines(
  textLines: readonly string[],
  ocrLines: readonly OcrLine[],
): Array<number | null> {
  const used = new Array<boolean>(ocrLines.length).fill(false);
  const normalized = ocrLines.map((line) => normalizeForMatch(line.text));

  return textLines.map((text, index) => {
    const target = normalizeForMatch(text);
    if (!target) return null;

    if (index < ocrLines.length && !used[index] && normalized[index] === target) {
      used[index] = true;
      return index;
    }
    for (let i = 0; i < ocrLines.length; i += 1) {
      if (!used[i] && normalized[i] === target) {
        used[i] = true;
        return i;
      }
    }
    const candidates: number[] = [];
    for (let i = 0; i < ocrLines.length; i += 1) {
      if (used[i] || !normalized[i]) continue;
      if (normalized[i].includes(target) || target.includes(normalized[i])) candidates.push(i);
    }
    if (candidates.length === 1) {
      used[candidates[0]] = true;
      return candidates[0];
    }
    return null;
  });
}
