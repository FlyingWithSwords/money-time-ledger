import { describe, expect, it } from 'vitest';
import { extractOcrRows, ocrParser } from '../import/parsers/ocr';
import { inferDirection, normalizeRow } from '../import/normalize';
import type { NormalizedRow, RawRow } from '../import/base';

/**
 * OCR 后处理（金额 / 日期 / 商户 / 汇总行四条规则）。
 *
 * 这些用例来自"真实截图会怎么错"：¥ 符号、金额在行尾、两种日期写法、
 * 中英混排的商户名、以及千分位。改正则前先跑这个文件。
 *
 * 文件后半段是**一张实拍截图的真实输出**（7 行，逐字抄自支付宝「2026年10月」账单页），
 * 它同时踩了四个坑：月份汇总行被当成一笔账、日期行被丢、图标噪声粘在商户名上、
 * 正负号没转成方向。四个坑各有一条用例，改后处理前先跑这一组。
 */

function firstRow(lines: string[]) {
  const result = extractOcrRows(lines);
  return { ...result, row: result.rows[0] };
}

describe('extractOcrRows 金额抽取', () => {
  it('带 ¥ 的行：金额与商户干净分开', () => {
    const { row } = firstRow(['2026-11-04 午餐 ¥32.00']);
    expect(row?.cells['金额']).toBe('32.00');
    expect(row?.cells['日期']).toBe('2026-11-04');
    expect(row?.cells['项目']).toBe('午餐');
  });

  it('金额在行尾、没有货币符号', () => {
    const { row } = firstRow(['全家便利店 23.90']);
    expect(row?.cells['金额']).toBe('23.90');
    expect(row?.cells['项目']).toBe('全家便利店');
  });

  it('千分位金额不会被切成 "1,23"', () => {
    const { row } = firstRow(['¥1,234.56 房租']);
    expect(row?.cells['金额']).toBe('1234.56');
    expect(row?.cells['项目']).toBe('房租');
  });

  it('一行多个金额时取最后一个（小票的"实付"在最后）', () => {
    const { row } = firstRow(['原价 12.00 优惠 -1.00 实付 11.00']);
    expect(row?.cells['金额']).toBe('11.00');
  });
});

describe('extractOcrRows 日期抽取', () => {
  it('2026-11-04 这种带横线的写法', () => {
    const { row } = firstRow(['2026-11-04 咖啡 18.50']);
    expect(row?.cells['日期']).toBe('2026-11-04');
  });

  it('点分日期不会被当成金额（2026.11.04 里的 11.04）', () => {
    const { row } = firstRow(['2026.11.04 地铁 5.00']);
    expect(row?.cells['日期']).toBe('2026.11.04');
    expect(row?.cells['金额']).toBe('5.00');
  });

  it('11月4日 这种中文写法', () => {
    const { row } = firstRow(['11月4日 早餐 8.50']);
    expect(row?.cells['日期']).toBe('11月4日');
    expect(row?.cells['金额']).toBe('8.50');
  });

  it('没有日期时留空并给出提示，不猜成今天', () => {
    const { row, issues } = firstRow(['Starbucks 星巴克 12.00']);
    expect(row?.cells['日期']).toBe('');
    expect(issues.some((issue) => issue.reason.includes('没有识别到日期'))).toBe(true);
  });
});

describe('extractOcrRows 商户抽取（中英混排）', () => {
  it('英文店名 + 中文店名都保留', () => {
    const { row } = firstRow(['2026-11-04 Luckin Coffee 瑞幸 19.90']);
    expect(row?.cells['项目']).toBe('Luckin Coffee 瑞幸');
  });

  it('商户名里的英文不会被金额规则吃掉', () => {
    const { row } = firstRow(['Starbucks 星巴克 12.00']);
    expect(row?.cells['项目']).toBe('Starbucks 星巴克');
  });
});

