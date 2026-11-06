import { Box, Chip, Stack, TextField, Typography } from '@mui/material';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as transactionRepo from '../../db/repos/transactionRepo';
import { todayDateString } from '../../domain/date';
import {
  currentMonthRange,
  lastNMonthsRange,
  sameRange,
  shiftRangeBack,
  wholeMonthRange,
  yearToDate,
  type DateRange,
} from '../../domain/range';
import { useUiStore } from '../../store/uiStore';

/**
 * 日期区间选择器（总览 / 洞察 / 趋势共用）。
 *
 * 设计约束：
 * - 不引入 @mui/x-date-pickers：原生 <input type="date"> 用 MUI TextField 包一层，
 *   与 TxEditorDialog 里的日期输入保持完全一致的写法与外观；
 * - 没有「应用」按钮：变更即写 store，页面通过 useLiveQuery 自动重取；
 * - 手机上一行放不下 6 个快捷按钮，所以快捷按钮自己横向滚动，日期输入单独一行，
 *   两行都不换行 —— 观感是"紧凑两行"，不会被挤成参差不齐的多行。
 */

interface Preset {
  key: string;
  label: string;
  build: () => DateRange;
}

const PRESETS: Preset[] = [
  { key: 'this-month', label: '本月', build: () => currentMonthRange() },
  { key: 'last-month', label: '上月', build: () => shiftRangeBack(currentMonthRange(), 1) },
  { key: 'last-3', label: '近 3 月', build: () => lastNMonthsRange(3) },
  { key: 'ytd', label: '今年', build: () => yearToDate() },
  { key: 'last-12', label: '近 12 月', build: () => lastNMonthsRange(12) },
];

const SWAP_NOTICE_MS = 2600;

export function DateRangePicker(): JSX.Element {
  const dateRange = useUiStore((state) => state.dateRange);
  const setDateRange = useUiStore((state) => state.setDateRange);
  const monthsWithData = useLiveQuery(() => transactionRepo.monthsWithData(), [], []) ?? [];
  const [swapNotice, setSwapNotice] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  /** 「全部」：最早有数据的月份 1 号 → 今天（若最晚数据月晚于今天，则取那个月月末，免得漏掉未来记账）。 */
  const allRange = useMemo<DateRange>(() => {
    if (monthsWithData.length === 0) return currentMonthRange();
    const first = wholeMonthRange(monthsWithData[0]);
    const lastMonthEnd = wholeMonthRange(monthsWithData[monthsWithData.length - 1]).to;
    const today = todayDateString();
    return { from: first.from, to: lastMonthEnd > today ? lastMonthEnd : today };
  }, [monthsWithData]);

  const showSwapNotice = (): void => {
    setSwapNotice(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setSwapNotice(false), SWAP_NOTICE_MS);
  };

  /**
   * from > to 时不弹错、不阻塞输入：自动交换端点并给一行小字。
   * 用户改开始日期改过头（超过结束日期）是常见手误，报错会让他多点一次。
   */
  const handleFrom = (value: string): void => {
    if (!value) return;
    if (value > dateRange.to) {
      setDateRange({ from: dateRange.to, to: value });
      showSwapNotice();
      return;
    }
    setDateRange({ from: value, to: dateRange.to });
  };

  const handleTo = (value: string): void => {
    if (!value) return;
    if (value < dateRange.from) {
      setDateRange({ from: value, to: dateRange.from });
      showSwapNotice();
      return;
    }
    setDateRange({ from: dateRange.from, to: value });
  };

  const isAll = sameRange(dateRange, allRange);

  return (
    <Box sx={{ mb: 1.5 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          overflowX: 'auto',
          flexWrap: 'nowrap',
          pb: 0.5,
          '&::-webkit-scrollbar': { display: 'none' },
          scrollbarWidth: 'none',
        }}
      >
        {PRESETS.map((preset) => {
          const active = sameRange(dateRange, preset.build());
          return (
            <Chip
              key={preset.key}
              label={preset.label}
              size="small"
              clickable
              color={active ? 'primary' : 'default'}
              variant={active ? 'filled' : 'outlined'}
              onClick={() => setDateRange(preset.build())}
              sx={{ flexShrink: 0 }}
            />
          );
        })}
        <Chip
          label="全部"
          size="small"
          clickable
          color={isAll ? 'primary' : 'default'}
          variant={isAll ? 'filled' : 'outlined'}
          onClick={() => setDateRange(allRange)}
          sx={{ flexShrink: 0 }}
        />
      </Box>

      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1, flexWrap: 'nowrap' }}>
        <TextField
          label="开始"
          type="date"
          size="small"
          value={dateRange.from}
          onChange={(event) => handleFrom(event.target.value)}
          InputLabelProps={{ shrink: true }}
          inputProps={{ 'aria-label': '开始日期' }}
          sx={{ flex: 1, minWidth: 0 }}
        />
        <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
          ~
        </Typography>
        <TextField
          label="结束"
          type="date"
          size="small"
          value={dateRange.to}
          onChange={(event) => handleTo(event.target.value)}
          InputLabelProps={{ shrink: true }}
          inputProps={{ 'aria-label': '结束日期' }}
          sx={{ flex: 1, minWidth: 0 }}
        />
      </Stack>

      {swapNotice && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          已自动调整顺序
        </Typography>
      )}
    </Box>
  );
}
