/**
 * 可选的极简行情代理（默认**不部署**）。
 *
 * 什么时候才需要它：如果哪天 fund.eastmoney.com 的 pingzhongdata 也挂了，
 * 静态站点上的 <script> 注入就取不到净值。这时可以自己在任何 Node/Worker 环境跑这 60 行，
 * 由它转发请求（只接触 6 位基金代码，永远不接触你的账目）。
 *
 * 隐私边界：只接受 /quote/:code，code 必须是 6 位数字；不记录 IP、不落日志、不带用户信息。
 * 启动：node server/quote-proxy.mjs（默认端口 8787），然后把前端 Provider 指向它。
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);
const UPSTREAM = 'https://fund.eastmoney.com/pingzhongdata';
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function extract(text) {
  const name = /var\s+fS_name\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? null;
  const seriesRaw = /var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/.exec(text)?.[1];
  if (!seriesRaw) return null;
  let series = [];
  try {
    series = JSON.parse(seriesRaw);
  } catch {
    return null;
  }
  const points = series
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ date: new Date(point.x).toISOString().slice(0, 10), nav: Number(point.y) }));
  if (points.length === 0) return null;
  return { name, latest: points[points.length - 1], points: points.slice(-120) };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const matched = /^\/quote\/(\d{6})$/.exec(url.pathname);
  if (!matched) {
    sendJson(res, 404, { error: 'only /quote/:code (6 digits)' });
    return;
  }
  const code = matched[1];
  const cached = cache.get(code);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    sendJson(res, 200, { code, ...cached.value, cached: true });
    return;
  }
  try {
    const response = await fetch(`${UPSTREAM}/${code}.js?v=${Date.now()}`, {
      headers: { accept: '*/*' },
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`upstream ${response.status}`);
    const text = await response.text();
    const parsed = extract(text);
    if (!parsed) throw new Error('upstream 未返回净值序列（代码可能不存在）');
    cache.set(code, { at: Date.now(), value: parsed });
    sendJson(res, 200, { code, ...parsed, cached: false });
  } catch (error) {
    sendJson(res, 502, { code, error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, () => {
  console.log(`[quote-proxy] listening on http://localhost:${PORT}/quote/161725`);
  console.log('[quote-proxy] 只转发基金代码，不接触任何账目数据；本文件默认不部署。');
});