describe('extractOcrRows 行过滤与行号', () => {
  it('没有金额的行进 issues，不产生空行', () => {
    const result = extractOcrRows(['微信支付账单明细', '2026-11-04 午餐 32.00']);
    expect(result.rows).toHaveLength(1);
    expect(result.issues.map((issue) => issue.row)).toEqual([1]);
    expect(result.lineIndexes).toEqual([1]);
  });

  it('lineIndexes 与 rows 一一对应，用于和 bbox 对齐', () => {
    const result = extractOcrRows(['2026-11-04 A 10.00', '没有金额', '2026-11-05 B 20.00']);
    expect(result.rows.map((row) => row.cells['金额'])).toEqual(['10.00', '20.00']);
    expect(result.lineIndexes).toEqual([0, 2]);
    expect(result.rows.map((row) => row.rowIndex)).toEqual([1, 3]);
  });

  it('金额不是数字时宁可不收这一行', () => {
    const result = extractOcrRows(['2026-11-04 商户 1.2.3']);
    expect(result.rows).toHaveLength(0);
  });

  it('空输入不崩', () => {
    expect(extractOcrRows([])).toEqual({ rows: [], issues: [], lineIndexes: [], dateInferred: [] });
  });
});

/* ------------------------------------------------------------------ *
 * 回归：一张实拍截图的真实 OCR 输出（支付宝「2026年10月」账单页）
 * ------------------------------------------------------------------ */

/**
 * 逐字抄下来的 7 行。界面上这 7 行全部显示「日期 需要手填」。
 * 真实内容：顶部一行是**月份汇总**（支出 3,683.22 / 收入 30.54），下面 6 笔交易。
 * 这一张图同时踩了四个坑，所以它是这四个缺陷的共同回归用例：
 * 汇总行被当成一笔账、日期行被丢、图标噪声粘在商户名上、正负号没转成方向。
 */
const SCREENSHOT_LINES: string[] = [
  'ZH ¥3,683.22 "收入娄30.54 收支分析 >',
  '◎ 货货灯界-国泰A育电网设备IE 陨攀... 97.50',
  '(2) 蚂蚁财富-帮你投-定投转入 100.00',
  '@ 余额宝-收益发放 0.94',
  '「 余额宝-自动转入 30.00',
  '2 收钱码收款-来自*义 +30.00',
  'G 扫钱码付款-给*义 -241.00',
];

/** 同一张图，补上每笔下方那行小字日期（OCR 认得出来，只是不含金额，旧实现当噪声丢了） */
const SCREENSHOT_WITH_DATES: string[] = [
  'ZH ¥3,683.22 "收入娄30.54 收支分析 >',
  '◎ 货货灯界-国泰A育电网设备IE 陨攀... 97.50',
  '10-19 09:10',
  '(2) 蚂蚁财富-帮你投-定投转入 100.00',
  '10-19 08:36',
  '@ 余额宝-收益发放 0.94',
  '10-19 04:38',
  '「 余额宝-自动转入 30.00',
  '10-19 02:21',
  '2 收钱码收款-来自*义 +30.00',
  '10-18 20:22',
  'G 扫钱码付款-给*义 -241.00',
  '10-18 18:05',
];

/** 固定"今天"，否则"年份不晚于今天"的推断会随跑测试的日期漂移 */
const TODAY = new Date(2026, 10, 4); // 2026-11-04

function normalizeOcrRow(row: RawRow, today: Date = TODAY): NormalizedRow {
  const result = normalizeRow(row, {
    fieldMap: ocrParser.fieldHints,
    defaultYear: today.getFullYear(),
  });
  if (!result.row) throw new Error(`行 ${row.rowIndex} 无法归一化：${JSON.stringify(result.issues)}`);
  return result.row;
}

describe('实拍截图回归 · 月份汇总行不是交易', () => {
  it('7 行只出 6 笔，且不存在 30.54 的假账', () => {
    const { rows } = extractOcrRows(SCREENSHOT_LINES, { today: TODAY });
    expect(rows.map((row) => row.cells['金额'])).toEqual([
      '97.50',
      '100.00',
      '0.94',
      '30.00',
      '+30.00',
      '-241.00',
    ]);
    // 假账的具体形态：行内第二个数字（收入 30.54）被当成了这笔交易的金额
    expect(rows.some((row) => row.cells['金额'] === '30.54')).toBe(false);
  });

  it('跳过汇总行要说明原因，不能静默丢行', () => {
    const { issues } = extractOcrRows(SCREENSHOT_LINES, { today: TODAY });
    const skipped = issues.find((issue) => issue.row === 1);
    expect(skipped?.reason).toContain('汇总');
  });

  it('三条汇总规则各自生效', () => {
    const cases = [
      '支出 ¥3,683.22 收入 ¥30.54 收支分析 >',
      '支出 3,683.22 收入 30.54',
      '本月支出 3,683.22 本月收入 30.54',
      '上月支出 1,000.00 收入 20.00',
    ];
    for (const line of cases) {
      expect(extractOcrRows([line], { today: TODAY }).rows, line).toHaveLength(0);
    }
  });
});

