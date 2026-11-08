import { ThemeProvider } from '@mui/material';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

/* ------------------------------------------------------------------ *
 * 筛选区布局回归（末行半空 / 三个「全部」分不清 / label 被 chips 压住）
 *
 * 上面那组用例只读 `textContent`，而这次的三个缺陷全是**结构**问题：
 * 文字都在，只是位置错、label 没上浮、被上一行压住。纯文本断言对它们完全
 * 免疫——把代码改回旧样子，`toContain('按月份')` 依然是绿的。所以下面改用
 * DOM 结构（label 的 shrink 状态、控件的父容器、控件的兄弟数量）来钉。
 * ------------------------------------------------------------------ */

/** 筛选区五个控件的 label 文案。按文案定位控件，不用位置下标或哈希类名。 */
const FILTER_LABEL_TEXTS = ['按月份', '来源', '一级分类', '渠道', '方向'] as const;

interface MountedLedger {
  container: HTMLElement;
  /** 卸载并摘掉容器：label 的 htmlFor 是全局 id 查询，残留节点会污染后面的用例。 */
  unmount: () => Promise<void>;
}

/**
 * 挂载流水页并**保留 DOM**（上面那个 `render()` 只回传文本，没法查结构）。
 *
 * 末尾那一轮 `act` 是给 Dexie 的 `useLiveQuery` 一个真实事件循环轮次把数据取回来，
 * 与本文件既有辅助函数完全一致；断言本身不依赖时间，只看结构。
 */
