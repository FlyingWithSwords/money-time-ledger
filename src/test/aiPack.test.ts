import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { totalsOf } from '../domain/aggregate';
import { centsToYuan } from '../domain/money';
import { buildAiPack } from '../export/aiPack';
import type { Transaction } from '../types';
import { makeTx } from './txFixture';

/**
 * AI 分析数据包构建测试。
 *
 * 测试的重点不是「数字算得对」——聚合口径由 aggregate.test.ts 保证，
 * buildAiPack 只要复用 totalsOf / categoryShares 就天然对。
 * 这里盯的是三件只有这个模块才可能出错的事：
 * 1) 脱敏不漏（strip/pseudonym 下真实商户名与备注不得出现在序列化结果里）；
 * 2) 代号确定性（两次构建同一批数据，代号分配一致，跨平台不漂移）；
 * 3) 隐私红线（源码里没有网络调用）。
 */

/** makeTx 的输入形状（共享 fixture 未导出该类型，这里本地声明，避免改动并行文件）。 */
interface MakeTxInput {
  id: string;
  at: string;
  amount: number;
  l1?: string;
  l2?: string;
  direction?: Transaction['direction'];
  flags?: string[];
  dedupe_status?: Transaction['dedupe_status'];
  account_id?: string;
  source?: Transaction['source'];
  source_refs?: Transaction['source_refs'];
}

interface PackTxInput extends MakeTxInput {
  counterparty?: string;
  note?: string;
}

/** txFixture 不带 counterparty/note 字段，这里包一层补上（不改动共享 fixture，避免并行冲突）。 */
function packTx(input: PackTxInput): Transaction {
  return { ...makeTx(input), counterparty: input.counterparty, note: input.note };
}

/** 两个月、多商户、含退款冲正/收入/深夜消费的固定数据集。 */
function baseTxs(): Transaction[] {
  return [
    packTx({ id: 'e1', at: '2026-09-05T12:00:00+08:00', amount: 100000, l1: 'shopping', counterparty: '大商户' }),
    packTx({ id: 'e2', at: '2026-09-06T12:00:00+08:00', amount: 5000, l1: 'food', counterparty: '小商户' }),
    packTx({ id: 'e3', at: '2026-10-01T12:00:00+08:00', amount: 1500, counterparty: '张三的店', note: '家里地址是秘密路1号' }),
    packTx({ id: 'r1', at: '2026-10-02T12:00:00+08:00', amount: 500, direction: 'refund', counterparty: '张三的店' }),
    packTx({
      id: 'i1',
      at: '2026-10-03T12:00:00+08:00',
      amount: 500000,
      direction: 'income',
      l1: 'salary',
      counterparty: '某某公司',
      note: '工资到账',
    }),
    // 无 counterparty：largest_expenses 里应显示占位文案
    packTx({ id: 'n1', at: '2026-10-04T12:00:00+08:00', amount: 3000 }),
    // 23:40 的深夜消费
    packTx({ id: 'ln1', at: '2026-10-05T23:40:00+08:00', amount: 2000, counterparty: '夜宵店' }),
  ];
}

const REAL_NAMES = ['大商户', '小商户', '张三的店', '某某公司', '夜宵店'];

describe('AI 分析数据包：代号确定性与顺序', () => {
  it('同一批数据构建两次，top_merchants 与 largest_expenses 的代号完全一致', () => {
    const a = buildAiPack(baseTxs());
    const b = buildAiPack(baseTxs());
    expect(a.top_merchants.map((m) => m.name)).toEqual(b.top_merchants.map((m) => m.name));
    expect(a.largest_expenses.map((e) => e.merchant)).toEqual(b.largest_expenses.map((e) => e.merchant));
  });

  it('支出净额最大的商户拿「商户A」，无 counterparty 的交易用占位文案', () => {
    const pack = buildAiPack(baseTxs());
    // 大商户净额 100000（=1000.00 元）最大
    expect(pack.top_merchants[0]?.name).toBe('商户A');
    expect(pack.top_merchants[0]?.total).toBe('1000.00');
    // 最大单笔是大商户那笔 1000.00 元
    expect(pack.largest_expenses[0]?.amount).toBe('1000.00');
    expect(pack.largest_expenses[0]?.merchant).toBe('商户A');
    // n1（3000 分 = 30.00 元）没有 counterparty，不得出现真名也不得是空串
    const noCounterparty = pack.largest_expenses.find((e) => e.amount === '30.00');
    expect(noCounterparty?.merchant).toBe('（未记录对方）');
  });

  it('pseudonym 模式：序列化结果不含任何真实商户名（含收入方向对手方）', () => {
    const json = JSON.stringify(buildAiPack(baseTxs(), { includeNotes: true }));
    for (const name of REAL_NAMES) {
      expect(json, `pseudonym 模式泄露了真实商户名：${name}`).not.toContain(name);
    }
  });
});

