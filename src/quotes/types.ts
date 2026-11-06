import { LedgerError } from '../domain/errors';

/**
 * 行情 Provider 契约（02-arch.md §1.3）。
 * 隐私红线：请求 URL 只允许含 6 位基金代码，绝不带份额/成本/金额。
 */

export interface NavPoint {
  nav_date: string;
  nav: number;
  acc_nav?: number;
}

export interface QuoteResult {
  code: string;
  name?: string;
  nav: number;
  nav_date: string;
  acc_nav?: number;
  /** nav=单位净值 / market_price=场内价（仅 LOF/ETF） */
  kind: 'nav' | 'market_price';
  quote_at: string;
  source: string;
}

export type QuoteRange = '1m' | '1y' | 'all';

export interface QuoteProvider {
  id: 'eastmoney_pzdata' | 'eastmoney_push2' | 'manual';
  supports(code: string): boolean;
  fetchLatest(code: string, signal?: AbortSignal): Promise<QuoteResult>;
  fetchSeries(code: string, range: QuoteRange): Promise<NavPoint[]>;
}

export class QuoteUnavailableError extends LedgerError {
  constructor(message: string, detail?: string) {
    super('QUOTE_UNAVAILABLE', message, detail);
    this.name = 'QuoteUnavailableError';
  }
}

export function isValidFundCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

/** 场内代码的交易所判定：5/6/9 开头在上交所，其余在深交所。 */
export function marketPrefix(code: string): 0 | 1 {
  return /^[569]/.test(code) ? 1 : 0;
}
