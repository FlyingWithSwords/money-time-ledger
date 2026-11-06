/**
 * 持仓截图 OCR 行提取（纯逻辑，零依赖、零副作用）。
 *
 * 为什么单独一层：支付宝/天天基金持仓页的行结构（代码/名称/份额/金额/净值）
 * 与账单截图（商户/金额/日期）完全不同，塞进 parsers/ocr.ts 会让两条解析链
 * 互相污染。这里只做「OCR 行 → 结构化持仓行」，输入输出都是纯数据，
 * 引擎调用、UI、落库都在别的层，测试不需要 mock 任何东西。
 *
 * 两条通道，红线不同：
 * - `extractHoldingRows`：**严格版式**（代码 + 份额 + 金额/净值），无代码一律
 *   不进 rows。这是「可直接入库」的唯一来源。
 * - `extractHoldingCandidates`：**宽松版式**（支付宝持仓列表：名称 + 金额），
 *   只产出「待人工补全的候选」，missing 字段明确告诉 UI 还缺什么。
 *   候选绝不直接入库——错误入账比不入账更糟。
 *
 * 设计红线（来自需求原话「错误入账比不入账更糟」）：
 * - 一行多数字的归属按「[代码] [份额] [金额] [净值]」的位置顺序猜，
 *   但任何无法唯一归属的行**宁可进 unmatched 交人工**，绝不瞎猜；
 * - 汇总行（总资产/持仓收益…）没有代码，先拦掉——它混进来会变成假持仓。
 */

/** OCR 行的最小输入（bbox 可选：纯文本测试不传，真实 OCR 一定带） */
export interface HoldingLineInput {
  text: string;
  confidence: number;
  bbox?: { x0: number; y0: number; x1: number; y1: number } | null;
}

/** 一条已解析的持仓行（严格版式，可直接入库） */
export interface HoldingOcrRow {
  fund_code: string;
  fund_name: string;
  /** 份额（基金）/ 克重（黄金） */
  shares: number;
  /** 能识别到金额时给（分）。截图通常只有市值没有成本，成本由 holdingRepo 反推。 */
  market_value_cents?: number;
  /** 能识别到净值/单位成本时给 */
  current_nav?: number;
  /** 来源 OCR 行的置信度（0–100），UI 用它标黄低置信行 */
  confidence: number;
  /** 原始行文本，校对界面逐字对照用 */
  raw: string;
}

export interface HoldingOcrResult {
  rows: HoldingOcrRow[];
  /** 看起来像持仓但没能安全解析的行原文，交给人工 */
  unmatched: string[];
  /** 有效行的平均置信度（0–100）；没有有效行时为 0 */
  meanConfidence: number;
}

/**
 * 列表页候选（宽松版式）。
 * 支付宝「基金 → 我的持仓」只显示名称 + 持仓金额 + 收益，没有代码和份额，
 * 因此这里如实标出 missing，由用户在核对界面补全，绝不自动入库。
 */
export interface HoldingCandidate {
  fund_name: string;
  /** 无符号金额（市值），分 */
  market_value_cents?: number;
  /** 识别到代码时给（详情页版式） */
  fund_code?: string;
  /** 识别到份额时给（详情页版式） */
  shares?: number;
  confidence: number;
  raw: string;
  /** 还缺哪些入库必需字段 */
  missing: Array<'code' | 'shares'>;
}

export interface HoldingCandidateResult {
  candidates: HoldingCandidate[];
  unmatched: string[];
  /** 识别到含中文的行数：用来诊断「深色截图到底有没有认出中文」 */
  chineseLineCount: number;
}

/* ------------------------------------------------------------------ *
 * Token 分类
 * ------------------------------------------------------------------ */

/**
 * 基金/黄金代码形态：
 * - 6 位纯数字（`000051`、`110022`、场内 `518880`）；
 * - 字母开头的场内/黄金代号（`AU9999`、`GLNC`）——黄金按克重，代码不强制 6 位。
 *
 * 纯字母词（ETF/LOF…）形态上与 GLNC 无法区分，但又几乎不可能单独成
 * 「代码 token」（名称里的 ETF 总是粘着前后文），这里用小黑名单排除
 * 高频金融缩写，宁可漏认也不把「华夏 ETF」认成代码。
 */
