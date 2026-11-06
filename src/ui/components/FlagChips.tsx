import { Chip, Stack } from '@mui/material';
import type { FlagHit } from '../../domain/flags';

const COLORS: Record<string, 'default' | 'primary' | 'secondary' | 'warning' | 'success' | 'info'> = {
  most_worthless: 'secondary',
  late_night: 'info',
  large_amount: 'warning',
  small_change: 'default',
  habitual: 'default',
};

interface Props {
  hits: readonly FlagHit[];
  size?: 'small' | 'medium';
}

/**
 * 标记必须**同时给文字标签**，颜色不是唯一信息载体（PRD §11 ⑥，无障碍要求）。
 */
export function FlagChips({ hits, size = 'small' }: Props): JSX.Element | null {
  if (hits.length === 0) return null;
  return (
    <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap' }}>
      {hits.map((hit) => (
        <Chip
          key={hit.kind}
          label={hit.label}
          size={size}
          color={COLORS[hit.kind] ?? 'default'}
          variant={hit.kind === 'most_worthless' ? 'filled' : 'outlined'}
          title={hit.detail ?? hit.label}
          sx={{ height: 20, fontSize: 11, '& .MuiChip-label': { px: 0.75 } }}
        />
      ))}
    </Stack>
  );
}