async function mountLedger(): Promise<MountedLedger> {
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
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** 本文件新增用例挂载的页面，用例结束统一卸载，避免 DOM 与 useId 串到下一个用例。 */
const mountedPages: MountedLedger[] = [];

afterEach(async () => {
  while (mountedPages.length > 0) {
    const page = mountedPages.pop();
    if (page) await page.unmount();
  }
});

/** 按文案找 MUI TextField 的 `<label>`；找不到直接抛，让报错指向「结构变了」而不是空指针。 */
function findLabel(container: HTMLElement, text: string): HTMLLabelElement {
  const hit = Array.from(container.querySelectorAll('label')).find(
    (el) => (el.textContent ?? '').trim() === text,
  );
  if (!hit) throw new Error(`找不到文案为「${text}」的 label：筛选区结构可能被改动了`);
  return hit;
}

/**
 * label 是否处于「上浮」状态（骑在边框上、始终可见）。
 *
 * MUI 由同一个 `shrink` prop 同时产出 `MuiInputLabel-shrink` 类与 `data-shrink`
 * 属性，这里任一为真即认，避免 MUI 小版本换实现时误报；但只要有人删掉
 * `InputLabelProps={{ shrink: true }}`，两者都会变 false，护栏照样生效。
 */
function isLabelShrunk(label: HTMLLabelElement): boolean {
  return (
    label.classList.contains('MuiInputLabel-shrink') || label.getAttribute('data-shrink') === 'true'
  );
}

/**
 * 从 label 反查它所属的 `.MuiFormControl-root`（即这个筛选控件的根节点）。
 *
 * 走 `htmlFor → getElementById → closest`，而不是 `label.parentElement`：
 * 这样顺手验证了 label 与控件的关联关系没断（label 点不动、读屏读不出维度名
 * 都是从这儿坏的）。极端情况下 htmlFor 拿不到目标元素，再退回 `closest`。
 */
function formControlOf(container: HTMLElement, labelText: string): HTMLElement {
  const label = findLabel(container, labelText);
  const target = label.htmlFor ? document.getElementById(label.htmlFor) : null;
  const root = target?.closest('.MuiFormControl-root') ?? label.closest('.MuiFormControl-root');
  if (!root) throw new Error(`「${labelText}」没有落在 .MuiFormControl-root 里，控件结构异常`);
  return root as HTMLElement;
}

/**
 * 读计算样式（CSS 属性名直接用连字符写法）。
 *
 * jsdom 能解析 emotion 注入的普通声明，但**不解析媒体查询**——所以只能用来断言
 * 非响应式的布局声明，见下面各用例里的说明。
 */
function styleOf(el: Element, prop: 'display' | 'padding-top'): string {
  return getComputedStyle(el).getPropertyValue(prop);
}

/** 取父容器；没有就直接抛，免得到处写 `if (!parent) return` 让用例静默通过。 */
function parentOf(el: Element, label: string): HTMLElement {
  const parent = el.parentElement;
  if (!parent) throw new Error(`「${label}」没有父容器，页面结构异常`);
  return parent;
}

describe('流水页 · 筛选区布局（末行半空 / 三个「全部」分不清 / label 被 chips 压住）', () => {
  /** 造一笔 2020-06 的账，并把区间设成整月：此时「按月份」的值是 `2020-06`，非空。 */
  async function seedJune(): Promise<void> {
    await transactionRepo.addMany([
      makeTx({ id: 'j1', at: '2020-06-10T12:00:00+08:00', amount: 100 }),
    ]);
    useUiStore.setState({
      filter: { ...EMPTY_FILTER, fromDate: '2020-06-01', toDate: '2020-06-30' },
    });
  }

  it('五个控件的 label 全部渲染且都上浮（防「三个『全部』分不清」复发）', async () => {
    await seedJune();
    const page = await mountLedger();
    mountedPages.push(page);

    // 五个维度名都在 DOM 里：先把「控件的 label 没被占位文本顶掉」这件事钉住
    for (const text of FILTER_LABEL_TEXTS) {
      expect(findLabel(page.container, text).textContent?.trim()).toBe(text);
    }

    // 核心护栏：`shrink: true` 被删掉时，空值控件的 label 会退回未上浮，
    // 屏幕上就又是三个一模一样的「全部」。逐个数 shrink 的 label 才不会漏。
    const allLabels = Array.from(page.container.querySelectorAll('label'));
    const shrunkLabels = allLabels.filter(isLabelShrunk);
    // 5 个筛选控件 + 开始/结束两个日期框 = 7 个上浮 label。
    // 断言 >= 5 而不是 === 7：日期框不属于本次回归范围，将来增删别的带 label 的
    // 控件不该让这条用例变红；真正的定位在下面逐个控件的检查。
    expect(shrunkLabels.length).toBeGreaterThanOrEqual(5);

    for (const text of FILTER_LABEL_TEXTS) {
      expect(isLabelShrunk(findLabel(page.container, text))).toBe(true);
    }
  });

  it('区间不是整月时「按月份」的 label 依然上浮（value 为空串时最容易掉回未上浮）', async () => {
    await transactionRepo.addMany([
      makeTx({ id: 'j2', at: '2020-06-10T12:00:00+08:00', amount: 100 }),
    ]);
    // 6/3 ~ 6/17 不是整月 → 月份下拉的 value 是空串，显示「自定义区间」。
    // MUI 默认认为「空值 = 未聚焦」→ 不上浮 → label 被占位文本盖住，正好复现缺陷 2。
    useUiStore.setState({
      filter: { ...EMPTY_FILTER, fromDate: '2020-06-03', toDate: '2020-06-17' },
    });
    const page = await mountLedger();
    mountedPages.push(page);

    expect(isLabelShrunk(findLabel(page.container, '按月份'))).toBe(true);
    // 顺带确认前提成立：此刻下拉里显示的确实是「自定义区间」，不是某个具体月份
    expect(page.container.textContent ?? '').toContain('自定义区间');
  });

  it('「按月份」已移出维度网格：它与「来源」不共享父容器（防末行半空复发）', async () => {
    await seedJune();
    const page = await mountLedger();
    mountedPages.push(page);

    const monthRoot = formControlOf(page.container, '按月份');
    const sourceRoot = formControlOf(page.container, '来源');

    // 同一个父容器 = 月份又被塞回那个 2 列网格 → 5 个格子排成 3 行、末行只剩「方向」
    expect(monthRoot.parentElement).not.toBe(sourceRoot.parentElement);
    // 反向确认：网格里不含月份（两者即便父容器不同，也不该有包含关系）
    expect(parentOf(sourceRoot, '来源').contains(monthRoot)).toBe(false);
    expect(parentOf(monthRoot, '按月份').contains(sourceRoot)).toBe(false);
  });

  it('维度网格恰好 4 个控件（2×2 填满，不多不少）', async () => {
    await seedJune();
    const page = await mountLedger();
    mountedPages.push(page);

    const grid = parentOf(formControlOf(page.container, '来源'), '来源');

    // 用 `:scope >` 限定「直接子节点」，防止将来把控件再包一层后数量被算多
    const controls = Array.from(grid.querySelectorAll(':scope > .MuiFormControl-root'));
    // 4 个正好 2 列填满 2 行；5 个（月份回来了）或 3 个（漏了一个维度）都会让
    // 末行只剩一个半格子，视觉上又变回「残缺感」
    expect(controls).toHaveLength(4);
    expect(controls.map((el) => el.querySelector('label')?.textContent?.trim())).toEqual([
      '来源',
      '一级分类',
      '渠道',
      '方向',
    ]);
    // `display: grid` 是非响应式声明，jsdom 能算出来；
    // 但 `gridTemplateColumns` 写的是 `{ xs, sm }` 响应式对象，emotion 会把它塞进
    // 媒体查询，jsdom 不解析媒体查询（取到空串），所以这里不断言列数——
    // 「正好 4 个控件」已经等价表达了「2×2 填满、没有半空末行」。
    expect(styleOf(grid, 'display')).toBe('grid');
  });

  it('chips 行与维度网格都留了 label 上浮的空间（防「按月份」被 chips 压住）', async () => {
    await seedJune();
    const page = await mountLedger();
    mountedPages.push(page);

    const monthRow = parentOf(formControlOf(page.container, '按月份'), '按月份');
    const grid = parentOf(formControlOf(page.container, '来源'), '来源');

    // `pt: 1` → 8px。MUI 的 label 有一半骑在边框上，这段留白去掉后
    // label 上半截就被上一行的日期输入框压住，看起来像被切掉一块。
    // 断言 8px（theme spacing 1）而不是「大于 0」：顺手锁住设计意图的量级。
    expect(styleOf(monthRow, 'padding-top')).toBe('8px');
    expect(styleOf(grid, 'padding-top')).toBe('8px');
    // 月份那一行是横向排布（chips 可滚动 + 下拉固定宽度），不是网格
    expect(styleOf(monthRow, 'display')).toBe('flex');
  });
});

