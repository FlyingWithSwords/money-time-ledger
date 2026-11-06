import { Box, Button, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

interface Props {
  icon?: ReactNode;
  title: string;
  description?: string;
  primary?: { label: string; onClick: () => void; disabled?: boolean };
  secondary?: { label: string; onClick: () => void; disabled?: boolean };
  /** 局部空态（某个卡片里）用紧凑版，避免一行字被撑成半屏空白。 */
  compact?: boolean;
}

/** 空状态即引导（PRD §11 ④）：不留一句"暂无数据"。 */
export function EmptyState({ icon, title, description, primary, secondary, compact = false }: Props): JSX.Element {
  return (
    <Box sx={{ textAlign: 'center', py: compact ? 2.5 : 6, px: 2 }}>
      {icon && (
        <Box sx={{ fontSize: compact ? 28 : 40, mb: compact ? 0.5 : 1 }} aria-hidden="true">
          {icon}
        </Box>
      )}
      <Typography variant={compact ? 'body2' : 'subtitle1'} fontWeight={700} gutterBottom>
        {title}
      </Typography>
      {description && (
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mb: compact ? 1.5 : 2, maxWidth: 420, mx: 'auto' }}
        >
          {description}
        </Typography>
      )}
      <Stack direction="row" spacing={1} justifyContent="center" sx={{ flexWrap: 'wrap' }}>
        {primary && (
          <Button
            variant="contained"
            size={compact ? 'small' : 'medium'}
            disabled={primary.disabled}
            onClick={primary.onClick}
          >
            {primary.label}
          </Button>
        )}
        {secondary && (
          <Button
            variant="outlined"
            size={compact ? 'small' : 'medium'}
            disabled={secondary.disabled}
            onClick={secondary.onClick}
          >
            {secondary.label}
          </Button>
        )}
      </Stack>
    </Box>
  );
}
