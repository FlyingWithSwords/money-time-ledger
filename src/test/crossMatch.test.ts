import { describe, expect, it } from 'vitest';
import { findCrossSourcePairs, pairDismissalKey } from '../domain/crossMatch';
import { makeTx } from './txFixture';

/**
 * 跨平台匹配引擎（纯逻辑）。
 *
 * 钉住的是**判定理由的可见性**：这个功能的价值在于每条候选都给出可验证的
 * 中文依据（金额/日期/对手方），用户看着依据做裁决。理由文案一旦悄悄变了
 * 措辞（比如「同一天」改成「当日」），界面承诺就失效了，所以要逐字钉住。
 */

describe('跨平台匹配 · 基础配对', () => {
  it('金额不同不配对（分桶本身是精确过滤）', () => {
    const pairs = findCrossSourcePairs(
      [
        makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 3500, source: 'wechat' }),
        makeTx({ id: 'a', at: '2020-06-10T13:00:00+08:00', amount: 3501, source: 'alipay' }),
      ],
      new Set(),
    );
    expect(pairs).toEqual([]);
  });

  it('同源不配对：两笔都是微信（同金额同日）→ 无候选', () => {
    const pairs = findCrossSourcePairs(
      [
        makeTx({ id: 'w1', at: '2020-06-10T12:00:00+08:00', amount: 3500, source: 'wechat' }),
        makeTx({ id: 'w2', at: '2020-06-10T13:00:00+08:00', amount: 3500, source: 'wechat' }),
      ],
      new Set(),
    );
    expect(pairs).toEqual([]);
  });

  it('跨源配对：微信 + 支付宝同金额同日 → 1 组，含金额与日期理由，a 是较早那笔', () => {
    const pairs = findCrossSourcePairs(
      [
        makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 3500, source: 'wechat' }),
        makeTx({ id: 'a', at: '2020-06-10T13:00:00+08:00', amount: 3500, source: 'alipay' }),
      ],
      new Set(),
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.a).toBe('w');
    expect(pairs[0]?.b).toBe('a');
    expect(pairs[0]?.reasons).toContain('金额完全一致 ¥35.00');
    expect(pairs[0]?.reasons).toContain('同一天交易');
    // 双方都没有对手方 → 缺信息理由也得给，不能静默略过这一维
    expect(pairs[0]?.reasons).toContain('有一方缺少对手方信息');
  });

  it('日期窗口：相差 3 天配、相差 4 天不配（默认窗口 3 天）', () => {
    const within = findCrossSourcePairs(
      [
        makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 100, source: 'wechat' }),
        makeTx({ id: 'a', at: '2020-06-13T12:00:00+08:00', amount: 100, source: 'alipay' }),
      ],
      new Set(),
    );
    expect(within).toHaveLength(1);
    expect(within[0]?.reasons.join(' ')).toContain('日期相差 3 天');

    const outside = findCrossSourcePairs(
      [
        makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 100, source: 'wechat' }),
        makeTx({ id: 'a', at: '2020-06-14T12:00:00+08:00', amount: 100, source: 'alipay' }),
      ],
      new Set(),
    );
    expect(outside).toEqual([]);
  });

  it('containment：财付通-美团外卖 ⊃ 美团外卖；* 脱敏星号归一化后保留', () => {
    const pairs = findCrossSourcePairs(
      [
        { ...makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 3500, source: 'wechat' }), counterparty: '美团外卖' },
        {
          ...makeTx({ id: 'a', at: '2020-06-10T13:00:00+08:00', amount: 3500, source: 'alipay' }),
          counterparty: '财付通-美团外卖',
        },
      ],
      new Set(),
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.reasons).toContain('对手方吻合（一方包含另一方）');

    const masked = findCrossSourcePairs(
      [
        {
          ...makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 500, source: 'wechat' }),
          counterparty: '给*义',
        },
        {
          ...makeTx({ id: 'a', at: '2020-06-10T13:00:00+08:00', amount: 500, source: 'alipay' }),
          counterparty: '扫钱码付款-给*义',
        },
      ],
      new Set(),
    );
    expect(masked).toHaveLength(1);
    expect(masked[0]?.reasons).toContain('对手方吻合（一方包含另一方）');
  });

  it('相似度边界：完全不同的对手方 → 给「对手方不同」的核对提示', () => {
    const pairs = findCrossSourcePairs(
      [
        { ...makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 2000, source: 'wechat' }), counterparty: '美团外卖' },
        { ...makeTx({ id: 'a', at: '2020-06-10T13:00:00+08:00', amount: 2000, source: 'alipay' }), counterparty: '滴滴出行' },
      ],
      new Set(),
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.reasons).toContain('对手方不同——请核对是否真的同一笔');
  });

  it('相似但非包含的对手方给百分比文案，且 ≥0.6 才算相似', () => {
    // 归一化后互不包含、前缀大部分重合：Dice 相似度 2·5/16 = 0.625 ≥ 0.6
    const pairs = findCrossSourcePairs(
      [
        {
          ...makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 1800, source: 'wechat' }),
          counterparty: '肯德基宅急送-北京站',
        },
        {
          ...makeTx({ id: 'a', at: '2020-06-10T13:00:00+08:00', amount: 1800, source: 'alipay' }),
          counterparty: '肯德基宅急送-西直门',
        },
      ],
      new Set(),
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.reasons.some((reason) => /^对手方相似度 \d+%$/.test(reason))).toBe(true);
  });
});

