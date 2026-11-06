/**
 * 持仓标识规则（纯函数，无副作用）。
 *
 * 支付宝「我的持仓」列表只给「基金名称 + 持仓金额」，没有基金代码，
 * 但用户希望先记上账。为了能入库又不造假代码，用 `NAME:<归一化名称>`
 * 作为 fund_code 占位：
 * - 同平台同名 → 同一个 key，重复导入幂等覆盖；
 * - 占位代码不参与行情查询（查了也是 404），净值/收益留给用户补份额后计算。
 *
 * 这是「诚实降级」：名称和金额是截图里真实存在的，份额和收益标为未知，
 * 绝不拿 0 冒充「不赚不亏」。
 */

export const PLACEHOLDER_CODE_PREFIX = 'NAME:';

export function isPlaceholderCode(code: string | null | undefined): boolean {
  return typeof code === 'string' && code.startsWith(PLACEHOLDER_CODE_PREFIX);
}

/** 名称归一化：去空白、全角括号转半角、去间隔号，保证同一只基金每次生成同一个 key。 */
export function normalizeHoldingName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[·・]/g, '');
}

export function placeholderCode(name: string): string {
  return `${PLACEHOLDER_CODE_PREFIX}${normalizeHoldingName(name)}`;
}

/** 展示用：占位代码不该以 `NAME:xxx` 的形式出现在界面上。 */
export function displayHoldingCode(code: string): string {
  return isPlaceholderCode(code) ? '未识别代码' : code;
}
