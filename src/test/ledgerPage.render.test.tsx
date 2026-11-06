import { ThemeProvider } from '@mui/material';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import * as transactionRepo from '../db/repos/transactionRepo';
import { ensureSeeded } from '../db/seed';
import { EMPTY_FILTER, useUiStore } from '../store/uiStore';
import { buildTheme } from '../ui/theme';
import { Ledger } from '../ui/pages/Ledger';
import { makeTx } from './txFixture';

/**
 * 流水页渲染测试。
 *
 * 为什么需要它：这次改的是筛选区的整个结构（月份下拉 → 任意日期区间 + 来源筛选）。
 * `tsc` 通过只说明类型对，不说明 5 个 `TextField select` 与两个 `type="date"`
 * 在运行时不会炸；而流水页是用户查账的唯一入口，它渲染不出来用户就什么都做不了。
 */

async function render(): Promise<string> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ThemeProvider theme={buildTheme('light')}>
        <MemoryRouter>
          <Ledger />
        </MemoryRouter>
      </ThemeProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
  const text = container.textContent ?? '';
  await act(async () => {
    root.unmount();
  });
  container.remove();
  return text;
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  await ensureSeeded(db);
  useUiStore.setState({ filter: { ...EMPTY_FILTER } });
});

describe('流水页 · 任意日期区间与来源标记', () => {
  it('日期区间跨年时把两端的账都渲染出来（不再受 12 个月窗口限制）', async () => {
    await transactionRepo.addMany([
      makeTx({ id: 'old', at: '2019-07-05T12:00:00+08:00', amount: 1234, source: 'wechat' }),
      makeTx({ id: 'new', at: '2020-06-20T12:00:00+08:00', amount: 5678, source: 'alipay' }),
    ]);
    useUiStore.setState({
      filter: { ...EMPTY_FILTER, fromDate: '2019-07-01', toDate: '2020-06-30' },
    });

    const text = await render();
    expect(text).toContain('流水');
    // 跨年区间下分组标题必须带年份，否则「7月5日」同时指向 2019 和 2020
    expect(text).toContain('2019年7月5日');
    expect(text).toContain('2020年6月20日');
    expect(text).toContain('2 笔');
    // 区间两端都落在结果里，证明不受「12 个月滚动窗口」限制
    expect(text).toContain('¥12.34');
    expect(text).toContain('¥56.78');
  });

  it('每行标出来源，多来源时标「多源」标签并给出提示', async () => {
    await transactionRepo.addMany([
      makeTx({ id: 'w', at: '2020-06-10T12:00:00+08:00', amount: 100, source: 'wechat' }),
      makeTx({ id: 'm', at: '2020-06-11T12:00:00+08:00', amount: 200, source: 'wechat', source_refs: ['wechat', 'alipay'] }),
    ]);
    useUiStore.setState({
      filter: { ...EMPTY_FILTER, fromDate: '2020-06-01', toDate: '2020-06-30' },
    });

    const text = await render();
    // 单来源行显示「微信」；多来源行显示「微信+支付宝」
    expect(text).toContain('微信');
    expect(text).toContain('微信+支付宝');
    // 头部给出「来源覆盖」而不是「来源分布」——各来源笔数之和会大于总笔数
    expect(text).toContain('来源覆盖');
  });

  it('筛选区同时提供「按月份」与「来源」两个入口（原来的月份下拉只剩滚动窗口）', async () => {
    await transactionRepo.addMany([makeTx({ id: 'x', at: '2020-06-10T12:00:00+08:00', amount: 100 })]);
    useUiStore.setState({
      filter: { ...EMPTY_FILTER, fromDate: '2020-06-01', toDate: '2020-06-30' },
    });

    const text = await render();
    expect(text).toContain('按月份');
    expect(text).toContain('来源');
    expect(text).toContain('全部来源');
    // 区间正好是整月时，月份选择器显示该月，而不是「自定义区间」
    expect(text).toContain('2020-06');
  });

  it('区间内没有记录时给出可操作的空态，而不是空白页', async () => {
    useUiStore.setState({
      filter: { ...EMPTY_FILTER, fromDate: '2015-01-01', toDate: '2015-01-31' },
    });
    const text = await render();
    expect(text).toContain('这个筛选下没有记录');
    expect(text).toContain('重置筛选');
  });
});
