/**
 * 图像预处理（纯 canvas，无任何依赖）。
 *
 * 为什么这一步性价比最高：手机截图多是 750px 宽的压缩图，字高只有 10–14px，
 * 直接喂 tesseract 就是"识别差"的主因。放大 + 灰度 + 对比度拉伸之后，
 * 同一个引擎的识别率提升最明显，而且和引擎无关（换 PP-OCR 也需要）。
 *
 * 全部在本地 canvas 上完成，**不产生任何网络请求**（隐私红线）。
 */
import {
  applyLut,
  buildContrastLut,
  buildHistogram,
  binarize,
  invertGray,
  isDarkBackground,
  otsuThreshold,
  planImageScale,
  rgbToGray,
  type ImageScalePlan,
} from './ocrMath';
import type { TilePlan } from './ocrTiles';

export interface PreprocessOptions {
  /** 直接指定目标宽度（优先级高于短边规则），用于「预览按屏宽降采样」 */
  targetWidth?: number;
  /** 是否二值化，默认 false：抗锯齿文字二值化后更差，只在对比度拉伸后仍发灰时开 */
  binarize?: boolean;
  minShortEdge?: number;
  maxLongEdge?: number;
}

export interface PreprocessResult {
  /** 送进识别引擎、同时用于预览的图。与 bbox 共用同一坐标系 */
  blob: Blob;
  width: number;
  height: number;
  /** 相对原图的缩放倍率；1 表示没缩放 */
  scaled: number;
  originalWidth: number;
  originalHeight: number;
  /** 环境不支持 canvas 时降级：blob 就是原图，bbox 仍按原始像素对齐 */
  skipped: boolean;
  reason?: string;
}

/**
 * 解码后的图像句柄。
 *
 * 导出原因：`ocrPipeline` 要在分片**之前**拿到原图宽高（先 preprocess 再看尺寸
 * 就晚了——那时长图已经被整体缩小），必须复用这条与 preprocessImage 完全
 * 一致的解码路径（含 EXIF 旋转修正）。只是追加导出，语义没变。
 */
export interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}

type CreateBitmap = (input: Blob, options?: ImageBitmapOptions) => Promise<ImageBitmap>;

const DECODE_TIMEOUT_MS = 8000;

function loadHtmlImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => {
      image.onload = null;
      image.onerror = null;
      reject(new Error('图片解码超时'));
    }, DECODE_TIMEOUT_MS);
    image.onload = () => {
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timer);
      reject(new Error('图片解码失败'));
    };
    image.src = url;
  });
}

/** 解码图片（优先 createImageBitmap + EXIF 方向修正，退回 <img>）。失败返回 null。 */
export async function decodeImage(blob: Blob): Promise<DecodedImage | null> {
  const createBitmap = (globalThis as unknown as { createImageBitmap?: CreateBitmap }).createImageBitmap;
  if (typeof createBitmap === 'function') {
    try {
      // 手机拍照常带 EXIF 旋转：不解方向会把整张图识别成"横躺"的乱码
      const bitmap = await createBitmap(blob, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // 老 Safari 不支持 imageOrientation 选项，退回 <img>
    }
  }
  if (typeof Image !== 'function' || typeof URL.createObjectURL !== 'function') return null;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await loadHtmlImage(objectUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error('图片尺寸为 0');
    return { source: image, width, height, release: () => URL.revokeObjectURL(objectUrl) };
  } catch {
    URL.revokeObjectURL(objectUrl);
    return null;
  }
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

/**
 * canvas 是否可用。
 *
 * 先判这里再去解码：没有 canvas 的环境（jsdom、部分老浏览器）里，
 * 解码只会白等超时；而且预览本来就用原图，跳过完全不影响可用性。
 */
function canvasSupported(): boolean {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false;
  // 先看构造器：jsdom 之类"有 canvas 元素但没有 2D 实现"的环境到这里就能返回，
  // 不用真的去调 getContext（那会在控制台刷一堆 not implemented）
  if (typeof (globalThis as { CanvasRenderingContext2D?: unknown }).CanvasRenderingContext2D === 'undefined') {
    return false;
  }
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext && canvas.getContext('2d'));
  } catch {
    return false;
  }
}

/**
 * 预处理主流程：放大 → 灰度 → 对比度拉伸（→ 可选二值化）→ PNG。
 *
 * 输出 PNG 而不是 JPEG：JPEG 的块效应会在文字边缘制造"假笔画"，
 * 对小字号中文伤害特别大；PNG 无损，代价只是临时内存。
 */
