import { Box, Typography } from '@mui/material';
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { centsToYuanNumber, formatCents } from '../../domain/money';
import type { CategoryShare } from '../../domain/aggregate';
import { useChartTheme } from './chartTokens';

interface Props {
  shares: CategoryShare[];
  /** 含待分类时打水印，避免被错误数据误导（PRD §6-4） */
  hasPending: boolean;
  totalCents: number;
}

/** 环形图 + Top3 文字：一眼看钱主要花在哪。 */
export default function CategoryDonut({ shares, hasPending, totalCents }: Props): JSX.Element {
  const theme = useChartTheme();
  const data = shares.map((share) => ({
    name: share.name,
    value: centsToYuanNumber(share.cents),
    ratio: share.ratio,
    icon: share.icon,
  }));

  return (
    <Box sx={{ position: 'relative', width: '100%', height: 260 }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="58%"
            outerRadius="86%"
            paddingAngle={1}
            stroke="none"
          >
            {data.map((entry, index) => (
              <Cell key={entry.name} fill={theme.series[index % theme.series.length]} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value: number, name: string) => [`¥${value.toFixed(2)}`, name]}
            contentStyle={theme.tooltip.contentStyle}
            labelStyle={theme.tooltip.labelStyle}
            itemStyle={theme.tooltip.itemStyle}
          />
          <Legend
            verticalAlign="bottom"
            height={36}
            iconType="circle"
            wrapperStyle={theme.legend.wrapperStyle}
            formatter={(value: string) => <span style={theme.legend.wrapperStyle}>{value}</span>}
          />
        </PieChart>
      </ResponsiveContainer>
      <Box
        sx={{
          position: 'absolute',
          top: '38%',
          left: 0,
          right: 0,
          textAlign: 'center',
          pointerEvents: 'none',
        }}
      >
        <Typography variant="caption" color="text.secondary">
          支出净额
        </Typography>
        <Typography sx={{ fontSize: 18, fontWeight: 700 }} className="tabular">
          {formatCents(totalCents)}
        </Typography>
      </Box>
      {hasPending && (
        <Typography
          variant="caption"
          sx={{ position: 'absolute', bottom: 40, left: 0, right: 0, textAlign: 'center', color: 'warning.main' }}
        >
          含待分类
        </Typography>
      )}
    </Box>
  );
}
