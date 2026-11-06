import { create } from 'zustand';
import { currentMonthRange, type DateRange } from '../domain/range';
import type { Direction } from '../types';

/**
 * Zustand 只存 **UI 态**（筛选条件、主题、弹窗开关）。
 * 业务数据的唯一来源是 IndexedDB（Dexie + useLiveQuery），不在这里复制一份。
 */

export type ThemeMode = 'light' | 'dark' | 'system';

/** 主题偏好的同步镜像：IndexDB 读取是异步的，首屏会先亮后暗，用 localStorage 消除闪烁。 */
const THEME_MIRROR_KEY = 'ledger.theme';

function readInitialThemeMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_MIRROR_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // 无痕模式 / 禁用站点数据时 localStorage 会抛，按跟随系统处理即可。
  }
  return 'system';
}

export interface LedgerFilterState {
  keyword: string;
  /**
   * 流水页自己的时间窗口，与总览/趋势的 `dateRange` 分开存。
   *
   * 为什么不共用：流水页是「查账」的地方，用户经常一边把总览固定在近 12 月看趋势，
   * 一边在流水里翻某个月的凭证。强行联动会让两边互相打架。
   * 空串表示「未指定」，页面渲染时回落到本月——这样 `EMPTY_FILTER` 保持为纯常量，
   * 「重置筛选」也真的能回到当月，而不是回到应用启动时那个月。
   */
  fromDate: string;
  toDate: string;
  l1: string;
  channel: string;
  /** 空串 = 全部来源。取值见 types.ts 的 Source。 */
  source: string;
  direction: Direction | '';
  minYuan: string;
  maxYuan: string;
  onlyFlagged: boolean;
}

export const EMPTY_FILTER: LedgerFilterState = {
  keyword: '',
  fromDate: '',
  toDate: '',
  l1: '',
  channel: '',
  source: '',
  direction: '',
  minYuan: '',
  maxYuan: '',
  onlyFlagged: false,
};

export interface SnackState {
  message: string;
  severity: 'success' | 'error' | 'info' | 'warning';
  /** 可选的可点操作（目前用于「撤销」）；有它时提示停留更久。 */
  actionLabel?: string;
  onAction?: () => void;
  /** 自定义停留毫秒数。 */
  duration?: number;
  /** 内部排队序号：让 Snackbar 换条时重挂载，重置自动关闭计时。 */
  id?: number;
}

interface UiState {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  currentMonthKey: string;
  setCurrentMonthKey: (monthKey: string) => void;
  /**
   * 全局日期区间（总览 / 洞察 / 趋势共用）。
   * 与 currentMonthKey 并存而不是替换：月度复盘卡、预算、Review 路由的语义就是「整月」，
   * 不能因为用户把区间拖成 3 天就变成"3 天的月度复盘"。两者靠 setDateRange 保持同步。
   */
  dateRange: DateRange;
  setDateRange: (range: DateRange) => void;
  filter: LedgerFilterState;
  setFilter: (patch: Partial<LedgerFilterState>) => void;
  resetFilter: () => void;
  snack: SnackState | null;
  snackQueue: SnackState[];
  showSnack: (snack: SnackState) => void;
  clearSnack: () => void;
  quickAddOpen: boolean;
  setQuickAddOpen: (open: boolean) => void;
  editingTxId: string | null;
  setEditingTxId: (id: string | null) => void;
  dataVersion: number;
  bumpLocalVersion: () => void;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** 连续两次写操作不再互相顶掉提示：后来的排队，当前这条关闭后接着显示。 */
let snackSeq = 0;

export const useUiStore = create<UiState>((set) => ({
  themeMode: readInitialThemeMode(),
  setThemeMode: (mode) => {
    try {
      localStorage.setItem(THEME_MIRROR_KEY, mode);
    } catch {
      // 存不了镜像也不影响本次会话内的主题切换。
    }
    set({ themeMode: mode });
  },
  currentMonthKey: currentMonth(),
  setCurrentMonthKey: (monthKey) => set({ currentMonthKey: monthKey }),
  dateRange: currentMonthRange(),
  /**
   * 区间变更时把 currentMonthKey 拉到区间**末月**。
   * 这样"月度复盘卡 / 预算"这类只能按整月看的卡片自动跟随区间末月，
   * 不会出现「区间选到 3 月，复盘卡还停在 1 月」的错乱。
   */
  setDateRange: (range) => {
    const from = range.from <= range.to ? range.from : range.to;
    const to = range.from <= range.to ? range.to : range.from;
    set({ dateRange: { from, to }, currentMonthKey: to.slice(0, 7) });
  },
  filter: { ...EMPTY_FILTER },
  setFilter: (patch) => set((state) => ({ filter: { ...state.filter, ...patch } })),
  resetFilter: () => set({ filter: { ...EMPTY_FILTER } }),
  snack: null,
  snackQueue: [],
  showSnack: (snack) =>
    set((state) => {
      const item: SnackState = { ...snack, id: ++snackSeq };
      if (state.snack) return { snackQueue: [...state.snackQueue, item] };
      return { snack: item };
    }),
  clearSnack: () =>
    set((state) => {
      const [next, ...rest] = state.snackQueue;
      return { snack: next ?? null, snackQueue: rest };
    }),
  quickAddOpen: false,
  setQuickAddOpen: (open) => set({ quickAddOpen: open }),
  editingTxId: null,
  setEditingTxId: (id) => set({ editingTxId: id }),
  dataVersion: 1,
  bumpLocalVersion: () => set((state) => ({ dataVersion: state.dataVersion + 1 })),
}));
