import { Box, Button, Typography } from '@mui/material';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import type { OverallPoint } from '../../domain/aggregate';
import { formatMonthLabel } from '../../domain/date';
import { centsToYuanNumber, formatCents } from '../../domain/money';
import { compactYuan, useChartTheme } from './chartTokens';

/** 投资部分为什么画不出来 —— 三种原因要给三种不同的下一步，不能混成一句"去刷新"。 */
export type InvestBlocker = 'no-holdings' | 'pending-shares' | 'no-quotes';

interface Props {
  points: OverallPoint[];
  /** 投资部分缺席的原因（`hasInvest` 为真时不显示） */
  blockedBy: InvestBlocker;
  /** 就地的下一步动作：刷新行情 / 去补份额。由页面决定，图表不自己联网也不自己跳转。 */
  action?: { label: string; onClick: () => void; busy?: boolean };
}

interface Row {
  label: string;
  full: string;
  /** 含投资的整体收益（元）；null = 投资部分无数据 */
  total: number | null;
  /** 纯现金流累计（元） */
  cash: number;
  invest: number | null;
  totalCents: number | null;
  cashCents: number;
  investCents: number | null;
}

/** 渐变 id 必须全页唯一：同页多图时重复 id 会让后渲染的覆盖前者。 */
const GRADIENT_UP = 'overall-profit-up';
const GRADIENT_DOWN = 'overall-profit-down';

const BLOCKER_COPY: Record<InvestBlocker, string> = {
  'no-holdings': '还没有持仓记录，整体收益目前只等于现金流。在「基金」页添加持仓后，这里会算上基金/股票的浮盈。',
  'pending-shares':
    '持仓只有名称和市值、还没补份额，收益无法计算，所以这里只画现金流。补上份额后会自动算上投资部分。',
  'no-quotes': '有持仓但还没有净值历史，所以这里只画现金流。刷新一次行情就会补上投资部分。',
};

/**
 * 整体收益面积图：**现金流累计 + 持仓浮盈**，累计从第一笔账起算，X 轴显示区间内月份。
 *
 * 三条线的关系（画的是前两条）：
 * - 面积 = 整体收益 = 现金流累计 + 持仓浮盈（用户口径：只算除本金以外的净收益）；
 * - 虚线 = 纯现金流累计，用来一眼看出「钱主要是基金赚的还是攒下来的」；
 * - 两条线之间的距离 = 同期持仓浮盈。
 *
 * 有两点必须诚实：
 * 1. 投资部分定不了价时（缺净值/份额待补）`total` 是 null，曲线在那里断开 ——
 *    不拿 0 顶上，也不拿现金流冒充整体收益。
 * 2. 历史月份的份额是按**当前**持仓回算的（账本没有加仓流水），
 *    所以曲线反映的是"如果一直持有现在这些份额"的收益，文案里要写。
 */
