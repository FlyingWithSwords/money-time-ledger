import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_TILES,
  isLongImage,
  mergeTileLines,
  planTiles,
  assessSourceSize,
} from '../import/ocrTiles';
import type { OcrLine } from '../import/ocrTypes';

/**
 * 长截图分片的纯逻辑测试。
 *
 * 这里锁的全是数字：切几片、片在哪、重叠多少、合并后坐标对不对。
 * 这些值一旦回归（比如有人"顺手"改了 overlap 或贴底逻辑），长截图识别
 * 会静默退回「图尾漏一段 / 同一行出现两次」——比崩溃更难发现。
 */

function makeLine(text: string, confidence: number, y0: number, y1: number): OcrLine {
  return { text, confidence, bbox: { x0: 10, y0, x1: 500, y1 } };
}

describe('isLongImage 长图判定', () => {
  it('普通手机截图（1080×2200，宽高比 2.04）不是长图', () => {
    expect(isLongImage(1080, 2200)).toBe(false);
  });

  it('宽高比恰好等于阈值 2.4 不算长图（严格大于才切，普通截图上限在 2.3 左右）', () => {
    expect(isLongImage(1200, 2880)).toBe(false);
    expect(isLongImage(1200, 2881)).toBe(true);
  });

  it('长截图（1080×13000，宽高比 12）是长图；非法尺寸一律不是', () => {
    expect(isLongImage(1080, 13000)).toBe(true);
    expect(isLongImage(0, 0)).toBe(false);
    expect(isLongImage(-100, 500)).toBe(false);
    expect(isLongImage(Number.NaN, 500)).toBe(false);
  });
});

describe('planTiles 切片规划', () => {
  it('普通图返回单片整图，调用方无需分支', () => {
    const tiles = planTiles(1080, 2200);
    expect(tiles).toEqual([{ index: 0, offsetY: 0, height: 2200 }]);
  });

  it('长截图（1080×13000）分片：片数 ≥2 且不超过 maxTiles，首片贴顶', () => {
    const tiles = planTiles(1080, 13000);
    expect(tiles.length).toBeGreaterThanOrEqual(2);
    expect(tiles.length).toBeLessThanOrEqual(DEFAULT_MAX_TILES);
    expect(tiles[0].offsetY).toBe(0);
    expect(tiles.map((tile) => tile.index)).toEqual(tiles.map((_, i) => i));
  });

  it('覆盖无空洞：下一片的起点不会超过上一片的终点（重叠为正）', () => {
    const tiles = planTiles(1080, 13000);
    for (let i = 0; i < tiles.length - 1; i += 1) {
      const end = tiles[i].offsetY + tiles[i].height;
      expect(tiles[i + 1].offsetY).toBeLessThanOrEqual(end);
    }
  });

  it('标准片高 = round(1080×1.6) = 1728（最后一片按原图高截断，允许更矮）', () => {
    const tiles = planTiles(1080, 13000);
    expect(tiles[0].height).toBe(1728);
    for (const tile of tiles.slice(0, -1)) {
      expect(tile.height).toBe(1728);
    }
    expect(tiles[tiles.length - 1].height).toBeLessThanOrEqual(1728);
  });

  it('相邻片重叠 = 片高 × 0.08（138.24px，±1px 取整容差）', () => {
    const tiles = planTiles(1080, 13000);
    const expected = 1728 * 0.08;
    for (let i = 0; i < tiles.length - 1; i += 1) {
      const end = tiles[i].offsetY + tiles[i].height;
      const overlap = end - tiles[i + 1].offsetY;
      expect(Math.abs(overlap - expected)).toBeLessThanOrEqual(1);
    }
  });

  it('最后一片必须贴底：offsetY + height === 原图高（图尾不漏）', () => {
    for (const [width, height] of [
      [1080, 13000],
      [1080, 30000],
      [750, 9000],
      [1000, 5000],
    ] as const) {
      const tiles = planTiles(width, height);
      const last = tiles[tiles.length - 1];
      expect(last.offsetY + last.height).toBe(height);
    }
  });

  it('片数超过上限时放大片高，片数恰好等于 maxTiles', () => {
    // 默认上限：1080×30000 自然要切 19 片 → 被压回 10 片，片高放大到 >1728
    const clamped = planTiles(1080, 30000);
    expect(clamped).toHaveLength(DEFAULT_MAX_TILES);
    expect(clamped[0].height).toBeGreaterThan(1728);
    expect(clamped[0].height).toBeLessThan(30000); // 放大是有限度的，不会一口吞下整图

    // 显式给更紧的上限：3 片铺满 13000
    const tight = planTiles(1080, 13000, { maxTiles: 3 });
    expect(tight).toHaveLength(3);
    expect(tight[2].offsetY + tight[2].height).toBe(13000);
    expect(tight[0].height).toBeGreaterThan(1728);
  });

  it('非正数 / NaN 尺寸返回空数组（调用方要当「无法识别」处理）', () => {
    expect(planTiles(0, 100)).toEqual([]);
    expect(planTiles(1080, 0)).toEqual([]);
    expect(planTiles(-50, 1000)).toEqual([]);
    expect(planTiles(Number.NaN, 1000)).toEqual([]);
    expect(planTiles(1080, Number.POSITIVE_INFINITY)).toEqual([]);
  });
});

