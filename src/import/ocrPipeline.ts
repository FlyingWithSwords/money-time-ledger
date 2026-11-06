/**
 * 长截图 OCR 编排：按原分辨率切段 → 每段独立预处理+识别 → 行拼回原图坐标。
 *
 * 为什么需要这一层：`ocrMath.planImageScale` 的「长边 2400 封顶」对普通大图
 * 是对的（防 canvas 撑爆手机内存），但对 1080×13000 的长截图会把整张图压到
 * 约 18%，30px 的字变成 5px，tesseract 只能吐 `won / ore / ann` 这种碎片。
 * **整图缩放对长图必然错**，唯一解法是按原分辨率切段、每段单独识别——段的
 * 高宽比 ≈ 1.6，长边上限永远不会触发，每段都保住原始分辨率。
 *
 * 坐标系约定（本文件唯一真值）：**原图像素坐标**。
 * 每段识别出的 bbox 是「该段预处理后」的坐标，合并前必须统一换算：
 *
 *     原图坐标 = 段内坐标 / pre.scaled + 段.offsetY   （y 轴）
 *     原图坐标 = 段内坐标 / pre.scaled                （x 轴，段无水平偏移）
 *
 * `pre.scaled` 是 preprocessImage 返回的「输出尺寸 / 原尺寸」倍率。所有段
 * 同宽同高、缩放倍率相同，所以这个换算对每一段都成立。少除一次 scaled 或
 * 少加一次 offsetY，预览高亮框就会整体偏移——这条公式是整个分片方案里
 * 最容易错的一步，改之前先想清楚。
 */
import { LedgerError } from '../domain/errors';
import { decodeImage, preprocessImage, sliceImage, type SlicedTile } from './ocrPreprocess';
import { mergeTileLines, planTiles } from './ocrTiles';
import { recognizeImage } from './parsers/ocr';
import type { OcrLine, OcrMode } from './ocrTypes';
import { assessSourceSize } from './ocrTiles';

export interface LongOcrResult {
  text: string;
  /** 已换算回**原图坐标**的识别行，按 y0 升序 */
  lines: OcrLine[];
  meanConfidence: number;
  /** 实际分了几片；1 表示没分片 */
  tileCount: number;
  /** 原图尺寸 */
  width: number;
  height: number;
  /**
   * 源图本身太窄（< MIN_USABLE_WIDTH），文字在压缩时已丢失。
   * true 时上层应直接展示 advice，而不是让用户对着乱码猜。
   */
  sourceTooSmall: boolean;
}

export interface LongOcrProgress {
  stage: 'preprocess' | 'tile' | 'merge';
  label: string;
  /** 0–1 */
  progress: number;
}

export interface LongOcrOptions {
  mode?: 'block' | 'sparse';
  onProgress?: (info: LongOcrProgress) => void;
}

