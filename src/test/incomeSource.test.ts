import { describe, expect, it } from 'vitest';
import {
  detectBuiltinIncome,
  detectWhitelistedIncome,
  mergeIncomeSources,
  scanIncomeCandidates,
  type IncomeSource,
} from '../domain/incomeSource';
import { makeTx } from './txFixture';

const WAGE: IncomeSource = { keyword: 'xx科技有限公司', label: 'XX科技有限公司', l1: 'salary', l2: 'monthly' };
const SUBSIDY: IncomeSource = { keyword: '餐补', label: '餐补', l1: 'salary', l2: 'allowance' };

describe('收入来源识别：内置词表只用于找候选', () => {
  it('转账里的工资记录能被找出来，并判定为工资补贴一级', () => {
    const hit = detectBuiltinIncome({
      direction: 'transfer',
      counterparty: 'XX科技有限公司',
      note: '代发工资',
    });
    expect(hit).not.toBeNull();
    expect(hit?.l1).toBe('salary');
    expect(hit?.l2).toBe('monthly');
    expect(hit?.hint).toBe('代发工资');
  });

  it('补贴类落到「补贴津贴」二级', () => {
    const hit = detectBuiltinIncome({ direction: 'transfer', counterparty: '公司', note: '9月餐补' });
    expect(hit?.l2).toBe('allowance');
  });

  it('奖金落到 bonus', () => {
    expect(detectBuiltinIncome({ direction: 'transfer', note: '季度奖金' })?.l2).toBe('bonus');
  });

  it('已经是收入或退款的行不再判定，避免重复计算', () => {
    expect(detectBuiltinIncome({ direction: 'income', note: '工资' })).toBeNull();
    expect(detectBuiltinIncome({ direction: 'refund', note: '工资退款' })).toBeNull();
  });

  it.each(['工资代扣社保', '公积金汇缴', '个税申报', '出差报销', '发票报销'])(
    '排除词命中就不算收入：%s',
    (note) => {
      expect(detectBuiltinIncome({ direction: 'transfer', counterparty: '公司', note })).toBeNull();
    },
  );

  it('没有任何线索时返回 null，不猜', () => {
    expect(detectBuiltinIncome({ direction: 'transfer', counterparty: '张三' })).toBeNull();
    expect(detectBuiltinIncome({ direction: 'transfer' })).toBeNull();
  });
});

describe('收入来源识别：白名单决定是否改判方向', () => {
  it('白名单为空时一律不改判——这是投资本金之外唯一会动方向的开关', () => {
    expect(
      detectWhitelistedIncome({ direction: 'transfer', counterparty: 'XX科技有限公司' }, []),
    ).toBeNull();
  });

  it('命中白名单才改判，并按白名单给的分类', () => {
    const hit = detectWhitelistedIncome(
      { direction: 'transfer', counterparty: 'XX科技有限公司', note: '代发工资' },
      [WAGE],
    );
    expect(hit?.l1).toBe('salary');
    expect(hit?.l2).toBe('monthly');
    expect(hit?.by).toBe('whitelist');
  });

  it('不在白名单里的转账仍然不动——宁可漏判，不可错判', () => {
    expect(
      detectWhitelistedIncome({ direction: 'transfer', counterparty: '张三' }, [WAGE]),
    ).toBeNull();
  });

  it('白名单命中时排除词同样生效：勾了公司名，社保代扣仍不算收入', () => {
    expect(
      detectWhitelistedIncome(
        { direction: 'transfer', counterparty: 'XX科技有限公司', note: '社保代扣' },
        [WAGE],
      ),
    ).toBeNull();
  });

  it('多个关键词同时命中时取更长的那个（更具体者胜）', () => {
    const longer: IncomeSource = { keyword: 'xx科技有限公司', label: '全称', l1: 'salary', l2: 'monthly' };
    const shorter: IncomeSource = { keyword: 'xx', label: '简称', l1: 'salary', l2: 'bonus' };
    const hit = detectWhitelistedIncome(
      { direction: 'transfer', counterparty: 'XX科技有限公司' },
      [shorter, longer],
    );
    expect(hit?.l2).toBe('monthly');
  });

  it('报销备注混在白名单里也不改判（排除词优先于白名单）', () => {
    expect(
      detectWhitelistedIncome(
        { direction: 'transfer', counterparty: 'XX科技有限公司', note: '报销款' },
        [WAGE],
      ),
    ).toBeNull();
  });
});

describe('候选扫描：按对方名聚合', () => {
  it('同一来源的多笔合并成一条候选，金额与笔数累加', () => {
    const txs = [
      makeTx({ id: 'a', at: '2026-09-10T09:00:00+08:00', amount: 800000, direction: 'transfer', counterparty: 'XX科技有限公司', note: '代发工资' }),
      makeTx({ id: 'b', at: '2026-10-10T09:00:00+08:00', amount: 800000, direction: 'transfer', counterparty: 'XX科技有限公司', note: '代发工资' }),
    ];
    const candidates = scanIncomeCandidates(txs);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].count).toBe(2);
    expect(candidates[0].cents).toBe(1600000);
    expect(candidates[0].ids).toEqual(['a', 'b']);
    expect(candidates[0].latest_date).toBe('2026-10-10');
  });

  it('已删除的记录不参与扫描', () => {
    const txs = [
      makeTx({
        id: 'a',
        at: '2026-09-10T09:00:00+08:00',
        amount: 800000,
        direction: 'transfer',
        counterparty: 'XX科技有限公司',
        note: '工资',
        deleted_at: '2026-09-11T00:00:00.000Z',
      }),
    ];
    expect(scanIncomeCandidates(txs)).toHaveLength(0);
  });

  it('金额大的排在前面，用户先看到值得配的那条', () => {
    const txs = [
      makeTx({ id: 'a', at: '2026-09-10T09:00:00+08:00', amount: 30000, direction: 'transfer', counterparty: '餐补' }),
      makeTx({ id: 'b', at: '2026-09-11T09:00:00+08:00', amount: 800000, direction: 'expense', counterparty: '工资' }),
    ];
    const candidates = scanIncomeCandidates(txs);
    expect(candidates[0].label).toBe('工资');
  });

  it('对方名为空时退回用线索词当 key，勾一次就能覆盖这批记录', () => {
    const txs = [
      makeTx({ id: 'a', at: '2026-09-10T09:00:00+08:00', amount: 5000, direction: 'transfer', note: '工资' }),
    ];
    const candidates = scanIncomeCandidates(txs);
    expect(candidates[0].keyword).toBe('工资');
  });
});

describe('白名单合并', () => {
  it('同关键词去重，后写入的分类生效', () => {
    const merged = mergeIncomeSources([WAGE], [{ ...WAGE, l2: 'bonus' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].l2).toBe('bonus');
  });

  it('不同关键词都保留，且关键词统一归一化', () => {
    const merged = mergeIncomeSources([WAGE], [SUBSIDY, { ...SUBSIDY, keyword: ' 交 通 补 ' }]);
    expect(merged.map((item) => item.keyword).sort()).toEqual(['交通补', 'xx科技有限公司', '餐补'].sort());
  });
});
