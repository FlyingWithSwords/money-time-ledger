import { describe, expect, it } from 'vitest';
import { computeMonthFlags, summarizeImpulse } from '../domain/flags';
import { makeTx } from './txFixture';

describe('flags: 4 条自动规则 + 主观标记', () => {
  it('深夜 23:00–05:00 命中', () => {
    const txs = [
      makeTx({ id: 'a', at: '2026-10-01T23:30:00+08:00', amount: 2000 }),
      makeTx({ id: 'b', at: '2026-10-01T04:10:00+08:00', amount: 2000 }),
      makeTx({ id: 'c', at: '2026-10-01T12:00:00+08:00', amount: 2000 }),
    ];
    const map = computeMonthFlags(txs, '2026-10');
    expect(map.get('a')?.some((hit) => hit.kind === 'late_night')).toBe(true);
    expect(map.get('b')?.some((hit) => hit.kind === 'late_night')).toBe(true);
    expect(map.get('c')?.some((hit) => hit.kind === 'late_night')).toBe(false);
  });

  it('同二级分类 30 分钟内 3 笔 → 碎钞', () => {
    const txs = [
      makeTx({ id: 'a', at: '2026-10-02T12:00:00+08:00', amount: 2000, l2: 'drink' }),
      makeTx({ id: 'b', at: '2026-10-02T12:10:00+08:00', amount: 2000, l2: 'drink' }),
      makeTx({ id: 'c', at: '2026-10-02T12:20:00+08:00', amount: 2000, l2: 'drink' }),
    ];
    const map = computeMonthFlags(txs, '2026-10');
    expect(map.get('a')?.some((hit) => hit.kind === 'small_change')).toBe(true);
  });

  it('单笔 <10 元且同日 ≥5 笔 → 碎钞', () => {
    const txs = Array.from({ length: 5 }, (_, index) =>
      makeTx({ id: `t${index}`, at: `2026-10-03T0${index + 6}:00:00+08:00`, amount: 300, l2: `x${index}` }),
    );
    const map = computeMonthFlags(txs, '2026-10');
    expect(map.get('t0')?.some((hit) => hit.kind === 'small_change')).toBe(true);
  });

  it('单笔 ≥ 当月日均 ×3 → 大额（补录后结论会变）', () => {
    const small = Array.from({ length: 10 }, (_, index) =>
      makeTx({ id: `s${index}`, at: `2026-10-0${(index % 9) + 1}T12:00:00+08:00`, amount: 1000 }),
    );
    const big = makeTx({ id: 'big', at: '2026-10-05T12:00:00+08:00', amount: 90000 });
    const before = computeMonthFlags([...small, big], '2026-10');
    expect(before.get('big')?.some((hit) => hit.kind === 'large_amount')).toBe(true);

    // 补录一批更大的支出后，日均抬高，同一笔不再是"大额"
    const extra = Array.from({ length: 40 }, (_, index) =>
      makeTx({ id: `e${index}`, at: '2026-10-06T12:00:00+08:00', amount: 200000 }),
    );
    const after = computeMonthFlags([...small, big, ...extra], '2026-10');
    expect(after.get('big')?.some((hit) => hit.kind === 'large_amount') ?? false).toBe(false);
  });

  it('同一二级分类连续 7 天 → 习惯性', () => {
    const txs = Array.from({ length: 7 }, (_, index) =>
      makeTx({ id: `d${index}`, at: `2026-10-0${index + 1}T09:00:00+08:00`, amount: 1500, l2: 'drink' }),
    );
    const map = computeMonthFlags(txs, '2026-10');
    expect(map.get('d0')?.some((hit) => hit.kind === 'habitual')).toBe(true);
    expect(map.get('d6')?.some((hit) => hit.kind === 'habitual')).toBe(true);
  });

  it('主观「最不值」来自落库的 flags', () => {
    const txs = [makeTx({ id: 'w', at: '2026-10-01T12:00:00+08:00', amount: 5000, flags: ['most_worthless'] })];
    const map = computeMonthFlags(txs, '2026-10');
    expect(map.get('w')?.[0].kind).toBe('most_worthless');
    const summary = summarizeImpulse(txs, map, 5000);
    expect(summary.count).toBe(1);
    expect(summary.cents).toBe(5000);
    expect(summary.ratio).toBe(1);
  });
});