const LETTER_CODE_BLOCKLIST = new Set(['ETF', 'LOF', 'NAV', 'QDII', 'FOF', 'REIT', 'APP']);

const SIX_DIGIT_CODE_RE = /^\d{6}$/;
const LETTER_CODE_RE = /^[A-Za-z]{2,6}[0-9]{0,6}$/;

function isCodeToken(token: string): boolean {
  if (SIX_DIGIT_CODE_RE.test(token)) return true;
  if (LETTER_CODE_RE.test(token) && !LETTER_CODE_BLOCKLIST.has(token.toUpperCase())) return true;
  return false;
}

/** 份额形态：千分位/小数 + 「份」或「克」（黄金）。有单位字样就是铁的份额证据。 */
const SHARES_UNIT_RE = /^[\d,]+(?:\.\d+)?[份克]$/;
/** 金额形态：`¥3,638.90` / `￥3638.90`（OCR 常把 ¥ 认成全角￥）。 */
const AMOUNT_PREFIX_RE = /^[¥￥][\d,]+(?:\.\d{1,4})?$/;
/** 金额形态：`3,638.90元`（天天基金风格）。 */
const AMOUNT_SUFFIX_RE = /^[\d,]+(?:\.\d{1,4})?元$/;
/** 千分位形态：`1,234.56` / `12,345`（分组必须严格 3 位一组，乱逗号宁可不当数字） */
const PLAIN_THOUSANDS_RE = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
/** 普通数字形态：`1234.56` / `2.9501`（允许纯整数，但是否算持仓证据由调用方决定） */
const PLAIN_DECIMAL_RE = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * 无标记数字：千分位或小数二选一必须有——纯整数（`100`）既可能是定投金额
 * 也可能是页码，谁都不是持仓证据，直接不算数。
 */
function isPlainNumber(token: string): boolean {
  if (PLAIN_THOUSANDS_RE.test(token)) return true;
  if (!PLAIN_DECIMAL_RE.test(token)) return false;
  return token.includes('.');
}

function isQuantityLike(token: string): boolean {
  return SHARES_UNIT_RE.test(token) || AMOUNT_PREFIX_RE.test(token) || AMOUNT_SUFFIX_RE.test(token) || isPlainNumber(token);
}

/**
 * 净值候选：无千分位、≥3 位小数、值 < 1000。
 * 依据：基金净值几乎都是 `2.9501` 这种形态（4 位小数、不上千），
 * 而金额/份额要么有 ¥/元/份标记，要么是 2 位小数。用它把
 * 「份额+净值但没金额」的行救回来（否则净值会按位置顺序错记成金额）。
 */
function isNavCandidate(token: string): boolean {
  if (!isPlainNumber(token) || token.includes(',')) return false;
  const dotIndex = token.indexOf('.');
  if (dotIndex < 0) return false;
  if (token.length - dotIndex - 1 < 3) return false;
  const value = Number(token);
  return Number.isFinite(value) && value > 0 && value < 1000;
}

/**
 * 列表页的「持仓金额」：无正负号、无 %、不是净值形态。
 *
 * 为什么用正负号区分金额和收益：支付宝持仓列表里持仓金额永远不带符号，
 * 而收益一律带 `+`/`-`（`+301.73`、`-6.66`）。这是比字号更可靠的信号，
 * 也避免依赖 bbox 高度做字号推断。
 */