describe('AI 分析数据包：脱敏模式', () => {
  it('strip 模式：整个序列化结果不含任何真实 counterparty，top_merchants 为空', () => {
    const pack = buildAiPack(baseTxs(), { counterpartyMode: 'strip' });
    const json = JSON.stringify(pack);
    for (const name of REAL_NAMES) {
      expect(json, `strip 模式泄露了真实商户名：${name}`).not.toContain(name);
    }
    expect(pack.top_merchants).toEqual([]);
    expect(pack.largest_expenses[0]?.merchant).toBe('（未记录对方）');
    expect(pack.privacy.counterparty_mode).toBe('strip');
  });

  it('full 模式：真实名称保留', () => {
    const pack = buildAiPack(baseTxs(), { counterpartyMode: 'full' });
    const json = JSON.stringify(pack);
    expect(json).toContain('张三的店');
    expect(pack.top_merchants[0]?.name).toBe('大商户');
    expect(pack.privacy.counterparty_mode).toBe('full');
  });

  it('includeNotes=false（默认）不含备注原文；=true 时含备注但商户仍脱敏', () => {
    const offJson = JSON.stringify(buildAiPack(baseTxs()));
    expect(offJson).not.toContain('秘密路');
    expect(offJson).not.toContain('工资到账');

    const onPack = buildAiPack(baseTxs(), { includeNotes: true });
    const onJson = JSON.stringify(onPack);
    expect(onJson).toContain('家里地址是秘密路1号');
    expect(onJson).toContain('工资到账');
    expect(onPack.privacy.notes_included).toBe(true);
    // 备注里的商户字段同样走代号表，收入对手方（某某公司）不因备注而漏出
    const salaryNote = onPack.notes?.find((n) => n.note === '工资到账');
    expect(salaryNote?.merchant).toMatch(/^商户[A-Z]+$/);
  });
});

describe('AI 分析数据包：口径与过滤', () => {
  it('monthly 逐月金额与 totalsOf 的净支出一致（含退款冲正）', () => {
    const pack = buildAiPack(baseTxs());
    expect(pack.monthly.map((m) => m.month)).toEqual(['2026-09', '2026-10']);

    for (const month of ['2026-09', '2026-10']) {
      const monthTxs = baseTxs().filter((tx) => tx.month_key === month);
      const expected = centsToYuan(totalsOf(monthTxs).net_expense_cents);
      const row = pack.monthly.find((m) => m.month === month);
      expect(row?.expense).toBe(expected);
    }
    // 手工核对 10 月：1500 + 3000 + 2000 − 500（冲正）= 6000 分 = 60.00 元
    const october = pack.monthly.find((m) => m.month === '2026-10');
    expect(october?.expense).toBe('60.00');
    // 收入 5000.00 元，结余 = 收入 − 支出净额
    expect(october?.income).toBe('5000.00');
    expect(october?.net).toBe('4940.00');
  });

  it('区间过滤：fromDate/toDate 外的交易不进包（tx_count 与 monthly 都体现）', () => {
    const pack = buildAiPack(baseTxs(), { fromDate: '2026-10-01', toDate: '2026-10-31' });
    expect(pack.summary.tx_count).toBe(5); // e3 r1 i1 n1 ln1
    expect(pack.monthly).toHaveLength(1);
    expect(pack.monthly[0]?.month).toBe('2026-10');
    expect(pack.summary.range).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    // 区间内商户净额：夜宵店 2000 > 张三的店 1000 → 夜宵店拿商户A
    expect(pack.top_merchants[0]?.name).toBe('商户A');
    expect(pack.top_merchants[0]?.total).toBe('20.00');
  });

  it('impulse：深夜消费（23:40）计入 kind_counts，键为中文标签', () => {
    const pack = buildAiPack(baseTxs());
    expect(pack.impulse.kind_counts['深夜']).toBe(1);
    // most_worthless 没有任何主观标记，计数为 0 而不是缺键后变 undefined
    expect(pack.impulse.most_worthless_count).toBe(0);
  });

  it('空交易：返回有效结构，不抛错', () => {
    const pack = buildAiPack([]);
    expect(pack.schema_version).toBe(1);
    expect(pack.pack_kind).toBe('ledger-ai-analysis');
    expect(pack.summary.tx_count).toBe(0);
    expect(pack.summary.months).toBe(0);
    expect(pack.monthly).toEqual([]);
    expect(pack.top_merchants).toEqual([]);
    expect(pack.largest_expenses).toEqual([]);
    expect(pack.summary.range).toEqual({ from: '', to: '' });
    expect(typeof pack.suggested_prompt).toBe('string');
  });

  it('来源用中文标签，金额为元字符串且无千分位', () => {
    const pack = buildAiPack(baseTxs());
    expect(pack.summary.sources_covered).toEqual(['手动']);
    // centsToYuan 不带千分位：100000 分 → "1000.00"
    expect(pack.largest_expenses[0]?.amount).toBe('1000.00');
    expect(pack.top_merchants[0]?.total).not.toContain(',');
  });

  it('suggested_prompt 含「不编造」约束；field_dictionary 覆盖关键路径', () => {
    const pack = buildAiPack(baseTxs());
    expect(pack.suggested_prompt).toContain('不编造');
    expect(pack.suggested_prompt).toContain('field_dictionary');
    for (const key of [
      'monthly[].expense',
      'monthly[].net',
      'categories[].share',
      'top_merchants[].name',
      'impulse.kind_counts',
      'largest_expenses[].merchant',
    ]) {
      expect(pack.field_dictionary[key], `字段词典缺 ${key}`).toBeTruthy();
    }
    // 隐私声明必须写明「本地生成、未上传」
    expect(pack.privacy.statement).toContain('未上传任何服务器');
  });
});

describe('AI 分析数据包：隐私红线（自检）', () => {
  it('aiPack.ts 与 AiExport.tsx 源码里没有 fetch（防止后人加联网调用）', () => {
    const files = [
      resolve(process.cwd(), 'src/export/aiPack.ts'),
      resolve(process.cwd(), 'src/ui/pages/Settings/AiExport.tsx'),
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source.includes('fetch('), `${file} 出现了 fetch(`).toBe(false);
    }
  });
});
