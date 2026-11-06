import {
  isValidFundCode,
  marketPrefix,
  QuoteUnavailableError,
  type NavPoint,
  type QuoteProvider,
  type QuoteResult,
} from './types';

/**
 * 备 Provider：`push2.eastmoney.com`（**有 CORS**，但只覆盖场内 LOF/ETF/股票）。
 * 实测 161725：f43=591 → 现价 0.591（÷1000），f58=名称。
 * 场外开放式基金没有 secid，`supports()` 会放行但请求会失败 → 交给 scheduler 降级。
 */

const PRICE_SCALE = 1000;

interface Push2Response {
  data?: {
    f43?: number;
    f58?: string;
    f60?: number;
    f86?: number;
  } | null;
}

export const push2Provider: QuoteProvider = {
  id: 'eastmoney_push2',
  supports(code: string): boolean {
    return isValidFundCode(code);
  },
  async fetchLatest(code: string, signal?: AbortSignal): Promise<QuoteResult> {
    const secid = `${marketPrefix(code)}.${code}`;
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f58,f60,f86`;
    const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new QuoteUnavailableError(`场内行情接口返回 ${response.status}`, `code=${code}`);
    }
    const payload = (await response.json()) as Push2Response;
    const data = payload.data;
    if (!data || typeof data.f43 !== 'number' || data.f43 <= 0) {
      throw new QuoteUnavailableError('这不是场内可交易的代码，没有场内价', `code=${code}`);
    }
    const nav = data.f43 / PRICE_SCALE;
    if (!Number.isFinite(nav) || nav <= 0 || nav > 10000) {
      throw new QuoteUnavailableError('场内价数值异常，已拒绝使用', `code=${code}`);
    }
    return {
      code,
      name: data.f58,
      nav,
      nav_date: todayString(),
      kind: 'market_price',
      quote_at: new Date().toISOString(),
      source: 'eastmoney_push2',
    };
  },
  async fetchSeries(): Promise<NavPoint[]> {
    // 场内分钟线需要额外接口；本产品只在"最新价"场景用它，不提供历史序列
    return [];
  },
};

function todayString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