function isListAmount(token: string): boolean {
  if (token.startsWith('+') || token.startsWith('-') || token.includes('%')) return false;
  if (!isPlainNumber(token)) return false;
  if (isNavCandidate(token)) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * 数值解析（整数运算，杜绝浮点乘法）
 * ------------------------------------------------------------------ */

/** 份额/克重：剥掉单位与千分位后 Number() 再收 4 位小数（与 holdingRepo.round4 对齐）。 */
function parseShares(token: string): number {
  const value = Number(token.replace(/[份克,]/g, ''));
  if (!Number.isFinite(value)) return NaN;
  return Math.round(value * 10000) / 10000;
}

/**
 * 金额 → 分：按十进制位拆开做整数拼接，不走 `x * 100` 浮点乘法
 * （`3638.90 * 100 === 363889.999…` 这种错一分都不能有）。
 */
function parseCents(token: string): number | undefined {
  const digits = token.replace(/[¥￥元,]/g, '').replace(/^\+/, '');
  if (!/^\d+(?:\.\d+)?$/.test(digits)) return undefined;
  const dotIndex = digits.indexOf('.');
  const intPart = dotIndex >= 0 ? digits.slice(0, dotIndex) : digits;
  const fracPart = dotIndex >= 0 ? digits.slice(dotIndex + 1) : '';
  const intCents = Number(intPart) * 100;
  const fracCents = Number(`${fracPart}00`.slice(0, 2));
  return intCents + fracCents;
}

/* ------------------------------------------------------------------ *
 * 名称清洗（简版，独立于 parsers/ocr.ts 的 cleanMerchantPrefix）
 * ------------------------------------------------------------------ *
 * 为什么不 import 那份：parsers/ocr.ts 会连带动态 import tesseract，
 * 纯逻辑模块拖引擎进测试就废了。规则也简化了——这里没有 `*` 脱敏姓名、
 * `-` 层级分隔符那种业务红线，只需要剥 OCR 把图标认出来的前导噪声。
 */
const ICON_PREFIX_RULES: readonly RegExp[] = [
  // 开头的单个符号（◎ @ 「 ○ ● ► 等），图标噪声
  /^[^\u4e00-\u9fffA-Za-z0-9]+/u,
  // 单个大写字母 + 空格：图标被认成 "G"
  /^[A-Z]\s+(?=[\u4e00-\u9fff])/,
  // 单个数字 + 空格 + 中文：图标被认成 "2"（只剥 1 位，多位数更可能是真实内容）
  /^\d\s+(?=[\u4e00-\u9fff])/,
];

function cleanNamePrefix(raw: string): string {
  let text = raw.trim();
  // 上界防规则互相「喂」出死循环（实际 2~3 轮就稳定）
  for (let round = 0; round < 12; round += 1) {
    const before = text;
    for (const rule of ICON_PREFIX_RULES) text = text.replace(rule, '');
    text = text.replace(/^\s+/, '');
    if (text === before) break;
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * 汇总行过滤
 * ------------------------------------------------------------------ */

/**
 * 汇总/操作行关键词。这些行没有代码、混进来会凭空多出一笔「假持仓」，
 * 且它们几乎总是和真持仓同屏出现，必须先拦。
 * 「含关键词且无代码才丢」——真持仓行带「定投」字样（如「定投计划 000051…」）
 * 不能误伤，那种行有代码，按持仓行正常解析。
 */
const SUMMARY_KEYWORDS: readonly string[] = [
  '总资产',
  '持仓收益',
  '昨日收益',
  '累计收益',
  '收益率',
  '买入',
  '卖出',
  '定投',
  '赎回',
  '转换',
  '合计',
  '搜索',
];

function isSummaryLine(text: string): boolean {
  return SUMMARY_KEYWORDS.some((keyword) => text.includes(keyword));
}

const CHINESE_RUN_RE = /[\u4e00-\u9fff]{2,}/;

function hasChinese(text: string): boolean {
  return CHINESE_RUN_RE.test(text);
}

/* ------------------------------------------------------------------ *
 * 版面重组：把被 OCR 切碎的同一行拼回来
 * ------------------------------------------------------------------ */

function centerY(line: HoldingLineInput): number {
  const box = line.bbox;
  return box ? (box.y0 + box.y1) / 2 : 0;
}

function boxHeight(line: HoldingLineInput): number {
  const box = line.bbox;
  return box ? Math.max(0, box.y1 - box.y0) : 0;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * 按纵向位置把行聚成「视觉行」，同一视觉行内按 x 从左到右拼接。
 *
 * 为什么需要：PSM.SPARSE_TEXT 会把同一张卡片左侧的基金名称和右侧的金额
 * 切成两条独立 line。不拼回来的话，名称行（无数字）被丢弃、金额行
 * （无代码）进 unmatched，用户看到的就是「一堆数字、0 笔持仓」。
 *
 * 只有八成以上的行都带有效 bbox 才做重组；否则原样返回，
 * 避免纯文本测试/异常数据被错误合并。
 */
function mergeVisualRows(lines: readonly HoldingLineInput[]): HoldingLineInput[] {
  const withBox = lines.filter((line) => {
    const box = line.bbox;
    return Boolean(box && box.x1 > box.x0 && box.y1 > box.y0);
  });
  if (withBox.length < 2 || withBox.length < lines.length * 0.8) return [...lines];

  const tolerance = Math.max(6, median(withBox.map(boxHeight)) * 0.6);
  const sorted = [...withBox].sort((a, b) => centerY(a) - centerY(b));
  const groups: HoldingLineInput[][] = [];
  for (const line of sorted) {
    const last = groups[groups.length - 1];
    if (last) {
      const reference = centerY(last[last.length - 1]);
      if (Math.abs(centerY(line) - reference) <= tolerance) {
        last.push(line);
        continue;
      }
    }
    groups.push([line]);
  }

  return groups.map((group) => {
    const ordered = [...group].sort((a, b) => (a.bbox?.x0 ?? 0) - (b.bbox?.x0 ?? 0));
    const boxes = ordered.map((line) => line.bbox).filter((box): box is NonNullable<typeof box> => Boolean(box));
    return {
      text: ordered.map((line) => line.text.trim()).filter(Boolean).join(' '),
      // 取最低置信度：一个视觉行里只要有一段没认准，整行就该被标黄
      confidence: Math.min(...ordered.map((line) => line.confidence)),
      bbox: {
        x0: Math.min(...boxes.map((box) => box.x0)),
        y0: Math.min(...boxes.map((box) => box.y0)),
        x1: Math.max(...boxes.map((box) => box.x1)),
        y1: Math.max(...boxes.map((box) => box.y1)),
      },
    };
  });
}

/* ------------------------------------------------------------------ *
 * 主流程 A：严格版式（可直接入库）
 * ------------------------------------------------------------------ */

/**
 * OCR 行 → 持仓行。
 *
 * 每行的判定顺序：
 * 1. 汇总/操作行（无代码 + 命中关键词）→ 整行丢弃，不进 unmatched；
 * 2. 无代码但有数字 → unmatched（可能是代码漏识别的持仓，交人工）；
 * 3. 有代码：数字按「[份额] [金额] [净值]」的位置顺序分配到空位，
 *    净值候选优先填净值位；任何一个数字无处安放 / 份额缺失 → unmatched；
 * 4. 名称 = 第一个数字 token 之前的文本去掉代码 token（兼容「代码在名称前」
 *    的天天基金版式），再做图标噪声清洗。
 */
export function extractHoldingRows(lines: readonly HoldingLineInput[]): HoldingOcrResult {
  const rows: HoldingOcrRow[] = [];
  const unmatched: string[] = [];

  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    const tokens = text.split(/\s+/);
    const codeTokens = tokens.filter((token) => isCodeToken(token));

    // ① 无代码行：汇总行丢弃；带数字的才值得人工看一眼
    if (codeTokens.length === 0) {
      if (isSummaryLine(text)) continue;
      if (tokens.some((token) => isQuantityLike(token))) unmatched.push(text);
      continue;
    }

    // ② 多个代码 = 两笔持仓挤在一行（sparse OCR 偶发），拆不开就整行交人工
    if (codeTokens.length > 1) {
      unmatched.push(text);
      continue;
    }

    const code = codeTokens[0];
    let shares: number | undefined;
    let marketValueCents: number | undefined;
    let currentNav: number | undefined;
    let ambiguous = false;
    const plains: string[] = [];

    for (const token of tokens) {
      if (token === code) continue;
      if (SHARES_UNIT_RE.test(token)) {
        if (shares !== undefined) {
          ambiguous = true; // 两个份额数，无法判断哪个是真的
          continue;
        }
        shares = parseShares(token);
      } else if (AMOUNT_PREFIX_RE.test(token) || AMOUNT_SUFFIX_RE.test(token)) {
        if (marketValueCents !== undefined) {
          ambiguous = true; // 两个金额（金额+成本并存），快照该记哪个说不清
          continue;
        }
        marketValueCents = parseCents(token);
      } else if (isPlainNumber(token)) {
        plains.push(token);
      }
    }

    // ③ 无标记数字按位置顺序分配：净值候选优先，其余按 [份额] [金额] 补空位。
    //    有数字无处安放（第 4 个以后的数字）说明版式没见过——交人工。
    for (const plain of plains) {
      if (isNavCandidate(plain)) {
        if (currentNav === undefined) {
          currentNav = Math.round(Number(plain) * 10000) / 10000;
          continue;
        }
        ambiguous = true;
        continue;
      }
      if (shares === undefined) {
        shares = parseShares(plain);
        continue;
      }
      if (marketValueCents === undefined) {
        marketValueCents = parseCents(plain);
        continue;
      }
      ambiguous = true;
    }

    if (ambiguous || shares === undefined || !Number.isFinite(shares) || shares <= 0) {
      unmatched.push(text);
      continue;
    }

    // ④ 名称：第一个数字 token 之前的文本（去掉代码），兼容天天基金「代码在名称前」
    const firstQuantityIndex = tokens.findIndex((token) => token !== code && isQuantityLike(token));
    const nameSlice = firstQuantityIndex < 0 ? tokens : tokens.slice(0, firstQuantityIndex);
    const fundName = cleanNamePrefix(nameSlice.filter((token) => token !== code).join(' '));

    const row: HoldingOcrRow = {
      fund_code: code,
      fund_name: fundName,
      shares,
      confidence: line.confidence,
      raw: text,
    };
    if (marketValueCents !== undefined) row.market_value_cents = marketValueCents;
    if (currentNav !== undefined) row.current_nav = currentNav;
    rows.push(row);
  }

  // ⑤ 均值只算有效行：unmatched 行的置信度不代表持仓质量
  const meanConfidence =
    rows.length === 0
      ? 0
      : Math.round((rows.reduce((sum, row) => sum + row.confidence, 0) / rows.length) * 10) / 10;

  return { rows, unmatched, meanConfidence };
}

/* ------------------------------------------------------------------ *
 * 主流程 B：列表页候选（只给校对界面，绝不自动入库）
 * ------------------------------------------------------------------ */

/**
 * 从一段 OCR 文本里提取「名称 + 持仓金额」。
 *
 * 只认两类信号，其余一律不猜：
 * - 名称：至少两个连续汉字（英文碎片 `an mm` 不算）；
 * - 金额：无正负号、非百分比、非净值形态的数字。
 *   带 `+`/`-` 的是收益，带 `%` 的是收益率，两者都不当市值。
 *
 * 若一行里出现多个候选金额，取绝对值最大的一个：同一张卡片上
 * 持仓金额一定大于收益（收益是持仓的零头），这是比位置更稳的判据。
 */
function parseListLine(line: HoldingLineInput): HoldingCandidate | null {
  const text = line.text.trim();
  if (!text || isSummaryLine(text)) return null;
  if (!hasChinese(text)) return null;

  const tokens = text.split(/\s+/);
  const code = tokens.find((token) => isCodeToken(token));
  const amounts = tokens.filter((token) => isListAmount(token));
  const sharesToken = tokens.find((token) => SHARES_UNIT_RE.test(token));

  // 名称 = 去掉代码、数字、百分数后的中文/字母片段
  const nameSource = tokens
    .filter((token) => token !== code && !isQuantityLike(token) && !token.includes('%'))
    .join(' ');
  const fundName = cleanNamePrefix(nameSource).replace(/\s{2,}/g, ' ').trim();
  if (!hasChinese(fundName)) return null;

  const marketValueCents =
    amounts.length === 0
      ? undefined
      : parseCents(
          amounts.reduce((best, token) => {
            const current = Math.abs(Number(token.replace(/,/g, '')));
            const bestValue = Math.abs(Number(best.replace(/,/g, '')));
            return current > bestValue ? token : best;
          }),
        );

  const shares = sharesToken ? parseShares(sharesToken) : undefined;

  // 既没有金额也解析不出份额：不是持仓证据
  if (marketValueCents === undefined && (shares === undefined || !Number.isFinite(shares))) return null;

  const missing: Array<'code' | 'shares'> = [];
  if (!code) missing.push('code');
  if (shares === undefined || !Number.isFinite(shares) || shares <= 0) missing.push('shares');

  const candidate: HoldingCandidate = {
    fund_name: fundName,
    confidence: line.confidence,
    raw: text,
    missing,
  };
  if (marketValueCents !== undefined) candidate.market_value_cents = marketValueCents;
  if (code) candidate.fund_code = code;
  if (shares !== undefined && Number.isFinite(shares)) candidate.shares = shares;
  return candidate;
}

/**
 * 相邻行配对：名称一行、金额一行（上下版式）时把它们接起来。
 *
 * 只在「上一行是纯名称（有中文、无数字）且下一行是纯金额（单个无符号金额、
 * 无中文）」且纵向距离不超过两倍行高时才合并。任何含糊情况都不配对——
 * 把 A 的金额配到 B 的名称上，就是一次错误入账。
 */
function pairAdjacentRows(lines: readonly HoldingLineInput[]): HoldingLineInput[] {
  const result: HoldingLineInput[] = [];
  let pendingName: HoldingLineInput | null = null;

  const looksLikeNameOnly = (line: HoldingLineInput): boolean => {
    const tokens = line.text.trim().split(/\s+/);
    return hasChinese(line.text) && !tokens.some((token) => isQuantityLike(token) || token.includes('%'));
  };
  const looksLikeAmountOnly = (line: HoldingLineInput): boolean => {
    const tokens = line.text.trim().split(/\s+/);
    return !hasChinese(line.text) && tokens.filter((token) => isListAmount(token)).length === 1 && tokens.length <= 2;
  };

  for (const line of lines) {
    if (pendingName && looksLikeAmountOnly(line)) {
      const gap =
        pendingName.bbox && line.bbox ? Math.abs(centerY(line) - centerY(pendingName)) : Number.POSITIVE_INFINITY;
      const allowance = Math.max(boxHeight(pendingName), boxHeight(line), 12) * 2.2;
      if (gap <= allowance) {
        result.push({
          text: `${pendingName.text.trim()} ${line.text.trim()}`,
          confidence: Math.min(pendingName.confidence, line.confidence),
          bbox: pendingName.bbox ?? line.bbox ?? null,
        });
        pendingName = null;
        continue;
      }
    }
    if (pendingName) {
      result.push(pendingName);
      pendingName = null;
    }
    if (looksLikeNameOnly(line)) {
      pendingName = line;
      continue;
    }
    result.push(line);
  }
  if (pendingName) result.push(pendingName);
  return result;
}

/**
 * 列表页候选提取（支付宝「我的持仓」版式）。
 *
 * 输入可以是原始 OCR 行（带 bbox）；先做视觉行重组，再做相邻配对，
 * 最后逐行抽名称与金额。整个过程只产出候选，不产出可入库行。
 */
export function extractHoldingCandidates(lines: readonly HoldingLineInput[]): HoldingCandidateResult {
  const chineseLineCount = lines.filter((line) => hasChinese(line.text)).length;
  const merged = pairAdjacentRows(mergeVisualRows(lines));

  const candidates: HoldingCandidate[] = [];
  const unmatched: string[] = [];
  const seen = new Set<string>();

  for (const line of merged) {
    const text = line.text.trim();
    if (!text) continue;
    const candidate = parseListLine(line);
    if (!candidate) {
      // 有数字但不是汇总行、也凑不出名称的行才值得给用户看；纯标题/操作行不刷屏
      if (line.text.split(/\s+/).some((token) => isQuantityLike(token)) && !isSummaryLine(text)) {
        unmatched.push(text);
      }
      continue;
    }
    // 同名同金额的重复行（长截图分段重叠区可能重复）只留一条，取置信度高的
    const key = `${candidate.fund_name}::${candidate.market_value_cents ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }

  return { candidates, unmatched, chineseLineCount };
}
