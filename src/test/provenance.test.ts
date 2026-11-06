import { describe, expect, it } from 'vitest';
import {
  isMultiSource,
  mergeSources,
  provenanceLongLabel,
  provenanceOf,
  provenanceShortLabel,
  sourceBreakdown,
} from '../domain/provenance';
import type { Source } from '../types';
import { makeTx } from './txFixture';

/**
 * 来源（凭据）标记的纯逻辑。
 *
 * 这一层的价值在于：界面上一律走 `provenanceOf()`，而不是直接读 `tx.source`。
 * 所以「老数据没有 source_refs」与「多来源」这两种情况必须在函数里就定死，
 * 不能留给每个调用点各自 if 判断——那样迟早会有一处漏判，显示成「只来自微信」。
 */

describe('provenance · 来源集合', () => {
  it('老数据没有 source_refs 时回落成单个 source', () => {
    const tx = makeTx({ id: 't1', at: '2026-03-01T12:00:00+08:00', amount: 1000, source: 'wechat' });
    expect(provenanceOf(tx)).toEqual(['wechat']);
    expect(isMultiSource(tx)).toBe(false);
  });

  it('source_refs 为空数组时同样回落（导入后清理过字段的兜底）', () => {
    const tx = makeTx({ id: 't2', at: '2026-03-01T12:00:00+08:00', amount: 1000, source: 'ocr', source_refs: [] });
    expect(provenanceOf(tx)).toEqual(['ocr']);
  });

  it('多来源按存储顺序保留，重复项只留一次', () => {
    const tx = makeTx({
      id: 't3',
      at: '2026-03-01T12:00:00+08:00',
      amount: 1000,
      source: 'wechat',
      source_refs: ['wechat', 'alipay', 'wechat', 'ocr'],
    });
    expect(provenanceOf(tx)).toEqual(['wechat', 'alipay', 'ocr']);
    expect(isMultiSource(tx)).toBe(true);
  });

  it('mergeSources 保序去重，先来的在前（顺序携带「先微信、后截图确认」的信息）', () => {
    const a: Source[] = ['wechat'];
    const b: Source[] = ['alipay', 'wechat'];
    expect(mergeSources(a, b)).toEqual(['wechat', 'alipay']);
    expect(mergeSources([], [])).toEqual([]);
  });

  it('短标签用于列表、长标签用于提示框', () => {
    const tx = makeTx({
      id: 't4',
      at: '2026-03-01T12:00:00+08:00',
      amount: 1000,
      source: 'wechat',
      source_refs: ['wechat', 'legacy_xlsx'],
    });
    expect(provenanceShortLabel(tx)).toBe('微信+表格');
    expect(provenanceLongLabel(tx)).toBe('微信账单、旧表格');
  });
});

describe('provenance · 来源构成统计', () => {
  it('多来源记录在每个来源下各计一次（它确实被两个来源确认过）', () => {
    const rows = [
      makeTx({ id: 'a', at: '2026-03-01T12:00:00+08:00', amount: 100, source: 'wechat' }),
      makeTx({ id: 'b', at: '2026-03-02T12:00:00+08:00', amount: 200, source: 'wechat' }),
      makeTx({
        id: 'c',
        at: '2026-03-03T12:00:00+08:00',
        amount: 300,
        source: 'wechat',
        source_refs: ['wechat', 'alipay'],
      }),
      makeTx({ id: 'd', at: '2026-03-04T12:00:00+08:00', amount: 400, source: 'manual' }),
    ];
    const result = sourceBreakdown(rows);
    expect(result).toEqual([
      { source: 'wechat', count: 3 },
      { source: 'alipay', count: 1 },
      { source: 'manual', count: 1 },
    ]);
    // 各来源笔数之和允许大于总笔数 —— 界面文案必须写「来源覆盖」而不是「分布」
    expect(result.reduce((sum, item) => sum + item.count, 0)).toBeGreaterThan(rows.length);
  });

  it('空输入返回空数组，不返回一条 0 笔的假项', () => {
    expect(sourceBreakdown([])).toEqual([]);
  });

  it('笔数相同时按固定顺序排（微信 → 支付宝 → 银行 → 表格 → 截图 → 手动），避免每次渲染顺序乱跳', () => {
    const rows = [
      makeTx({ id: 'a', at: '2026-03-01T12:00:00+08:00', amount: 100, source: 'manual' }),
      makeTx({ id: 'b', at: '2026-03-02T12:00:00+08:00', amount: 200, source: 'ocr' }),
      makeTx({ id: 'c', at: '2026-03-03T12:00:00+08:00', amount: 300, source: 'wechat' }),
    ];
    expect(sourceBreakdown(rows).map((item) => item.source)).toEqual(['wechat', 'ocr', 'manual']);
  });
});
