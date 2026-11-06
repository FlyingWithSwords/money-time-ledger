import { describe, expect, it } from 'vitest';
import { workdayBudget } from '../domain/timecost';
import type { Cents } from '../types';

const yuan = (value: number): Cents => value * 100 as Cents;
/** 一元负号会把 branded 类型退化成 number，这里显式转回来 */
const negYuan = (value: number): Cents => (-value * 100) as Cents;
const WAGE_100 = yuan(100); // 时薪 100 元

/**
 * 「这段时间挣来的工天已经花掉多少」的纯计算。
 *
 * 这块逻辑存在的理由是对抗反向激励：只显示单笔「这杯咖啡 = 0.5 小时」
 * 会让用户觉得「不贵」，实测有人因此把月支出做到预算的 115%。
 * 所以必须有一个总量口径，且它的取整方向必须有立场——不能夸大消耗、也不能夸大剩余。
 */
describe('workdayBudget：劳动时间消耗预算', () => {
  it('常规：月薪口径下 21.7 个工作日的预算里花掉 26.4 个即为超支', () => {
    // 21120 元支出 / 100 元时薪 = 211.2 小时 / 8 = 26.4 个工作日
    const result = workdayBudget(yuan(21120), WAGE_100, 8, 174);
    expect(result).not.toBeNull();
    expect(result?.hours).toBe(211.2);
    expect(result?.consumed_days).toBe(26.4);
    // 174 / 8 = 21.75，向下取到 1 位小数
    expect(result?.total_days).toBe(21.7);
    expect(result?.overdrawn).toBe(true);
  });

  it('未超支时 overdrawn 为 false，比例小于 1', () => {
    const result = workdayBudget(yuan(5000), WAGE_100, 8, 174);
    expect(result?.consumed_days).toBe(6.2);
    expect(result?.overdrawn).toBe(false);
    expect(result?.ratio).toBeCloseTo(0.287, 2);
  });

  it('不足一天时仍给出小时数，供界面降级成「6.5 小时」', () => {
    const result = workdayBudget(yuan(650), WAGE_100, 8, 174);
    expect(result?.hours).toBe(6.5);
    expect(result?.consumed_days).toBe(0.8);
  });

  it('消耗天数向下取整，不夸大（1.99 天不能显示成 2 天）', () => {
    // 1592 元 / 100 = 15.92 小时 / 8 = 1.99 天
    const result = workdayBudget(yuan(1592), WAGE_100, 8, 174);
    expect(result?.consumed_days).toBe(1.9);
  });

  it('净支出为负（退款冲正大于支出）时消耗记 0，不取绝对值', () => {
    const result = workdayBudget(negYuan(500), WAGE_100, 8, 174);
    expect(result?.hours).toBe(0);
    expect(result?.consumed_days).toBe(0);
    expect(result?.overdrawn).toBe(false);
  });

  it('没有时薪时返回 null，界面整块不渲染（不显示 0、不占位）', () => {
    expect(workdayBudget(yuan(100), 0 as Cents, 8, 174)).toBeNull();
    expect(workdayBudget(yuan(100), negYuan(1), 8, 174)).toBeNull();
  });

  it('月工时为 0 时不臆造总预算：total_days 为 0、ratio 为 null', () => {
    const result = workdayBudget(yuan(1000), WAGE_100, 8, 0);
    expect(result?.total_days).toBe(0);
    expect(result?.ratio).toBeNull();
    expect(result?.overdrawn).toBe(false);
  });

  it('每日工时非法时退回 8 小时，不抛错也不除零', () => {
    const result = workdayBudget(yuan(1600), WAGE_100, 0, 174);
    expect(result?.consumed_days).toBe(2);
  });
});