describe('实拍截图回归 · 日期行归属给上一条交易', () => {
  it('6 笔的日期全部填上，且逐年标记为"推断"', () => {
    const { rows, dateInferred } = extractOcrRows(SCREENSHOT_WITH_DATES, { today: TODAY });
    expect(rows.map((row) => row.cells['日期'])).toEqual([
      '2026-10-19 09:10',
      '2026-10-19 08:36',
      '2026-10-19 04:38',
      '2026-10-19 02:21',
      '2026-10-18 20:22',
      '2026-10-18 18:05',
    ]);
    expect(dateInferred).toEqual([true, true, true, true, true, true]);
    for (const row of rows) expect(row.cells['日期推断']).toBe('1');
  });

  it('归一化后的 occurred_at 带真实的年月日与时分', () => {
    const { rows } = extractOcrRows(SCREENSHOT_WITH_DATES, { today: TODAY });
    // 时区随运行环境变，只比到分钟，避免在 CI 上因 TZ 抖红
    expect(normalizeOcrRow(rows[0]).occurred_at.slice(0, 16)).toBe('2026-10-19T09:10');
    expect(normalizeOcrRow(rows[5]).occurred_at.slice(0, 16)).toBe('2026-10-18T18:05');
  });

  it('三种日期形态都认；显式年份的不标记为推断', () => {
    for (const form of ['10-19 09:10', '10月19日 09:10']) {
      const { rows } = extractOcrRows(['午餐 32.00', form], { today: TODAY });
      expect(rows[0].cells['日期'], form).toBe('2026-10-19 09:10');
      expect(rows[0].cells['日期推断'], form).toBe('1');
    }
    const { rows, dateInferred } = extractOcrRows(['午餐 32.00', '2026-10-19 09:10'], { today: TODAY });
    expect(rows[0].cells['日期']).toBe('2026-10-19 09:10');
    expect(rows[0].cells['日期推断']).toBeUndefined();
    expect(dateInferred).toEqual([false]);
  });

  it('年份取"最近一个不晚于今天"的同月日：今年还没到就取去年', () => {
    const { rows } = extractOcrRows(['地铁 5.00', '12-25 08:00'], { today: new Date(2026, 0, 15) });
    expect(rows[0].cells['日期']).toBe('2025-12-25 08:00');
  });

  it('同一天算今年：只比年月日，不比时分', () => {
    const { rows } = extractOcrRows(['地铁 5.00', '11-04 23:59'], { today: new Date(2026, 10, 4, 7, 0) });
    expect(rows[0].cells['日期']).toBe('2026-11-04 23:59');
  });

  it('上一条已有日期时不覆盖，也不甩给更上面一条', () => {
    const { rows, issues } = extractOcrRows(
      ['2026-11-01 午餐 32.00', '10-19 09:10', '地铁 5.00'],
      { today: TODAY },
    );
    expect(rows[0].cells['日期']).toBe('2026-11-01');
    expect(rows[1].cells['日期']).toBe('');
    // 真没日期的行才提示手填
    expect(issues.some((issue) => issue.row === 3 && issue.reason.includes('没有识别到日期'))).toBe(true);
  });

  it('日期行补上之后，「需要手填」的提示要收回', () => {
    const { issues } = extractOcrRows(SCREENSHOT_WITH_DATES, { today: TODAY });
    expect(issues.some((issue) => issue.reason.includes('没有识别到日期'))).toBe(false);
  });
});

