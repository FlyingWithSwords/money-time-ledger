import { db } from '../db';
import {
  isValidFundCode,
  QuoteUnavailableError,
  type NavPoint,
  type QuoteProvider,
  type QuoteRange,
  type QuoteResult,
} from './types';

/**
 * 兜底 Provider：手填净值 / 库内最近一次成功获取的价格。
 * **绝不返回 0 或空值代替** —— 没有数据就抛错，让 UI 显示「数据截至 X 日」或引导手填。
 */
export const manualProvider: QuoteProvider = {
  id: 'manual',
  supports(code: string): boolean {
    return isValidFundCode(code);
  },
  async fetchLatest(code: string): Promise<QuoteResult> {
    const rows = await db.quotes.where('fund_code').equals(code).toArray();
    if (rows.length === 0) {
      throw new QuoteUnavailableError('还没有这只基金的任何价格记录，请手动填写净值', `code=${code}`);
    }
    const latest = rows.reduce((best, row) => (row.quote_at > best.quote_at ? row : best), rows[0]);
    return {
      code,
      nav: latest.nav,
      nav_date: latest.nav_date,
      kind: latest.kind === 'market_price' ? 'market_price' : 'nav',
      quote_at: latest.quote_at,
      source: latest.source,
    };
  },
  async fetchSeries(code: string, range: QuoteRange): Promise<NavPoint[]> {
    const rows = await db.quotes.where('fund_code').equals(code).toArray();
    const points = rows
      .filter((row) => row.kind === 'nav')
      .map((row) => ({ nav_date: row.nav_date, nav: row.nav }))
      .sort((a, b) => a.nav_date.localeCompare(b.nav_date));
    if (range === 'all') return points;
    const days = range === '1m' ? 31 : 366;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return points.filter((point) => Date.parse(`${point.nav_date}T00:00:00`) >= cutoff);
  },
};

/** 用户手填净值：写入一条 kind='nav'（或场内 market_price）的 FundQuote。 */
export async function saveManualNav(input: {
  code: string;
  nav: number;
  nav_date: string;
  kind?: 'nav' | 'market_price';
}): Promise<void> {
  if (!isValidFundCode(input.code)) throw new QuoteUnavailableError('基金代码必须是 6 位数字');
  if (!Number.isFinite(input.nav) || input.nav <= 0) throw new QuoteUnavailableError('净值必须大于 0');
  const kind = input.kind ?? 'nav';
  await db.quotes.put({
    id: `${input.code}:${input.nav_date}:${kind}`,
    fund_code: input.code,
    nav: input.nav,
    nav_date: input.nav_date,
    kind,
    quote_at: new Date().toISOString(),
    source: 'manual',
  });
}
