import type { Direction, PaymentChannel } from '../types';
import type { Cents } from '../types';
import { parseMoneyString } from '../domain/money';
import { buildLocalIso, parseLooseDateTime } from '../domain/date';
import type { NormalizedRow, ParseIssue, RawRow, TargetField } from './base';

/**
 * 归一化：金额转分 / 日期补年份与时分 / 方向推断 / 渠道枚举。
 * 任何一步失败都进 issues，不允许静默变成 0 或今天。
 *
 * 方向推断的三条硬规则（真实账单踩出来的，别调优先级）：
 * 1. **状态优先**：`交易关闭` = 钱从头到尾没动过 → transfer；
 *    `已全额退款` / 部分退款 → refund（钱回来了，不能再算一笔支出）。
 * 2. **收/支列压倒关键词**：微信账单里 `收/支 = /` 的语义是「中性交易」
 *    （零钱充值、转入/转出零钱通、零钱提现、信用卡还款），**既不是收入也不是支出**；
 *    支付宝对应的写法是「不计收支」，语义相同。两者都必须判 transfer，
 *    否则 24 笔充值/提现会被兜底成「支出」，凭空多出两万多消费。
 *    `/` 只做**整格精确比对**：微信的「商品」「支付方式」、支付宝的「对方账号」列满是 `/`，
 *    用子串匹配会把整份账单都判成 transfer。
 * 3. **显式收/支压过关键词扫描**：微信「群收款」「收款方备注:二维码收款」含「收款」二字，
 *    但收/支写的是「支出」——先扫关键词会把 40 多笔支出算进收入。
 * 4. **金额自带的正负号压过关键词扫描**：截图 OCR 出来的行是 `收钱码付款-给*义 -241.00`，
 *    方向全靠 `-`/`+`。商户名里有没有「收/付」二字纯属运气（`蚂蚁财富-定投转入 -241.00`
 *    就没有），靠关键词碰巧判对不可复现，所以符号的优先级必须高于关键词。
 */

export interface NormalizeOptions {
  fieldMap: Partial<Record<TargetField, string>>;
  defaultYear: number;
  /** 无年份的日期用这个月份兜底（旧表按段推断月份时传入） */
  defaultMonth?: number;
  fallbackDirection?: Direction;
  defaultChannel?: PaymentChannel;
}

const EXPENSE_HINTS = ['支出', '付款', '消费', '扣款'];
const INCOME_HINTS = ['收入', '收款', '退款成功'];
const REFUND_HINTS = ['退款', '退货', '冲正'];
/**
 * 「转账」本身不是方向：微信的「转账」既可能是收入也可能是支出，
 * 真正的"不计收支"只有一种表达。所以这里只认「不计收支」，
 * 否则一笔正常的收款会被错判成转账、从统计里消失。
 */
const TRANSFER_HINTS = ['不计收支'];
/**
 * 「收/支」列**整格就是**这些符号时，语义是「中性交易」：
 * 微信账单把 零钱充值 / 转入零钱通 / 零钱通转出 / 零钱提现 的「收/支」写成 `/`，
 * 钱只是在自己口袋之间挪（或从银行卡进出），既不是收入也不是支出。
 * 不认它就会被兜底判成「支出」——24 笔 24317.89 元的充值/提现会被记成消费。
 *
 * 必须**逐格精确比对**，不能拿整行文本去 includes：
 * 微信账单的「商品」「支付方式」列大量出现 `/`（如商品的 `/`、支付方式的 `/`），
 * 支付宝的「对方账号」列也全是 `/`。用子串匹配会把整份账单都判成 transfer。
 */
const NEUTRAL_DIRECTION_VALUES = new Set(['/', '／']);

/** 「交易关闭」= 下单后没付款/被取消，钱从头到尾没动过。 */
const CLOSED_STATUS = '交易关闭';
const FULL_REFUND_STATUS = '已全额退款';
/** 微信部分退款写成「已退款¥43.00」或「已退款(¥43.00)」 */
const PARTIAL_REFUND_STATUS = '已退款';

