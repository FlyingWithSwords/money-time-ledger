import type { Cents, Direction, PaymentChannel, Source } from '../types';

/**
 * 导入管线的插件契约。加平台只加一个文件，不改编排逻辑。
 */

export interface ImportFile {
  name: string;
  size: number;
  type: string;
  readArrayBuffer(): Promise<ArrayBuffer>;
  readText(): Promise<string>;
}

export interface RawRow {
  /** 1-based 物理行号，用于 issues 定位与"定位到未匹配行" */
  rowIndex: number;
  cells: Record<string, string>;
  raw?: string;
}

export interface ParseIssue {
  row: number;
  reason: string;
  raw?: string;
}

/** 表内逐月合计（汇总表里的 月份 / 月支出 / 月收入），用于把差异定位到具体月份 */
export interface MonthlyFileTotal {
  /** 'YYYY-MM' */
  month_key: string;
  expense?: Cents;
  income?: Cents;
}

export interface FileTotal {
  expense?: Cents;
  income?: Cents;
  /**
   * 「不计收支 / 中性交易」合计。支付宝写「不计收支」、微信写「中性交易」，
   * 语义相同：充值、提现、零钱通存取、还款这类钱只是换个口袋，既不是收入也不是支出。
   * 存下来是为了能和明细里的 transfer 行对账——不参与收入/支出对账。
   */
  neutral?: Cents;
  /** 文件自报的笔数（汇总行的「共 N 笔」）。注意各家口径不一致，只能做参考。 */
  count?: number;
  /** 各方向自报笔数：只在汇总行写成「支出：289笔 6881.93元」这种形态时才有 */
  expenseCount?: number;
  incomeCount?: number;
  neutralCount?: number;
  /**
   * 文件声明的收入/支出合计是否**按发生额统计**（含随后被退款的交易）。
   * 微信账单就是这样：`收/支=支出` 的行即使「已全额退款」仍计入支出合计，
   * `收/支=收入` 的退款行也仍计入收入合计。
   * 本账把退款单列为 refund、两边都不计，所以对账时必须按毛额还原，
   * 否则每一份带退款的微信账单都会永远差一笔退款金额（看起来像解析漏单）。
   */
  totalsIncludeRefund?: boolean;
  /** 逐月合计；不提供就只能做单笔金额兜底定位 */
  monthly?: MonthlyFileTotal[];
}

export interface ParseOutcome {
  parserId: string;
  rows: RawRow[];
  headerMap: Record<string, string>;
  fileTotal?: FileTotal;
  issues: ParseIssue[];
  /**
   * info 级说明（不是错误）：例如"这张表是汇总表，只取合计对账"、
   * "4 月表内与明细差 120 元"。与 issues 分开，避免把正常情况算成失败。
   */
  notes?: string[];
}

export interface ParseOpts {
  /** 用户确认后的字段映射：目标字段 → 源列名 */
  headerMap?: Record<string, string>;
  defaultYear?: number;
  signal?: AbortSignal;
}

/** 目标字段全集（UI 的字段映射预览按这个顺序展示） */
export const TARGET_FIELDS = [
  { key: 'occurred_at', label: '交易时间', required: true },
  { key: 'amount', label: '金额', required: true },
  { key: 'direction', label: '收支方向', required: false },
  { key: 'counterparty', label: '交易对方', required: false },
  { key: 'note', label: '备注', required: false },
  { key: 'txn_no', label: '交易单号', required: false },
  { key: 'channel', label: '支付方式', required: false },
  // 状态列不只是展示：它决定方向（交易关闭 / 已全额退款 / 部分退款），
  // 支付宝写「交易状态」、微信写「当前状态」
  { key: 'status', label: '交易状态', required: false },
] as const;

export type TargetField = (typeof TARGET_FIELDS)[number]['key'];

export type FieldHintMap = Partial<Record<TargetField, string>>;

export interface Parser {
  id: string;
  label: string;
  canHandle(file: ImportFile): boolean | Promise<boolean>;
  parse(file: ImportFile, opts: ParseOpts): Promise<ParseOutcome>;
  fieldHints: FieldHintMap;
  /** 尾部汇总行过滤：这些行不得入明细（旧表"汇总行与明细混排"的病根） */
  isSummaryRow?(row: RawRow): boolean;
}

export interface NormalizedRow {
  rowIndex: number;
  amount_cents: Cents;
  direction: Direction;
  occurred_at: string;
  counterparty?: string;
  note?: string;
  payment_channel: PaymentChannel;
  txn_no?: string;
  /**
   * 原始状态文本（交易关闭 / 已全额退款 / 支付成功…）。
   * 不落库，只给管线做「已把 N 笔交易关闭按不计收支处理」这类汇总提示用。
   */
  status_text?: string;
  /**
   * 账单「收/支」列原本写的方向（不看状态、不做推断）。
   * 不落库，只用于把文件声明的合计与明细放在同一口径上比较：
   * - 退款冲正要知道它原本记在支出侧还是收入侧（微信 10 笔退款里 6 笔在支出、4 笔在收入）；
   * - 「交易关闭」要知道它原本属于支出还是本来就写着不计收支
   *   （支付宝 52 笔关闭里 50 笔写「不计收支」、2 笔写「支出」，后者不进「不计收支」小计）。
   */
  declared_direction?: 'expense' | 'income' | 'neutral';
  raw?: string;
}

export function makeImportFile(file: File): ImportFile {
  return {
    name: file.name,
    size: file.size,
    type: file.type,
    readArrayBuffer: () => file.arrayBuffer(),
    readText: () => file.text(),
  };
}

export function sourceOfParser(parserId: string): Source {
  if (parserId.startsWith('wechat')) return 'wechat';
  if (parserId.startsWith('alipay')) return 'alipay';
  if (parserId.startsWith('legacy')) return 'legacy_xlsx';
  if (parserId.startsWith('ocr')) return 'ocr';
  return 'bank';
}