export default function OverallProfit({ points, blockedBy, action }: Props): JSX.Element {
  const theme = useChartTheme();
  if (points.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        所选区间没有数据
      </Typography>
    );
  }

  const priced = points.filter((point) => point.total_cents !== null);
  const latestPriced = priced[priced.length - 1] ?? null;
  const latest = points[points.length - 1];
  const positive = (latestPriced?.total_cents ?? latest.cum_net_cents) >= 0;
  const stroke = positive ? theme.colors.green : theme.colors.red;
  const gradientId = positive ? GRADIENT_UP : GRADIENT_DOWN;
  // 只有真的有一只持仓被定过价，才有"投资部分"可谈；否则面积就是现金流本身
  const hasInvest = points.some((point) => point.priced_holdings > 0);
  const firstPriced = points.find((point) => point.priced_holdings > 0) ?? null;
  const unpriced = latest.unpriced_holdings;

  const data: Row[] = points.map((point) => ({
    label: point.label,
    full: formatMonthLabel(point.month_key),
    total: point.total_cents === null ? null : centsToYuanNumber(point.total_cents),
    cash: centsToYuanNumber(point.cum_net_cents),
    invest: point.invest_cents === null ? null : centsToYuanNumber(point.invest_cents),
    totalCents: point.total_cents,
    cashCents: point.cum_net_cents,
    investCents: point.invest_cents,
  }));

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 0.25, flexWrap: 'wrap' }}>
        <Typography variant="caption" color="text.secondary">
          截至 {formatMonthLabel(latest.month_key)}
        </Typography>
        <Typography
          variant="subtitle2"
          className="tabular"
          sx={{ color: positive ? 'success.main' : 'error.main' }}
        >
          {/* 正负号与千分位统一由 formatCents 出，别在这里手拼 '−'：全应用符号要一致 */}
          {latestPriced
            ? formatCents(latestPriced.total_cents ?? 0, { symbol: false, showPlus: true })
            : formatCents(latest.cum_net_cents, { symbol: false, showPlus: true })}{' '}
          元
        </Typography>
        {latestPriced && latestPriced.invest_cents !== null && (
          <Typography variant="caption" color="text.secondary" className="tabular">
            其中持仓浮盈 {formatCents(latestPriced.invest_cents, { symbol: false, showPlus: true })} 元
          </Typography>
        )}
      </Box>

      {/* 图例：两个系列必须能区分，否则面积和虚线的关系没人看得懂 */}
      {hasInvest && (
        <Box sx={{ display: 'flex', gap: 1.5, mb: 0.5, flexWrap: 'wrap' }}>
          <LegendItem color={stroke} label="整体收益（含投资）" />
          <LegendItem color={theme.colors.gray} label="纯现金流累计" dashed />
        </Box>
      )}

      <Box sx={{ width: '100%', height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
            <defs>
              {/* 面积渐变：顶部浓、底部近乎透明，避免盖住网格和零线 */}
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={0.42} />
                <stop offset="100%" stopColor={stroke} stopOpacity={0.03} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={theme.grid.stroke} strokeDasharray="3 3" vertical={false} opacity={0.25} />
            <XAxis
              dataKey="label"
              tick={{ fill: theme.axis.tick.fill, fontSize: 10 }}
              axisLine={{ stroke: theme.axis.stroke }}
              tickLine={{ stroke: theme.axis.stroke }}
              interval={points.length > 24 ? 'preserveStartEnd' : 0}
            />
            <YAxis
              tick={{ fill: theme.axis.tick.fill, fontSize: 11 }}
              axisLine={{ stroke: theme.axis.stroke }}
              tickLine={{ stroke: theme.axis.stroke }}
              width={52}
              tickFormatter={(value: number) => compactYuan(value)}
            />
            <Tooltip
              content={(props: TooltipProps<number, string>) => <OverallTooltip {...props} />}
              contentStyle={theme.tooltip.contentStyle}
              labelStyle={theme.tooltip.labelStyle}
              itemStyle={theme.tooltip.itemStyle}
            />
            <ReferenceLine y={0} stroke={theme.colors.gray} strokeDasharray="4 4" />
            {hasInvest && (
              <Area
                type="monotone"
                dataKey="cash"
                name="纯现金流累计"
                stroke={theme.colors.gray}
                strokeWidth={1.5}
                strokeDasharray="5 4"
                fill="none"
                dot={false}
                activeDot={false}
              />
            )}
            <Area
              type="monotone"
              dataKey="total"
              name="整体收益"
              stroke={stroke}
              strokeWidth={2.5}
              fill={`url(#${gradientId})`}
              // 投资部分无数据的月份保持 null，曲线断开而不是掉到 0
              connectNulls={false}
              dot={points.length > 24 ? false : { r: 2 }}
              activeDot={{ r: 4 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </Box>

      {!hasInvest && (
        <Box sx={{ mt: 0.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {BLOCKER_COPY[blockedBy]}
          </Typography>
          {action && (
            <Button size="small" onClick={action.onClick} disabled={action.busy} sx={{ mt: 0.25, ml: -0.75 }}>
              {action.busy ? '正在取净值…' : action.label}
            </Button>
          )}
        </Box>
      )}
      {hasInvest && unpriced > 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          另有 {unpriced} 只持仓缺净值或份额待补，未计入投资部分。
        </Typography>
      )}
      {hasInvest && firstPriced && firstPriced.month_key !== points[0].month_key && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
          {formatMonthLabel(firstPriced.month_key)} 之前没有可用的净值记录，含投资的曲线从该月开始。
        </Typography>
      )}
    </Box>
  );
}

function LegendItem({
  color,
  label,
  dashed = false,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}): JSX.Element {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <Box
        sx={{
          width: 14,
          height: 0,
          borderTop: `2px ${dashed ? 'dashed' : 'solid'} ${color}`,
          flexShrink: 0,
        }}
      />
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Box>
  );
}

function OverallTooltip({ active, payload }: TooltipProps<number, string>): JSX.Element | null {
  const theme = useChartTheme();
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload as Row | undefined;
  if (!row) return null;
  return (
    <Box style={{ ...theme.tooltip.contentStyle, padding: '6px 10px' }}>
      <Typography variant="caption" style={{ display: 'block', color: theme.tooltip.labelStyle.color }}>
        截至 {row.full}
      </Typography>
      <Typography variant="body2" className="tabular" fontWeight={600}>
        整体 {row.totalCents === null ? '待补' : `${formatCents(row.totalCents, { symbol: false, showPlus: true })} 元`}
      </Typography>
      <Typography variant="caption" className="tabular" style={{ display: 'block' }} color="text.secondary">
        持仓浮盈{' '}
        {row.investCents === null
          ? '待补'
          : `${formatCents(row.investCents, { symbol: false, showPlus: true })} 元`}
      </Typography>
      <Typography variant="caption" className="tabular" style={{ display: 'block' }} color="text.secondary">
        现金流 {formatCents(row.cashCents, { symbol: false, showPlus: true })} 元
      </Typography>
    </Box>
  );
}
