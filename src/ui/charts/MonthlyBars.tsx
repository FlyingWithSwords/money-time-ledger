import { Box } from '@mui/material';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { centsToYuanNumber } from '../../domain/money';
import type { TrendPoint } from '../../domain/aggregate';
import type { Cents } from '../../types';
import { useChartTheme } from './chartTokens';

interface Props {
  points: TrendPoint[];
  averageCents: Cents;
  height?: number;
}

/** 月度柱图 + 均值参考线：这个月比过去贵吗。 */
export default function MonthlyBars({ points, averageCents, height = 180 }: Props): JSX.Element {
  const theme = useChartTheme();
  const data = points.map((point) => ({
    label: point.label,
    value: centsToYuanNumber(point.net_expense_cents),
  }));
  const avg = centsToYuanNumber(averageCents);

  return (
    <Box sx={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
          <CartesianGrid stroke={theme.grid.stroke} strokeDasharray="3 3" vertical={false} opacity={0.25} />
          <XAxis
            dataKey="label"
            tick={{ fill: theme.axis.tick.fill, fontSize: 11 }}
            axisLine={{ stroke: theme.axis.stroke }}
            tickLine={{ stroke: theme.axis.stroke }}
          />
          <YAxis
            tick={{ fill: theme.axis.tick.fill, fontSize: 11 }}
            axisLine={{ stroke: theme.axis.stroke }}
            tickLine={{ stroke: theme.axis.stroke }}
            width={52}
          />
          <Tooltip
            formatter={(value: number) => [`¥${value.toFixed(2)}`, '支出净额']}
            contentStyle={theme.tooltip.contentStyle}
            labelStyle={theme.tooltip.labelStyle}
            itemStyle={theme.tooltip.itemStyle}
          />
          {avg > 0 && (
            <ReferenceLine
              y={avg}
              stroke={theme.colors.orange}
              strokeDasharray="4 4"
              label={{ value: '均值', fontSize: 10, fill: theme.colors.orange, position: 'insideTopRight' }}
            />
          )}
          <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={34}>
            {data.map((entry) => (
              <Cell key={entry.label} fill={entry.value > avg && avg > 0 ? theme.colors.orange : theme.colors.blue} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Box>
  );
}
