import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import RestoreIcon from '@mui/icons-material/Restore';
import SearchIcon from '@mui/icons-material/Search';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import StarIcon from '@mui/icons-material/Star';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  InputAdornment,
  ListItemButton,
  ListItemText,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as planRepo from '../../db/repos/planRepo';
import * as settingsRepo from '../../db/repos/settingsRepo';
import * as transactionRepo from '../../db/repos/transactionRepo';
import { dayNetExpenseCents, groupByDate, isActiveTx } from '../../domain/txUtils';
import { computeMonthFlags, flagsFor, type FlagHit } from '../../domain/flags';
import { formatDayLabel } from '../../domain/date';
import {
  currentMonthRange,
  isWholeMonth,
  lastNMonthsRange,
  normalizeRange,
  rangeLabel,
  sameRange,
  shiftRangeBack,
  wholeMonthRange,
  yearToDate,
  type DateRange,
} from '../../domain/range';
import { INVEST_PRINCIPAL_FLAG } from '../../domain/investPrincipal';
import { formatCents, yuanToCents } from '../../domain/money';
import { provenanceOf, provenanceShortLabel, sourceBreakdown } from '../../domain/provenance';
import {
  CHANNEL_LABEL,
  DIRECTION_LABEL,
  SOURCE_LABEL,
  type Source,
  type Transaction,
} from '../../types';
import { useUiStore } from '../../store/uiStore';
import { shouldSuppressClick } from '../../store/dragStore';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { FlagChips } from '../components/FlagChips';
import { TimeCostLine } from '../components/TimeCostLine';
import { useDragSource, useDropTarget } from '../dnd/useDragSource';
import { useCategoryTree, useWageResult, useWageSettings } from '../hooks/useLedgerData';
import type { CategoryTree } from '../../db/repos/categoryRepo';
import { PLAN_KIND_LABEL, type Plan } from '../../types';

/**
 * P2 流水：按日分组（日期 + 当日合计），行内展示分类 / 金额 / 渠道 / 来源 / 时间成本 / 标记。
 * 左滑编辑、右滑标"最不值"；删除后可撤销（软删）。
 *
 * 时间筛选从「月份下拉」改成「任意日期区间」：原来的下拉只生成「当前月 + 往前 11 个月」，
 * 且以**当前选中月**为基准，所以选 2019-07 之后列表就变成 2019-07~2018-08，
 * 永远够不到 2020-07 以后。账单横跨两三年时这个控件等于不可用。
 */
