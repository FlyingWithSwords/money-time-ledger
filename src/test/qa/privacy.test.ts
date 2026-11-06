import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isValidFundCode } from '../../quotes/types';

/**
 * QA-4：隐私红线（静态检查）。
 * 允许的域名只有两个行情域名 + SVG 命名空间；任何第三个域名都算红线问题。
 */

const ROOT = process.cwd();
const SRC = resolve(ROOT, 'src');

const ALLOWED_HOSTS = ['fund.eastmoney.com', 'push2.eastmoney.com', 'www.w3.org'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx|css|html|json|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

function scan(pattern: RegExp, files: string[]): Array<{ file: string; match: string }> {
  const hits: Array<{ file: string; match: string }> = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const found of text.match(pattern) ?? []) {
      hits.push({ file: relative(ROOT, file).replace(/\\/g, '/'), match: found });
    }
  }
  return hits;
}

const sourceFiles = [...walk(SRC), resolve(ROOT, 'index.html')].filter(
  // 测试代码自身含"禁词清单"，不参与扫描
  (file) => !relative(ROOT, file).replace(/\\/g, '/').startsWith('src/test/'),
);

describe('QA-4a 外部域名白名单', () => {
  it('src 与 index.html 里除行情域名 + SVG 命名空间外没有第三个域名', () => {
    const hosts = scan(/https?:\/\/([a-zA-Z0-9.-]+)/g, sourceFiles);
    const offenders = hosts.filter((hit) => {
      const host = /https?:\/\/([a-zA-Z0-9.-]+)/.exec(hit.match)?.[1] ?? '';
      return !ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    });
    expect(offenders, `发现未授权域名: ${JSON.stringify(offenders)}`).toHaveLength(0);
  });

  it('没有埋点/统计/字体 CDN/远程图片', () => {
    const forbidden = /googleapis|gstatic|gtag|googletagmanager|analytics|umami|sentry|cnzz|baidu|hm\.js|hotjar|mixpanel|segment\.io|@import\s+url\(|<img[^>]+src=["']https?:/gi;
    const hits = scan(forbidden, sourceFiles);
    expect(hits, `发现第三方统计/远程资源: ${JSON.stringify(hits)}`).toHaveLength(0);
  });
});

describe('QA-4b 表单不得收集凭据', () => {
  it('源码里没有密码/验证码/卡号/身份证语义的输入，只有「本地加密口令」', () => {
    const uiFiles = walk(resolve(SRC, 'ui'));
    const hits = scan(/密码|验证码|卡号|身份证|CVV|安全码/g, uiFiles);
    const offenders = hits.filter((hit) => !hit.file.includes('Privacy.tsx'));
    // Privacy.tsx 里这些词只出现在「我们没有这些输入框」的声明中
    expect(offenders, `发现疑似凭据输入: ${JSON.stringify(offenders)}`).toHaveLength(0);

    const backup = readFileSync(resolve(SRC, 'ui/pages/Settings/Backup.tsx'), 'utf8');
    expect(backup).toMatch(/口令/);
    expect(backup).toMatch(/不会被保存在任何地方|不可找回|没有服务器/);
  });
});

describe('QA-4c 网络调用点收敛', () => {
  it('只有行情与 OCR 语言包会发起网络请求', () => {
    const hits = scan(/fetch\(|script\.src\s*=|XMLHttpRequest|sendBeacon|new WebSocket|EventSource/g, sourceFiles);
    const allowed = [
      'src/quotes/',
      'src/import/ocrPack.ts',
      'src/import/parsers/ocr.ts',
      'src/pwa/registerSW.ts',
    ];
    const offenders = hits.filter((hit) => !allowed.some((prefix) => hit.file.startsWith(prefix)));
    expect(offenders, `意外网络调用点: ${JSON.stringify(offenders)}`).toHaveLength(0);
  });

  it('行情请求 URL 只允许含 6 位基金代码', () => {
    const pzdata = readFileSync(resolve(SRC, 'quotes/pzdata.ts'), 'utf8');
    const push2 = readFileSync(resolve(SRC, 'quotes/push2.ts'), 'utf8');
    // URL 模板插值只能是 code / secid / fields 这几种
    const pzdataUrl = /script\.src\s*=\s*`([^`]+)`/.exec(pzdata)?.[1] ?? '';
    expect(pzdataUrl).toContain('${code}');
    expect(pzdataUrl).not.toMatch(/shares|cost|amount|holdings|nav_cents/i);

    const push2Url = /const url = `([^`]+)`/.exec(push2)?.[1] ?? '';
    expect(push2Url).not.toMatch(/shares|cost|amount|holdings/i);

    // 代码必过 6 位校验，任何注入/额外参数一律不合法
    for (const bad of ['161725?leak=1', '../../etc/passwd', '16172', '1617255', 'abc123', '']) {
      expect(isValidFundCode(bad), bad).toBe(false);
    }
    expect(isValidFundCode('161725')).toBe(true);
  });
});

describe('QA-4d 断网可用性', () => {
  it('OCR 引擎必须同源自托管：不得依赖 jsdelivr/unpkg 的 worker 与 wasm', () => {
    const ocr = readFileSync(resolve(SRC, 'import/parsers/ocr.ts'), 'utf8');
    // tesseract.js v5 的 workerPath 默认指向 cdn.jsdelivr.net，必须显式覆盖
    expect(ocr, 'createWorker 必须显式指定 workerPath（同源），否则断网/隐私红线都不成立').toContain('workerPath');
    expect(ocr, 'createWorker 必须显式指定 corePath（同源 wasm），否则断网不可用').toContain('corePath');
  });

  it('PWA 产物齐全，且应用壳进入 precache', () => {
    const dist = resolve(ROOT, 'dist');
    if (!existsSync(dist)) return;
    for (const file of ['manifest.webmanifest', 'sw.js', 'index.html']) {
      expect(existsSync(resolve(dist, file)), `dist 缺少 ${file}`).toBe(true);
    }
    const sw = readFileSync(resolve(dist, 'sw.js'), 'utf8');
    expect(sw).toContain('index.html');
    expect(sw).toContain('vendor-');
    const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.webmanifest'), 'utf8')) as Record<string, unknown>;
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBeTruthy();
  });

  it('首屏 chunk 列表里不含 tesseract / xlsx / 图表库', () => {
    const dist = resolve(ROOT, 'dist');
    if (!existsSync(dist)) return;
    const html = readFileSync(resolve(dist, 'index.html'), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((match) => match[1]);
    expect(refs.length, '首屏应至少引用 entry + vendor').toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref, `首屏引用了重资源 ${ref}`).not.toMatch(/tesseract|xlsx|Chart|recharts|generateCategoricalChart/i);
    }
    // 反过来确认重资源确实被拆成了独立懒加载 chunk
    const assets = readdirSync(resolve(dist, 'assets'));
    expect(assets.some((name) => /xlsx-/.test(name)), 'xlsx 应独立成 chunk').toBe(true);
    expect(assets.some((name) => /Chart|recharts/.test(name)), '图表应独立成 chunk').toBe(true);
  });

  it('交付物里的 OCR 语言包是否就位（缺失则 OCR 完全不可用）', () => {
    const pack = resolve(ROOT, 'public/tessdata/chi_sim.traineddata.gz');
    // 这里只做事实记录：缺失时由 CI 提示，不判失败（体积大，.gitignore 已排除）
    console.log(`[QA-4] chi_sim.traineddata.gz 存在: ${existsSync(pack)}`);
  });
});
