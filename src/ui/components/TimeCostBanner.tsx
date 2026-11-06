import { Box, LinearProgress, Typography } from '@mui/material';
import type { Cents } from '../../types';
import { workdayBudget } from '../../domain/timecost';

interface Props {
  /** 本区间净支出（支出减退款冲正） */
  expenseCents: Cents;
  /** 上一个可比区间净支出，用于「比上一区间多/少」 */
  prevExpenseCents: Cents;
  /** 「本月」或「所选区间」，跟着日期筛选变 */
  scopeLabel: string;
  /** 解析出的时薪；null 表示用户还没提供任何薪酬信息 */
  wageCents: Cents | null;
  workdayHours: number;
  monthlyHours: number;
}

function trim(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

function compareText(currentDays: number, prevDays: number): string | null {
  const diff = currentDays - prevDays;
  if (Math.abs(diff) < 0.1) return '与上一个区间基本持平';
  if (diff > 0) return `比上一个可比区间多花 ${trim(diff)} 个工作日`;
  return `比上一个可比区间少花 ${trim(-diff)} 个工作日`;
}

/**
 * 「这段日子的劳动，已经用掉了多少」。
 *
 * 存在的理由：只显示单笔「这杯咖啡 = 0.5 小时」会诱发反向激励——
 * 半小时听着不贵，于是继续买（有实测用户因此把月支出做到预算的 115%）。
 * 所以必须同时给出总量与进度：挣来的 21.75 个工作日里，已经花掉 11.3 个。
 *
 * 没有时薪时整块不渲染 —— 与行内时间成本一致，不显示 0、不用占位符。
 */
export function TimeCostBanner({
  expenseCents,
  prevExpenseCents,
  scopeLabel,
  wageCents,
  workdayHours,
  monthlyHours,
}: Props): JSX.Element | null {
  if (wageCents === null) return null;

  const current = workdayBudget(expenseCents, wageCents, workdayHours, monthlyHours);
  if (!current) return null;
  const prev = workdayBudget(prevExpenseCents, wageCents, workdayHours, monthlyHours);

  // 不足一天时用小时表达，避免「0.5 个工作日」这种读不出量级的写法
  const underOneDay = current.consumed_days < 1;
  const percent = current.ratio === null ? null : Math.round(current.ratio * 100);
  const barValue = current.ratio === null ? 0 : Math.min(current.ratio * 100, 100);
  const tone = current.overdrawn ? 'error' : (percent ?? 0) >= 70 ? 'warning' : 'primary';
  const barColor = tone === 'error' ? 'error' : tone === 'warning' ? 'warning' : 'primary';

  const exhausted = current.hours < 0.01;
  const projection = prev ? compareText(current.consumed_days, prev.consumed_days) : null;

  return (
    <Box
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        p: 1.5,
        mb: 1.5,
        bgcolor: 'background.paper',
      }}
    >
      {exhausted ? (
        <Typography variant="body2" color="text.secondary">
          {scopeLabel}还没有支出，你的时间一天都没被花掉。
        </Typography>
      ) : (
        <>
          <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 1 }}>
            <Typography variant="caption" color="text.secondary">
              {scopeLabel}的代价
            </Typography>
            {percent !== null ? (
              <Typography variant="caption" color={`${tone}.main`} fontWeight={600}>
                已用掉 {percent}%
              </Typography>
            ) : null}
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, mt: 0.25 }}>
            <Typography variant="h6" sx={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2 }}>
              {underOneDay ? trim(current.hours) : trim(current.consumed_days)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {underOneDay ? '小时' : '个工作日'}
            </Typography>
          </Box>

          {current.total_days > 0 ? (
            <>
              <LinearProgress
                variant="determinate"
                value={barValue}
                color={barColor}
                aria-label={`${scopeLabel}已消耗劳动时间占比`}
                sx={{ height: 6, borderRadius: 3, my: 0.75 }}
              />
              <Typography variant="caption" color="text.secondary">
                这段时间你一共挣来 {trim(current.total_days)} 个工作日
                {current.overdrawn
                  ? ' —— 已经花超了，超出的部分是在花以前攒下的。'
                  : `，还剩 ${trim(current.total_days - current.consumed_days)} 个。`}
              </Typography>
            </>
          ) : (
            <Typography variant="caption" color="text.secondary">
              相当于为这些支出工作这么久。
            </Typography>
          )}

          {projection ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
              {projection}
            </Typography>
          ) : null}
        </>
      )}
    </Box>
  );
}