export async function preprocessImage(blob: Blob, options: PreprocessOptions = {}): Promise<PreprocessResult> {
  if (!canvasSupported()) {
    return {
      blob,
      width: 0,
      height: 0,
      scaled: 1,
      originalWidth: 0,
      originalHeight: 0,
      skipped: true,
      reason: '当前浏览器不支持 canvas 图像处理，已按原图直接识别',
    };
  }
  const decoded = await decodeImage(blob);
  if (!decoded) {
    return {
      blob,
      width: 0,
      height: 0,
      scaled: 1,
      originalWidth: 0,
      originalHeight: 0,
      skipped: true,
      reason: '当前环境无法解码图片，已按原图直接识别',
    };
  }

  const originalWidth = decoded.width;
  const originalHeight = decoded.height;
  let plan: ImageScalePlan = planImageScale(originalWidth, originalHeight, {
    minShortEdge: options.minShortEdge,
    maxLongEdge: options.maxLongEdge,
  });
  if (options.targetWidth && options.targetWidth > 0) {
    const scale = options.targetWidth / originalWidth;
    plan = {
      width: Math.max(1, Math.round(originalWidth * scale)),
      height: Math.max(1, Math.round(originalHeight * scale)),
      scale: Number(scale.toFixed(4)),
      reason: scale > 1 ? 'up' : 'down',
    };
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    // willReadFrequently：整张图要反复 getImageData，不加这个标记浏览器会走 GPU 回读，慢十倍
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('canvas 2d 不可用');

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(decoded.source, 0, 0, plan.width, plan.height);

    const imageData = context.getImageData(0, 0, plan.width, plan.height);
    const pixels = imageData.data;
    const pixelCount = plan.width * plan.height;
    const rawGray = new Uint8ClampedArray(pixelCount);
    for (let i = 0; i < pixelCount; i += 1) {
      const offset = i * 4;
      rawGray[i] = rgbToGray(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    }

    // 深色模式截图是「深底浅字」，直接做对比度拉伸只会得到更纯的黑底白字。
    // Tesseract 对黑底白字的中文识别率极低（细笔画先丢，只剩粗笔画数字），
    // 所以先按背景众数判断方向，反成白底黑字再拉伸。浅色截图不受影响。
    const gray = isDarkBackground(rawGray) ? invertGray(rawGray) : rawGray;

    const histogram = buildHistogram(gray);
    let processed = applyLut(gray, buildContrastLut(histogram));
    if (options.binarize) {
      processed = binarize(processed, otsuThreshold(buildHistogram(processed)));
    }

    for (let i = 0; i < pixelCount; i += 1) {
      const offset = i * 4;
      const value = processed[i];
      pixels[offset] = value;
      pixels[offset + 1] = value;
      pixels[offset + 2] = value;
      pixels[offset + 3] = 255;
    }
    context.putImageData(imageData, 0, 0);

    const png = await canvasToPngBlob(canvas);
    if (!png) throw new Error('canvas.toBlob 不可用');
    return {
      blob: png,
      width: plan.width,
      height: plan.height,
      scaled: plan.scale,
      originalWidth,
      originalHeight,
      skipped: false,
    };
  } catch (error) {
    // 降级而不是报错：预处理只是"让识别更准"，不该让整个导入路径失败
    return {
      blob,
      width: 0,
      height: 0,
      scaled: 1,
      originalWidth,
      originalHeight,
      skipped: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    decoded.release();
  }
}

/* ------------------------------------------------------------------ *
 * 长截图切片（追加导出，不改上面的任何既有函数）
 * ------------------------------------------------------------------ */

/** sliceImage 的返回：一片按原分辨率裁出的子图（未做任何缩放） */
export interface SlicedTile {
  index: number;
  offsetY: number;
  blob: Blob;
  width: number;
  height: number;
}

/**
 * 按原分辨率把长截图裁成若干片，**不做缩放**——缩放交给每片自己的
 * preprocessImage（那时片的高宽比 ≈ 1.6，planImageScale 的长边上限
 * 永远不会被触发，字不会被压糊）。
 *
 * 实现要点：
 * - 用 `drawImage(source, 0, -offsetY)` 做垂直裁切：把原图整体向上平移
 *   offsetY，画布外的部分由 canvas 自动裁掉。不用带 sx/sy 的九参重载，
 *   不同浏览器实现里两者的采样路径不一致，1:1 位移拷贝最稳也最快；
 * - 输出 `image/png`：无损。JPEG 的块效应会在文字边缘制造"假笔画"，
 *   对已经只剩原始分辨率的小字是二次伤害；
 * - 复用模块内的 decodeImage（含 EXIF 旋转修正），保证与整图路径同一坐标系；
 * - **任何一片失败都整批抛错**：静默跳过一段等于漏账，比失败更坏。
 */
export async function sliceImage(blob: Blob, plan: readonly TilePlan[]): Promise<SlicedTile[]> {
  if (plan.length === 0) return [];
  if (!canvasSupported()) {
    throw new Error('当前浏览器不支持 canvas 图像处理，无法裁切长截图');
  }
  const decoded = await decodeImage(blob);
  if (!decoded) {
    throw new Error('图片解码失败，无法裁切长截图');
  }
  try {
    const tiles: SlicedTile[] = [];
    for (const piece of plan) {
      // 防御：plan 由 planTiles 生成时保证在界内，越界说明上游算错了，宁可整批失败
      const tileHeight = Math.min(piece.height, decoded.height - piece.offsetY);
      if (!Number.isFinite(tileHeight) || tileHeight <= 0) {
        throw new Error(`切片规划越界：offsetY=${piece.offsetY}, height=${piece.height}`);
      }
      const canvas = document.createElement('canvas');
      canvas.width = decoded.width;
      canvas.height = tileHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas 2d 不可用');
      // 1:1 位移拷贝，无重采样； smoothing 设置对无缩放的 drawImage 不影响结果
      context.drawImage(decoded.source, 0, -piece.offsetY);
      const png = await canvasToPngBlob(canvas);
      if (!png) throw new Error('canvas.toBlob 不可用');
      tiles.push({ index: piece.index, offsetY: piece.offsetY, blob: png, width: decoded.width, height: tileHeight });
    }
    return tiles;
  } finally {
    decoded.release();
  }
}
