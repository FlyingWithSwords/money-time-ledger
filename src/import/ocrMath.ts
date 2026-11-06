/**
 * OCR 图像预处理的**纯算法**部分（不碰 canvas、不碰 DOM）。
 *
 * 抽出来的理由有两个：
 * 1. jsdom 里 canvas 是空实现，像素级断言写不了；但这些数组运算可以精确单测；
 * 2. 预处理链的每一步都能用数字说清楚（分位点、Otsu 阈值、缩放倍率），
 *    出问题时能单独定位，而不是"整条链跑一遍看看"。
 */

export const GRAY_LEVELS = 256;

/* ------------------------------------------------------------------ *
 * 缩放计划
 * ------------------------------------------------------------------ */

export interface ImageScalePlan {
  width: number;
  height: number;
  /** 输出尺寸 / 原尺寸。>1 是放大，<1 是缩小 */
  scale: number;
  reason: 'up' | 'down' | 'none';
}

export interface ScaleOptions {
  /** 短边至少要放大到多少（手机截图常见 750px 宽，直接喂 tesseract 一定糊） */
  minShortEdge?: number;
  /** 长边上限，防止超长截图把 canvas 撑爆 */
  maxLongEdge?: number;
}

export const DEFAULT_MIN_SHORT_EDGE = 1000;
export const DEFAULT_MAX_LONG_EDGE = 2400;

/**
 * 计算目标尺寸：先按短边放大，再用长边封顶。
 *
 * 为什么短边优先：识别质量取决于字的高度（像素），而字高跟短边相关；
 * 但长图（如整屏聊天记录）如果只按短边放大，canvas 会有上亿像素，手机上直接崩。
 * 冲突时让**长边上限**赢，宁可短边不足也不能卡死。
 */
export function planImageScale(
  sourceWidth: number,
  sourceHeight: number,
  options: ScaleOptions = {},
): ImageScalePlan {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    return { width: 0, height: 0, scale: 1, reason: 'none' };
  }
  const minShortEdge = options.minShortEdge ?? DEFAULT_MIN_SHORT_EDGE;
  const maxLongEdge = options.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE;

  const short = Math.min(sourceWidth, sourceHeight);
  const long = Math.max(sourceWidth, sourceHeight);

  let scale = 1;
  if (short < minShortEdge) scale = minShortEdge / short;
  if (long * scale > maxLongEdge) scale = maxLongEdge / long;

  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const reason: ImageScalePlan['reason'] = scale > 1.001 ? 'up' : scale < 0.999 ? 'down' : 'none';
  return { width, height, scale: Number(scale.toFixed(4)), reason };
}

/* ------------------------------------------------------------------ *
 * 灰度与直方图
 * ------------------------------------------------------------------ */

