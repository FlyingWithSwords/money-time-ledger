import { Box } from '@mui/material';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { centsToYuanNumber } from '../../domain/money';
import type { RangeCumulativePoint } from '../../domain/aggregate';
import { useChartTheme, compactYuan } from './chartTokens';

interface Props {
  /** 当前区间的逐日累计支出（净额） */
  current: RangeCumulativePoint[];
  /** 上一个等长区间的逐日累计支出（净额） */
  previous: RangeCumulativePoint[];
  currentLabel: string;
  previousLabel: string;
}

/**
 * 累计支出折线（当前区间 vs 上一个等长区间）：支出在恶化吗，看斜率。
 *
 * 对齐方式是**按下标逐日对齐**而不是按日期：两个区间等长（shiftRangeBack 保证），
 * 第 N 天对第 N 天才有可比性。日期字符串只用来做横轴刻度与 tooltip。
 */
export default function ExpenseTrend({ current, previous, currentLabel, previousLabel }: Props): JSX.Element {
  const theme = useChartTheme();
  const length = Math.max(current.length, previous.length);
  const data = Array.from({ length }, (_, index) => {
    const cur = current[index];
    const prev = previous[index];
    return {
      day: cur?.label ?? prev?.label ?? `${index + 1}天`,
      本区间: cur ? centsToYuanNumber(cur.expense_cents) : null,
      上一区间: prev ? centsToYuanNumber(prev.expense_cents) : null,
    };
  });
  // 一条腿是 365 天时每秒都画 tick 会把轴糊死：抽稀到 8 个左右刻度
  const interval = data.length > 40 ? 'preserveStartEnd' : Math.max(0, Math.floor(data.length / 8) - 1);

  return (
    <Box sx={{ width: '100%', height: 220 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
          <CartesianGrid stroke={theme.grid.stroke} strokeDasharray="3 3" vertical={false} opacity={0.25} />
          <XAxis
            dataKey="day"
            tick={{ fill: theme.axis.tick.fill, fontSize: 10 }}
            axisLine={{ stroke: theme.axis.stroke }}
            tickLine={{ stroke: theme.axis.stroke }}
            interval={interval}
          />
          <YAxis
            tick={{ fill: theme.axis.tick.fill, fontSize: 11 }}
            axisLine={{ stroke: theme.axis.stroke }}
            tickLine={{ stroke: theme.axis.stroke }}
            width={52}
            tickFormatter={(value: number) => compactYuan(value)}
          />
          <Tooltip
            formatter={(value: number) => (value === null ? '—' : `¥${Number(value).toFixed(2)}`)}
            contentStyle={theme.tooltip.contentStyle}
            labelStyle={theme.tooltip.labelStyle}
            itemStyle={theme.tooltip.itemStyle}
          />
          <Legend
            verticalAlign="top"
            height={26}
            iconType="plainline"
            wrapperStyle={theme.legend.wrapperStyle}
            formatter={(value: string) => (
              <span style={theme.legend.wrapperStyle}>{value === '本区间' ? currentLabel : previousLabel}</span>
            )}
          />
          <Line type="monotone" dataKey="上一区间" stroke={theme.colors.gray} strokeWidth={2} dot={false} connectNulls />
          <Line type="monotone" dataKey="本区间" stroke={theme.colors.green} strokeWidth={2.5} dot={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </Box>
  );
}