describe('mergeTileLines 合并与去重', () => {
  it('每片行的 bbox.y 加上该片 offsetY，回到原图坐标系', () => {
    const merged = mergeTileLines([
      { offsetY: 0, lines: [makeLine('第一段行', 90, 10, 30)] },
      { offsetY: 1590, lines: [makeLine('第二段行', 80, 50, 70)] },
    ]);
    expect(merged).toHaveLength(2);
    // 片 2 的 y0=50 → 原图 y0=1640；y1 同步平移
    expect(merged[1].bbox.y0).toBe(1640);
    expect(merged[1].bbox.y1).toBe(1660);
    // x 不动（片没有水平偏移）
    expect(merged[1].bbox.x0).toBe(10);
    // 结果按 y0 升序
    expect(merged[0].bbox.y0).toBeLessThanOrEqual(merged[1].bbox.y0);
  });

  it('重叠区同一行被两片各识别一次：去重后只留 confidence 高的那条', () => {
    const merged = mergeTileLines([
      {
        offsetY: 0,
        // 原图 y 100~128，中心 114
        lines: [makeLine('华夏成长混合', 70, 100, 128)],
      },
      {
        offsetY: 100,
        // 平移后 y 110~138，中心 124：与上一条中心距 10 < 0.6×28
        lines: [makeLine('华夏成长混合', 92, 10, 38)],
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].confidence).toBe(92);
  });

  it('去重对空白差异不敏感：OCR 两次识别的空格不一样也算同一行', () => {
    const merged = mergeTileLines([
      { offsetY: 0, lines: [makeLine('华夏 成长 混合', 70, 100, 128)] },
      { offsetY: 100, lines: [makeLine('华夏成长混合', 88, 10, 38)] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].confidence).toBe(88);
  });

  it('文本相同但 y 相距很远（不同段的不同行）→ 两条都保留', () => {
    const merged = mergeTileLines([
      { offsetY: 0, lines: [makeLine('持仓收益', 70, 100, 128)] },
      { offsetY: 1000, lines: [makeLine('持仓收益', 90, 100, 128)] },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].bbox.y0).toBe(100);
    expect(merged[1].bbox.y0).toBe(1100);
  });

  it('空输入返回空数组', () => {
    expect(mergeTileLines([])).toEqual([]);
    expect(mergeTileLines([{ offsetY: 0, lines: [] }])).toEqual([]);
  });
});

describe('源图尺寸评估 —— 用户实测的 150×1920 长截图', () => {
  it('150px 宽被判为「不可用」，并给出可行动建议（重新截原始图，不要用预览图）', () => {
    const verdict = assessSourceSize(150, 1920);
    expect(verdict.tooSmall).toBe(true);
    expect(verdict.advice).toContain('150px');
    expect(verdict.advice).toContain('原始截图');
  });

  it('源图过窄时不分片：150×1920 只识别 1 次，不做 9 段白等', () => {
    const tiles = planTiles(150, 1920);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toEqual({ index: 0, offsetY: 0, height: 1920 });
  });

  it('正常手机截图宽度（1080）判为可用且照常分片', () => {
    expect(assessSourceSize(1080, 13000).tooSmall).toBe(false);
    expect(assessSourceSize(1080, 13000).advice).toBeNull();
    expect(planTiles(1080, 13000).length).toBeGreaterThan(1);
  });

  it('边界：479 不可用、480 可用（阈值本身要被钉住，否则以后调参没人知道影响面）', () => {
    expect(assessSourceSize(479, 2000).tooSmall).toBe(true);
    expect(assessSourceSize(480, 2000).tooSmall).toBe(false);
  });

  it('非法尺寸给出「可能已损坏」而不是空结论', () => {
    expect(assessSourceSize(0, 0).tooSmall).toBe(true);
    expect(assessSourceSize(0, 0).advice).toBeTruthy();
  });
});
