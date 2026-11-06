import { Alert, Box, Button, Skeleton, Typography } from '@mui/material';
import { lazy, Suspense, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { flowSeries, OVERALL_TREND_MIN_MONTHS, overallProfitSeries, withInvestment } from '../../domain/aggregate';
import { todayDateString } from '../../domain/date';
import { describeError } from '../../domain/errors';
import { isPlaceholderCode } from '../../domain/holdingIdentity';
import { detectInvestPrincipal } from '../../domain/investPrincipal';
import { monthlyHoldingProfit, navSeriesByCode } from '../../domain/investment';
import { monthsInRange, rangeLabel } from '../../domain/range';
import * as fundsService from '../../quotes/fundService';
import { useUiStore } from '../../store/uiStore';
import type { InvestBlocker } from '../charts/OverallProfit';
import { DateRangePicker } from '../components/DateRangePicker';
import { EmptyState } from '../components/EmptyState';
import { SectionCard } from '../components/SectionCard';
import { useAllTxs, useHoldings, useNavQuotes, useRangeTxs } from '../hooks/useLedgerData';

// 图表一律懒加载：recharts 不能进首屏 chunk（QA-4d 会静态断言首屏引用里没有 recharts）
const FlowLines = lazy(() => import('../charts/FlowLines'));
const CumulativeProfit = lazy(() => import('../charts/CumulativeProfit'));
const CumulativeFlow = lazy(() => import('../charts/CumulativeFlow'));
const OverallProfit = lazy(() => import('../charts/OverallProfit'));

/**
 * P6 趋势：整体收益走势、区间内的收支节奏、累计利润、累计收支。
 *
 * 与洞察页的分工：洞察回答"钱花在哪、值不值"（分类 / 时间成本），
 * 趋势回答"这段时间进出是否健康"（时序）。
 *
 * 两种累计口径必须区分清楚，否则用户会算出两个互相矛盾的数字：
 * - **整体收益走势**（第一张图）：从**记账第一天**起累加，接着历史往下画，
 *   第一个点通常不是 0。回答"到今天为止一共攒了多少"。
 *   它 = 现金流累计 + 持仓浮盈（市值 − 成本），浮盈由 `domain/investment` 按月估算。
 * - 下面三张图：累计从**所选区间起点**归零起算。回答"这段区间内赚了多少"。
 * 卡片副标题必须写清各自口径。
 *
 * 投资部分的两个诚实边界（写在这里，避免以后被"优化"掉）：
 * - 浮盈只算除本金以外的净收益，本金不是赚来的钱；
 * - 定不了价就给 null（断线），绝不拿 0 顶：0 会让用户以为那几个月基金持平。
 *
 * 下面三张图的横轴都是**整月**（哪怕区间只覆盖某月的 5 天，该月也按整月口径参与对比）。
 * 注意：这里用 flowSeries 而不是 monthlyTrend —— monthlyTrend 不做月份集合过滤，
 * 区间会静默变成"整月数据"；flowSeries 显式按 months 集合分桶并给缺月补 0。
 */
export function Trends(): JSX.Element {
  const navigate = useNavigate();
  const range = useUiStore((state) => state.dateRange);
  const setDateRange = useUiStore((state) => state.setDateRange);
  const showSnack = useUiStore((state) => state.showSnack);
  const [refreshingQuotes, setRefreshingQuotes] = useState(false);
  const rangeTxs = useRangeTxs(range);
  const allTxs = useAllTxs();
  const holdings = useHoldings();
  const navQuotes = useNavQuotes();

  const months = useMemo(() => monthsInRange(range), [range.from, range.to]);
  // 区间无数据时传空数组，让图表显示「所选区间没有数据」而不是一条贴地的零线
  const points = useMemo(() => (rangeTxs.length === 0 ? [] : flowSeries(months, rangeTxs)), [months, rangeTxs]);
  // 整体收益走全量流水：区间内没有交易也要画出当时的累计高度。
  // 至少铺 6 个月：区间只选一个月时曲线会退化成孤立的点，看不出任何走势。
  const cashPoints = useMemo(
    () => overallProfitSeries(allTxs, range, OVERALL_TREND_MIN_MONTHS),
    [allTxs, range],
  );
  // 投资部分：每月末持仓浮盈（市值 − 成本），净值取该月末之前最近的一个点
  const navSeries = useMemo(() => navSeriesByCode(navQuotes), [navQuotes]);
  const overallPoints = useMemo(() => {
    const snapshots = monthlyHoldingProfit(
      holdings,
      navSeries,
      cashPoints.map((point) => point.month_key),
    );
    return withInvestment(cashPoints, snapshots);
  }, [cashPoints, holdings, navSeries]);
  // 真实补足了月份时要把话说清，不能让用户以为区间被悄悄改了
  const widened = overallPoints.length > 0 && overallPoints[0].month_key < range.from.slice(0, 7);

  /**
   * 投资部分缺席时该给哪个下一步：
   * 全是「仅名称+市值」的占位持仓时，刷新行情永远刷不到东西，必须引导去补份额，
   * 否则用户会对着「刷新」按钮反复点，越点越觉得这功能坏了。
   */
  const quotable = useMemo(
    () => holdings.filter((holding) => holding.shares > 0 && !isPlaceholderCode(holding.fund_code)).length,
    [holdings],
  );
  const investBlocker: InvestBlocker =
    holdings.length === 0 ? 'no-holdings' : quotable === 0 ? 'pending-shares' : 'no-quotes';

  /**
   * 账本里还躺在支出侧的投资本金有几笔。
   * 直接复用已经加载的全量流水，不额外查库；它会让「整体收益」把本金重复扣一遍，
   * 所以要在图下面直接提示，并给一个去改正的入口。
   */
  const pendingInvest = useMemo(
    () =>
      allTxs.filter(
        (tx) =>
          tx.direction === 'expense' &&
          detectInvestPrincipal({ direction: tx.direction, counterparty: tx.counterparty, note: tx.note }).matched,
      ).length,
    [allTxs],
  );

  // 「看全部历史」：整体收益的 X 轴只铺区间内的月份，选了单月就只剩一小段，
  // 所以给一个一键拉回全历史的出口
  const fullRange = useMemo(() => {
    if (allTxs.length === 0) return null;
    let from = allTxs[0].occurred_date;
    let to = todayDateString();
    for (const tx of allTxs) {
      if (tx.occurred_date < from) from = tx.occurred_date;
      // 预先录的未来日期（记账时手滑选错年份）也要落在全历史里，否则末点会被截掉
      if (tx.occurred_date > to) to = tx.occurred_date;
    }
    return { from, to, firstMonth: from.slice(0, 7) };
  }, [allTxs]);
  const showingFull = fullRange !== null && range.from <= fullRange.from && range.to >= fullRange.to;

  /**
   * 就地补行情：有持仓却没有净值历史时，用户点一下就能把投资部分补上。
   * 不自动发起 —— 联网必须由用户点击触发（本应用只在本机存数据，这一点不能让图表破例）。
   */
  const handleRefreshQuotes = async (): Promise<void> => {
    setRefreshingQuotes(true);
    try {
      const result = await fundsService.refreshFunds();
      const failed = result.outcomes.filter((outcome) => outcome.degraded === 'unavailable');
      showSnack({
        message:
          failed.length === 0
            ? '净值已更新，整体收益已补上投资部分'
            : `${failed.length} 只基金暂时取不到净值，投资部分可能不完整`,
        severity: failed.length === 0 ? 'success' : 'warning',
      });
    } catch (error) {
      showSnack({ message: describeError(error), severity: 'error' });
    } finally {
      setRefreshingQuotes(false);
    }
  };

  if (allTxs.length === 0) {
    return (
      <EmptyState
        icon="📈"
        title="还没有可画的数据"
        description="记几笔或者导入账单之后，这里会显示这段时间的收支曲线。"
        primary={{ label: '记一笔', onClick: () => useUiStore.getState().setQuickAddOpen(true) }}
        secondary={{ label: '导入账单', onClick: () => navigate('/import') }}
      />
    );
  }

  return (
    <>
      <Box sx={{ mb: 1.5 }}>
        <Typography variant="h6" sx={{ fontSize: 20 }}>
          趋势
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {rangeLabel(range)} · 整体收益从记账第一天起算，其余累计从区间起点起算
        </Typography>
      </Box>

      <DateRangePicker />

      <SectionCard
        title="整体收益走势"
        subtitle="现金流 + 基金/股票浮盈，从记账第一天累计"
        dense
        action={
          fullRange && !showingFull ? (
            <Button size="small" sx={{ flexShrink: 0 }} onClick={() => setDateRange(fullRange)}>
              看全部历史
            </Button>
          ) : undefined
        }
      >
        <Suspense fallback={<Skeleton variant="rounded" height={260} />}>
          <OverallProfit
            points={overallPoints}
            blockedBy={investBlocker}
            action={
              investBlocker === 'no-quotes'
                ? { label: '刷新行情，补上投资部分', onClick: handleRefreshQuotes, busy: refreshingQuotes }
                : investBlocker === 'pending-shares'
                  ? { label: '去基金页补份额', onClick: () => navigate('/funds') }
                  : undefined
            }
          />
        </Suspense>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          整体收益 = 现金流净额（收入 − 支出净额）+ 持仓浮盈（市值 − 成本），只算赚到的钱、不含本金；
          买基金/理财的本金按「不计收支」处理，不会和浮盈重复扣一次。
          投资部分按每月末之前最近的净值估算，历史份额按当前持仓回算。
          下面「累计利润统计图」是纯现金流、且从区间起点归零的另一套口径。
        </Typography>
        {pendingInvest > 0 && (
          <Alert
            severity="warning"
            sx={{ mt: 1 }}
            action={
              <Button size="small" color="inherit" onClick={() => navigate('/settings')}>
                去改正
              </Button>
            }
          >
            还有 {pendingInvest} 笔买基金/理财的钱记在「支出」里，会让这张图的整体收益偏低。
          </Alert>
        )}
        {widened && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
            {overallPoints[0].month_key === fullRange?.firstMonth
              ? `区间不足 ${OVERALL_TREND_MIN_MONTHS} 个月，已铺满账本全部历史（共 ${overallPoints.length} 个月）`
              : `区间不足 ${OVERALL_TREND_MIN_MONTHS} 个月，已向前补足到 ${overallPoints.length} 个月以便看出走势`}
            ，累计值本身不受影响。
          </Typography>
        )}
      </SectionCard>

      <Box sx={{ mt: 1.5 }}>
        <SectionCard title="收支统计图" subtitle="按月对比收入与支出" dense>
          <Suspense fallback={<Skeleton variant="rounded" height={220} />}>
            <FlowLines points={points} />
          </Suspense>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            支出为净额（已扣退款冲正）；区间内没有交易的月份按 0 计入，不会被跳过。区间只覆盖某月的一部分时，
            该月数字只含区间内的那几天。
          </Typography>
        </SectionCard>
      </Box>

      <Box sx={{ mt: 1.5 }}>
        <SectionCard title="累计利润统计图" subtitle="从所选区间起点开始累加的净额，可为负" dense>
          <Suspense fallback={<Skeleton variant="rounded" height={240} />}>
            <CumulativeProfit points={points} />
          </Suspense>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            净额 = 收入 − 支出净额；零线以上为盈，以下为亏。
          </Typography>
        </SectionCard>
      </Box>

      <Box sx={{ mt: 1.5 }}>
        <SectionCard title="累计收支统计图" subtitle="两条累计线之间的垂直距离就是累计利润" dense>
          <Suspense fallback={<Skeleton variant="rounded" height={240} />}>
            <CumulativeFlow points={points} />
          </Suspense>
        </SectionCard>
      </Box>
    </>
  );
}
