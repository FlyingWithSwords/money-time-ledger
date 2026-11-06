/**
 * OCR 相关的**纯类型**定义。
 *
 * 单独成文件的原因：`ocrEngine` / `ocrQuality` / UI 都要引用这些形状，
 * 而引擎文件（会动态 import tesseract）不该被其他人牵连。
 * 这里没有任何副作用、没有依赖、也不会被任何 `fetch` 污染。
 */

/** 页面分割模式：整块文字（截图/小票）还是稀疏多列（表格截图） */
export type OcrMode = 'block' | 'sparse';

/**
 * `RawRow.cells` 里的「年份为推断」标记键。
 *
 * 支付宝/微信的列表只在每笔下方写 `10-19 09:10`，年份是解析时按"不晚于今天"推出来的。
 * 这个键不进数据库、也不参与字段映射（normalizeRow 只取 headerMap 声明的列），
 * 纯粹给校对界面用：让用户知道"这个年份是猜的"，而不是把它当 OCR 原文。
 *
 * 放在 ocrTypes 里而不是 parsers/ocr.ts：UI 需要读它，而 parsers/ocr.ts 会被
 * 动态 import（连带 tesseract 的懒加载），UI 不该为了一个字符串常量拖进那个模块。
 */
export const OCR_DATE_INFERRED_CELL = '日期推断';

export interface OcrBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrLine {
  text: string;
  confidence: number;
  bbox: OcrBbox;
}

export interface OcrResult {
  text: string;
  lines: OcrLine[];
  /**
   * 整图平均置信度（0–100）。
   * 优先用 tesseract 自己的 MeanTextConf，拿不到时退化成逐行平均。
   */
  meanConfidence: number;
}

/**
 * 识别进度。
 * stage 用来区分「在等引擎」和「在等识别」——首次加载 best 模型要十几秒，
 * 只转圈用户会以为卡死，必须给出阶段文案。
 */
export interface OcrProgress {
  stage: 'preprocess' | 'engine' | 'recognize';
  label: string;
  /** 0–1；未知时为 0 */
  progress: number;
}

export interface OcrProgressHandler {
  (info: OcrProgress): void;
}

export interface OcrRecognizeOptions {
  mode?: OcrMode;
  onProgress?: OcrProgressHandler;
}

/**
 * 可替换的识别引擎。
 *
 * 现在只有 `tesseract` 一个实现。后续若要接 PP-OCR（paddle_ocr），
 * 需要自带本地 ONNX 模型 + onnxruntime-web（约 15MB）+ 检测框/CTC 解码，
 * 并且必须用真实账单截图做过精度对照再换——只在接口层留好口子，不盲改。
 */
export interface OcrEngine {
  id: 'tesseract' | (string & {});
  label: string;
  recognize(blob: Blob, options?: OcrRecognizeOptions): Promise<OcrResult>;
  dispose(): Promise<void>;
}
