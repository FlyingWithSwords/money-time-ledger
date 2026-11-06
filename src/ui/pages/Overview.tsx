import SettingsIcon from '@mui/icons-material/Settings';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  Skeleton,
  Stack,
  Typography,
} from '@mui/material';
import { useLiveQuery } from 'dexie-react-hooks';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as reviewRepo from '../../db/repos/reviewRepo';
import * as transactionRepo from '../../db/repos/transactionRepo';
import { buildOverview, lastMonths, monthlyTrend, averageCents, totalsOf } from '../../domain/aggregate';
import { formatMonthLabel, shiftMonth } from '../../domain/date';
import { formatCents, asCents } from '../../domain/money';
import { isWholeMonth, previousComparableRange, rangeLabel } from '../../domain/range';
import { costToTime } from '../../domain/timecost';
import { fundsService } from '../../quotes/fundService';
import { useUiStore } from '../../store/uiStore';
import { DateRangePicker } from '../components/DateRangePicker';
import { TimeCostBanner } from '../components/TimeCostBanner';
import { SectionCard } from '../components/SectionCard';
import { MoneyText } from '../components/MoneyText';
import { EmptyState } from '../components/EmptyState';
import { useAccounts, useAllTxs, useRangeTxs, useRecentMonthsTxs, useWageResult, useWageSettings } from '../hooks/useLedgerData';
import { autoGenerateLastMonthCard } from '../../services/reviewService';

const MonthlyBars = lazy(() => import('../charts/MonthlyBars'));

/**
 * P1 总览：3 秒回答"我现在有多少钱、这段时间危不危险"。
 * 一屏 4 个核心数字，无需滚动；金额字号最大。
 *
 * 日期口径：核心数字用**区间**数据（用户可选任意起止日），
 * 趋势柱图与复盘提醒仍按整月（它们是月度语义，混入区间会得出不存在的"月"）。
 */
