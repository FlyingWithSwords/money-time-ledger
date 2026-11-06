import { Box, Paper, Typography } from '@mui/material';
import type { ReactNode } from 'react';

interface Props {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  dense?: boolean;
}

export function SectionCard({ title, subtitle, action, children, dense = false }: Props): JSX.Element {
  return (
    <Paper
      variant="outlined"
      sx={{ p: dense ? 1.5 : 2, borderRadius: 3, borderColor: 'divider', bgcolor: 'background.paper' }}
    >
      {(title || action) && (
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 1.5, gap: 1 }}>
          <Box>
            {title && (
              <Typography variant="subtitle2" sx={{ fontSize: 14 }}>
                {title}
              </Typography>
            )}
            {subtitle && (
              <Typography variant="caption" color="text.secondary">
                {subtitle}
              </Typography>
            )}
          </Box>
          {action}
        </Box>
      )}
      {children}
    </Paper>
  );
}
