import { Typography, type SxProps, type Theme } from '@mui/material';
import { formatCents } from '../../domain/money';
import type { Cents } from '../../types';

interface Props {
  cents: Cents | number;
  /** hero = 总览主数字；lg = 页面标题数字；md = 列表主行；sm = 次要 */
  size?: 'hero' | 'lg' | 'md' | 'sm';
  color?: string;
  showSign?: boolean;
  sx?: SxProps<Theme>;
}

const SIZES: Record<NonNullable<Props['size']>, string> = {
  hero: 'clamp(34px, 9vw, 46px)',
  lg: 'clamp(24px, 6vw, 30px)',
  md: '17px',
  sm: '13px',
};

/** 金额展示统一走这里：等宽数字、固定 2 位、颜色只做辅助（标记同时给文字）。 */
export function MoneyText({ cents, size = 'md', color, showSign = false, sx }: Props): JSX.Element {
  return (
    <Typography
      component="span"
      className="tabular"
      sx={{
        fontSize: SIZES[size],
        fontWeight: size === 'hero' || size === 'lg' ? 700 : 600,
        letterSpacing: size === 'hero' || size === 'lg' ? '-0.02em' : 0,
        lineHeight: 1.15,
        whiteSpace: 'nowrap',
        color,
        ...sx,
      }}
    >
      {formatCents(cents, { showPlus: showSign })}
    </Typography>
  );
}
