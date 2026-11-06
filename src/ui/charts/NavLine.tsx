import { Box } from '@mui/material';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { NavPoint } from '../../quotes/types';
import { useChartTheme } from './chartTokens';

interface Props {
  points: NavPoint[];
  height?: number;
}

/** 净值折线（与收益率曲线分开两张图，避免双轴误读）。 */
export default function NavLine({ points, height = 200 }: Props): JSX.Element {
  const theme = useChartTheme();
  const data = points.map((point) => ({ date: point.nav_date.slice(5), nav: point.nav }));
  return (
    <Box sx={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid stroke={theme.grid.stroke} strokeDasharray="3 3" vertical={false} opacity={0.25} />
          <XAxis
            dataKey="date"
            tick={{ fill: theme.axis.tick.fill, fontSize: 10 }}
            axisLine={{ stroke: theme.axis.stroke }}
            tickLine={{ stroke: theme.axis.stroke }}
            interval="preserveStartEnd"
          />
          <YAxis
            domain={['auto', 'auto']}
            tick={{ fill: theme.axis.tick.fill, fontSize: 10 }}
            axisLine={{ stroke: theme.axis.stroke }}
            tickLine={{ stroke: theme.axis.stroke }}
            width={52}
          />
          <Tooltip
            formatter={(value: number) => [Number(value).toFixed(4), '单位净值']}
            contentStyle={theme.tooltip.contentStyle}
            labelStyle={theme.tooltip.labelStyle}
            itemStyle={theme.tooltip.itemStyle}
          />
          <Line type="monotone" dataKey="nav" stroke={theme.colors.blue} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </Box>
  );
}
