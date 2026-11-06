import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Alert, Box, Button, Stack, Typography } from '@mui/material';

/**
 * 兜底：任何渲染异常都不能变成白屏。账目数据在 IndexedDB 里不会丢，
 * 所以这里只提示"重试 / 刷新"而不是"清空数据"。
 */
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 只打印到本地控制台，不上报任何地方（R1）
    console.error('[ledger] render error', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <Box sx={{ p: 3, maxWidth: 560, mx: 'auto' }}>
          <Alert severity="error" sx={{ mb: 2 }}>
            页面出错了，你的数据仍在本地，没有丢失。
          </Alert>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2, wordBreak: 'break-all' }}>
            {this.state.error.message}
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button variant="contained" onClick={() => this.setState({ error: null })}>
              重试渲染
            </Button>
            <Button variant="outlined" onClick={() => window.location.reload()}>
              刷新页面
            </Button>
          </Stack>
        </Box>
      );
    }
    return this.props.children;
  }
}
