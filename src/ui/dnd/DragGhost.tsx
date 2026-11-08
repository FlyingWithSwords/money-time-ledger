import { Box, Typography } from '@mui/material';
import { createPortal } from 'react-dom';
import { formatCents } from '../../domain/money';
import { useDragStore } from '../../store/dragStore';

/**
 * 拖拽浮层：跟着指针走的一张小卡片。
 *
 * 用 portal 挂到 body：列表行本身在 `overflow: hidden` 的圆角容器里，
 * 留在原地会被裁掉一半；而且父级若有 transform，position: fixed 会失效。
 *
 * `pointerEvents: 'none'` 是硬要求——浮层正好压在指针下面，
 * 能被 elementFromPoint 命中的话就永远找不到底下的投放区。
 */
export function DragGhost(): JSX.Element | null {
  const payload = useDragStore((state) => state.payload);
  const point = useDragStore((state) => state.point);
  const overKey = useDragStore((state) => state.overKey);

  if (!payload || typeof document === 'undefined') return null;

  const count = payload.txIds.length;
  const sign = payload.direction === 'expense' ? '-' : payload.direction === 'income' ? '+' : '';

  return createPortal(
    <Box
      sx={{
        position: 'fixed',
        // 偏到指针右下：正好压住手指时看不见它指着哪个投放区
        left: point.x + 12,
        top: point.y + 8,
        zIndex: 3000,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.25,
        py: 0.75,
        borderRadius: 2,
        bgcolor: overKey ? 'primary.main' : 'background.paper',
        color: overKey ? 'primary.contrastText' : 'text.primary',
        boxShadow: 6,
        border: '1px solid',
        borderColor: overKey ? 'primary.dark' : 'divider',
        maxWidth: 260,
        transform: 'rotate(-1.5deg)',
        transition: 'background-color 120ms ease',
      }}
    >
      <Typography variant="caption" sx={{ fontWeight: 700 }}>
        {count > 1 ? `${count} 笔` : payload.label}
      </Typography>
      <Typography variant="caption" className="tabular" sx={{ opacity: 0.85 }}>
        {sign}
        {formatCents(payload.cents, { symbol: false })}
      </Typography>
      <Typography variant="caption" sx={{ opacity: 0.7, fontSize: 10 }}>
        {overKey ? '松手放下' : '拖到目标上'}
      </Typography>
    </Box>,
    document.body,
  );
}
