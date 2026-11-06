import type { ImportFile } from '../../import/base';

/**
 * 微信账单「真实形态」脱敏 fixture 生成器。
 *
 * 为什么不提交 .xlsx 二进制：
 * 1. 用户真实账单里是真实消费记录（商户、时间、金额、单号），进 git 等于泄露隐私；
 * 2. 二进制无法 review，金额/行数改了也看不出来。
 * 所以表头文字、17 行前缀的行数与位置、11 列顺序、收/支与状态的取值分布**照抄真实文件**，
 * 只把金额、商户、单号换成生成值，并在测试里用 xlsx 库现算成字节。
 *
 * 真实文件（A1:K207，单 sheet）的结构：
 *   0 标题 → 1 昵称 → 2 起止时间 → 3 导出类型 → 4 导出时间 → 5 空行
 *   → 6 共N笔记录 → 7 收入 → 8 支出 → 9 中性交易 → 10 注： → 11~14 四条说明
 *   → 15 空行 → 16 分隔线 → **17 表头** → 18 起明细
 */

export const WECHAT_HEADER = [
  '交易时间',
  '交易类型',
  '交易对方',
  '商品',
  '收/支',
  '金额(元)',
  '支付方式',
  '当前状态',
  '交易单号',
  '商户单号',
  '备注',
] as const;

export type WechatBlock = 'income' | 'expense' | 'neutral';

interface Draft {
  block: WechatBlock;
  status: string;
  tradeType: string;
  counterparty: string;
  goods: string;
  payMethod: string;
  /** 金额（分）。全程整数，绝不出现浮点乘法 */
  cents: number;
  /** 部分退款行按真实形态写成 43 元档 */
  forceCents?: number;
}

/**
 * 状态分配表：总数与真实文件完全一致（189 行）。
 * 真实的退款 10 笔里 6 笔原本是「支出」、4 笔原本是「收入」；
 * 这里按 7/3 分配（两边都覆盖到），仍保留"退款行会出现在收入侧"这个关键形态。
 */
const REFUND_FULL = '已全额退款';
const REFUND_PARTIAL_1 = '已退款¥43.00';
const REFUND_PARTIAL_2 = '已退款(¥43.00)';

function buildDrafts(): Draft[] {
  const drafts: Draft[] = [];

  // ── 收入 45 行：已存入零钱 37 + 到账成功 1 + 已转账 0 + 已全额退款 2 + 已退款¥43.00 1 ──
  for (let i = 0; i < 41; i += 1) {
    drafts.push({
      block: 'income',
      status: '已存入零钱',
      tradeType: i % 2 === 0 ? '微信红包' : '转账',
      counterparty: `好友${String.fromCharCode(65 + (i % 26))}`,
      goods: '/',
      payMethod: '/',
      cents: 200 + (i % 47) * 13,
    });
  }
  drafts.push({
    block: 'income',
    status: '到账成功',
    tradeType: '转账',
    counterparty: '好友转入',
    goods: '转账备注:微信转账',
    payMethod: '/',
    cents: 20000,
  });
  for (let i = 0; i < 2; i += 1) {
    drafts.push({
      block: 'income',
      status: REFUND_FULL,
      tradeType: '某商户-退款',
      counterparty: '某商户',
      goods: '某商户',
      payMethod: '零钱通',
      cents: 699 + i * 300,
    });
  }
  drafts.push({
    block: 'income',
    status: REFUND_PARTIAL_1,
    tradeType: '某平台-退款',
    counterparty: '某平台',
    goods: '某平台',
    payMethod: '零钱',
    cents: 4300,
  });

  // ── 支出 120 行：支付成功 91 + 对方已收钱 11 + 已转账 11 + 已全额退款 6 + 已退款(¥43.00) 1 ──
  const expensePlan: Array<[string, number]> = [
    ['支付成功', 91],
    ['对方已收钱', 11],
    ['已转账', 11],
    [REFUND_FULL, 6],
    [REFUND_PARTIAL_2, 1],
  ];
  const tradeTypes = ['商户消费', '扫二维码付款', '群收款'];
  let expenseIndex = 0;
  for (const [status, count] of expensePlan) {
    for (let i = 0; i < count; i += 1) {
      const tradeType = tradeTypes[expenseIndex % tradeTypes.length];
      drafts.push({
        block: 'expense',
        status,
        tradeType,
        counterparty: `商户${(expenseIndex % 40) + 1}`,
        // 「群收款」「收款方备注:二维码收款」是真实账单里的关键词陷阱：
        // 它们含「收款」二字，但收/支列明写「支出」，绝不能被判成收入
        goods: tradeType === '扫二维码付款' ? '收款方备注:二维码收款' : '/',
        payMethod: expenseIndex % 2 === 0 ? '零钱' : '零钱通',
        cents: 150 + (expenseIndex % 89) * 17,
        forceCents: status === REFUND_PARTIAL_2 ? 4550 : undefined,
      });
      expenseIndex += 1;
    }
  }

  // ── 「/」中性交易 24 行：充值完成 7 + 提现已到账 3 + 已转账 13 + 提现失败 1 ──
  const neutralPlan: Array<[string, string, number]> = [
    ['充值完成', '零钱充值', 7],
    ['提现已到账', '零钱提现', 3],
    ['已转账', '转入零钱通-来自零钱', 13],
    ['提现失败，已退回零钱', '零钱提现', 1],
  ];
  let neutralIndex = 0;
  for (const [status, tradeType, count] of neutralPlan) {
    for (let i = 0; i < count; i += 1) {
      drafts.push({
        block: 'neutral',
        status,
        tradeType,
        counterparty: '/',
        goods: '/',
        payMethod: '零钱',
        cents: 5000 + (neutralIndex % 97) * 500,
      });
      neutralIndex += 1;
    }
  }

  return drafts;
}

