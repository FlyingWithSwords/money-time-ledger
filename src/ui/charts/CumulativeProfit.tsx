import { Box, Typography } from '@mui/material';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import type { FlowPoint } from '../../domain/aggregate';
import { formatMonthLabel } from '../../domain/date';
import { centsToYuanNumber, formatCents } from '../../domain/money';
import { useChartTheme, compactYuan } from './chartTokens';

interface Props {
  points: FlowPoint[];
}

interface Row {
  label: string;
  value: number;
  /** tooltip 用的精确月份与整数分，避免浮点反算 */
  full: string;
  cents: number;
}

/** 渐变的 id 必须全页唯一：同一页面可能同时挂多个图表，重复 id 会让后渲染的覆盖前者。 */
const GRADIENT_ID = 'cumulative-profit-gradient';

/**
 * 累计利润折线：从所选区间起点开始累加 net（收入 − 支出净额），可以为负。
 * 零线用虚线标出来 —— "什么时候回本/开始亏损"是这张图唯一要回答的问题。
 */
export default function CumulativeProfit({ points }: Props): JSX.Element {
  const theme = useChartTheme();
  if (points.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        所选区间没有数据
      </Typography>
    );
  }

  const data: Row[] = points.map((point) => ({
    label: point.label,
    value: centsToYuanNumber(point.cum_net_cents),
    full: formatMonthLabel(point.month_key),
    cents: point.cum_net_cents,
  }));

  return (
    <Box sx={{ width: '100%', height: 240 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
          <defs>
            {/* 垂直渐变：上方绿（盈利）→ 下方橙（亏损），颜色本身就是零线两侧的语义 */}
            <linearGradient id={GRADIENT_ID} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={theme.colors.green} />
              <stop offset="100%" stopColor={theme.colors.orange} />
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
          {/* 自定义 content 自带容器样式；同时把统一 tooltip 样式传下去，深浅色一致 */}
          <Tooltip
            content={(props: TooltipProps<number, string>) => <ProfitTooltip {...props} />}
            contentStyle={theme.tooltip.contentStyle}
            labelStyle={theme.tooltip.labelStyle}
            itemStyle={theme.tooltip.itemStyle}
          />
          <ReferenceLine y={0} stroke={theme.colors.gray} strokeDasharray="4 4" />
          <Line
            type="monotone"
            dataKey="value"
            name="累计利润"
            stroke={`url(#${GRADIENT_ID})`}
            strokeWidth={2.5}
            dot={points.length > 24 ? false : { r: 2 }}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </Box>
  );
}

/** 自定义 tooltip：用统一的 contentStyle 做容器，labelStyle 给月份文字上色。 */
function ProfitTooltip({ active, payload }: TooltipProps<number, string>): JSX.Element | null {
  const theme = useChartTheme();
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload as Row | undefined;
  if (!row) return null;
  const sign = row.cents >= 0 ? '+' : '-';
  return (
    <Box style={{ ...theme.tooltip.contentStyle, padding: '6px 10px' }}>
      <Typography variant="caption" style={{ display: 'block', color: theme.tooltip.labelStyle.color }}>
        截至 {row.full}
      </Typography>
      <Typography variant="body2" className="tabular" fontWeight={600}>
        累计 {sign}
        {formatCents(Math.abs(row.cents), { symbol: false })} 元
      </Typography>
    </Box>
  );
}
