import { describe, expect, it } from 'vitest';
import { extractHoldingCandidates, extractHoldingRows } from '../import/holdingOcr';
import { estimateBackgroundLevel, invertGray, isDarkBackground } from '../import/ocrMath';

/**
 * 两个真实失败样本的回归钉子：
 * 1. 深色模式截图（深底浅字）被拉伸成黑底白字 → 中文全丢，只剩数字；
 * 2. 支付宝「我的持仓」列表页只有「名称 + 金额」，没有代码和份额 →
 *    严格通道一行都不认，用户看到「0 笔 + 一堆数字」。
 */

function box(x0: number, y0: number, x1: number, y1: number) {
  return { x0, y0, x1, y1 };
}

function solid(value: number, count = 1000): Uint8ClampedArray {
  return new Uint8ClampedArray(count).fill(value);
}

describe('深色截图：背景检测与反色', () => {
  it('深底浅字被识别为深色背景，反色后变成白底黑字', () => {
    const dark = solid(18); // #0f1115 附近的深色底
    for (let i = 0; i < 20; i += 1) dark[i] = 230; // 少量浅色文字像素

    expect(estimateBackgroundLevel(dark)).toBeLessThan(40);
    expect(isDarkBackground(dark)).toBe(true);

    const inverted = invertGray(dark);
    expect(inverted[0]).toBe(25); // 230 → 25
    expect(estimateBackgroundLevel(inverted)).toBeGreaterThan(200);
    expect(isDarkBackground(inverted)).toBe(false);
  });

  it('浅色截图不反色（#f7f7f5 附近）', () => {
    const light = solid(246);
    for (let i = 0; i < 20; i += 1) light[i] = 20;
    expect(isDarkBackground(light)).toBe(false);
  });

  it('中灰背景不误判，宁可保持原样也不赌错方向', () => {
    expect(isDarkBackground(solid(128))).toBe(false);
  });
});

describe('支付宝持仓列表：名称 + 金额候选', () => {
  it('同一视觉行的名称与金额被拼成一条候选，收益/收益率不当市值', () => {
    const lines = [
      { text: '易方达蓝筹精选混合', confidence: 82, bbox: box(10, 100, 200, 128) },
      { text: '8,932.73', confidence: 90, bbox: box(280, 100, 380, 128) },
      { text: '+301.73', confidence: 70, bbox: box(300, 140, 370, 160) },
      { text: '+3.50%', confidence: 60, bbox: box(380, 140, 420, 160) },
    ];
    const result = extractHoldingCandidates(lines);

    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate.fund_name).toContain('易方达蓝筹精选混合');
    expect(candidate.market_value_cents).toBe(893273);
    expect(candidate.missing).toEqual(['code', 'shares']);
    expect(result.chineseLineCount).toBe(1);
  });

  it('名称一行、金额一行（上下版式）也能相邻配对', () => {
    const lines = [
      { text: '华夏沪深300ETF联接A', confidence: 80, bbox: box(10, 100, 240, 130) },
      { text: '1,068.97', confidence: 88, bbox: box(10, 136, 120, 162) },
    ];
    const result = extractHoldingCandidates(lines);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].market_value_cents).toBe(106897);
    expect(result.candidates[0].fund_name).toContain('华夏沪深300ETF联接A');
  });

  it('一屏多只基金按纵向顺序各成一条候选', () => {
    const lines = [
      { text: '易方达蓝筹精选混合', confidence: 80, bbox: box(10, 0, 200, 28) },
      { text: '8,932.73', confidence: 90, bbox: box(280, 0, 380, 28) },
      { text: '广发多因子混合', confidence: 80, bbox: box(10, 40, 200, 68) },
      { text: '2,135.29', confidence: 90, bbox: box(280, 40, 380, 68) },
      { text: '天弘余额宝货币', confidence: 80, bbox: box(10, 80, 200, 108) },
      { text: '1,864.39', confidence: 90, bbox: box(280, 80, 380, 108) },
    ];
    const result = extractHoldingCandidates(lines);

    expect(result.candidates.map((candidate) => candidate.market_value_cents)).toEqual([
      893273, 213529, 186439,
    ]);
  });

  it('没有中文的纯数字行不当候选，仍进未识别交人工', () => {
    const result = extractHoldingCandidates([{ text: '8,932.73', confidence: 90 }]);
    expect(result.candidates).toHaveLength(0);
    expect(result.unmatched).toEqual(['8,932.73']);
  });

  it('汇总行（持仓收益/总资产）不产出候选', () => {
    const result = extractHoldingCandidates([
      { text: '持仓收益 +301.73', confidence: 80 },
      { text: '总资产 12,345.67', confidence: 80 },
    ]);
    expect(result.candidates).toHaveLength(0);
  });

  it('重复识别（长截图分段重叠）只保留一条', () => {
    const lines = [
      { text: '易方达蓝筹精选混合 8,932.73', confidence: 80 },
      { text: '易方达蓝筹精选混合 8,932.73', confidence: 90 },
    ];
    const result = extractHoldingCandidates(lines);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].confidence).toBe(80);
  });
});

describe('严格通道不受影响', () => {
  it('无代码的行仍然不生成可入库持仓', () => {
    const result = extractHoldingRows([{ text: '华夏成长混合 12,345.67份 ¥3,638.90', confidence: 80 }]);
    expect(result.rows).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
  });

  it('详情页版式（代码 + 份额 + 金额）仍正常解析', () => {
    const result = extractHoldingRows([{ text: '000051 12,345.67份 ¥3,638.90 2.9501', confidence: 80 }]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].fund_code).toBe('000051');
    expect(result.rows[0].shares).toBe(12345.67);
    expect(result.rows[0].market_value_cents).toBe(363890);
  });
});