describe('实拍截图回归 · 商户名图标噪声', () => {
  it('◎ / (2) / @ / 「 / 2 这些图标被剥掉', () => {
    const { rows } = extractOcrRows(SCREENSHOT_LINES, { today: TODAY });
    expect(rows[0].cells['项目']).toBe('货货灯界-国泰A育电网设备IE 陨攀...');
    expect(rows[1].cells['项目']).toBe('蚂蚁财富-帮你投-定投转入');
    expect(rows[2].cells['项目']).toBe('余额宝-收益发放');
    expect(rows[3].cells['项目']).toBe('余额宝-自动转入');
  });

  it('* 与 - 必须保留：*义 是脱敏姓名，- 是渠道分隔符', () => {
    const { rows } = extractOcrRows(SCREENSHOT_LINES, { today: TODAY });
    expect(rows[4].cells['项目']).toBe('收钱码收款-来自*义');
    expect(rows[5].cells['项目']).toBe('扫钱码付款-给*义');
  });

  it('商户名中间的括号/连字符不动（美团(北京)、7-11 是真实名字）', () => {
    expect(firstRow(['2026-11-04 美团(北京) 28.00']).row?.cells['项目']).toBe('美团(北京)');
    expect(firstRow(['2026-11-04 7-11 便利店 9.50']).row?.cells['项目']).toBe('7-11 便利店');
  });

  it('清洗后为空时回退原文并给 issue，不留空商户名', () => {
    const { rows, issues } = extractOcrRows(['◎ 12.00'], { today: TODAY });
    expect(rows[0].cells['项目']).not.toBe('');
    expect(issues.some((issue) => issue.reason.includes('商户名'))).toBe(true);
  });
});

describe('实拍截图回归 · 金额正负号转方向', () => {
  it('+30.00 → 收入、-241.00 → 支出，金额存绝对值', () => {
    const { rows } = extractOcrRows(SCREENSHOT_WITH_DATES, { today: TODAY });
    expect(rows.map((row) => row.cells['金额'])).toContain('+30.00');
    expect(rows.map((row) => row.cells['金额'])).toContain('-241.00');

    const plus = normalizeOcrRow(rows[4]);
    expect(plus.direction).toBe('income');
    expect(plus.amount_cents).toBe(3000);

    const minus = normalizeOcrRow(rows[5]);
    expect(minus.direction).toBe('expense');
    expect(minus.amount_cents).toBe(24100);
  });

  it('商户名里没有「收/付」时，符号是唯一线索', () => {
    const { rows } = extractOcrRows(['蚂蚁财富-赎回 +500.00', '10-19 09:10'], { today: TODAY });
    expect(normalizeOcrRow(rows[0]).direction).toBe('income');
    const { rows: other } = extractOcrRows(['蚂蚁财富-定投转入 -500.00', '10-19 09:10'], { today: TODAY });
    expect(normalizeOcrRow(other[0]).direction).toBe('expense');
  });

  it('优先级：收/支列 > 正负号 > 关键词', () => {
    // 收/支列是平台的结论，符号与关键词都不能翻盘
    expect(inferDirection({ directionText: '收入', signPrefix: '-' })).toBe('income');
    expect(inferDirection({ directionText: '支出', signPrefix: '+' })).toBe('expense');
    // 符号压过"碰巧判对"的关键词
    expect(inferDirection({ typeText: '扫钱码付款', signPrefix: '+' })).toBe('income');
    expect(inferDirection({ typeText: '收钱码收款', signPrefix: '-' })).toBe('expense');
    // 没有符号时仍然退回关键词
    expect(inferDirection({ typeText: '收钱码收款' })).toBe('income');
  });

  it('没写符号的金额不会被误当成"+"', () => {
    // amountSign 只说明值是正的；只有原文写了 + 才允许判收入
    expect(inferDirection({ typeText: '某商户', amountSign: 1 })).toBe('expense');
  });
});

describe('汇总行规则不误杀真实交易', () => {
  it('单金额 + 商户含「收入」：余额宝收益不能被吃掉', () => {
    const { rows } = extractOcrRows(['@ 余额宝-收益发放 0.94', '10-19 04:38'], { today: TODAY });
    expect(rows).toHaveLength(1);
    expect(rows[0].cells['金额']).toBe('0.94');
    expect(rows[0].cells['项目']).toBe('余额宝-收益发放');
  });

  it('只有一个金额的「本月/上月」行不是汇总（合计不可能只有一个数）', () => {
    expect(extractOcrRows(['本月房租 3000.00'], { today: TODAY }).rows).toHaveLength(1);
    expect(extractOcrRows(['上月话费 39.00'], { today: TODAY }).rows).toHaveLength(1);
  });
});
