import type { FileTotal, TargetField } from '../base';
import { extractFileTotal } from './tabular';

/**
 * 微信账单（CSV / XLSX 两种容器）的共有定义。
 *
 * 为什么单独一个文件：微信同一份「支付账单流水」既可以导出成 .csv 也可以是 .xlsx，
 * 两者的说明行数量、列顺序、收/支取值完全一样，只有"读字节"的方式不同。
 * 表头特征词、字段映射、汇总行口径这些**必须只有一份**，否则改一处漏一处。
 */

/** 表头特征词：真实表头 11 列，命中 5 个即认（个别列改名不影响整份文件）。 */
export const WECHAT_HEADER_TOKENS = [
  '交易时间',
  '交易类型',
  '交易对方',
  '收/支',
  '金额',
  '支付方式',
  '交易单号',
  '当前状态',
] as const;
export const WECHAT_HEADER_MIN_HITS = 5;

/** 真实列名映射（2020 版导出）。 */
export const WECHAT_FIELD_HINTS: Partial<Record<TargetField, string>> = {
  occurred_at: '交易时间',
  amount: '金额(元)',
  direction: '收/支',
  counterparty: '交易对方',
  note: '商品',
  txn_no: '交易单号',
  channel: '支付方式',
  status: '当前状态',
};

/**
 * 微信汇总行的口径说明（info 级，不是错误）：
 * 「收/支」列写着 `/` 的行（零钱充值、转入/转出零钱通、零钱提现、信用卡还款）
 * 计入「中性交易」——钱在自己口袋之间挪，既不是收入也不是支出。
 * 本账把它们记为 transfer，并在备注里保留原文，方便用户回查。
 */
export const WECHAT_NEUTRAL_NOTE =
  '「收/支」为 / 的行（零钱充值、转入/转出零钱通、零钱提现）是「中性交易」，已按转账(transfer)处理，不计入收入与支出';

export const WECHAT_REFUND_CALIBER_NOTE =
  '微信汇总的「支出」按发生额统计（含「已全额退款」的行）；本账把退款单列为退款冲正，对账时按毛额（支出 + 退款冲正）比较';

/**
 * 微信 xlsx 没有文本流，汇总区是若干**单列单元格**。
 * 把表头之前的行按单元格拼接成"文本行"再交给 extractFileTotal，
 * 保证 CSV 与 XLSX 走同一条汇总解析逻辑。
 */
export function wechatFileTotalFromLines(prefixRows: readonly (readonly string[])[]): FileTotal | undefined {
  const text = prefixRows.map((row) => row.join('')).join('\n');
  const total = extractFileTotal(text);
  if (!total) return undefined;
  // 微信的「支出」合计含后续退款的交易，对账要按毛额比
  return { ...total, totalsIncludeRefund: true };
}
