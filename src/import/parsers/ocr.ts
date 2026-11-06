import { LedgerError } from '../../domain/errors';
import {
  checkLangPack,
  ocrCorePath,
  ocrWorkerPath,
  tessdataBaseUrl,
  OCR_LANGS,
  type OcrPackInfo,
} from '../ocrPack';
import { createTesseractEngine, FIRST_RUN_SECONDS } from '../ocrEngine';
import { preprocessImage } from '../ocrPreprocess';
import { alignOcrLines, classifyOcrQuality, type OcrQualityReport } from '../ocrQuality';
import { OCR_DATE_INFERRED_CELL } from '../ocrTypes';
import type {
  OcrBbox,
  OcrEngine,
  OcrLine,
  OcrMode,
  OcrProgressHandler,
  OcrResult,
} from '../ocrTypes';
import type { ImportFile, ParseIssue, Parser, ParseOutcome, RawRow } from '../base';

/**
 * 截图 OCR（路径 B）。三条硬约束：
 * 1. 默认**本地**执行，图片不出设备（tesseract.js WASM 在 worker 里跑）；
 * 2. 语言包与引擎**同源自托管**（public/tessdata、public/tesseract），
 *    首次使用提示下载，之后断网可识别；
 * 3. 识别结果**一律不自动入库**，进「待确认列表」逐条核对（现在还能对着原图校对）。
 *
 * 识别质量的四层改动全部在这里汇合：
 * ① 预处理（放大 / 灰度 / 对比度拉伸）—— 见 ocrPreprocess.ts
 * ② PSM 按场景切换 + preserve_interword_spaces —— 见 ocrEngine.ts
 * ③ chi_sim + eng 多语言 —— 见 ocrPack.ts / ocrEngine.ts
 * ④ best 语言包（体积换精度）—— 见 scripts/fetch-tessdata.mjs
 *
 * tesseract.js 只在真正识别时 dynamic import()，首屏 JS 不含它。
 */

export type { OcrBbox, OcrLine, OcrMode, OcrResult };

/** 预处理后的图：既是送进引擎的图，也是预览用的图，两者共用同一坐标系（bbox 才对得上） */
export interface OcrImageInfo {
  blob: Blob;
  /** 预处理后的像素尺寸；skipped 时为 0（以 <img> 的自然尺寸为准） */
  width: number;
  height: number;
  /** 相对原图的缩放倍率，1 表示没缩放 */
  scaled: number;
  skipped: boolean;
  reason?: string;
}

/** 行 ↔ 图上位置的对应关系。对不上就是 null，不硬凑 */
export interface OcrRowAnnotation {
  /** 物理行号（与 RawRow.rowIndex 一致），用于稳定匹配 */
  rowIndex: number;
  /** 在 OcrScan.lines 里的下标；null 表示这一行无法定位到图上 */
  lineIndex: number | null;
  /** OCR 的原始文本，供用户逐字对照 */
  rawText: string;
  confidence: number | null;
  bbox: OcrBbox | null;
}

export interface OcrScan {
  engineId: string;
  engineLabel: string;
  mode: OcrMode;
  meanConfidence: number;
  quality: OcrQualityReport;
  lines: OcrLine[];
  rows: OcrRowAnnotation[];
  image: OcrImageInfo;
  degraded: boolean;
  /** 预处理被跳过的原因；有值说明 bbox 是**原图**像素坐标 */
  preprocessNote?: string;
}

export interface OcrParseOutcome extends ParseOutcome {
  /** 只给 UI 用；pipeline 不读它，落库不涉及 */
  ocrScan?: OcrScan;
}

export interface OcrAnalyzeOptions {
  mode?: OcrMode;
  binarize?: boolean;
  onProgress?: OcrProgressHandler;
}

export interface OcrAnalysis {
  scan: OcrScan;
  rows: RawRow[];
  issues: ParseIssue[];
}

/* ------------------------------------------------------------------ *
 * 引擎单例
 * ------------------------------------------------------------------ */

interface EngineBundle {
  engine: OcrEngine;
  pack: OcrPackInfo;
}

let bundlePromise: Promise<EngineBundle> | null = null;

