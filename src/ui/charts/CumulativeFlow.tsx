import { Box, Typography } from '@mui/material';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { FlowPoint } from '../../domain/aggregate';
import { centsToYuanNumber } from '../../domain/money';
import { useChartTheme, compactYuan } from './chartTokens';

interface Props {
  points: FlowPoint[];
}

/**
 * 累计收支双折线：累计收入 vs 累计支出净额。
 * 两条线之间的垂直距离就是同期累计利润 —— 距离缩小意味着当期入不敷出。
 */
export default function CumulativeFlow({ points }: Props): JSX.Element {
  const theme = useChartTheme();
  if (points.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        所选区间没有数据
      </Typography>
    );
  }

  const data = points.map((point) => ({
    label: point.label,
    cumIncome: centsToYuanNumber(point.cum_income_cents),
    cumExpense: centsToYuanNumber(point.cum_expense_cents),
  }));

  return (
    <Box sx={{ width: '100%', height: 240 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
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
            formatter={(value: number, name: string) => [`¥${Number(value).toFixed(2)}`, name]}
            contentStyle={theme.tooltip.contentStyle}
            labelStyle={theme.tooltip.labelStyle}
            itemStyle={theme.tooltip.itemStyle}
          />
          <Legend
            verticalAlign="top"
            height={26}
            iconType="plainline"
            wrapperStyle={theme.legend.wrapperStyle}
          />
          <Line
            type="monotone"
            dataKey="cumIncome"
            name="累计收入"
            stroke={theme.colors.green}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
          <Line
            type="monotone"
            dataKey="cumExpense"
            name="累计支出（净额）"
            stroke={theme.colors.red}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </Box>
  );
}
