import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  Divider,
  Skeleton,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useLiveQuery } from 'dexie-react-hooks';
import { lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as reviewRepo from '../../db/repos/reviewRepo';
import {
  averageCents,
  buildCompare,
  categoryShares,
  cumulativeInRange,
  lastMonths,
  monthlyTrend,
  topExpenses,
  totalsOf,
} from '../../domain/aggregate';
import { formatMonthLabel } from '../../domain/date';
import { computeMonthFlags, summarizeImpulse } from '../../domain/flags';
import { formatCents } from '../../domain/money';
import { isWholeMonth, rangeLabel, shiftRangeBack } from '../../domain/range';
import { costToTime } from '../../domain/timecost';
import { generateReviewCard } from '../../services/reviewService';
import { useUiStore } from '../../store/uiStore';
import { DateRangePicker } from '../components/DateRangePicker';
import { EmptyState } from '../components/EmptyState';
import { SectionCard } from '../components/SectionCard';
import { useAllTxs, useRangeTxs, useRecentMonthsTxs, useWageResult, useWageSettings } from '../hooks/useLedgerData';

const CategoryDonut = lazy(() => import('../charts/CategoryDonut'));
const MonthlyBars = lazy(() => import('../charts/MonthlyBars'));
const ExpenseTrend = lazy(() => import('../charts/ExpenseTrend'));
const TimeCostBars = lazy(() => import('../charts/TimeCostBars'));

/**
 * P5 洞察：用数据说"该不该省、省哪里"。
 * 三套口径同屏（毛额 / 冲正 / 净额）；对比基准**只有自己的历史**。
 *
 * 日期口径分成两层，刻意不统一：
 * - 「钱花在哪 / 最贵几笔 / 时间成本」是纯区间统计（categoryShares / topExpenses 不看
 *   month_key，喂任意区间都安全）；
 * - 「环比同比 / 冲动消费 / 月度复盘卡」必须按**整月** —— 它们依赖"当月其他数据"作分母，
 *   用区间数据会静默换掉分母（例如"日均 ×3"门槛会被压低），所以锚点取区间末月，
 *   并在卡片上直接写清"按整月口径"。
 */
export function Insight(): JSX.Element {
  const navigate = useNavigate();
  const range = useUiStore((state) => state.dateRange);
  // currentMonthKey 已由 setDateRange 同步为区间末月
  const monthKey = useUiStore((state) => state.currentMonthKey);
  const showSnack = useUiStore((state) => state.showSnack);
  const [span, setSpan] = useState<6 | 12>(6);
  /** 生成复盘卡是异步写，处理中禁用按钮防连点生成两张快照。 */
  const [generating, setGenerating] = useState(false);
  const wholeMonth = isWholeMonth(range);

  const rangeTxs = useRangeTxs(range);
  const prevRange = useMemo(() => shiftRangeBack(range), [range.from, range.to]);
  const prevRangeTxs = useRangeTxs(prevRange);
  const allTxs = useAllTxs();
  const recentTxs = useRecentMonthsTxs(lastMonths(span, monthKey));
  const settings = useWageSettings();
  const wage = useWageResult(settings);
  const cards = useLiveQuery(() => reviewRepo.list(), [], []);

  const total = useMemo(() => totalsOf(rangeTxs), [rangeTxs]);
  const shares = useMemo(() => categoryShares(rangeTxs), [rangeTxs]);
  const priciest = useMemo(() => topExpenses(rangeTxs, 5), [rangeTxs]);

  // 冲动消费的 4 条规则都是「相对当月其他数据」派生（flags.ts §规则 3 用月日均），
  // 因此这里显式按整月取数：否则区间只有 3 天时"日均"会被算小，正常消费被误判成大额。
  const anchorMonthTxs = useMemo(() => allTxs.filter((tx) => tx.month_key === monthKey), [allTxs, monthKey]);
  const anchorTotals = useMemo(() => totalsOf(anchorMonthTxs), [anchorMonthTxs]);
  const flagMap = useMemo(() => computeMonthFlags(anchorMonthTxs, monthKey), [anchorMonthTxs, monthKey]);
  const impulse = useMemo(
    () => summarizeImpulse(anchorMonthTxs, flagMap, anchorTotals.net_expense_cents),
    [anchorMonthTxs, flagMap, anchorTotals],
  );

  const availableMonths = useMemo(() => [...new Set(allTxs.map((tx) => tx.month_key))], [allTxs]);
  const compare = useMemo(() => buildCompare(monthKey, allTxs, availableMonths), [monthKey, allTxs, availableMonths]);
  const trend = useMemo(() => monthlyTrend(lastMonths(span, monthKey), recentTxs), [span, monthKey, recentTxs]);
  const avg = averageCents(trend, 'net_expense_cents');

  // 区间累计：与 cumulativeByDay 无关的独立路径（后者按 month_key 过滤，喂区间会得到空数组）
  const currentCumulative = useMemo(() => cumulativeInRange(range, rangeTxs), [range.from, range.to, rangeTxs]);
  const previousCumulative = useMemo(
    () => cumulativeInRange(prevRange, prevRangeTxs),
    [prevRange.from, prevRange.to, prevRangeTxs],
  );

  const costBars = useMemo(() => {
    const wageCents = wage.cents;
    if (wageCents === null) return [];
    return shares.shares.slice(0, 6).map((share) => ({
      name: share.name,
      hours: costToTime(share.cents, wageCents, settings.workday_hours).hours,
    }));
  }, [shares, wage, settings.workday_hours]);

  const handleGenerate = async (): Promise<void> => {
    if (generating) return;
    setGenerating(true);
    try {
      await generateReviewCard(monthKey);
      showSnack({ message: `${formatMonthLabel(monthKey)}复盘卡已生成`, severity: 'success' });
    } catch (error) {
      showSnack({ message: error instanceof Error ? error.message : String(error), severity: 'error' });
    } finally {
      setGenerating(false);
    }
  };

  if (allTxs.length === 0) {
    return (
      <EmptyState
        icon="🔍"
        title="还没有可分析的数据"
        description="记几笔或者导入账单之后，这里会告诉你钱花在哪、值不值。"
        primary={{ label: '记一笔', onClick: () => useUiStore.getState().setQuickAddOpen(true) }}
        secondary={{ label: '导入账单', onClick: () => navigate('/import') }}
      />
    );
  }

  return (
    <>
      <Box sx={{ mb: 1 }}>
        <Typography variant="h6" sx={{ fontSize: 20 }}>
          洞察
        </Typography>
        <Typography variant="caption" color="text.secondary">
          只和你的过去比
        </Typography>
      </Box>

      <DateRangePicker />

      <SectionCard dense>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1, mb: 1 }}>
          <Chip size="small" variant="outlined" label={`支出毛额 ${formatCents(total.expense_cents)}`} />
          <Chip size="small" variant="outlined" label={`退款冲正 ${formatCents(total.refund_cents)}`} />
          <Chip size="small" color="primary" variant="outlined" label={`支出净额 ${formatCents(total.net_expense_cents)}`} />
        </Stack>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
          <DeltaChip result={compare.mom} />
          {compare.yoy && <DeltaChip result={compare.yoy} />}
          {compare.avg3 && <DeltaChip result={compare.avg3} />}
        </Stack>
        {!compare.yoy && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            累计满 12 个月数据后会出现同比
          </Typography>
        )}
        {!wholeMonth && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            环比 / 同比 / 近 3 月均值只能按整月计算，当前基准月为 {formatMonthLabel(monthKey)}。
          </Typography>
        )}
      </SectionCard>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1.5, mt: 1.5 }}>
        <SectionCard
          title="钱主要花在哪"
          subtitle={shares.hasPending ? '含待分类，占比仅供参考' : '按支出净额'}
          dense
        >
          {shares.shares.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              {wholeMonth ? '这个月还没有支出。' : '这个区间还没有支出。'}
            </Typography>
          ) : (
            <>
              <Suspense fallback={<Skeleton variant="rounded" height={260} />}>
                <CategoryDonut shares={shares.shares} hasPending={shares.hasPending} totalCents={shares.total} />
              </Suspense>
              <Stack spacing={0.5} sx={{ mt: 1 }}>
                {shares.shares.slice(0, 3).map((share) => (
                  <Box key={share.l1} sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="body2">
                      {share.icon} {share.name}
                    </Typography>
                    <Typography variant="body2" className="tabular">
                      {formatCents(share.cents)} · {Math.round(share.ratio * 100)}%
                    </Typography>
                  </Box>
                ))}
              </Stack>
            </>
          )}
        </SectionCard>

        <SectionCard
          title={wholeMonth ? '这个月比过去贵吗' : '这段区间比过去贵吗'}
          subtitle={`按月锚定 ${formatMonthLabel(monthKey)}`}
          action={
            <ToggleButtonGroup size="small" exclusive value={span} onChange={(_, value) => value && setSpan(value)}>
              <ToggleButton value={6}>6 月</ToggleButton>
              <ToggleButton value={12}>12 月</ToggleButton>
            </ToggleButtonGroup>
          }
          dense
        >
          <Suspense fallback={<Skeleton variant="rounded" height={180} />}>
            <MonthlyBars points={trend} averageCents={avg} />
          </Suspense>
        </SectionCard>
      </Box>

      <Box sx={{ mt: 1.5 }}>
        <SectionCard
          title="支出在恶化吗"
          subtitle={`${rangeLabel(range)} 累计支出 vs 上一个等长区间（逐日对齐）`}
          dense
        >
          {rangeTxs.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              所选区间没有数据
            </Typography>
          ) : (
            <Suspense fallback={<Skeleton variant="rounded" height={220} />}>
              <ExpenseTrend
                current={currentCumulative}
                previous={previousCumulative}
                currentLabel={`本区间（${range.from.slice(5)} 起）`}
                previousLabel={`上一区间（${prevRange.from.slice(5)} 起）`}
              />
            </Suspense>
          )}
        </SectionCard>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1.5, mt: 1.5 }}>
        <SectionCard title="时间成本有多重" subtitle={wage.cents ? undefined : '还没设时薪'} dense>
          {wage.cents === null ? (
            <Button size="small" onClick={() => navigate('/settings/wage')}>
              设置时薪后显示
            </Button>
          ) : (
            <Suspense fallback={<Skeleton variant="rounded" height={220} />}>
              <TimeCostBars items={costBars} />
            </Suspense>
          )}
        </SectionCard>

        <SectionCard
          title="冲动消费"
          subtitle={
            wholeMonth
              ? '深夜 / 碎钞 / 大额 / 习惯性 / 你标记的最不值'
              : `按整月判定，当前 ${formatMonthLabel(monthKey)}`
          }
          dense
        >
          {impulse.count === 0 ? (
            <Typography variant="body2" color="text.secondary">
              这个月没有被标记的消费。
            </Typography>
          ) : (
            <>
              <Typography variant="body2">
                本月被标记 <b>{impulse.count}</b> 笔，合计 <b>{formatCents(impulse.cents)}</b>，占支出{' '}
                <b>{Math.round(impulse.ratio * 100)}%</b>
              </Typography>
              <Stack direction="row" spacing={0.75} sx={{ mt: 1, flexWrap: 'wrap', gap: 0.75 }}>
                {Object.entries(impulse.kinds).map(([kind, count]) => (
                  <Chip key={kind} size="small" variant="outlined" label={`${labelOfKind(kind)} ${count}`} />
                ))}
              </Stack>
            </>
          )}
        </SectionCard>
      </Box>

      <Box sx={{ mt: 1.5 }}>
        <SectionCard title={wholeMonth ? '本月最贵的 5 笔' : '区间最贵的 5 笔'} subtitle="换算成工作时间看" dense>
          {priciest.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              所选区间没有支出记录。
            </Typography>
          ) : (
            <Stack divider={<Divider />} spacing={1}>
              {priciest.map((tx) => (
                <Box key={tx.id} sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" fontWeight={600}>
                      {tx.counterparty || tx.category_l2}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {tx.occurred_date} · {tx.category_l1}.{tx.category_l2}
                    </Typography>
                  </Box>
                  <Box sx={{ textAlign: 'right' }}>
                    <Typography variant="body2" className="tabular" fontWeight={600}>
                      {formatCents(tx.amount_cents)}
                    </Typography>
                    {wage.cents !== null && (
                      <Typography variant="caption" color="text.secondary">
                        ≈ {costToTime(tx.amount_cents, wage.cents, settings.workday_hours).display}
                      </Typography>
                    )}
                  </Box>
                </Box>
              ))}
            </Stack>
          )}
        </SectionCard>
      </Box>

      <Box sx={{ mt: 1.5 }}>
        <SectionCard
          title="月度复盘卡"
          subtitle="生成后即是快照，不随后续补录改变"
          action={
            <Button size="small" variant="contained" disabled={generating} onClick={() => void handleGenerate()}>
              生成复盘卡
            </Button>
          }
          dense
        >
          {!wholeMonth && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              复盘卡按整月生成，当前展示 {formatMonthLabel(monthKey)}
            </Typography>
          )}
          {(cards ?? []).length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              还没有复盘卡。每月 1 日首次打开会自动生成上月卡片。
            </Typography>
          ) : (
            <Stack spacing={1}>
              {(cards ?? []).map((card) => (
                <ButtonBase
                  key={card.id}
                  component="div"
                  aria-label={`查看 ${formatMonthLabel(card.month_key)}复盘卡`}
                  onClick={() => navigate(`/review/${card.month_key}`)}
                  sx={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    cursor: 'pointer',
                    width: '100%',
                    textAlign: 'left',
                    borderRadius: 1,
                    px: 0.5,
                    '&:focus-visible, &.Mui-focusVisible': {
                      outline: (theme) => `2px solid ${theme.palette.primary.main}`,
                      outlineOffset: 2,
                    },
                  }}
                >
                  <Box>
                    <Typography variant="body2" fontWeight={600}>
                      {formatMonthLabel(card.month_key)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      生成于 {card.generated_at.slice(0, 10)}
                    </Typography>
                  </Box>
                  <ChevronRightIcon fontSize="small" />
                </ButtonBase>
              ))}
            </Stack>
          )}
        </SectionCard>
      </Box>

      {shares.hasPending && (
        <Alert severity="warning" sx={{ mt: 1.5 }} action={<Button size="small" onClick={() => navigate('/ledger')}>去归位</Button>}>
          {shares.pendingCount} 笔待分类，分类占比图带「含待分类」水印
        </Alert>
      )}
    </>
  );
}

function DeltaChip({ result }: { result: { label: string; delta_cents: number; baseline_cents: number | null } }): JSX.Element | null {
  if (result.baseline_cents === null) return null;
  const less = result.delta_cents <= 0;
  return (
    <Chip
      size="small"
      variant="outlined"
      color={less ? 'success' : 'warning'}
      label={`${result.label}${less ? '少花' : '多花'} ${formatCents(Math.abs(result.delta_cents), { symbol: false })} 元`}
    />
  );
}

const KIND_LABEL: Record<string, string> = {
  late_night: '深夜',
  small_change: '碎钞',
  large_amount: '大额',
  habitual: '习惯性',
  most_worthless: '最不值',
};

function labelOfKind(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}