/** 标准亮度权重。人眼对绿最敏感，直接 (r+g+b)/3 会让彩色文字对比失真。 */
export function rgbToGray(r: number, g: number, b: number): number {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

/** 256 桶直方图 */
export function buildHistogram(gray: ArrayLike<number>): Uint32Array {
  const histogram = new Uint32Array(GRAY_LEVELS);
  for (let i = 0; i < gray.length; i += 1) {
    const level = gray[i];
    if (level >= 0 && level < GRAY_LEVELS) histogram[level] += 1;
  }
  return histogram;
}

/* ------------------------------------------------------------------ *
 * 深色截图的背景检测与反色
 * ------------------------------------------------------------------ */

/**
 * 背景亮度估计：直方图按 8 级一桶，取像素最多的桶中心。
 * 截图里背景像素永远占绝大多数，所以众数就是背景色，不需要遍历连通域。
 */
export function estimateBackgroundLevel(gray: ArrayLike<number>, bucketSize = 8): number {
  const size = Math.max(1, Math.ceil(bucketSize));
  const buckets = new Uint32Array(Math.ceil(GRAY_LEVELS / size));
  for (let i = 0; i < gray.length; i += 1) {
    const level = gray[i];
    if (level >= 0 && level < GRAY_LEVELS) buckets[Math.floor(level / size)] += 1;
  }
  let best = 0;
  let bestCount = -1;
  for (let bucket = 0; bucket < buckets.length; bucket += 1) {
    if (buckets[bucket] > bestCount) {
      bestCount = buckets[bucket];
      best = bucket;
    }
  }
  return Math.min(GRAY_LEVELS - 1, best * size + Math.floor(size / 2));
}

/**
 * 深色背景阈值。
 *
 * 浅色截图背景通常 230+（#f7f7f5 ≈ 246），深色截图背景通常 <40（#0f1115 ≈ 17）。
 * 取 110 留足中间地带：灰色卡片、图片背景这类不确定的情况保持不反色，
 * 宁可沿用原样也不要赌错方向。
 */
export const DARK_BACKGROUND_THRESHOLD = 110;

export function isDarkBackground(gray: ArrayLike<number>, threshold = DARK_BACKGROUND_THRESHOLD): boolean {
  return estimateBackgroundLevel(gray) < threshold;
}

/**
 * 反色：深底浅字 → 白底黑字。
 *
 * 为什么必须做：Tesseract 的 LSTM 以白底黑字为主训练，黑底白字的中文识别率
 * 会断崖式下跌（笔画细的字先丢，只剩粗笔画的数字能认出来）。深色模式截图
 * 正是这种形态，所以要在对比度拉伸之前翻过来，否则拉伸只会把「黑底白字」拉得更纯。
 */
export function invertGray(gray: ArrayLike<number>, out?: Uint8ClampedArray): Uint8ClampedArray {
  const result = out ?? new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i += 1) {
    const level = Number(gray[i]);
    result[i] = GRAY_LEVELS - 1 - (Number.isFinite(level) ? Math.min(GRAY_LEVELS - 1, Math.max(0, level)) : 0);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * 对比度拉伸
 * ------------------------------------------------------------------ */

/**
 * 取直方图的第 pct 百分位对应的灰度级。
 *
 * 不用固定阈值（比如"<80 算暗"）的原因：截图来源差异极大，
 * 深色模式截图整体偏暗、HDR 照片整体偏亮，固定阈值会把整张图压成一团。
 */
export function percentileLevel(histogram: ArrayLike<number>, percentile: number): number {
  let total = 0;
  for (let i = 0; i < GRAY_LEVELS; i += 1) total += histogram[i];
  if (total === 0) return 0;

  const p = Math.min(100, Math.max(0, percentile));
  if (p <= 0) {
    for (let i = 0; i < GRAY_LEVELS; i += 1) if (histogram[i] > 0) return i;
    return 0;
  }
  const target = (total * p) / 100;
  let cumulative = 0;
  for (let i = 0; i < GRAY_LEVELS; i += 1) {
    cumulative += histogram[i];
    if (cumulative >= target) return i;
  }
  return GRAY_LEVELS - 1;
}

/**
 * 百分位线性拉伸查找表：<=low 压到 0，>=high 拉到 255，中间线性。
 *
 * 退化情况（low >= high，通常是纯色图或已经全对比的图）返回恒等表：
 * 这时任何"拉伸"都只会放大噪点。
 */
export function buildContrastLut(
  histogram: ArrayLike<number>,
  lowPercentile = 2,
  highPercentile = 98,
): Uint8Array {
  const low = percentileLevel(histogram, lowPercentile);
  const high = percentileLevel(histogram, highPercentile);
  const lut = new Uint8Array(GRAY_LEVELS);
  if (high <= low) {
    for (let i = 0; i < GRAY_LEVELS; i += 1) lut[i] = i;
    return lut;
  }
  const span = high - low;
  for (let i = 0; i < GRAY_LEVELS; i += 1) {
    if (i <= low) lut[i] = 0;
    else if (i >= high) lut[i] = 255;
    else lut[i] = Math.round(((i - low) / span) * 255);
  }
  return lut;
}

export function applyLut(
  gray: ArrayLike<number>,
  lut: Uint8Array,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const result = out ?? new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i += 1) {
    const level = gray[i];
    result[i] = level >= 0 && level < GRAY_LEVELS ? lut[level] : 0;
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Otsu 二值化
 * ------------------------------------------------------------------ */

/**
 * Otsu 阈值（最大化类间方差）。
 *
 * 默认**不启用**：抗锯齿文字二值化后边缘变成硬台阶，tesseract 反而更容易断笔。
 * 只在"对比度拉伸后仍然发灰"的图上由调用方显式打开。
 *
 * 平局时取较小的阈值（前景区 = 亮部），这样浅色背景上的深字不会被整块判成前景。
 */
export function otsuThreshold(histogram: ArrayLike<number>): number {
  let total = 0;
  let sum = 0;
  for (let i = 0; i < GRAY_LEVELS; i += 1) {
    total += histogram[i];
    sum += i * histogram[i];
  }
  if (total === 0) return 127;

  let sumB = 0;
  let weightB = 0;
  let bestVariance = -1;
  let threshold = 127;
  for (let t = 0; t < GRAY_LEVELS; t += 1) {
    weightB += histogram[t];
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;
    sumB += t * histogram[t];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const between = weightB * weightF * (meanB - meanF) * (meanB - meanF);
    if (between > bestVariance) {
      bestVariance = between;
      threshold = t;
    }
  }
  return threshold;
}

/** 大于阈值判前景（255），否则背景（0）。文字通常是深色、背景浅色，这里按"亮部为前景"取反更稳。 */
export function binarize(
  gray: ArrayLike<number>,
  threshold: number,
  out?: Uint8ClampedArray,
): Uint8ClampedArray {
  const result = out ?? new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i += 1) {
    result[i] = gray[i] > threshold ? 255 : 0;
  }
  return result;
}