export function Ledger(): JSX.Element {
  const filter = useUiStore((state) => state.filter);
  const setFilter = useUiStore((state) => state.setFilter);
  const resetFilter = useUiStore((state) => state.resetFilter);
  const setEditingTxId = useUiStore((state) => state.setEditingTxId);
  const showSnack = useUiStore((state) => state.showSnack);
  const settings = useWageSettings();
  const wage = useWageResult(settings);
  const tree = useCategoryTree();
  const [showDeleted, setShowDeleted] = useState(false);
  const [lastDeleted, setLastDeleted] = useState<Transaction | null>(null);
  /** 待确认删除的流水：非 null 即打开二次确认框。 */
  const [pendingDelete, setPendingDelete] = useState<Transaction | null>(null);
  /** 所有异步写共用的闸门，避免连点重复提交。 */
  const [busy, setBusy] = useState(false);

  /**
   * 批量模式。
   *
   * 记账是碎片时间做的事：一次导入后往往要连着改十几笔的分类，
   * 逐笔点开编辑框是这条路径上最慢的一环。批量模式的全部目的就是
   * 「一次多选、一次落地」，所以它不做二次确认，删除后靠可撤销的提示兜底。
   */
  const [batch, setBatch] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  /** 待选二级的一级分类：拖到分类 chip 或点它时打开 */
  const [pendingL1, setPendingL1] = useState<string | null>(null);
  /** 这次要改的是哪几笔（拖拽的可能是没勾选的那一行） */
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const plans = useLiveQuery(() => planRepo.list(), [], []) ?? [];

  /**
   * 批量模式下收起右下角悬浮球。
   *
   * 它是 fixed 的，滚到哪都盖住行右侧的金额；而批量核对时用户最需要看清的就是这个数。
   * 卸载时（离开流水页）一定要还原，否则用户回到总览会发现「记一笔」不见了。
   */
  const setFabHidden = useUiStore((state) => state.setFabHidden);
  useEffect(() => {
    setFabHidden(batch);
    return () => setFabHidden(false);
  }, [batch, setFabHidden]);

  const l1Name = (id: string): string => tree.l1List.find((item) => item.id === id)?.name ?? id;
  const l2Name = (l1: string, l2: string): string =>
    tree.byL1.get(l1)?.find((item) => item.l2_id === l2)?.l2_name ?? l2;

  const exitBatch = (): void => {
    setBatch(false);
    setSelected([]);
  };

  const toggleSelect = (id: string): void => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const applyCategory = async (ids: readonly string[], l1: string, l2: string): Promise<void> => {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    try {
      const changed = await transactionRepo.bulkUpdateCategory(ids, l1, l2);
      await settingsRepo.bumpDataVersion();
      showSnack({ message: `已把 ${changed} 笔改成「${l1Name(l1)} · ${l2Name(l1, l2)}」`, severity: 'success' });
      exitBatch();
    } catch (error) {
      showSnack({ message: `操作失败：${error instanceof Error ? error.message : String(error)}`, severity: 'error' });
    } finally {
      setBusy(false);
      setPendingL1(null);
      setPendingIds([]);
    }
  };

  /** 打开二级选择：拖到 chip 与点 chip 走同一条路径，行为可预期。 */
  const startAssign = (l1: string, ids: readonly string[]): void => {
    if (ids.length === 0) {
      showSnack({ message: '先勾选或拖动至少一笔', severity: 'info' });
      return;
    }
    setPendingIds([...ids]);
    setPendingL1(l1);
  };

  const applyDelete = async (): Promise<void> => {
    if (selected.length === 0 || busy) return;
    const ids = [...selected];
    setBusy(true);
    try {
      const changed = await transactionRepo.bulkSoftDelete(ids);
      await settingsRepo.bumpDataVersion();
      exitBatch();
      showSnack({
        message: `已删除 ${changed} 笔`,
        severity: 'info',
        actionLabel: '撤销',
        onAction: () => {
          void transactionRepo.bulkRestore(ids).then(() => settingsRepo.bumpDataVersion());
        },
      });
    } catch (error) {
      showSnack({ message: `操作失败：${error instanceof Error ? error.message : String(error)}`, severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const applyNote = async (): Promise<void> => {
    const text = noteText.trim();
    if (!text || selected.length === 0 || busy) return;
    setBusy(true);
    try {
      const changed = await transactionRepo.bulkAppendNote(selected, text);
      await settingsRepo.bumpDataVersion();
      setNoteOpen(false);
      setNoteText('');
      exitBatch();
      showSnack({ message: `已给 ${changed} 笔加上备注`, severity: 'success' });
    } catch (error) {
      showSnack({ message: `操作失败：${error instanceof Error ? error.message : String(error)}`, severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const applyPlan = async (plan: Plan, ids: readonly string[]): Promise<void> => {
    if (ids.length === 0 || busy) return;
    const items = (rows ?? []).filter((tx) => ids.includes(tx.id));
    const compatible =
      plan.kind === 'save'
        ? items.filter((tx) => tx.direction === 'income')
        : items.filter((tx) => tx.direction === 'expense' || tx.direction === 'refund');
    if (compatible.length === 0) {
      showSnack({
        message: plan.kind === 'save' ? `「${plan.title}」是攒钱计划，只累计收入记录` : `「${plan.title}」是消费计划，只累计支出记录`,
        severity: 'warning',
      });
      return;
    }
    setBusy(true);
    try {
      const added = await planRepo.link(
        plan.id,
        compatible.map((tx) => tx.id),
      );
      await settingsRepo.bumpDataVersion();
      const skipped = items.length - compatible.length;
      exitBatch();
      showSnack({
        message: skipped > 0 ? `已加入「${plan.title}」${added} 笔（${skipped} 笔方向不符未计入）` : `已加入「${plan.title}」${added} 笔`,
        severity: 'success',
      });
    } catch (error) {
      showSnack({ message: `操作失败：${error instanceof Error ? error.message : String(error)}`, severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const monthsWithData = useLiveQuery(() => transactionRepo.monthsWithData(), [], []) ?? [];

  /** 未指定区间时回落到本月：`EMPTY_FILTER` 保持纯常量，重置也能真的回到当月。 */
  const range = useMemo<DateRange>(
    () =>
      filter.fromDate && filter.toDate
        ? normalizeRange({ from: filter.fromDate, to: filter.toDate })
        : currentMonthRange(),
    [filter.fromDate, filter.toDate],
  );

  /** 「全部」= 最早有数据月 1 号 → 最晚有数据月月末。没有数据时退回本月。 */
  const allRange = useMemo<DateRange>(() => {
    if (monthsWithData.length === 0) return currentMonthRange();
    return {
      from: wholeMonthRange(monthsWithData[0]).from,
      to: wholeMonthRange(monthsWithData[monthsWithData.length - 1]).to,
    };
  }, [monthsWithData]);

  const applyRange = (next: DateRange): void => setFilter({ fromDate: next.from, toDate: next.to });

  const rows = useLiveQuery(
    () =>
      transactionRepo.search({
        keyword: filter.keyword,
        fromDate: range.from,
        toDate: range.to,
        l1: filter.l1 || undefined,
        channel: filter.channel || undefined,
        source: filter.source || undefined,
        direction: filter.direction || undefined,
        minCents: toOptionalCents(filter.minYuan),
        maxCents: toOptionalCents(filter.maxYuan),
        onlyFlagged: filter.onlyFlagged,
      }),
    [filter, range.from, range.to],
    [] as Transaction[],
  );

  const deletedRows = useLiveQuery(
    () =>
      transactionRepo
        .listByDateRange(range.from, range.to, true)
        .then((list) => list.filter((tx) => tx.deleted_at)),
    [range.from, range.to, showDeleted],
    [] as Transaction[],
  );

  /**
   * 标记按**各自所属月份**分别计算。
   *
   * 不能把整个区间的交易一起丢给 computeMonthFlags：它的规则里有「超过当月日均 3 倍」
   * 与「7 天内重复」这类相对量，跨月混算会让分母变成整个区间的天数，
   * 三个月的账看起来「天天都很省」，冲动标记集体消失——不报错，只是安静地不标了。
   */
  const flags = useMemo(() => {
    const merged = new Map<string, FlagHit[]>();
    const byMonth = new Map<string, Transaction[]>();
    for (const tx of rows ?? []) {
      const list = byMonth.get(tx.month_key);
      if (list) list.push(tx);
      else byMonth.set(tx.month_key, [tx]);
    }
    for (const [month, list] of byMonth) {
      for (const [id, hits] of computeMonthFlags(list, month)) merged.set(id, hits);
    }
    return merged;
  }, [rows]);

  const groups = useMemo(() => groupByDate(rows ?? []), [rows]);
  const total = useMemo(
    () => (rows ?? []).filter(isActiveTx).reduce((acc, tx) => acc + (tx.direction === 'expense' ? tx.amount_cents : 0), 0),
    [rows],
  );
  const breakdown = useMemo(() => sourceBreakdown(rows ?? []), [rows]);

  /** 选中金额合计：拖动多笔时浮层显示的是这笔账一共多少钱，不是单笔。 */
  const selectedTotal = useMemo(
    () => (rows ?? []).filter((tx) => selected.includes(tx.id)).reduce((sum, tx) => sum + tx.amount_cents, 0),
    [rows, selected],
  );

  /** 删除的原有写路径保持不变，只是改由确认框触发。 */
  const performDelete = async (tx: Transaction): Promise<void> => {
    await transactionRepo.softDelete(tx.id);
    await settingsRepo.bumpDataVersion();
    setLastDeleted(tx);
    showSnack({ message: '已删除，可撤销', severity: 'info' });
  };

  const handleConfirmDelete = async (): Promise<void> => {
    const tx = pendingDelete;
    if (!tx) return;
    setBusy(true);
    try {
      await performDelete(tx);
    } finally {
      setBusy(false);
      setPendingDelete(null);
    }
  };

  const handleRestore = async (tx: Transaction): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await transactionRepo.restore(tx.id);
      await settingsRepo.bumpDataVersion();
      setLastDeleted(null);
      showSnack({ message: '已恢复', severity: 'success' });
    } finally {
      setBusy(false);
    }
  };

  const toggleWorthless = async (tx: Transaction): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const marked = (tx.flags ?? []).includes('most_worthless');
      await transactionRepo.setMostWorthless(tx.id, !marked);
      await settingsRepo.bumpDataVersion();
      showSnack({ message: marked ? '已取消「最不值」' : '已标记「最不值」', severity: 'success' });
    } finally {
      setBusy(false);
    }
  };

  const monthValue = isWholeMonth(range) ? range.from.slice(0, 7) : '';
  // 跨年区间下日期分组必须带年份，否则「7月5日」同时指向两年
  const spansYears = range.from.slice(0, 4) !== range.to.slice(0, 4);

  /**
   * 月份下拉的选项：以「实际有数据的月份」为全集，并补上当前区间所在的月。
   * 不补的话，用户用日期输入跳到某个空月份时，`value` 不在选项里，
   * MUI 会把它渲染成空白并抛 out-of-range 警告（界面上就是一个空框）。
   */
  const monthChoices = useMemo(() => {
    const list = monthsWithData.slice().sort((a, b) => (a < b ? 1 : -1));
    if (monthValue && !list.includes(monthValue)) list.unshift(monthValue);
    return list;
  }, [monthsWithData, monthValue]);

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Box>
          <Typography variant="h6" sx={{ fontSize: 20 }}>
            流水
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {rangeLabel(range)} · {(rows ?? []).length} 笔 · 支出 {formatCents(total)}
          </Typography>
          {breakdown.length > 1 && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              来源覆盖：
              {breakdown
                .map((item) => `${SOURCE_LABEL[item.source]} ${item.count}`)
                .join(' · ')}
            </Typography>
          )}
        </Box>
        <Button
          size="small"
          variant={batch ? 'contained' : 'outlined'}
          onClick={() => (batch ? exitBatch() : setBatch(true))}
          sx={{ flexShrink: 0 }}
        >
          {batch ? '退出批量' : '批量'}
        </Button>
      </Box>

      <Stack spacing={1} sx={{ mb: 1.5 }}>
        <TextField
          size="small"
          placeholder="搜索对方、备注、分类"
          value={filter.keyword}
          onChange={(event) => setFilter({ keyword: event.target.value })}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
          fullWidth
        />

        <Stack direction="row" spacing={1} alignItems="center">
          <TextField
            label="开始"
            type="date"
            size="small"
            value={range.from}
            onChange={(event) => {
              const value = event.target.value;
              if (!value) return;
              // 起止颠倒不报错，直接交换——改过头是常见手误，弹错只会让他多点一次
              applyRange(normalizeRange({ from: value, to: range.to }));
            }}
            InputLabelProps={{ shrink: true }}
            inputProps={{ 'aria-label': '开始日期' }}
            sx={{ flex: 1, minWidth: 0 }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
            ~
          </Typography>
          <TextField
            label="结束"
            type="date"
            size="small"
            value={range.to}
            onChange={(event) => {
              const value = event.target.value;
              if (!value) return;
              applyRange(normalizeRange({ from: range.from, to: value }));
            }}
            InputLabelProps={{ shrink: true }}
            inputProps={{ 'aria-label': '结束日期' }}
            sx={{ flex: 1, minWidth: 0 }}
          />
        </Stack>

        {/*
          「快捷区间 chips」与「按月份」下拉合成一行：它们回答的是同一个问题
          （看哪段时间），排在一起用户不必在两处之间来回找。
          - chips 横向可滚动，`flex: 1 + minWidth: 0` 才能在容器里正常收缩，
            否则 flex 子项默认 min-width: auto 会把整行撑宽、把下拉挤出屏幕；
          - 「按月份」固定成 150px 不参与收缩，保证月份文字（YYYY-MM）不被截断；
          - xs 下强制换行：chips 占满一行，下拉下一行占满宽度，避免 chips 被压成几个像素；
          - `pt: 1` 是给下拉 label 上浮留的高度——MUI 的 label 有一半骑在边框上，
            没有这段留白就会被上一行的日期输入框压住，看起来像被切掉一块。
        */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            flexWrap: { xs: 'wrap', sm: 'nowrap' },
            pt: 1,
          }}
        >
          <Box
            sx={{
              flex: { xs: '1 1 100%', sm: 1 },
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              overflowX: 'auto',
              flexWrap: 'nowrap',
              '&::-webkit-scrollbar': { display: 'none' },
              scrollbarWidth: 'none',
            }}
          >
            {RANGE_PRESETS.map((preset) => {
              const active = sameRange(range, preset.build());
              return (
                <Chip
                  key={preset.key}
                  label={preset.label}
                  size="small"
                  clickable
                  color={active ? 'primary' : 'default'}
                  variant={active ? 'filled' : 'outlined'}
                  onClick={() => applyRange(preset.build())}
                  sx={{ flexShrink: 0 }}
                />
              );
            })}
            <Chip
              label="全部"
              size="small"
              clickable
              color={sameRange(range, allRange) ? 'primary' : 'default'}
              variant={sameRange(range, allRange) ? 'filled' : 'outlined'}
              onClick={() => applyRange(allRange)}
              sx={{ flexShrink: 0 }}
            />
          </Box>

          {/*
            月份快捷跳转：列出**实际有数据**的月份，而不是「当前月往前推 12 个月」。
            用户原来的痛点就是列表永远只覆盖一个滚动窗口；这里的数据源换成
            monthsWithData()，账目跨多少年就能选到多少年。
            它原来在 2 列网格里，和其余 4 个维度筛混合排 → 5 个格子排成 3 行、末行半个空格。
            移到这里既消掉空行，也让它和 chips 语义对齐。
          */}
          <TextField
            select
            SelectProps={{ displayEmpty: true }}
            size="small"
            label="按月份"
            value={monthValue}
            onChange={(event) => {
              const next = event.target.value;
              if (next) applyRange(wholeMonthRange(next));
            }}
            InputLabelProps={{ shrink: true }}
            sx={{ flexShrink: 0, width: { xs: '100%', sm: 150 } }}
          >
            <MenuItem value="">自定义区间</MenuItem>
            {monthChoices.map((month) => (
              <MenuItem key={month} value={month}>
                {month}
              </MenuItem>
            ))}
          </TextField>
        </Box>

        {/*
          剩下 4 个「筛选维度」走规整 2×2（xs 单列）：4 个正好填满，
          不会再出现末行只有「方向」一个、右边半个格子空着的残缺感。
          `pt: 1` 同样是给这 4 个 label 上浮留的呼吸位。
        */}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' },
            gap: 1,
            pt: 1,
          }}
        >
          {/*
            下面 4 个 select 都强制 `shrink: true`：它们的值可以是空串（「全部来源 / 全部」），
            MUI 判定「空值 = 未聚焦」就不会上浮 label，于是占位文本把 label 整个盖住，
            屏幕上就出现三个一模一样的「全部」，用户分不清哪个是分类、哪个是渠道、哪个是方向。
            固定上浮后，即使不展开下拉，也能从边框上的标签读出每个框的维度。
          */}
          <TextField
            select
            SelectProps={{ displayEmpty: true }}
            size="small"
            label="来源"
            value={filter.source}
            onChange={(event) => setFilter({ source: event.target.value })}
            InputLabelProps={{ shrink: true }}
          >
            <MenuItem value="">全部来源</MenuItem>
            {(Object.keys(SOURCE_LABEL) as Source[]).map((source) => (
              <MenuItem key={source} value={source}>
                {SOURCE_LABEL[source]}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            SelectProps={{ displayEmpty: true }}
            size="small"
            label="一级分类"
            value={filter.l1}
            onChange={(event) => setFilter({ l1: event.target.value })}
            InputLabelProps={{ shrink: true }}
          >
            <MenuItem value="">全部</MenuItem>
            {tree.l1List.map((item) => (
              <MenuItem key={item.id} value={item.id}>
                {item.icon} {item.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            SelectProps={{ displayEmpty: true }}
            size="small"
            label="渠道"
            value={filter.channel}
            onChange={(event) => setFilter({ channel: event.target.value })}
            InputLabelProps={{ shrink: true }}
          >
            <MenuItem value="">全部</MenuItem>
            {Object.entries(CHANNEL_LABEL).map(([value, label]) => (
              <MenuItem key={value} value={value}>
                {label}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            SelectProps={{ displayEmpty: true }}
            size="small"
            label="方向"
            value={filter.direction}
            onChange={(event) => setFilter({ direction: event.target.value as typeof filter.direction })}
            InputLabelProps={{ shrink: true }}
          >
            <MenuItem value="">全部</MenuItem>
            {Object.entries(DIRECTION_LABEL).map(([value, label]) => (
              <MenuItem key={value} value={value}>
                {label}
              </MenuItem>
            ))}
          </TextField>
        </Box>

        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Chip
            label="只看「最不值」"
            size="small"
            color={filter.onlyFlagged ? 'secondary' : 'default'}
            variant={filter.onlyFlagged ? 'filled' : 'outlined'}
            onClick={() => setFilter({ onlyFlagged: !filter.onlyFlagged })}
          />
          <Chip label="重置筛选" size="small" variant="outlined" onClick={resetFilter} />
          <Chip
            label={showDeleted ? '隐藏已删除' : `已删除 ${(deletedRows ?? []).length}`}
            size="small"
            variant="outlined"
            onClick={() => setShowDeleted((value) => !value)}
          />
        </Stack>
      </Stack>

      {/*
        批量工具栏：sticky 到顶部，因为拖拽的落点就在这里。
        不 sticky 的话用户往下翻两屏后再拖，目标已经在屏幕外，拖动等于白做。
      */}
      {batch && (
        <Box
          sx={{
            position: 'sticky',
            top: 0,
            zIndex: 4,
            bgcolor: 'background.default',
            py: 1,
            mb: 1,
            borderBottom: '1px solid',
            borderColor: 'divider',
          }}
        >
          <Typography variant="caption" color="text.secondary">
            {selected.length > 0
              ? `已选 ${selected.length} 笔：点下面的分类落地，或把行拖到分类/计划上`
              : '点行左边的方框多选；也可以按住一行拖到下面的分类或计划上'}
          </Typography>
          <Box
            sx={{
              display: 'flex',
              gap: 0.75,
              overflowX: 'auto',
              mt: 0.75,
              pb: 0.25,
              '&::-webkit-scrollbar': { display: 'none' },
              scrollbarWidth: 'none',
            }}
          >
            {tree.l1List.map((item) => (
              <L1DropChip
                key={item.id}
                id={item.id}
                label={`${item.icon} ${item.name}`}
                onClick={() => startAssign(item.id, selected)}
                onDrop={(ids) => startAssign(item.id, ids)}
              />
            ))}
          </Box>
          {plans.some((plan) => plan.status === 'active') && (
            <Box
              sx={{
                display: 'flex',
                gap: 0.75,
                overflowX: 'auto',
                mt: 0.75,
                pb: 0.25,
                '&::-webkit-scrollbar': { display: 'none' },
                scrollbarWidth: 'none',
              }}
            >
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ flexShrink: 0, alignSelf: 'center', mr: 0.5, whiteSpace: 'nowrap' }}
              >
                加入计划
              </Typography>
              {plans
                .filter((plan) => plan.status === 'active')
                .map((plan) => (
                  <PlanDropChip
                    key={plan.id}
                    plan={plan}
                    onClick={() => void applyPlan(plan, selected)}
                    onDrop={(ids) => void applyPlan(plan, ids)}
                  />
                ))}
            </Box>
          )}
        </Box>
      )}

      {lastDeleted && (
        <Alert
          severity="info"
          sx={{ mb: 1.5 }}
          action={
            <Button size="small" startIcon={<RestoreIcon />} disabled={busy} onClick={() => void handleRestore(lastDeleted)}>
              撤销
            </Button>
          }
        >
          删除了 1 笔 {formatCents(lastDeleted.amount_cents)}
        </Alert>
      )}

      {groups.length === 0 ? (
        <EmptyState
          icon="🔍"
          title="这个筛选下没有记录"
          description="换个日期区间或来源看看，或者直接记一笔。"
          primary={{ label: '记一笔', onClick: () => useUiStore.getState().setQuickAddOpen(true) }}
          secondary={{ label: '重置筛选', onClick: resetFilter }}
        />
      ) : (
        groups.map((group) => {
          const dayTotal = dayNetExpenseCents(group.txs);
          return (
            <Box key={group.date} sx={{ mb: 1.5 }}>
              <Box
                sx={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  px: 0.5,
                  py: 0.5,
                  position: 'sticky',
                  top: 0,
                  bgcolor: 'background.default',
                  zIndex: 1,
                }}
              >
                <Typography variant="caption" color="text.secondary" fontWeight={600}>
                  {formatDayLabel(group.date, { withYear: spansYears })}
                </Typography>
                <Typography variant="caption" color="text.secondary" className="tabular">
                  合计 {formatCents(dayTotal)}
                </Typography>
              </Box>
              <Box sx={{ borderRadius: 2.5, border: '1px solid', borderColor: 'divider', overflow: 'hidden' }}>
                {group.txs.map((tx, index) => (
                  <Box key={tx.id}>
                    {index > 0 && <Divider />}
                    <TxRow
                      tx={tx}
                      wage={wage}
                      settings={settings}
                      flags={flagsFor(tx, flags)}
                      tree={tree}
                      disabled={busy}
                      batch={batch}
                      selected={selected.includes(tx.id)}
                      dragIds={selected.length > 1 && selected.includes(tx.id) ? selected : [tx.id]}
                      dragCents={
                        selected.length > 1 && selected.includes(tx.id) ? selectedTotal : tx.amount_cents
                      }
                      onToggleSelect={() => toggleSelect(tx.id)}
                      onEdit={() => setEditingTxId(tx.id)}
                      onDelete={() => setPendingDelete(tx)}
                      onToggleWorthless={() => void toggleWorthless(tx)}
                    />
                  </Box>
                ))}
              </Box>
            </Box>
          );
        })
      )}

      {showDeleted && (deletedRows ?? []).length > 0 && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="caption" color="text.secondary">
            已删除（{deletedRows.length}）
          </Typography>
          <Box sx={{ borderRadius: 2.5, border: '1px dashed', borderColor: 'divider', mt: 0.5 }}>
            {deletedRows.map((tx) => (
              <Box
                key={tx.id}
                sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 1 }}
              >
                <Typography variant="body2" color="text.secondary">
                  {tx.occurred_date} · {labelOf(tx, tree)} · {formatCents(tx.amount_cents)}
                </Typography>
                <Button size="small" disabled={busy} onClick={() => void handleRestore(tx)}>
                  恢复
                </Button>
              </Box>
            ))}
          </Box>
        </Box>
      )}

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2, textAlign: 'center' }}>
        左滑编辑 · 右滑标记「最不值」
      </Typography>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除这笔账？"
        message="这笔账会移到流水的「已删除」区，不会真的消失；删除后可以点提示里的「撤销」或在已删除列表里恢复。"
        confirmLabel="删除"
        destructive
        busy={busy}
        onConfirm={() => void handleConfirmDelete()}
        onClose={() => {
          if (!busy) setPendingDelete(null);
        }}
      />

      {/*
        批量操作条固定在底部：选中几笔之后拇指就在列表下半部分，
        操作放顶部的话每次都要跨半屏回去点。
      */}
      {batch && (
        <Box
          sx={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 1300,
            bgcolor: 'background.paper',
            borderTop: '1px solid',
            borderColor: 'divider',
            pb: 'env(safe-area-inset-bottom, 0px)',
          }}
        >
          <Box
            sx={{
              maxWidth: 1080,
              mx: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              px: 2,
              py: 1,
              overflowX: 'auto',
            }}
          >
            <Typography variant="body2" sx={{ fontWeight: 700, flexShrink: 0, whiteSpace: 'nowrap' }}>
              {selected.length} 笔
            </Typography>
            <Button size="small" disabled={busy || selected.length === 0} onClick={() => setNoteOpen(true)}>
              加备注
            </Button>
            <Button
              size="small"
              color="error"
              disabled={busy || selected.length === 0}
              onClick={() => void applyDelete()}
            >
              删除
            </Button>
            <Button size="small" onClick={() => setSelected((rows ?? []).map((tx) => tx.id))}>
              全选本页
            </Button>
            <Box sx={{ flex: 1 }} />
            <Button size="small" variant="contained" onClick={exitBatch}>
              完成
            </Button>
          </Box>
        </Box>
      )}

      <Dialog
        open={pendingL1 !== null}
        onClose={() => {
          setPendingL1(null);
          setPendingIds([]);
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle sx={{ fontSize: 18 }}>
          归到「{pendingL1 ? l1Name(pendingL1) : ''}」的哪一类？（{pendingIds.length} 笔）
        </DialogTitle>
        <DialogContent>
          <Stack>
            {(pendingL1 ? tree.byL1.get(pendingL1) ?? [] : []).map((category) => (
              <ListItemButton
                key={category.id}
                disabled={busy}
                onClick={() => void applyCategory(pendingIds, pendingL1 ?? '', category.l2_id)}
              >
                <ListItemText primary={category.l2_name} primaryTypographyProps={{ fontSize: 14 }} />
              </ListItemButton>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setPendingL1(null);
              setPendingIds([]);
            }}
          >
            取消
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={noteOpen} onClose={() => (busy ? undefined : setNoteOpen(false))} fullWidth maxWidth="xs">
        <DialogTitle sx={{ fontSize: 18 }}>给 {selected.length} 笔加备注</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="备注"
            value={noteText}
            onChange={(event) => setNoteText(event.target.value)}
            InputLabelProps={{ shrink: true }}
            helperText="追加在原备注后面，不会覆盖账单原文；同一句话不会重复加"
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setNoteOpen(false)}>
            取消
          </Button>
          <Button variant="contained" disabled={busy || !noteText.trim()} onClick={() => void applyNote()}>
            保存
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

/** 分类投放 chip：拖上去或点一下，都进入「选二级」这一步。 */
function L1DropChip({
  id,
  label,
  onClick,
  onDrop,
}: {
  id: string;
  label: string;
  onClick: () => void;
  onDrop: (ids: string[]) => void;
}): JSX.Element {
  const { active, dropProps } = useDropTarget(`ledger:l1:${id}`, (payload) => onDrop(payload.txIds));
  return (
    <Box {...dropProps} sx={{ flexShrink: 0 }}>
      <Chip
        label={label}
        size="small"
        clickable
        color={active ? 'primary' : 'default'}
        variant={active ? 'filled' : 'outlined'}
        onClick={onClick}
      />
    </Box>
  );
}

/** 计划投放 chip：拖上去即加入该计划，点一下则把当前选中项加入。 */
function PlanDropChip({
  plan,
  onClick,
  onDrop,
}: {
  plan: Plan;
  onClick: () => void;
  onDrop: (ids: string[]) => void;
}): JSX.Element {
  const { active, dropProps } = useDropTarget(`ledger:plan:${plan.id}`, (payload) => onDrop(payload.txIds));
  return (
    <Box {...dropProps} sx={{ flexShrink: 0 }}>
      <Chip
        label={`${plan.title} · ${PLAN_KIND_LABEL[plan.kind]}`}
        size="small"
        clickable
        color={active ? 'primary' : 'default'}
        variant={active ? 'filled' : 'outlined'}
        onClick={onClick}
      />
    </Box>
  );
}

interface RangePreset {
  key: string;
  label: string;
  build: () => DateRange;
}

const RANGE_PRESETS: RangePreset[] = [
  { key: 'this-month', label: '本月', build: () => currentMonthRange() },
  { key: 'last-month', label: '上月', build: () => shiftRangeBack(currentMonthRange(), 1) },
  { key: 'last-3', label: '近 3 月', build: () => lastNMonthsRange(3) },
  { key: 'ytd', label: '今年', build: () => yearToDate() },
  { key: 'last-12', label: '近 12 月', build: () => lastNMonthsRange(12) },
];

/** 金额区间输入同样走 yuanToCents，不在页面里写 `金额 * 100`。 */
function toOptionalCents(value: string): number | undefined {
  if (!value.trim()) return undefined;
  try {
    return yuanToCents(value);
  } catch {
    return undefined;
  }
}

interface RowProps {
  tx: Transaction;
  wage: ReturnType<typeof useWageResult>;
  settings: ReturnType<typeof useWageSettings>;
  flags: ReturnType<typeof flagsFor>;
  /** 二级分类要按 ID 反查中文名，不能把 'digital' 直接糊在界面上 */
  tree: CategoryTree;
  /** 有异步写在飞时禁用整行操作，防连点重复提交。 */
  disabled: boolean;
  /** 批量模式：左侧出现勾选框，点行即切换选中 */
  batch: boolean;
  selected: boolean;
  /** 拖动时带走哪几笔（行已被选中则带走整批） */
  dragIds: string[];
  dragCents: number;
  onToggleSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleWorthless: () => void;
}

function TxRow({
  tx,
  wage,
  settings,
  flags,
  tree,
  disabled,
  batch,
  selected,
  dragIds,
  dragCents,
  onToggleSelect,
  onEdit,
  onDelete,
  onToggleWorthless,
}: RowProps): JSX.Element {
  const startX = useRef<number | null>(null);
  const marked = (tx.flags ?? []).includes('most_worthless');
  const sign = tx.direction === 'expense' ? '-' : tx.direction === 'income' ? '+' : '';
  const amountColor =
    tx.direction === 'income' ? 'success.main' : tx.direction === 'refund' ? 'text.secondary' : 'text.primary';
  const icon = tx.category_l1 === 'other' && tx.category_l2 === 'pending' ? '❓' : '🧾';
  const sources = provenanceOf(tx);
  const multi = sources.length > 1;

  /**
   * 拖拽源。批量模式外也能拖：触摸端靠 220ms 长按区分「拖」与「滑」，
   * 桌面靠移动 6px 区分「拖」与「点」，误触已经隔离掉了。
   */
  const { onPointerDown } = useDragSource({
    kind: 'tx',
    txIds: dragIds,
    label: dragIds.length > 1 ? `${dragIds.length} 笔` : tx.counterparty || labelOf(tx, tree),
    direction: tx.direction,
    cents: dragCents as Transaction['amount_cents'],
  });

  return (
    <Box
      onPointerDown={disabled ? undefined : onPointerDown}
      onClick={() => {
        // 刚拖完的那次松手不该被当成点击：否则拖到分类后会立刻弹一次编辑框
        if (shouldSuppressClick()) return;
        if (batch) onToggleSelect();
      }}
      onTouchStart={(event) => {
        startX.current = event.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(event) => {
        if (startX.current === null) return;
        const delta = (event.changedTouches[0]?.clientX ?? 0) - startX.current;
        startX.current = null;
        // 批量模式下不做滑动手势：多选时手常常是斜着划过去的，误触发太吵
        if (batch) return;
        if (delta < -60) onEdit();
        if (delta > 60) onToggleWorthless();
      }}
      sx={{
        display: 'flex',
        gap: 1,
        px: 1.5,
        py: 1.1,
        alignItems: 'flex-start',
        cursor: batch ? 'pointer' : undefined,
        bgcolor: selected ? 'action.selected' : undefined,
        '&:hover': { bgcolor: selected ? 'action.selected' : 'action.hover' },
      }}
    >
      {batch && (
        <Box
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelect();
          }}
          sx={{ display: 'flex', alignItems: 'center', alignSelf: 'stretch', mr: -0.5 }}
        >
          <Checkbox size="small" checked={selected} sx={{ p: 0.5 }} inputProps={{ 'aria-label': '勾选这一笔' }} />
        </Box>
      )}
      <Box sx={{ fontSize: 20, lineHeight: '24px', width: 24, textAlign: 'center' }}>{icon}</Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {tx.counterparty || labelOf(tx, tree)}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {tx.occurred_at.slice(11, 16)} · {labelOf(tx, tree)}
          {tx.direction !== 'expense' ? ` · ${DIRECTION_LABEL[tx.direction]}` : ''}
          {tx.payment_channel ? ` · ${CHANNEL_LABEL[tx.payment_channel as keyof typeof CHANNEL_LABEL] ?? tx.payment_channel}` : ''}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25, flexWrap: 'wrap' }}>
          <Tooltip title={multi ? `多来源结合：${sources.map((s) => SOURCE_LABEL[s]).join('、')}` : `来源：${SOURCE_LABEL[tx.source]}`}>
            <Chip
              label={provenanceShortLabel(tx)}
              size="small"
              color={multi ? 'primary' : 'default'}
              variant={multi ? 'filled' : 'outlined'}
              sx={{ height: 18, fontSize: 10, '& .MuiChip-label': { px: 0.75, lineHeight: '18px' } }}
            />
          </Tooltip>
          <FlagChips hits={flags} />
          {tx.flags?.includes(INVEST_PRINCIPAL_FLAG) && (
            <Tooltip title="买基金/理财的本金：钱从现金变成持仓，不算消费。点右侧编辑可以把它改回「支出」">
              <Chip
                label="投资本金"
                size="small"
                color="info"
                variant="outlined"
                sx={{ height: 18, fontSize: 10, '& .MuiChip-label': { px: 0.75, lineHeight: '18px' } }}
              />
            </Tooltip>
          )}
        </Box>
      </Box>
      <Box sx={{ textAlign: 'right', minWidth: 92 }}>
        <Typography
          component="div"
          className="tabular"
          sx={{ fontSize: 16, fontWeight: 600, color: amountColor, whiteSpace: 'nowrap' }}
        >
          {sign}
          {formatCents(tx.amount_cents, { symbol: false })}
        </Typography>
        <TimeCostLine cents={tx.amount_cents} settings={settings} wage={wage} />
      </Box>
      {/*
        批量模式下收起行内的三个单操作按钮。
        它们和勾选框同时出现时，390px 宽的手机上留给分类信息只剩 100px 左右，
        「09:00 · 淘宝 · 银行卡」被挤成三行——而这一行的操作本来就已经交给底部操作条了。
      */}
      {!batch && (
        <Stack direction="row" sx={{ ml: 0.5 }}>
          <IconButton size="small" disabled={disabled} aria-label={marked ? '取消最不值' : '标记最不值'} onClick={onToggleWorthless}>
            {marked ? <StarIcon fontSize="small" color="secondary" /> : <StarBorderIcon fontSize="small" />}
          </IconButton>
          <IconButton size="small" disabled={disabled} aria-label="编辑" onClick={onEdit}>
            <EditOutlinedIcon fontSize="small" />
          </IconButton>
          <IconButton size="small" disabled={disabled} aria-label="删除" onClick={onDelete}>
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </Stack>
      )}
    </Box>
  );
}

function labelOf(tx: Transaction, tree: CategoryTree): string {
  // category_l2 存的是 ID（'digital'/'monthly'），直接显示出来就是满屏英文
  const name = tree.byL1.get(tx.category_l1)?.find((item) => item.l2_id === tx.category_l2)?.l2_name;
  return name ?? tx.category_l2 ?? '未分类';
}