export function Overview(): JSX.Element {
  const navigate = useNavigate();
  const range = useUiStore((state) => state.dateRange);
  // currentMonthKey 由 setDateRange 同步成区间末月，月度语义的卡片（复盘/趋势锚点）跟着它走
  const monthKey = useUiStore((state) => state.currentMonthKey);
  const rangeTxs = useRangeTxs(range);
  // 基线区间：整月比上一个自然月，任意区间比上一个等长区间（见 previousComparableRange 注释）
  const prevRange = useMemo(() => previousComparableRange(range), [range.from, range.to]);
  const prevTxs = useRangeTxs(prevRange);
  const accounts = useAccounts();
  const allTxs = useAllTxs();
  const settings = useWageSettings();
  const wage = useWageResult(settings);
  const months = lastMonths(6, monthKey);
  const recentTxs = useRecentMonthsTxs(months);

  const fundState = useLiveQuery(() => fundsService.loadFundsState(), [], null);
  const pending = useLiveQuery(() => transactionRepo.countPending(), [], 0) ?? 0;
  const suspected = useLiveQuery(() => transactionRepo.countSuspected(), [], 0) ?? 0;
  const prevReview = useLiveQuery(() => reviewRepo.getByMonth(shiftMonth(monthKey, -1)), [monthKey]);
  const [autoChecked, setAutoChecked] = useState(false);

  useEffect(() => {
    if (autoChecked) return;
    setAutoChecked(true);
    void autoGenerateLastMonthCard();
  }, [autoChecked]);

  const overview = buildOverview({
    monthKey,
    monthTxs: rangeTxs,
    prevMonthTxs: prevTxs,
    allTxs,
    accounts,
    fundValue: fundState?.totalValueCents ?? asCents(0),
    pendingCount: pending,
    suspectedCount: suspected,
    hasReview: Boolean(prevReview),
  });

  const trend = monthlyTrend(months, recentTxs);
  const avg = averageCents(trend, 'net_expense_cents');
  const totals = overview.totals;
  const timeCost =
    wage.cents !== null && totals.net_expense_cents > 0
      ? costToTime(totals.net_expense_cents, wage.cents, settings.workday_hours, wage.basis ?? 'manual')
      : null;
  const momDelta = overview.mom_delta_cents;
  // 对比口径随区间形态变：整月比"上月"，任意区间比"上一个等长区间"（首尾相接不重叠）
  const momLabel = isWholeMonth(range) ? '较上月' : '较上一个等长区间';

  const noData = overview.totals.count === 0 && allTxs.length === 0;

  if (noData) {
    return (
      <>
        <PageHeader onSettings={() => navigate('/settings')} />
        <EmptyState
          icon="🧾"
          title="先记第一笔，或者把旧账单导进来"
          description="所有数据只存这台设备。导入微信/支付宝账单可以一次补齐几个月历史，差一分就会提醒你。"
          primary={{ label: '记第一笔', onClick: () => useUiStore.getState().setQuickAddOpen(true) }}
          secondary={{ label: '导入账单', onClick: () => navigate('/import') }}
        />
      </>
    );
  }

  return (
    <>
      <PageHeader onSettings={() => navigate('/settings')} />

      <DateRangePicker />

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        当前统计：{rangeLabel(range)}
      </Typography>

      <TimeCostBanner
        expenseCents={totals.net_expense_cents}
        prevExpenseCents={totalsOf(prevTxs).net_expense_cents}
        scopeLabel={isWholeMonth(range) ? formatMonthLabel(monthKey) : '所选区间'}
        wageCents={wage.cents}
        workdayHours={settings.workday_hours}
        monthlyHours={settings.monthly_hours}
      />

      <SectionCard dense>
        <Typography variant="caption" color="text.secondary">
          净资产
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
          <MoneyText cents={overview.net_worth.net_worth_cents} size="hero" />
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          现金 {formatCents(overview.net_worth.cash_cents)} · 基金 {formatCents(overview.net_worth.fund_cents)} · 负债{' '}
          {formatCents(overview.net_worth.liability_cents)}
        </Typography>
      </SectionCard>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, mt: 1.5 }}>
        <StatBlock
          label={isWholeMonth(range) ? `${formatMonthLabel(monthKey)}支出` : '区间支出'}
          cents={totals.net_expense_cents}
          hint={timeCost ? `≈ ${timeCost.display}` : undefined}
        />
        <StatBlock label="收入" cents={totals.income_cents} />
        <StatBlock label="结余" cents={totals.balance_cents} tone={totals.balance_cents < 0 ? 'warn' : 'normal'} />
      </Box>

      <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', gap: 1 }}>
        {momDelta !== 0 && (
          <Chip
            size="small"
            label={`${momLabel}${momDelta > 0 ? '多花' : '少花'} ${formatCents(Math.abs(momDelta), { symbol: false })} 元 ${momDelta > 0 ? '↑' : '↓'}`}
            color={momDelta > 0 ? 'warning' : 'success'}
            variant="outlined"
          />
        )}
        {totals.refund_cents > 0 && (
          <Chip size="small" variant="outlined" label={`退款冲正 ${formatCents(totals.refund_cents)}`} />
        )}
        <Chip size="small" variant="outlined" label={`支出毛额 ${formatCents(totals.expense_cents)}`} />
      </Stack>

      {rangeTxs.length === 0 && (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          所选区间没有交易，换个起止日期或点「全部」看看。
        </Alert>
      )}

      {wage.cents === null && (
        <Alert severity="info" sx={{ mt: 1.5 }} action={<Button onClick={() => navigate('/settings/wage')}>去设置</Button>}>
          还没设时薪，暂时看不到"这笔钱等于工作多久"。
        </Alert>
      )}

      <SectionCard
        title="近 6 个月支出"
        subtitle={avg > 0 ? `均值 ${formatCents(avg)}，橙色柱高于均值` : undefined}
        action={
          <Button size="small" onClick={() => navigate('/insight')}>
            洞察
          </Button>
        }
        dense
      >
        <Suspense fallback={<Skeleton variant="rounded" height={180} />}>
          <MonthlyBars points={trend} averageCents={avg} />
        </Suspense>
      </SectionCard>

      <Box sx={{ mt: 1.5 }}>
        <SectionCard title="待处理" dense>
          <Stack spacing={1}>
            <ReminderRow
              show={pending > 0}
              text={`${pending} 笔待分类`}
              action="去归位"
              onClick={() => navigate('/ledger')}
            />
            <ReminderRow
              show={suspected > 0}
              text={`${suspected} 笔疑似重复待裁决`}
              action="去裁决"
              onClick={() => navigate('/import')}
            />
            <ReminderRow
              show={!prevReview && overview.review_ready}
              text={`${formatMonthLabel(shiftMonth(monthKey, -1))}复盘卡还没生成`}
              action="生成"
              onClick={() => navigate('/insight')}
            />
            {pending === 0 && suspected === 0 && (prevReview || !overview.review_ready) && (
              <Typography variant="body2" color="text.secondary">
                没有待处理事项。
              </Typography>
            )}
          </Stack>
        </SectionCard>
      </Box>

      <Divider sx={{ my: 2 }} />
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center' }}>
        数据只存本机 · 无账号 · 无上传
      </Typography>
    </>
  );
}

function PageHeader({ onSettings }: { onSettings: () => void }): JSX.Element {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
      <Box>
        <Typography variant="h6" sx={{ fontSize: 20 }}>
          快记账
        </Typography>
        <Typography variant="caption" color="text.secondary">
          把每一笔支出换算成还要工作多久
        </Typography>
      </Box>
      <IconButton aria-label="设置" onClick={onSettings}>
        <SettingsIcon />
      </IconButton>
    </Box>
  );
}

function StatBlock({
  label,
  cents,
  hint,
  tone = 'normal',
}: {
  label: string;
  cents: number;
  hint?: string;
  tone?: 'normal' | 'warn';
}): JSX.Element {
  return (
    <Box
      sx={{
        p: 1.25,
        borderRadius: 2.5,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        minWidth: 0,
      }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 11 }}>
        {label}
      </Typography>
      <MoneyText
        cents={cents}
        size="md"
        color={tone === 'warn' ? 'warning.main' : undefined}
        sx={{ fontSize: 'clamp(15px, 4.4vw, 19px)' }}
      />
      {hint && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: 11 }}>
          {hint}
        </Typography>
      )}
    </Box>
  );
}

function ReminderRow({
  show,
  text,
  action,
  onClick,
}: {
  show: boolean;
  text: string;
  action: string;
  onClick: () => void;
}): JSX.Element | null {
  if (!show) return null;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
      <Typography variant="body2">⚠ {text}</Typography>
      <Button size="small" onClick={onClick}>
        {action}
      </Button>
    </Box>
  );
}
