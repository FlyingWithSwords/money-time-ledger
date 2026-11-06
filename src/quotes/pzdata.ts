import {
  isValidFundCode,
  QuoteUnavailableError,
  type NavPoint,
  type QuoteProvider,
  type QuoteRange,
  type QuoteResult,
} from './types';

/**
 * 主 Provider：`fund.eastmoney.com/pingzhongdata/{code}.js`
 *
 * 为什么用 <script> 注入而不是 fetch：该接口**没有 CORS 头**，但普通 script 不受 CORS 约束；
 * 文件内容是纯 JS 变量赋值（`var fS_name=...; var Data_netWorthTrend=[...]`），注入后即为全局变量。
 * 实测 161725 ≈ 435 KB / 000001 ≈ 765 KB，坏 code 会 301 重定向 → 变量缺失 → 判为失效。
 */

const SCRIPT_TIMEOUT_MS = 8000;
const MAX_SERIES_POINTS = 400;

interface RawNavPoint {
  x: number;
  y: number;
  equityReturn?: number;
}

interface PzdataGlobals {
  fS_name?: string;
  fS_code?: string;
  Data_netWorthTrend?: RawNavPoint[];
  Data_ACWorthTrend?: Array<[number, number]>;
  syl_1y?: string;
}

const inflight = new Map<string, Promise<PzdataGlobals>>();

function readGlobals(): PzdataGlobals {
  const globals = window as unknown as PzdataGlobals;
  return {
    fS_name: globals.fS_name,
    fS_code: globals.fS_code,
    Data_netWorthTrend: globals.Data_netWorthTrend,
    Data_ACWorthTrend: globals.Data_ACWorthTrend,
    syl_1y: globals.syl_1y,
  };
}

function clearGlobals(): void {
  const globals = window as unknown as Record<string, unknown>;
  delete globals.fS_name;
  delete globals.fS_code;
  delete globals.Data_netWorthTrend;
  delete globals.Data_ACWorthTrend;
  delete globals.syl_1y;
}

function loadScript(code: string, signal?: AbortSignal): Promise<PzdataGlobals> {
  const cached = inflight.get(code);
  if (cached) return cached;

  const promise = new Promise<PzdataGlobals>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new QuoteUnavailableError('当前环境不能注入脚本，无法获取净值'));
      return;
    }
    const script = document.createElement('script');
    // URL 只含 6 位基金代码 —— 满足隐私红线
    script.src = `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`;
    script.async = true;
    let settled = false;

    const cleanup = (): void => {
      window.clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (script.parentNode) script.parentNode.removeChild(script);
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    };

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      clearGlobals();
      reject(new QuoteUnavailableError(message, `code=${code}`));
    };

    const timer = window.setTimeout(() => fail('净值接口超时（8 秒）'), SCRIPT_TIMEOUT_MS);

    const onAbort = (): void => fail('已取消');

    script.onload = () => {
      if (settled) return;
      const globals = readGlobals();
      if (!globals.Data_netWorthTrend || globals.Data_netWorthTrend.length === 0) {
        fail('接口返回里没有净值序列（代码可能不存在）');
        return;
      }
      settled = true;
      cleanup();
      resolve(globals);
      // 数据已取出，立刻清掉全局变量，避免污染与内存常驻
      window.setTimeout(clearGlobals, 0);
    };
    script.onerror = () => fail('净值脚本加载失败（网络不可用或接口变更）');

    if (signal) {
      if (signal.aborted) {
        fail('已取消');
        return;
      }
      signal.addEventListener('abort', onAbort);
    }

    document.head.appendChild(script);
  });

  inflight.set(code, promise);
  promise.catch(() => inflight.delete(code));
  promise.then(() => inflight.delete(code));
  return promise;
}

function toNavPoints(raw: RawNavPoint[]): NavPoint[] {
  return raw
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => {
      const date = new Date(point.x);
      const navDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
        date.getDate(),
      ).padStart(2, '0')}`;
      return { nav_date: navDate, nav: Number(point.y) };
    })
    .sort((a, b) => a.nav_date.localeCompare(b.nav_date));
}

function trimRange(points: NavPoint[], range: QuoteRange): NavPoint[] {
  if (range === 'all') return points.slice(-MAX_SERIES_POINTS);
  const days = range === '1m' ? 31 : 366;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return points.filter((point) => Date.parse(`${point.nav_date}T00:00:00`) >= cutoff);
}

export const pzdataProvider: QuoteProvider = {
  id: 'eastmoney_pzdata',
  supports(code: string): boolean {
    return isValidFundCode(code);
  },
  async fetchLatest(code: string, signal?: AbortSignal): Promise<QuoteResult> {
    const globals = await loadScript(code, signal);
    const points = toNavPoints(globals.Data_netWorthTrend ?? []);
    const latest = points[points.length - 1];
    if (!latest) throw new QuoteUnavailableError('净值序列为空', `code=${code}`);
    return {
      code,
      name: globals.fS_name,
      nav: latest.nav,
      nav_date: latest.nav_date,
      kind: 'nav',
      quote_at: new Date().toISOString(),
      source: 'eastmoney_pzdata',
    };
  },
  async fetchSeries(code: string, range: QuoteRange): Promise<NavPoint[]> {
    const globals = await loadScript(code);
    return trimRange(toNavPoints(globals.Data_netWorthTrend ?? []), range);
  },
};

/** 名称单独取一次（持仓录入时自动填名称）。 */
export async function fetchFundName(code: string): Promise<string | null> {
  try {
    const globals = await loadScript(code);
    return globals.fS_name ?? null;
  } catch {
    return null;
  }
}
