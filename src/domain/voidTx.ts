import { normalizeText } from './classify';

/**
 * 「钱从头到尾没动过」的交易。
 *
 * 账单里这类记录的典型写法是状态列 `交易关闭`（下单未付款、超时取消、主动关闭），
 * 微信/支付宝仍会把它留在明细里，金额也照写。它们的语义不是「花掉了」也不是「收到了」，
 * 而是「这笔交易没有发生」。
 *
 * 为什么单独抽一个判定：导入时的 `inferDirection` 已经把 `交易关闭` 判成 transfer，
 * 但那个理由**不落库**（base.ts 说明了状态列只做汇总提示）。于是到了「收入来源」这一步，
 * 一笔 15,000 元的「余额宝-单次转入（交易关闭）」和一笔真的转账长得一模一样：
 * 方向都是 transfer、对方名都是「余额宝」。用户在设置里把「余额宝」加成收入来源，
 * 这笔就被改判成收入 —— 账上凭空多出 15,000 元进账，而支出侧一切正常，根本看不出来。
 *
 * 判定只看文本，因为落库后只剩对方名与备注这两处线索。
 */
const VOID_HINTS = ['交易关闭', '交易已关闭', '已关闭', '交易取消', '交易已取消', '交易失败', '支付失败'];

export interface VoidTxInput {
  counterparty?: string;
  note?: string;
}

/**
 * 是不是「没发生过」的交易。
 *
 * 这里刻意只做**排除**用途（不判成收入、不算候选），所以宁可多认几个词：
 * 多排掉一笔真收入，用户能在流水里看到并手动改回来；把一笔没发生的交易算成收入，
 * 则是静默的账务错误，且很难被发现。
 */
export function isVoidTx(input: VoidTxInput): boolean {
  const text = normalizeText(`${input.counterparty ?? ''} ${input.note ?? ''}`);
  if (!text) return false;
  return VOID_HINTS.some((hint) => text.includes(hint));
}