export function inferDirection(input: {
  directionText?: string;
  statusText?: string;
  typeText?: string;
  amountSign?: number;
  /**
   * 金额原文里**显式写着**的正负号。
   * 与 amountSign 的区别：amountSign 只回答"值是负的吗"（`30.00` 与 `+30.00` 都是 +1），
   * 这里回答"原文到底写没写符号"——没写符号时不应据此推断方向。
   */
  signPrefix?: '+' | '-';
  fallback?: Direction;
}): Direction {
  const directionText = (input.directionText ?? '').trim();
  const statusText = (input.statusText ?? '').trim();

  // ① 状态优先：交易关闭 = 钱从头到尾没动过 → 不计收支（比「支出」更接近事实）
  if (statusText.includes(CLOSED_STATUS)) return 'transfer';

  // ② 收/支列整格是中性符号 → transfer（精确整格比对，见 NEUTRAL_DIRECTION_VALUES 的说明）
  if (NEUTRAL_DIRECTION_VALUES.has(directionText)) return 'transfer';

  // ③ 「不计收支」是支付宝的显式声明，优先级高于后面所有关键词推断：
  //    支付宝的「退款成功」行，收/支就是「不计收支」，钱已经原路退回，
  //    若因为「退款」二字再判一次 refund，会和原来那笔支出重复冲减。
  if (directionText === '不计收支') return 'transfer';

  // ④ 退款状态：全额 / 部分退款都不再是支出
  if (statusText.includes('退款')) return 'refund';

  /**
   * ⑤ **显式的收/支列压倒一切关键词扫描**。
   * 这里是真实踩过的坑：微信「交易类型」里写着 `群收款`、商品里写着 `收款方备注:二维码收款`，
   * 但收/支列明明白白是「支出」。旧实现把两条文本拼起来先扫「收款」，
   * 44 笔支出（金额合计 417.32 元）被算进收入，收入和支出同时错。
   * 收/支列是平台自己的结论，只有它缺列时才轮到关键词。
   */
  if (directionText === '支出') return 'expense';
  if (directionText === '收入') return 'income';

  /**
   * ⑥ **金额自带的正负号**：`-241.00` = 支出、`+30.00` = 收入。
   * 优先级放在收/支列之后（列是平台的结论）、关键词扫描之前（关键词是猜的）。
   * 截图 OCR 出来的行没有收/支列，方向只能靠符号；
   * 现在靠「扫钱码付款」这类关键词碰巧判对，换个商户名（`蚂蚁财富-定投转入 -241.00`）就错。
   */
  if (input.signPrefix === '-') return 'expense';
  if (input.signPrefix === '+') return 'income';

  // ⑦ 没有收/支列（或值认不出）时的兜底：靠商品说明/摘要/类型文本推断
  const text = `${directionText} ${statusText} ${input.typeText ?? ''}`;
  if (REFUND_HINTS.some((hint) => text.includes(hint))) return 'refund';
  if (TRANSFER_HINTS.some((hint) => text.includes(hint))) return 'transfer';
  if (INCOME_HINTS.some((hint) => text.includes(hint))) return 'income';
  if (EXPENSE_HINTS.some((hint) => text.includes(hint))) return 'expense';
  if (input.amountSign !== undefined && input.amountSign < 0) return 'expense';
  return input.fallback ?? 'expense';
}

/**
 * 读金额原文里**显式**写的正负号（剥掉货币符号与括注）。
 * `(12.49)` 这种会计写法不在此处理：它由 parseMoneyString 判负，走 amountSign 兜底，
 * 因为括号是"记账惯例"而不是平台给的方向标记。
 */
export function readAmountSignPrefix(raw: string | undefined): '+' | '-' | undefined {
  if (!raw) return undefined;
  const text = String(raw).replace(/[¥￥$\s]/g, '');
  if (text.startsWith('-')) return '-';
  if (text.startsWith('+')) return '+';
  return undefined;
}

export function inferChannel(text: string | undefined, fallback: PaymentChannel = 'unknown'): PaymentChannel {
  if (!text) return fallback;
  const value = String(text);
  if (value.includes('花呗')) return 'huabei';
  if (value.includes('零钱') || value.includes('微信')) return 'wechat';
  if (value.includes('余额宝') || value.includes('支付宝') || value.includes('余额')) return 'alipay';
  if (value.includes('银行卡') || value.includes('储蓄卡') || value.includes('信用卡') || value.includes('招商') || value.includes('建设')) {
    return 'card';
  }
  if (value.includes('现金')) return 'cash';
  return fallback;
}

export interface NormalizeResult {
  row?: NormalizedRow;
  issues: ParseIssue[];
}

