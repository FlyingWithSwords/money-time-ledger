import { Box, Typography } from '@mui/material';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { FlowPoint } from '../../domain/aggregate';
import { centsToYuanNumber } from '../../domain/money';
import { useChartTheme, compactYuan } from './chartTokens';

interface Props {
  /** 由 flowSeries 算好再传进来：组件内不取数、不聚合 */
  points: FlowPoint[];
}

/** 月度收支对比（双折线）。支出是**净额**口径（毛利减退款冲正）。 */
export default function FlowLines({ points }: Props): JSX.Element {
  const theme = useChartTheme();
  if (points.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        所选区间没有数据
      </Typography>
    );
  }

  // 点数多时点标记会糊成一条带子，此时只留 activeDot（hover 才显示）
  const dense = points.length > 24;
  const data = points.map((point) => ({
    label: point.label,
    expense: centsToYuanNumber(point.expense_cents),
    income: centsToYuanNumber(point.income_cents),
  }));

  return (
    <Box sx={{ width: '100%', height: 220 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
          <CartesianGrid stroke={theme.grid.stroke} strokeDasharray="3 3" vertical={false} opacity={0.25} />
          <XAxis
            dataKey="label"
            tick={{ fill: theme.axis.tick.fill, fontSize: 10 }}
            axisLine={{ stroke: theme.axis.stroke }}
            tickLine={{ stroke: theme.axis.stroke }}
            interval={dense ? 'preserveStartEnd' : 0}
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
          {/* 缺月由 flowSeries 补 0 而不是补 null，所以不需要 connectNulls */}
          <Line
            type="monotone"
            dataKey="expense"
            name="月支出（净额）"
            stroke={theme.colors.blue}
            strokeWidth={2}
            dot={dense ? false : { r: 2 }}
            activeDot={{ r: 4 }}
          />
          <Line
            type="monotone"
            dataKey="income"
            name="月收入"
            stroke={theme.colors.orange}
            strokeWidth={2}
            dot={dense ? false : { r: 2 }}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </Box>
  );
}
