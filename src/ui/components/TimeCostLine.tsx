import { Typography } from '@mui/material';
import { costToTime, shouldShowTimeCost, type WageSettings, type WageResult } from '../../domain/timecost';
import type { Cents } from '../../types';

interface Props {
  cents: Cents;
  settings: WageSettings;
  wage: WageResult;
  /** 汇总条用：不受阈值限制 */
  always?: boolean;
  prefix?: string;
}

/**
 * M1 时间成本小字。
 * 未设时薪时**不显示 0、不用占位符**（PRD §4 边界），直接返回 null 由页面给引导。
 */
export function TimeCostLine({ cents, settings, wage, always = false, prefix = '≈' }: Props): JSX.Element | null {
  if (wage.cents === null) return null;
  if (!always && !shouldShowTimeCost(cents, settings)) return null;
  const cost = costToTime(cents, wage.cents, settings.workday_hours, wage.basis ?? 'manual');
  return (
    <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.25 }}>
      {prefix} {cost.display}
    </Typography>
  );
}
