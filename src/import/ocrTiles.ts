/**
 * 长截图分片的**纯逻辑**（不碰 canvas、不碰 DOM、不碰引擎）。
 *
 * 为什么必须分片：`ocrMath.planImageScale` 对普通大图是对的（短边放大、
 * 长边 2400 封顶防 canvas 撑爆），但对宽高比 5+ 的手机长截图是灾难——
 * 1080×13000 会被整体压到约 18%，30px 的字变成 5px，tesseract 只能吐出
 * `won / ore / ann` 这种英文碎片。**整图缩放对长图必然错**，唯一的解法是
 * 按原分辨率垂直切段，每段单独识别后再把行拼回原图坐标系。
 *
 * 这里只算数字（切几片、每片在哪、怎么去重），切图的 canvas 操作在
 * `ocrPreprocess.sliceImage`，编排识别的流程在 `ocrPipeline.ts`——
 * 三层分开是为了让这些数组运算可以在 jsdom 里精确单测。
 */
import type { OcrLine } from './ocrTypes';

export interface TilePlan {
  index: number;
  /** 该片在原图中的 y 起点（px） */
  offsetY: number;
  /** 该片高度（px）。片宽恒等于原图宽 */
  height: number;
}

export interface TileOptions {
  /** 宽高比超过此值才分片。普通手机截图 2.0~2.3，长截图 5+ */
  longImageRatio?: number;
  /** 每片目标高度 = 片宽 × 该系数（约一屏），默认 1.6 */
  tileAspect?: number;
  /** 相邻片重叠比例，防止把一行字从中间切断，默认 0.08 */
  overlapRatio?: number;
  /** 片数上限（内存与耗时保护），默认 10 */
  maxTiles?: number;
}

export const DEFAULT_LONG_IMAGE_RATIO = 2.4;
export const DEFAULT_TILE_ASPECT = 1.6;
export const DEFAULT_OVERLAP_RATIO = 0.08;
export const DEFAULT_MAX_TILES = 10;

/**
 * 可用源图的最小宽度。
 *
 * 480 是实测下限而不是拍脑袋：手机截图典型宽度 750/1080/1170，中文字高约
 * 28–34px，识别毫无压力；一旦宽度掉到 400 以下（聊天软件预览图、被压缩过的
 * 缩略图常见 150–320），字高只剩 4–6px，**笔画在压缩时就已丢失**，
 * 放大只是把糊掉的像素插值成更大的糊，换任何 OCR 引擎都读不出来。
 *
 * 判据用宽度而不是「总像素」：中文是横向排版的方块字，可读性由字高（≈ 宽度/30）
 * 决定；一张 150×13000 的图总像素并不少，但每个字都被压扁了。
 */
export const MIN_USABLE_WIDTH = 480;

export interface SourceSizeAssessment {
  /** 源图太窄，文字已不可恢复 */
  tooSmall: boolean;
  /** 给用户的可行动建议；tooSmall=false 时为 null */
  advice: string | null;
}

/**
 * 判断源图本身是否已经不可用。
 *
 * 为什么要在识别**之前**判断：这张图注定识别不出来，继续跑分片只会让用户
 * 等十几秒看 9 段全失败。直说「图被压坏了，请用原始截图」比给一堆乱码有用得多。
 */