describe('跨平台匹配 · 参与资格与过滤', () => {
  it('一对多是合法的：同金额同日 3 笔不同源 → 3 组候选全部列出', () => {
    const pairs = findCrossSourcePairs(
      [
        makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 1500, source: 'wechat' }),
        makeTx({ id: 'a', at: '2020-06-10T13:00:00+08:00', amount: 1500, source: 'alipay' }),
        { ...makeTx({ id: 'x', at: '2020-06-10T14:00:00+08:00', amount: 1500, source: 'legacy_xlsx' }) },
      ],
      new Set(),
    );
    expect(pairs).toHaveLength(3);
    const keys = pairs.map((pair) => pairDismissalKey(pair.a, pair.b)).sort();
    expect(keys).toEqual(['a|w', 'a|x', 'w|x'].sort());
  });

  it('dismissedKeys 里的对被跳过', () => {
    const txs = [
      makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 3500, source: 'wechat' }),
      makeTx({ id: 'a', at: '2020-06-10T13:00:00+08:00', amount: 3500, source: 'alipay' }),
    ];
    const dismissed = new Set([pairDismissalKey('w', 'a')]);
    expect(findCrossSourcePairs(txs, dismissed)).toEqual([]);
    // key 与 (a,b) 顺序无关：写成 ['a','w'] 的拼接也要命中同一条
    expect(findCrossSourcePairs(txs, new Set(['a|w']))).toEqual([]);
  });

  it('transfer 不参与；软删不参与；已裁决 duplicate 不参与', () => {
    // transfer：充值/还款跨平台噪音太大
    expect(
      findCrossSourcePairs(
        [
          makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 5000, source: 'wechat', direction: 'transfer' }),
          makeTx({ id: 'a', at: '2020-06-10T13:00:00+08:00', amount: 5000, source: 'alipay', direction: 'transfer' }),
        ],
        new Set(),
      ),
    ).toEqual([]);

    // 软删：还在恢复区里，没资格当候选
    const deleted = makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 100, source: 'wechat' });
    deleted.deleted_at = '2020-06-11T00:00:00+08:00';
    expect(
      findCrossSourcePairs(
        [deleted, makeTx({ id: 'a', at: '2020-06-10T13:00:00+08:00', amount: 100, source: 'alipay' })],
        new Set(),
      ),
    ).toEqual([]);

    // 同源去重已裁决为 duplicate 的：归同源去重管，这里不再翻旧账
    expect(
      findCrossSourcePairs(
        [
          makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 100, source: 'wechat', dedupe_status: 'duplicate' }),
          makeTx({ id: 'a', at: '2020-06-10T13:00:00+08:00', amount: 100, source: 'alipay' }),
        ],
        new Set(),
      ),
    ).toEqual([]);
  });

  it('suspected 仍正常参与（同源疑似不跨平台连坐）', () => {
    const pairs = findCrossSourcePairs(
      [
        makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 100, source: 'wechat', dedupe_status: 'suspected' }),
        makeTx({ id: 'a', at: '2020-06-10T13:00:00+08:00', amount: 100, source: 'alipay', dedupe_status: 'suspected' }),
      ],
      new Set(),
    );
    expect(pairs).toHaveLength(1);
  });

  it('空输入返回空数组', () => {
    expect(findCrossSourcePairs([], new Set())).toEqual([]);
    expect(findCrossSourcePairs([makeTx({ id: 'solo', at: '2020-06-10T12:00:00+08:00', amount: 100 })], new Set())).toEqual(
      [],
    );
  });

  it('排序：score 降序，同分按日期降序（近的账排前面）', () => {
    const pairs = findCrossSourcePairs(
      [
        // 早期 + 对手方不同（score = 3 + (-2) = 1）
        {
          ...makeTx({ id: 'old_a', at: '2019-01-10T12:00:00+08:00', amount: 100, source: 'wechat' }),
          counterparty: '美团外卖',
        },
        {
          ...makeTx({ id: 'old_b', at: '2019-01-10T13:00:00+08:00', amount: 100, source: 'alipay' }),
          counterparty: '滴滴出行',
        },
        // 近期 + 对手方包含（score = 3 + 3 = 6）
        {
          ...makeTx({ id: 'new_a', at: '2020-06-10T12:00:00+08:00', amount: 100, source: 'wechat' }),
          counterparty: '美团外卖',
        },
        {
          ...makeTx({ id: 'new_b', at: '2020-06-10T13:00:00+08:00', amount: 100, source: 'alipay' }),
          counterparty: '财付通-美团外卖',
        },
      ],
      new Set(),
    );
    expect(pairs.map((pair) => pair.a)).toEqual(['new_a', 'old_a']);
    expect(pairs[0]?.score).toBe(6);
    expect(pairs[1]?.score).toBe(1);
  });
});
