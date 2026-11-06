import { db } from '../db';
import { isTradingTime } from '../domain/date';
import { pzdataProvider } from './pzdata';
import { push2Provider } from './push2';
import { manualProvider } from './manual';
import type { NavPoint, QuoteResult } from './types';

/**
 * 四级降级链（02-arch.md §1.3 / K7）：
 *   pzdata（主） → push2（备，仅场内） → 库内最近价（灰字「数据截至 X 日」） → 手填
 * 全程**不插值、不伪造、不显示 0**。
 */

export type DegradeLevel = 'none' | 'push2' | 'cache' | 'unavailable';

export interface RefreshOutcome {
  code: string;
  quote?: QuoteResult;
  degraded: DegradeLevel;
  error?: string;
  /** 用的不是刚取到的实时数据 */
  stale: boolean;
}

export const DEGRADE_LABEL: Record<DegradeLevel, string> = {
  none: '最新净值',
  push2: '场内价',
  cache: '本地缓存',
  unavailable: '暂无数据',
};

export function isTradingHours(now: Date = new Date()): boolean {
  return isTradingTime(now);
}

async function persistQuote(quote: QuoteResult): Promise<void> {
  await db.quotes.put({
    id: `${quote.code}:${quote.nav_date}:${quote.kind}`,
    fund_code: quote.code,
    nav: quote.nav,
    acc_nav: quote.acc_nav,
    nav_date: quote.nav_date,
    kind: quote.kind,
    quote_at: quote.quote_at,
    source: quote.source,
  });
}

/** 历史净值序列入库（只留最近 120 点，避免 400+ 行常驻）。 */
async function persistSeries(code: string, points: NavPoint[]): Promise<void> {
  if (points.length === 0) return;
  const now = new Date().toISOString();
  const rows = points.slice(-120).map((point) => ({
    id: `${code}:${point.nav_date}:nav`,
    fund_code: code,
    nav: point.nav,
    acc_nav: point.acc_nav,
    nav_date: point.nav_date,
    kind: 'nav' as const,
    quote_at: now,
    source: 'eastmoney_pzdata',
  }));
  await db.quotes.bulkPut(rows);
}

export async function refreshQuote(code: string, signal?: AbortSignal): Promise<RefreshOutcome> {
  try {
    const quote = await pzdataProvider.fetchLatest(code, signal);
    await persistQuote(quote);
    try {
      const series = await pzdataProvider.fetchSeries(code, '1y');
      await persistSeries(code, series);
    } catch {
      // 序列失败不影响"最新净值"已拿到的事实
    }
    return { code, quote, degraded: 'none', stale: false };
  } catch (primaryError) {
    try {
      const quote = await push2Provider.fetchLatest(code, signal);
      await persistQuote(quote);
      return { code, quote, degraded: 'push2', stale: false };
    } catch {
      try {
        const cached = await manualProvider.fetchLatest(code);
        return {
          code,
          quote: cached,
          degraded: 'cache',
          stale: true,
          error: primaryError instanceof Error ? primaryError.message : String(primaryError),
        };
      } catch {
        return {
          code,
          degraded: 'unavailable',
          stale: true,
          error: primaryError instanceof Error ? primaryError.message : String(primaryError),
        };
      }
    }
  }
}

export async function refreshQuotes(codes: readonly string[], signal?: AbortSignal): Promise<RefreshOutcome[]> {
  const outcomes: RefreshOutcome[] = [];
  for (const code of codes) {
    outcomes.push(await refreshQuote(code, signal));
  }
  return outcomes;
}
