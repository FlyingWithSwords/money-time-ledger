import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import RestoreIcon from '@mui/icons-material/Restore';
import SearchIcon from '@mui/icons-material/Search';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import StarIcon from '@mui/icons-material/Star';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  InputAdornment,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useRef, useState } from 'react';
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
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { FlagChips } from '../components/FlagChips';
import { TimeCostLine } from '../components/TimeCostLine';
import { useCategoryTree, useWageResult, useWageSettings } from '../hooks/useLedgerData';

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

        <Box
          sx={{
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

        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 1 }}>
          {/*
            月份快捷跳转：列出**实际有数据**的月份，而不是「当前月往前推 12 个月」。
            用户原来的痛点就是列表永远只覆盖一个滚动窗口；这里的数据源换成
            monthsWithData()，账目跨多少年就能选到多少年。
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
          >
            <MenuItem value="">自定义区间</MenuItem>
            {monthChoices.map((month) => (
              <MenuItem key={month} value={month}>
                {month}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            SelectProps={{ displayEmpty: true }}
            size="small"
            label="来源"
            value={filter.source}
            onChange={(event) => setFilter({ source: event.target.value })}
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
                      disabled={busy}
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
                  {tx.occurred_date} · {tx.category_l2} · {formatCents(tx.amount_cents)}
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
    </>
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
  /** 有异步写在飞时禁用整行操作，防连点重复提交。 */
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggleWorthless: () => void;
}

function TxRow({ tx, wage, settings, flags, disabled, onEdit, onDelete, onToggleWorthless }: RowProps): JSX.Element {
  const startX = useRef<number | null>(null);
  const marked = (tx.flags ?? []).includes('most_worthless');
  const sign = tx.direction === 'expense' ? '-' : tx.direction === 'income' ? '+' : '';
  const amountColor =
    tx.direction === 'income' ? 'success.main' : tx.direction === 'refund' ? 'text.secondary' : 'text.primary';
  const icon = tx.category_l1 === 'other' && tx.category_l2 === 'pending' ? '❓' : '🧾';
  const sources = provenanceOf(tx);
  const multi = sources.length > 1;

  return (
    <Box
      onTouchStart={(event) => {
        startX.current = event.touches[0]?.clientX ?? null;
      }}
      onTouchEnd={(event) => {
        if (startX.current === null) return;
        const delta = (event.changedTouches[0]?.clientX ?? 0) - startX.current;
        startX.current = null;
        if (delta < -60) onEdit();
        if (delta > 60) onToggleWorthless();
      }}
      sx={{ display: 'flex', gap: 1, px: 1.5, py: 1.1, alignItems: 'flex-start', '&:hover': { bgcolor: 'action.hover' } }}
    >
      <Box sx={{ fontSize: 20, lineHeight: '24px', width: 24, textAlign: 'center' }}>{icon}</Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {tx.counterparty || labelOf(tx)}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {tx.occurred_at.slice(11, 16)} · {labelOf(tx)}
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
    </Box>
  );
}

function labelOf(tx: Transaction): string {
  const name = tx.category_l2;
  return name || '未分类';
}