export function normalizeRow(row: RawRow, opts: NormalizeOptions): NormalizeResult {
  const issues: ParseIssue[] = [];
  const pick = (field: TargetField): string => {
    const column = opts.fieldMap[field];
    if (!column) return '';
    return (row.cells[column] ?? '').toString().trim();
  };

  const rawAmount = pick('amount');
  const parsedAmount = parseMoneyString(rawAmount);
  if (parsedAmount === null) {
    return {
      issues: [{ row: row.rowIndex, reason: `金额无法解析："${rawAmount}"`, raw: row.raw }],
    };
  }
  const amountCents = Math.abs(parsedAmount) as Cents;
  if (amountCents === 0) {
    // 0 元账（旧表有 5 笔）允许入库，但必须能被人工看见
    issues.push({ row: row.rowIndex, reason: '金额为 0.00，请确认是否需要保留', raw: row.raw });
  }

  const rawDate = pick('occurred_at');
  const parsedDate = parseLooseDateTime(rawDate, {
    fallbackYear: opts.defaultYear,
    fallbackMonth: opts.defaultMonth,
  });
  if (!parsedDate) {
    return {
      issues: [{ row: row.rowIndex, reason: `日期无法解析："${rawDate}"`, raw: row.raw }],
    };
  }

  const directionText = pick('direction');
  const statusText = pick('status');
  // 商品说明 + 交易类型 + 状态一起参与关键词推断：微信「已全额退款」写在状态列，
  // 支付宝「退款-xxx」写在商品说明里，两边都得能认出来
  const typeText = `${pick('note')} ${row.cells['交易类型'] ?? ''} ${row.cells['类型'] ?? ''}`;
  const direction = inferDirection({
    directionText,
    statusText,
    typeText,
    amountSign: parsedAmount < 0 ? -1 : 1,
    // 显式符号（`+30.00` / `-241.00`）参与方向判定，见 inferDirection ⑥
    signPrefix: readAmountSignPrefix(rawAmount),
    fallback: opts.fallbackDirection,
  });

  const baseNote = pick('note');
  let noteSuffix = '';
  if (statusText.includes(CLOSED_STATUS)) {
    // 保留原状态文本让用户能看见"这笔钱其实没动过"，而不是悄悄改个方向
    noteSuffix = '（交易关闭）';
  } else if (direction === 'refund' && statusText.includes(PARTIAL_REFUND_STATUS) && !statusText.includes(FULL_REFUND_STATUS)) {
    noteSuffix = '（部分退款）';
    issues.push({
      row: row.rowIndex,
      reason: `状态为「${statusText}」，按部分退款处理；退款金额可能与原单不同，请人工核对`,
      raw: row.raw,
    });
  }

  const note = `${baseNote}${noteSuffix}`.trim();
  // 记住「收/支」列原本写的方向（不看状态）：对账要按文件口径还原毛额，
  // 否则退款（微信 6 支出 + 4 收入）与交易关闭（支付宝 50 不计收支 + 2 支出）都会错位。
  const declaredDirection: NormalizedRow['declared_direction'] =
    directionText === '支出'
      ? 'expense'
      : directionText === '收入'
        ? 'income'
        : directionText === '不计收支' || NEUTRAL_DIRECTION_VALUES.has(directionText)
          ? 'neutral'
          : undefined;
  return {
    row: {
      rowIndex: row.rowIndex,
      amount_cents: amountCents,
      direction,
      occurred_at: buildLocalIso(parsedDate.date, parsedDate.time),
      counterparty: pick('counterparty') || undefined,
      note: note || undefined,
      payment_channel: inferChannel(pick('channel'), opts.defaultChannel ?? 'unknown'),
      txn_no: pick('txn_no') || undefined,
      status_text: statusText || undefined,
      declared_direction: declaredDirection,
      raw: row.raw,
    },
    issues,
  };
}

/** 自动字段映射：按候选列名匹配（用户可在预览页改）。 */
export function autoFieldMap(
  headers: readonly string[],
  hints: Partial<Record<TargetField, string>>,
): Partial<Record<TargetField, string>> {
  const map: Partial<Record<TargetField, string>> = {};
  const find = (candidates: string[]): string | undefined =>
    headers.find((header) => candidates.some((candidate) => header.includes(candidate)));

  for (const [field, hint] of Object.entries(hints) as Array<[TargetField, string]>) {
    if (hint && headers.includes(hint)) {
      map[field] = hint;
      continue;
    }
  }

  if (!map.occurred_at) {
    map.occurred_at = find(['交易时间', '交易创建时间', '付款时间', '时间', '日期']);
  }
  if (!map.amount) {
    // 「基础收入/元」「结算收入/元」这类列名不含"金额"，收入表全靠这一条
    map.amount = find(['金额(元)', '金额（元）', '金额', '收/支金额', '基础收入/元', '基础收入', '结算收入/元', '收入/元', '收入']);
  }
  if (!map.direction) {
    map.direction = find(['收/支', '收支', '资金方向']);
  }
  if (!map.counterparty) {
    map.counterparty = find(['交易对方', '对方', '商户', '项目']);
  }
  if (!map.note) {
    map.note = find(['商品', '备注', '说明', '商品名称']);
  }
  if (!map.txn_no) {
    map.txn_no = find(['交易单号', '交易号', '订单号', '商户单号']);
  }
  if (!map.channel) {
    map.channel = find(['支付方式', '付款方式', '收/付款方式']);
  }
  if (!map.status) {
    // 「状态」放最后：支付宝叫「交易状态」、微信叫「当前状态」，两者都含「状态」
    map.status = find(['交易状态', '当前状态', '状态']);
  }
  return map;
}