/** 2020-01-01 00:00:00 往前每笔退 37 分钟，按 UTC 计算（不依赖本机时区）。 */
function stampAt(index: number): string {
  const base = Date.UTC(2020, 0, 1, 0, 0, 0) - index * 37 * 60 * 1000;
  const date = new Date(base);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/** 分 → 微信账单里的金额文本（'12.3'、'0.5'、'3650'，与真实导出一样不补零）。 */
function formatAmount(cents: number): string {
  const yuan = Math.floor(cents / 100);
  const frac = cents % 100;
  if (frac === 0) return String(yuan);
  return `${yuan}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}

export interface WechatRealShapeMeta {
  /** 明细行数（= 189） */
  rows: number;
  /** 各收/支块的行数（文件"收/支"列原文口径） */
  declared: Record<WechatBlock, { n: number; cents: number }>;
  /** 退款类行数与合计（跨两侧） */
  refund: { n: number; cents: number };
  /** 退款原本记在支出侧 / 收入侧的金额 */
  refundOnExpense: number;
  refundOnIncome: number;
  /** 行号（1 基，含前缀）→ 收/支 原文，用于锁"第 18 行是表头" */
  headerRowNumber: number;
}

export interface WechatRealShapeFixture {
  /** 可直接写进 xlsx 的二维数组（含 17 行前缀与表头） */
  matrix: string[][];
  meta: WechatRealShapeMeta;
}

export const WECHAT_PREFIX_ROWS = 17;

export function buildWechatRealShape(): WechatRealShapeFixture {
  const drafts = buildDrafts();
  const matrix: string[][] = [];
  const declared: Record<WechatBlock, { n: number; cents: number }> = {
    income: { n: 0, cents: 0 },
    expense: { n: 0, cents: 0 },
    neutral: { n: 0, cents: 0 },
  };
  let refundN = 0;
  let refundCents = 0;
  let refundOnExpense = 0;
  let refundOnIncome = 0;

  const directionOf = (block: WechatBlock): string =>
    block === 'income' ? '收入' : block === 'expense' ? '支出' : '/';

  drafts.forEach((draft, index) => {
    const isRefund = draft.status === REFUND_FULL || draft.status === REFUND_PARTIAL_1 || draft.status === REFUND_PARTIAL_2;
    const cents = draft.forceCents ?? draft.cents;
    matrix.push([
      stampAt(index),
      draft.tradeType,
      draft.counterparty,
      draft.goods,
      directionOf(draft.block),
      formatAmount(cents),
      draft.payMethod,
      draft.status,
      `4200000${String(1000000 + index)}`,
      index % 5 === 0 ? '' : `M${String(2000000 + index)}`,
      '/',
    ]);
    declared[draft.block].n += 1;
    declared[draft.block].cents += cents;
    if (isRefund) {
      refundN += 1;
      refundCents += cents;
      if (draft.block === 'expense') refundOnExpense += cents;
      else if (draft.block === 'income') refundOnIncome += cents;
    }
  });

  const prefix: string[][] = [
    ['微信支付账单明细'],
    ['微信昵称：[示例用户]'],
    ['起始时间：[2019-01-01 00:00:00] 终止时间：[2020-01-01 23:59:59]'],
    ['导出类型：[全部账单]'],
    ['导出时间：[2020-01-01 09:00:00]'],
    [''],
    [`共${drafts.length}笔记录`],
    [`收入：${declared.income.n}笔 ${formatAmount(declared.income.cents)}元`],
    [`支出：${declared.expense.n}笔 ${formatAmount(declared.expense.cents)}元`],
    [`中性交易：${declared.neutral.n}笔 ${formatAmount(declared.neutral.cents)}元`],
    ['注：'],
    ['1. 充值/提现/理财通购买/零钱通存取/信用卡还款等交易，将计入中性交易'],
    ['2. 若交易记录明细无有效内容，则代表该时间段内此微信号无交易'],
    ['3. 本明细仅供个人对账使用'],
    ['4. 本账单中所有时间均为UTC+08:00时间'],
    [''],
    ['----------------------微信支付账单明细列表--------------------'],
  ];
  if (prefix.length !== WECHAT_PREFIX_ROWS) {
    throw new Error(`前缀行数必须与真实文件一致（${WECHAT_PREFIX_ROWS} 行），当前 ${prefix.length} 行`);
  }
  matrix.unshift(...prefix);
  // 表头必须落在第 18 行（1 基）= 0 基索引 17，与真实文件一致
  matrix.splice(WECHAT_PREFIX_ROWS, 0, [...WECHAT_HEADER]);

  return {
    matrix,
    meta: {
      rows: drafts.length,
      declared,
      refund: { n: refundN, cents: refundCents },
      refundOnExpense,
      refundOnIncome,
      headerRowNumber: WECHAT_PREFIX_ROWS + 1,
    },
  };
}

/** 把 fixture 现算成 xlsx 字节，包成 ImportFile（不落地、不进 git）。 */
export async function makeWechatXlsxFile(name = 'wechat.real-shape.xlsx'): Promise<{ file: ImportFile; meta: WechatRealShapeMeta }> {
  const XLSX = await import('xlsx');
  const { matrix, meta } = buildWechatRealShape();
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), 'Sheet1');
  const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  const bytes = new Uint8Array(buffer);
  return {
    meta,
    file: {
      name,
      size: bytes.byteLength,
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      readArrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
      readText: async () => '',
    },
  };
}
