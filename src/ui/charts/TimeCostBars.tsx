import { Box } from '@mui/material';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useChartTheme } from './chartTokens';

export interface TimeCostItem {
  name: string;
  hours: number;
}

interface Props {
  items: TimeCostItem[];
  height?: number;
}

/** 时间成本横向条形：按分类排序，单位"小时" —— 本产品的特色视角。 */
export default function TimeCostBars({ items, height = 220 }: Props): JSX.Element {
  const theme = useChartTheme();
  const data = items.map((item) => ({ name: item.name, hours: Math.round(item.hours * 10) / 10 }));
  return (
    <Box sx={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid stroke={theme.grid.stroke} strokeDasharray="3 3" horizontal={false} opacity={0.25} />
          <XAxis
            type="number"
            tick={{ fill: theme.axis.tick.fill, fontSize: 11 }}
            axisLine={{ stroke: theme.axis.stroke }}
            tickLine={{ stroke: theme.axis.stroke }}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fill: theme.axis.tick.fill, fontSize: 12 }}
            axisLine={{ stroke: theme.axis.stroke }}
            tickLine={{ stroke: theme.axis.stroke }}
            width={56}
          />
          <Tooltip
            formatter={(value: number) => [`${value} 小时`, '时间成本']}
            contentStyle={theme.tooltip.contentStyle}
            labelStyle={theme.tooltip.labelStyle}
            itemStyle={theme.tooltip.itemStyle}
          />
          <Bar dataKey="hours" fill={theme.colors.purple} radius={[0, 4, 4, 0]} maxBarSize={22} />
        </BarChart>
      </ResponsiveContainer>
    </Box>
  );
}