async function getEngineBundle(): Promise<EngineBundle> {
  if (bundlePromise) return bundlePromise;
  bundlePromise = (async () => {
    const pack = await checkLangPack();
    if (!pack.available) throw new LedgerError('OCR_FAILED', pack.hint);
    // workerPath / corePath 必须显式指向同源：tesseract.js 的默认值在第三方 CDN 上，
    // 既违反隐私红线（只允许行情域名），也让断网识别直接失效。
    const engine = createTesseractEngine({
      workerPath: ocrWorkerPath(),
      corePath: ocrCorePath(),
      langPath: tessdataBaseUrl(),
      langs: OCR_LANGS,
      gzip: true,
    });
    return { engine, pack };
  })();
  try {
    return await bundlePromise;
  } catch (error) {
    bundlePromise = null;
    throw error instanceof LedgerError
      ? error
      : new LedgerError('OCR_FAILED', `识别引擎启动失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 只识别文本（不含行级 bbox），保留给"只想知道图上写了什么"的调用方 */
export async function recognizeImage(
  image: Blob,
  onProgress?: OcrProgressHandler,
  mode: OcrMode = 'block',
): Promise<OcrResult> {
  const { engine } = await getEngineBundle();
  return engine.recognize(image, { mode, onProgress });
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/**
 * 预处理 → 识别 → 抽行 → 行与 bbox 对齐 → 置信度分级。
 *
 * 说明一处刻意的取舍：预览图用**预处理后**的 blob。
 * 因为 bbox 是在预处理后的像素坐标里给出的，预览必须用同一张图，
 * 否则高亮框会整体偏移（缩放倍率差 1.33 时，右下角的框会偏出好几十像素）。
 */
export async function analyzeImage(blob: Blob, options: OcrAnalyzeOptions = {}): Promise<OcrAnalysis> {
  const mode: OcrMode = options.mode ?? 'block';
  options.onProgress?.({
    stage: 'preprocess',
    label: '预处理图片（放大、灰度、增强对比度）',
    progress: 0,
  });
  const pre = await preprocessImage(blob, { binarize: options.binarize });

  const { engine, pack } = await getEngineBundle();
  options.onProgress?.({
    stage: 'engine',
    label: `加载识别引擎（首次约 ${FIRST_RUN_SECONDS} 秒，之后走缓存）`,
    progress: 0,
  });

  let result: OcrResult;
  try {
    result = await engine.recognize(pre.blob, { mode, onProgress: options.onProgress });
  } catch (error) {
    throw new LedgerError(
      'OCR_FAILED',
      `识别失败：${error instanceof Error ? error.message : String(error)}。可以换一张更清晰的截图，或改用手动记账`,
    );
  }

  // 文本行来自 data.text（用户看到的可读文本），bbox 来自 blocks；
  // 两者顺序基本一致但不保证，所以用 alignOcrLines 显式对齐。
  const textLines = result.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const { rows, issues, lineIndexes } = extractOcrRows(textLines);
  const alignedLineIndexes = alignOcrLines(textLines, result.lines);
  const quality = classifyOcrQuality(result.lines, result.meanConfidence);

  const annotations: OcrRowAnnotation[] = rows.map((row, index) => {
    const lineIndex = alignedLineIndexes[lineIndexes[index]] ?? null;
    const line = lineIndex === null ? null : result.lines[lineIndex];
    return {
      rowIndex: row.rowIndex,
      lineIndex,
      rawText: row.raw ?? '',
      confidence: line ? line.confidence : null,
      bbox: line ? line.bbox : null,
    };
  });

  options.onProgress?.({ stage: 'recognize', label: '识别完成', progress: 1 });

  return {
    scan: {
      engineId: engine.id,
      engineLabel: engine.label,
      mode,
      meanConfidence: result.meanConfidence,
      quality,
      lines: result.lines,
      rows: annotations,
      image: {
        blob: pre.blob,
        width: pre.width,
        height: pre.height,
        scaled: pre.scaled,
        skipped: pre.skipped,
        reason: pre.reason,
      },
      degraded: pack.degraded,
      preprocessNote: pre.skipped ? pre.reason : undefined,
    },
    rows,
    issues,
  };
}

/** 解析整个文件（导入页与 ocrParser 共用同一条路径，避免两套逻辑漂移） */
export async function analyzeImportFile(
  file: ImportFile,
  options: OcrAnalyzeOptions = {},
): Promise<OcrParseOutcome> {
  const blob = new Blob([await file.readArrayBuffer()], { type: file.type || 'image/png' });
  const analysis = await analyzeImage(blob, options);
  if (analysis.rows.length === 0) {
    throw new LedgerError('OCR_FAILED', '没有从图片里识别出可用行，请换一张更清晰的截图或改用手动记账');
  }
  return {
    parserId: 'ocr_image',
    rows: analysis.rows,
    headerMap: { ...ocrParser.fieldHints },
    issues: analysis.issues,
    ocrScan: analysis.scan,
  };
}

/** 从解析结果里安全取出 OCR 扫描信息（非 OCR 路径返回 null） */
export function readOcrScan(outcome: ParseOutcome | null | undefined): OcrScan | null {
  if (!outcome) return null;
  return (outcome as OcrParseOutcome).ocrScan ?? null;
}

/* ------------------------------------------------------------------ *
 * 后处理：从文本行里抽金额 / 日期 / 商户
 * ------------------------------------------------------------------ */

/**
 * 金额：必须带两位小数（账单金额都是两位），并支持千分位。
 * 顺序很重要：千分位分支在前，否则 "1,234.56" 会被切成 "1,23"。
 *
 * 前导正负号**必须保留**：`-241.00` 是支出、`+30.00` 是收入。
 * 这是平台给出的方向，比"扫钱码付款"这类关键词可靠——商户名里没有
 * 「收/付」二字时（如 `蚂蚁财富-定投转入 -241.00`），只有符号能判对方向。
 */
const AMOUNT_SOURCE = String.raw`([-+]?\d{1,3}(?:,\d{3})+\.\d{2}|[-+]?\d+\.\d{2})`;
const AMOUNT_SCAN_RE = new RegExp(AMOUNT_SOURCE, 'g');

/** 行内日期：2026-11-04 / 2026.11.04 / 11月4日 / 12:30 */
const DATE_ONE_RE = /(\d{4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2})|(\d{1,2}\s*月\s*\d{1,2}\s*日)|(\d{1,2}:\d{2})/;
const DATE_ALL_RE = new RegExp(DATE_ONE_RE.source, 'g');

/**
 * 「纯日期行」的三种形态。支付宝/微信的交易列表把时间单独排在商户名**下一行**，
 * OCR 认得出来（`10-19 09:10` 这类小字），但它不含金额，旧实现当噪声丢掉了，
 * 结果每一笔都要手填日期。整行必须**只**是日期时间才认，时分可省。
 */
const DATE_ONLY_FULL_RE = /^(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})(?:\s*(\d{1,2}):(\d{2}))?$/;
const DATE_ONLY_MONTH_DAY_RE = /^(\d{1,2})\s*[-/.]\s*(\d{1,2})(?:\s*(\d{1,2}):(\d{2}))?$/;
const DATE_ONLY_CN_RE = /^(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2}):(\d{2}))?$/;

/**
 * 汇总行的特征词。三条规则都要求"像汇总"而不是"含关键词"（见 isSummaryLine）。
 * 「收支分析」是支付宝月份汇总行右侧的入口文字，最可靠。
 */
const SUMMARY_MONTH_HINTS = ['本月', '上月', '月支出', '月收入'];

/**
 * 货币符号与分隔噪声（OCR 常把竖线/圆点认进来）。
 * 注意这里**不含** `-`：`收钱码付款-给*义` 里的连字符是商户名层级分隔符，
 * 剥掉会把"付款-给"变成"付款 给"，商户名就毁了（支付宝用它区分渠道与对方）。
 */
const NOISE_RE = /[¥￥$|¦·•:：+]/g;

/**
 * 日期单元格旁的推断标记（写进 RawRow.cells 而不是新增字段）。
 *
 * 为什么不加字段：cells 是 `Record<string, string>`，UI 与管线都按列名取值，
 * 加一个"非列"的键不需要动 base.ts 的 RawRow 契约，也不会被 normalizeRow 的
 * fieldMap 命中（它只取 headerMap 里声明的列），零风险。
 * 语义：这一行的日期只给了月-日，年份是按"不晚于今天"推出来的，UI 要提示用户。
 * 常量定义在 ocrTypes.ts（UI 也要读，而本文件必须保持动态 import）。
 */
const DATE_INFERRED_CELL = OCR_DATE_INFERRED_CELL;

export interface OcrExtractOptions {
  /** 注入"今天"，用于年份推断（测试注入固定日期，避免用例随时间漂移） */
  today?: Date;
}

export interface OcrExtractResult {
  rows: RawRow[];
  issues: ParseIssue[];
  /** 与 rows 一一对应：该行在入参 lines 里的下标（用于和 bbox 对齐） */
  lineIndexes: number[];
  /** 与 rows 一一对应：该行日期是否"年份靠推断"（纯日期行只给了 10-19） */
  dateInferred: boolean[];
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

function isValidMonthDay(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function timeText(hour: string | undefined, minute: string | undefined): string {
  if (!hour || !minute) return '';
  return `${pad2(Number(hour))}:${minute}`;
}

/**
 * 「最近一个不晚于今天的同月日」推断年份。
 *
 * 截图上只有 `10-19`。如果直接落到默认年份，会出现两种坏结果：
 * 1. 以为是 1970（Date 纪元）—— 2026 年的账全部跑到"很久以前"，本月统计变 0；
 * 2. 以为是未来（今年 12 月看到 `10-19` 若当成明年）—— 未来的账不算进任何报表。
 * 所以取今年；今年这一天还没到就取去年。同一日的任何时刻都算"不晚于今天"，
 * 只比年月日，不比时分（否则今天 09:00 的账在 08:00 导入会被推成去年）。
 */
function inferYearOfMonthDay(month: number, day: number, today: Date): number {
  const thisYear = today.getFullYear();
  const todayStart = new Date(thisYear, today.getMonth(), today.getDate()).getTime();
  for (const year of [thisYear, thisYear - 1]) {
    const candidate = new Date(year, month - 1, day);
    // 2-29 落在平年会滚到 3-1：滚过的候选日不算数，换下一个年份再试
    if (candidate.getMonth() !== month - 1 || candidate.getDate() !== day) continue;
    if (candidate.getTime() <= todayStart) return year;
  }
  return thisYear - 1;
}

interface ParsedDateOnly {
  /** 'YYYY-MM-DD' */
  date: string;
  /** 'HH:mm'，没有时分时为空串 */
  time: string;
  /** 年份是推断出来的（行内只写了月-日） */
  inferred: boolean;
}

/** 整行只有日期时间时返回解析结果，否则 null（宁可漏，也不能把商户名里的数字当日期）。 */
function parseDateOnlyLine(line: string, today: Date): ParsedDateOnly | null {
  const text = line.trim();
  if (text === '') return null;

  const full = DATE_ONLY_FULL_RE.exec(text);
  if (full) {
    const month = Number(full[2]);
    const day = Number(full[3]);
    if (!isValidMonthDay(month, day)) return null;
    return {
      date: `${full[1]}-${pad2(month)}-${pad2(day)}`,
      time: timeText(full[4], full[5]),
      inferred: false,
    };
  }

  const monthDay = DATE_ONLY_MONTH_DAY_RE.exec(text) ?? null;
  if (monthDay) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    if (!isValidMonthDay(month, day)) return null;
    return {
      date: `${inferYearOfMonthDay(month, day, today)}-${pad2(month)}-${pad2(day)}`,
      time: timeText(monthDay[3], monthDay[4]),
      inferred: true,
    };
  }

  const cn = DATE_ONLY_CN_RE.exec(text);
  if (cn) {
    const month = Number(cn[1]);
    const day = Number(cn[2]);
    if (!isValidMonthDay(month, day)) return null;
    return {
      date: `${inferYearOfMonthDay(month, day, today)}-${pad2(month)}-${pad2(day)}`,
      time: timeText(cn[3], cn[4]),
      inferred: true,
    };
  }
  return null;
}

/**
 * 月份汇总行：截图最上方那行「支出 ¥3,683.22 收入 ¥30.54 收支分析 >」。
 *
 * 为什么必须拦：它不是一笔 30.54 元的收入，而是本月合计。
 * 放它进明细会**凭空多出一笔账**，而且取的还是行内第二个数字（收入 30.54）——
 * 这个数字看起来"很正常"，用户根本不会怀疑，只有对账时才发现多了 30.54 元收入。
 *
 * 三条规则：
 * 1. 含「收支分析」→ 支付宝汇总行的入口文字，单条最可靠；
 * 2. 同时含「支出」「收入」且金额 ≥ 2 → 一笔交易不会同时报两个方向；
 * 3. 含「本月/上月/月支出/月收入」且金额 ≥ 2。
 *
 * 防误杀（很关键）：`余额宝-收益发放 0.94` 只有一个金额，也不是"支出"，
 * 商户名里恰好含"收入"二字不能被吃掉；所以规则 2、3 都先要求 amountCount ≥ 2。
 */
function isSummaryLine(line: string, amountCount: number): boolean {
  if (line.includes('收支分析')) return true;
  if (amountCount < 2) return false;
  if (line.includes('支出') && line.includes('收入')) return true;
  return SUMMARY_MONTH_HINTS.some((hint) => line.includes(hint));
}

/**
 * App 图标噪声的前缀形态。
 *
 * 为什么必须洗：列表项左侧的图标（方框、圆点、徽标）会被 OCR 认成 `◎`、`@`、`「`、
 * `G`、`(2)`、`2`，粘在商户名最前面。这些字符不影响金额，但会让"上个月在蚂蚁财富
 * 花了多少"这种按商户聚合的结果分裂成 `◎ 蚂蚁财富` / `(2) 蚂蚁财富` 好几个"不同"商户。
 *
 * 只剥离开头：中间的括号、连字符是真实内容（`美团(北京)`、`7-11`）。
 */
const ICON_PREFIX_RULES: readonly RegExp[] = [
  // (2) / （12） ：消息数徽标
  /^[（(]\s*\d{1,2}\s*[)）]\s*/,
  // 单个大写字母 + 空格：图标被认成 "G"；空格交给循环里的 trim 处理
  /^[A-Z](?=\s)/,
  // 单个数字 + 空格 + 中文：图标被认成 "2"。
  // 只有 1 位数字才剥（`85度C` 没有空格、`7 天酒店` 这种会被剥掉 7，代价可接受：
  // 剥错只是少个数字，留着则是每张截图都带一条噪声）
  /^\d\s+(?=[\u4e00-\u9fff])/,
  // 开头任意一个非中文/非字母数字的字符（◎ @ 「 ○ ● ► 等），逐个剥
  /^[^\u4e00-\u9fffA-Za-z0-9*\-]/u,
];

/**
 * 清洗商户名开头的图标噪声。
 *
 * 红线（业务语义，绝对不能剥）：
 * - `*` 是支付宝的脱敏姓名（`*义`），剥掉就认不出对方是谁；
 * - `-` 是商户层级分隔符（`收钱码付款-给*义`），剥掉会把"付款-给"读成"付款 给"。
 */
function cleanMerchantPrefix(raw: string): string {
  let text = raw.trim();
  // 上界防止规则互相"喂"出无限循环（实际 2~3 轮就稳定）
  for (let round = 0; round < 12; round += 1) {
    const before = text;
    for (const rule of ICON_PREFIX_RULES) text = text.replace(rule, '');
    text = text.replace(/^\s+/, '');
    if (text === before) break;
  }
  return text;
}

/**
 * 一张截图里的每一行 → 待确认行。
 *
 * 优先级说明：
 * - 汇总行先拦掉，它是最贵的一种错（凭空一笔账）；
 * - 纯日期行归属给**上方最近那笔**交易（版式是商户在上、时间在下）；
 * - 金额取行内**最后一个**：小票常见「原价 12.00 优惠 -1.00 实付 11.00」，实付在最后；
 * - 先把日期整体摘掉再找金额：否则 "2026.11.04" 会被正则吃掉一段当成 "11.04"；
 * - 金额、日期都摘掉，剩下的才是商户名，中英混排都保留。
 */
export function extractOcrRows(lines: readonly string[], options: OcrExtractOptions = {}): OcrExtractResult {
  const today = options.today ?? new Date();
  const rows: RawRow[] = [];
  const issues: ParseIssue[] = [];
  const lineIndexes: number[] = [];
  const dateInferred: boolean[] = [];
  /** 上一条交易行在 rows 里的下标；-1 表示还没有交易行 */
  let lastRowIndex = -1;
  /** 真正没日期的行，等全部跑完再记 issue：纯日期行可能在后面才补上 */
  const missingDate: Array<{ row: number; raw: string }> = [];

  lines.forEach((line, index) => {
    const rowNumber = index + 1;
    const dateMatch = DATE_ONE_RE.exec(line);
    const withoutDate = line.replace(DATE_ALL_RE, ' ');
    const amounts = [...withoutDate.matchAll(AMOUNT_SCAN_RE)];

    // ① 月份汇总行：整行是「支出 X 收入 Y」，不是一笔交易
    if (amounts.length > 0 && isSummaryLine(line, amounts.length)) {
      issues.push({
        row: rowNumber,
        reason: '整行是月份汇总（支出/收入合计），不是一笔交易，已跳过',
        raw: line,
      });
      return;
    }

    if (amounts.length === 0) {
      // ② 纯日期行：补给它上方那笔交易
      const dateOnly = parseDateOnlyLine(line, today);
      if (dateOnly) {
        const target = lastRowIndex >= 0 ? rows[lastRowIndex] : undefined;
        // 只归属给上一条**日期为空**的交易：已有日期不覆盖（那是这笔交易自己的日期），
        // 也不往上再找一条——把时间安到别的交易头上比留空更坏。
        if (target && !target.cells['日期']) {
          target.cells['日期'] = dateOnly.time ? `${dateOnly.date} ${dateOnly.time}` : dateOnly.date;
          if (dateOnly.inferred) {
            target.cells[OCR_DATE_INFERRED_CELL] = '1';
            dateInferred[lastRowIndex] = true;
          }
        }
        return;
      }
      issues.push({ row: rowNumber, reason: '这一行没有找到金额', raw: line });
      return;
    }

    const amountText = amounts[amounts.length - 1][1] ?? '';
    const amount = amountText.replace(/,/g, '');
    if (!amount || Number.isNaN(Number(amount))) {
      issues.push({ row: rowNumber, reason: '金额看起来不是一个数字', raw: line });
      return;
    }

    const merchantRaw = withoutDate
      .replace(AMOUNT_SCAN_RE, ' ')
      .replace(NOISE_RE, ' ')
      .replace(/\s*[元圆]$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const merchant = cleanMerchantPrefix(merchantRaw);
    if (merchant === '') {
      // 不留空：宁可留一条带噪声的原文让用户改，也不能给一个空商户名
      issues.push({ row: rowNumber, reason: '商户名清洗后为空，已回退原文，请手动填写', raw: line });
    }
    const merchantFinal = merchant || merchantRaw || line;

    rows.push({
      rowIndex: rowNumber,
      cells: {
        日期: dateMatch ? dateMatch[0] : '',
        金额: amount,
        项目: merchantFinal.slice(0, 40),
        备注: 'OCR 识别，请核对',
      },
      raw: line,
    });
    lineIndexes.push(index);
    dateInferred.push(false);
    lastRowIndex = rows.length - 1;

    if (!dateMatch) missingDate.push({ row: rowNumber, raw: line });
  });

  for (const item of missingDate) {
    const row = rows.find((candidate) => candidate.rowIndex === item.row);
    if (row && !row.cells['日期']) {
      issues.push({ row: item.row, reason: '没有识别到日期，需要手填', raw: item.raw });
    }
  }

  return { rows, issues, lineIndexes, dateInferred };
}

export const ocrParser: Parser = {
  id: 'ocr_image',
  label: '截图识别（本地 OCR）',
  fieldHints: {
    occurred_at: '日期',
    amount: '金额',
    counterparty: '项目',
    note: '备注',
  },
  canHandle(file) {
    return /^image\//.test(file.type) || /\.(png|jpe?g|webp|bmp)$/i.test(file.name);
  },
  async parse(file, _opts): Promise<ParseOutcome> {
    return analyzeImportFile(file);
  },
  isSummaryRow(row) {
    return Object.values(row.cells).some((value) => /合计|小计|总计/.test(value));
  },
};