/** 把一段的识别行从「预处理后坐标」换算回「该段原始像素坐标」 */
function scaleLinesToTileOriginal(lines: readonly OcrLine[], scaled: number): OcrLine[] {
  // scaled ≤ 0 只可能出现在 skipped 降级里（那里 scaled 恒为 1），防御一下除零
  const divisor = scaled > 0 ? scaled : 1;
  return lines.map((line) => ({
    ...line,
    bbox: {
      x0: Math.round(line.bbox.x0 / divisor),
      y0: Math.round(line.bbox.y0 / divisor),
      x1: Math.round(line.bbox.x1 / divisor),
      y1: Math.round(line.bbox.y1 / divisor),
    },
  }));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 识别一张截图，长图自动分片。
 *
 * 流程：解码拿原图尺寸 → planTiles → sliceImage（只切不缩）→
 * 逐片 preprocessImage（每片单独缩放，长边上限不再触发）→ recognizeImage →
 * 行坐标换算回原图 → mergeTileLines 去重合并。
 *
 * 单片（非长图）时，喂给引擎的图与旧路径**完全一致**（同一个 preprocessImage
 * 参数、同一个 recognizeImage 调用），不引入额外缩放差异；唯一的行为差别是
 * 返回的 bbox 统一换算回原图坐标（旧路径给的是预处理后坐标——本文件的
 * 坐标系约定以原图为准）。
 */
export async function recognizeLongImage(blob: Blob, options: LongOcrOptions = {}): Promise<LongOcrResult> {
  const mode: OcrMode = options.mode ?? 'block';
  const onProgress = options.onProgress;

  // ① 先拿**原图**尺寸再决定分片。绝不能先 preprocessImage 再看尺寸——
  //    那条路会先把长图整体缩进 2400px（planImageScale 的长边上限），
  //    等看到尺寸时文字已经糊了。
  const decoded = await decodeImage(blob);
  if (!decoded) {
    // 解不开图（无 canvas 的环境 / 文件损坏）：与旧的单次识别路径一致地降级，
    // 让引擎层面给出它自己的错误文案，而不是在这里新造一种失败。
    return recognizeWholeImage(blob, mode, onProgress);
  }
  const width = decoded.width;
  const height = decoded.height;
  decoded.release();
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new LedgerError('OCR_FAILED', '图片尺寸无效，无法识别');
  }

  // ② 规划切片。非长图返回单片，调用方无需分支。
  const plan = planTiles(width, height);
  if (plan.length === 0) {
    throw new LedgerError('OCR_FAILED', '无法规划识别区域，请换一张截图重试');
  }

  // ③ 裁片。只在真正分片时走 canvas（多一次解码 + PNG 编码）；
  //    单片直接用原图 blob，保证与旧路径零差异。
  let tiles: SlicedTile[];
  if (plan.length > 1) {
    onProgress?.({
      stage: 'preprocess',
      label: `裁切长截图（共 ${plan.length} 段，每段单独识别）`,
      progress: 0,
    });
    try {
      tiles = await sliceImage(blob, plan);
    } catch (error) {
      throw new LedgerError('OCR_FAILED', `长截图裁切失败：${errorText(error)}`);
    }
    if (tiles.length !== plan.length) {
      // sliceImage 约定「任何一片失败整批抛错」，片数对不上说明契约被破坏
      throw new LedgerError('OCR_FAILED', '长截图裁切不完整，已中止识别');
    }
  } else {
    tiles = [{ index: 0, offsetY: 0, blob, width, height }];
  }

  // ④ 逐片识别。分片后总耗时约为片数倍，必须让用户看到「第几段/共几段」，
  //    否则十来秒的白屏转圈会被当成卡死。
  const total = tiles.length;
  const parts: Array<{ offsetY: number; lines: OcrLine[] }> = [];
  let singleResult: { text: string; lines: OcrLine[]; meanConfidence: number } | null = null;

  for (let i = 0; i < total; i += 1) {
    const tile = tiles[i];
    if (total > 1) {
      onProgress?.({
        stage: 'tile',
        label: `识别第 ${i + 1}/${total} 段`,
        // 起点放在 i/total：引擎回调会把它从 i/total 推到 (i+1)/total，
        // 整条进度条单调递增（先发 (i+1)/total 再被引擎拉回 i/total 会倒跳）
        progress: i / total,
      });
    }

    // 每片单独缩放：片高 ≈ 1.6×片宽，planImageScale 的长边上限不会再触发
    const pre = await preprocessImage(tile.blob);
    const result = await recognizeImage(
      pre.blob,
      onProgress
        ? (info) => {
            if (total > 1) {
              // 引擎内部进度（0–1）折算进整体：第 i 段占 1/total
              const inner = Number.isFinite(info.progress) ? Math.max(0, info.progress) : 0;
              onProgress({
                stage: 'tile',
                label: `识别第 ${i + 1}/${total} 段`,
                progress: Math.min(1, i / total + inner / total),
              });
            } else {
              // 单片：透传引擎自己的阶段文案（「首次加载引擎约 N 秒」这类提示
              // 必须原样到达 UI，否则用户会以为卡死），行为与旧路径一致
              onProgress({
                stage: 'tile',
                label: info.label,
                progress: Number.isFinite(info.progress) ? Math.max(0, info.progress) : 0,
              });
            }
          }
        : undefined,
      mode,
    );

    // 坐标换算（见文件头公式）：预处理后坐标 / scaled + offsetY → 原图坐标。
    // mergeTileLines 只负责加 offsetY，所以这里先除 scaled 回到「段原始像素」。
    const lines = scaleLinesToTileOriginal(result.lines, pre.scaled);
    parts.push({ offsetY: tile.offsetY, lines });

    if (total === 1) {
      // 单片：不做过 merge（排序/去重会扰动旧行为），原样返回
      singleResult = { text: result.text, lines, meanConfidence: result.meanConfidence };
    }
  }

  if (singleResult) {
    return {
      text: singleResult.text,
      lines: singleResult.lines,
      meanConfidence: singleResult.meanConfidence,
      tileCount: 1,
      width,
      height,
      sourceTooSmall: assessSourceSize(width, height).tooSmall,
    };
  }

  // ⑤ 合并：加 offsetY 回原图坐标 → 按 y0 排序 → 重叠区去重
  onProgress?.({ stage: 'merge', label: '拼接各段识别结果', progress: 1 });
  const lines = mergeTileLines(parts);
  const text = lines.map((line) => line.text).join('\n');
  const meanConfidence =
    lines.length === 0 ? 0 : lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length;

  onProgress?.({ stage: 'merge', label: '识别完成', progress: 1 });
  return {
    text,
    lines,
    meanConfidence,
    tileCount: total,
    width,
    height,
    sourceTooSmall: assessSourceSize(width, height).tooSmall,
  };
}

/**
 * 降级路径：整图一次识别（解码失败/无 canvas 环境用）。
 * 与旧版 ImportHoldingsDialog 的调用序列完全一致：preprocessImage → recognizeImage。
 */
async function recognizeWholeImage(
  blob: Blob,
  mode: OcrMode,
  onProgress?: (info: LongOcrProgress) => void,
): Promise<LongOcrResult> {
  onProgress?.({ stage: 'preprocess', label: '预处理图片（放大、灰度、增强对比度）', progress: 0 });
  const pre = await preprocessImage(blob);
  const result = await recognizeImage(
    pre.blob,
    onProgress
      ? (info) => {
          onProgress({
            stage: 'tile',
            label: info.label,
            progress: Number.isFinite(info.progress) ? Math.max(0, info.progress) : 0,
          });
        }
      : undefined,
    mode,
  );
  return {
    text: result.text,
    lines: scaleLinesToTileOriginal(result.lines, pre.scaled),
    meanConfidence: result.meanConfidence,
    tileCount: 1,
    width: pre.originalWidth,
    height: pre.originalHeight,
    sourceTooSmall: assessSourceSize(pre.originalWidth, pre.originalHeight).tooSmall,
  };
}
