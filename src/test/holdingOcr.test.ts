import { describe, expect, it } from 'vitest';
import { extractHoldingRows, type HoldingOcrResult } from '../import/holdingOcr';

/** 单行输入的快捷构造。默认置信度给个中高值，个别用例自己压低。 */
function line(text: string, confidence = 90): { text: string; confidence: number } {
  return { text, confidence };
}

function run(texts: readonly string[], confidence = 90): HoldingOcrResult {
  return extractHoldingRows(texts.map((text) => line(text, confidence)));
}

describe('extractHoldingRows 持仓行提取', () => {
  it('标准支付宝形态：名称 代码 份额 金额 净值 五段齐全', () => {
    const result = run(['华夏沪深300ETF联接A 000051 12,345.67份 ¥3,638.90 2.9501']);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.fund_code).toBe('000051');
    expect(row.fund_name).toBe('华夏沪深300ETF联接A');
    expect(row.shares).toBe(12345.67);
    expect(row.market_value_cents).toBe(363890);
    expect(row.current_nav).toBe(2.9501);
    expect(result.unmatched).toHaveLength(0);
  });

  it('只有两个数字时按 [份额] [金额] 分配，不给净值', () => {
    const result = run(['000051 1,234.56 ¥3,638.90']);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.shares).toBe(1234.56);
    expect(row.market_value_cents).toBe(363890);
    expect(row.current_nav).toBeUndefined();
  });

  it('天天基金形态（代码在名称前）：名称仍取到代码后的文本', () => {
    const result = run(['000051 华夏沪深300 1,234.56份 3,638.90元']);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.fund_code).toBe('000051');
    expect(row.fund_name).toBe('华夏沪深300');
    expect(row.shares).toBe(1234.56);
    expect(row.market_value_cents).toBe(363890);
    expect(row.current_nav).toBeUndefined();
  });

  it('黄金按克重：字母代号 + 「克」单位', () => {
    const result = run(['积存金 AU9999 12.5克 ¥5,500.00']);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.fund_code).toBe('AU9999');
    expect(row.fund_name).toBe('积存金');
    expect(row.shares).toBe(12.5);
    expect(row.market_value_cents).toBe(550000);
  });

  it('场内基金代码（6 位数字）与「份」单位', () => {
    const result = run(['黄金ETF 518880 2,000.00份 ¥8,460.00']);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].fund_code).toBe('518880');
    expect(result.rows[0].fund_name).toBe('黄金ETF');
    expect(result.rows[0].shares).toBe(2000);
  });

  it('汇总/操作行（无代码）整行丢弃，不进 unmatched', () => {
    const result = run(['总资产 ¥36,380.90', '持仓收益 ¥1,234.00', '昨日收益 +56.78', '定投']);
    expect(result.rows).toHaveLength(0);
    expect(result.unmatched).toHaveLength(0);
    expect(result.meanConfidence).toBe(0);
  });

  it('没有代码但有数字的行进 unmatched 交人工', () => {
    const result = run(['华夏成长混合 12,345.67份 ¥3,638.90']);
    expect(result.rows).toHaveLength(0);
    expect(result.unmatched).toEqual(['华夏成长混合 12,345.67份 ¥3,638.90']);
  });

  it('纯字母金融缩写（ETF）不当作代码——宁可 unmatched 也不造假持仓', () => {
    const result = run(['华夏成长 ETF 12,345.67份 ¥3,638.90']);
    expect(result.rows).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
  });

  it('meanConfidence 只对有效行取平均', () => {
    const result = extractHoldingRows([
      line('华夏沪深300ETF联接A 000051 12,345.67份 ¥3,638.90 2.9501', 80),
      line('积存金 AU9999 12.5克 ¥5,500.00', 60),
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.meanConfidence).toBe(70);
  });

  it('空输入返回全空结果', () => {
    expect(extractHoldingRows([])).toEqual({ rows: [], unmatched: [], meanConfidence: 0 });
  });

  it('千分位与 ¥/￥/元 符号剥离，金额用整数运算转分', () => {
    const result = run(['000051 123.45份 ￥1,234.56']);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].shares).toBe(123.45);
    expect(result.rows[0].market_value_cents).toBe(123456);
  });

  it('净值候选（无千分位、≥3 位小数、<1000）优先落净值位而不是错记成金额', () => {
    const result = run(['000051 12,345.67份 2.9501']);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].shares).toBe(12345.67);
    expect(result.rows[0].current_nav).toBe(2.9501);
    expect(result.rows[0].market_value_cents).toBeUndefined();
  });

  it('一行里塞了 4 个无标记数字——不确定的归属整行进 unmatched', () => {
    const raw = '000051 1,234.56 3,638.90 2.9501 4.3200';
    const result = run([raw]);
    expect(result.rows).toHaveLength(0);
    expect(result.unmatched).toEqual([raw]);
  });

  it('两个代码挤在一行（sparse OCR 粘行）不硬拆，交人工', () => {
    const raw = '华夏成长 000051 110022 12,345.67份 ¥3,638.90';
    const result = run([raw]);
    expect(result.rows).toHaveLength(0);
    expect(result.unmatched).toEqual([raw]);
  });

  it('两笔持仓混着标题行与汇总行：恰好 2 行，标题/汇总都不产生行', () => {
    const result = run([
      '我的持仓',
      '总资产 ¥52,000.00',
      '华夏沪深300ETF联接A 000051 12,345.67份 ¥3,638.90 2.9501',
      '积存金 AU9999 12.5克 ¥5,500.00',
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].fund_code).toBe('000051');
    expect(result.rows[1].fund_code).toBe('AU9999');
    expect(result.unmatched).toHaveLength(0);
  });

  it('低置信度行原样透传（<60 的标黄标记在 UI 层做）', () => {
    const result = extractHoldingRows([line('华夏成长混合 000051 1,234.56份 ¥3,638.90', 55)]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].confidence).toBe(55);
    expect(result.meanConfidence).toBe(55);
  });
});