export function assessSourceSize(width: number, height: number): SourceSizeAssessment {
  if (!hasValidSize(width, height)) {
    return { tooSmall: true, advice: '这张图读不出尺寸，可能已损坏，请重新截图。' };
  }
  if (width >= MIN_USABLE_WIDTH) return { tooSmall: false, advice: null };
  return {
    tooSmall: true,
    advice:
      `这张图只有 ${Math.round(width)}px 宽，文字在压缩时就已经丢失，放大也补不回来。` +
      '请在手机上重新截取原始截图（通常 1080px 宽、2MB 以上），不要用聊天软件里的预览图。',
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function hasValidSize(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

/**
 * 是否长截图（宽高比超阈值）。
 *
 * 阈值取 2.4 而不是 2.0：普通手机截图的宽高比在 2.0~2.3 之间（含状态栏/导航栏），
 * 用 2.0 会把正常截图也切一刀，平白多一次识别耗时；2.4 以上基本都是滚动长截图。
 * 横向长图（宽 > 高）也返回 true，但 planTiles 里片高会 ≥ 图高，自然退化为单片。
 */
export function isLongImage(width: number, height: number, options?: TileOptions): boolean {
  if (!hasValidSize(width, height)) return false;
  const longImageRatio = clamp(options?.longImageRatio ?? DEFAULT_LONG_IMAGE_RATIO, 1, 100);
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  return long / short > longImageRatio;
}

/**
 * 切片规划。
 *
 * - 非长图 → 返回单片 `[{index:0, offsetY:0, height}]`，调用方无需分支；
 * - 片高 = `round(width × tileAspect)`；若算出的片数超过 maxTiles，
 *   把片高放大到**恰好 maxTiles 片**（宁可片大也不让片数爆炸——
 *   总耗时与内存随片数线性涨，10 片已经是十几秒的量级）；
 * - 步进 = 片高 × (1 - overlapRatio)，各片均匀步进；
 * - 最后一片**贴底**：`offsetY + height === 原图高`（实现方式是「均匀步进的
 *   最后一片高度按原图高截断」，而不是把整片挪到底部——挪动会让最后一段
 *   与前一片重叠骤增到 90%，白白重复识别一大段）；
 * - 叠加不超过原图高度（片高上限截断）。
 *
 * ⚠️ 非正数/NaN 入参返回 `[]`：调用方必须当「无法识别」处理（抛错走降级
 * 文案），不能静默当成一张空图。
 */
export function planTiles(width: number, height: number, options: TileOptions = {}): TilePlan[] {
  if (!hasValidSize(width, height)) return [];

  // 源图太窄：分片没有意义（字在压缩时已丢失），切 9 段只会让用户白等十几秒。
  // 单片识别 + 上层用 assessSourceSize 的 advice 直接告知原因。
  if (width < MIN_USABLE_WIDTH) {
    return [{ index: 0, offsetY: 0, height }];
  }

  // 普通图：单片整图识别，行为与历史路径完全一致
  if (!isLongImage(width, height, options)) {
    return [{ index: 0, offsetY: 0, height }];
  }

  const tileAspect = clamp(options.tileAspect ?? DEFAULT_TILE_ASPECT, 0.1, 16);
  const overlapRatio = clamp(options.overlapRatio ?? DEFAULT_OVERLAP_RATIO, 0, 0.5);
  const maxTiles = Math.max(1, Math.round(options.maxTiles ?? DEFAULT_MAX_TILES));

  let tileHeight = Math.round(width * tileAspect);
  if (tileHeight < 1) tileHeight = 1;

  // 片高不小于图高：一张就装得下（极端宽图会走到这里），没必要切
  if (tileHeight >= height) {
    return [{ index: 0, offsetY: 0, height }];
  }

  // 自然片数：步进铺到「最后一片的起点 ≥ height - tileHeight」为止，
  // 这样最后一片（高度截断后）一定触底，图尾不漏。
  const step = tileHeight * (1 - overlapRatio);
  let count = Math.ceil((height - tileHeight) / step) + 1;

  if (count > maxTiles) {
    // 片数超上限 → 反解片高。maxTiles 片以步进 h·(1-r) 均匀铺满需要
    //   (maxTiles-1)·h·(1-r) ≥ H - h，即 h ≥ H / (1 + (maxTiles-1)·(1-r))。
    // 取满足该式的最小整数片高：既不超过上限，又尽量贴近一屏的比例。
    count = maxTiles;
    const minTileHeight = height / (1 + (maxTiles - 1) * (1 - overlapRatio));
    tileHeight = Math.max(tileHeight, Math.ceil(minTileHeight));
    if (tileHeight >= height) {
      return [{ index: 0, offsetY: 0, height }];
    }
  }

  // 注意：maxTiles 分支可能放大了 tileHeight，步进必须用**最终**片高重算
  const finalStep = tileHeight * (1 - overlapRatio);

  const tiles: TilePlan[] = [];
  for (let i = 0; i < count; i += 1) {
    // offsetY 取整会带来 ±1px 的步进误差，正好落在「重叠 ±1px」的容差里
    const offsetY = Math.min(Math.round(i * finalStep), height - 1);
    // 最后一片贴底：高度按原图高截断，offsetY + height === height 恒成立
    const cappedHeight = Math.min(tileHeight, height - offsetY);
    tiles.push({ index: i, offsetY, height: cappedHeight });
  }
  return tiles;
}

/** 文本归一化（去所有空白）：OCR 对同一行两次识别的空格差异不能挡住去重 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * 把各片的识别行合并回**原图坐标系**。
 *
 * - 每片 line 的 `bbox.y0/y1` 加上该片 `offsetY`（x 不动——片没有水平偏移）。
 *   预览高亮用的是原图坐标，不加这一步框会整体上移；
 * - 结果按 `bbox.y0` 升序（阅读顺序）；
 * - **重叠区去重**：相邻两片重叠约 8%，同一行文字常被识别两次。判定：
 *   文本归一化后相同，且两行垂直中心距 < 行高 × 0.6 → 视为同一行，
 *   只保留 `confidence` 高的那条；
 * - 空输入返回空数组。
 *
 * 注意：入参的 lines 必须已经换算回「该片原始像素」坐标（如果该片识别前
 * 被 preprocessImage 缩放过，调用方要先除以缩放倍率——见 ocrPipeline）。
 */
export function mergeTileLines(parts: readonly { offsetY: number; lines: OcrLine[] }[]): OcrLine[] {
  if (parts.length === 0) return [];

  // ① 回到原图坐标系
  const shifted: OcrLine[] = [];
  for (const part of parts) {
    for (const line of part.lines) {
      shifted.push({
        ...line,
        bbox: {
          ...line.bbox,
          y0: line.bbox.y0 + part.offsetY,
          y1: line.bbox.y1 + part.offsetY,
        },
      });
    }
  }

  // ② 按阅读顺序排（y0 升序，平局按 y1 稳定排序）
  shifted.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.y1 - b.bbox.y1);

  // ③ 重叠区去重：kept 已经按 y 排序，重复行一定在附近，线性扫即可。
  //    O(n²) 的 find 在几百行的量级下毫秒级，不值得上更复杂的数据结构。
  const kept: OcrLine[] = [];
  for (const line of shifted) {
    const normalized = normalizeText(line.text);
    const duplicateIndex = normalized
      ? kept.findIndex((existing) => {
          if (normalizeText(existing.text) !== normalized) return false;
          const existingCenter = (existing.bbox.y0 + existing.bbox.y1) / 2;
          const lineCenter = (line.bbox.y0 + line.bbox.y1) / 2;
          // 用两行里较高的那个做基准：跨片识别的 bbox 高度常有几个像素的抖动
          const referenceHeight = Math.max(
            existing.bbox.y1 - existing.bbox.y0,
            line.bbox.y1 - line.bbox.y0,
            1,
          );
          return Math.abs(existingCenter - lineCenter) < referenceHeight * 0.6;
        })
      : -1;
    if (duplicateIndex < 0) {
      kept.push(line);
    } else if (line.confidence > kept[duplicateIndex].confidence) {
      // 同一行被两片各认了一次：留置信度高的（位置差在容差内，取哪个都不亏）
      kept[duplicateIndex] = line;
    }
  }
  return kept;
}
