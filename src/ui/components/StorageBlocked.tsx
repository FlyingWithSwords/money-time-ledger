import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { StorageProbeFailure } from '../../db/storage';

/**
 * 存储被拒时的拦截页。
 *
 * 设计取舍：**不做"内存模式"兜底**。
 * 内存模式能让界面看起来正常，但刷新即丢 —— 用户会以为账记上了，
 * 事后发现全没，比当场失败恶劣得多。所以这里直接挡住，并给出可操作的出路。
 */

const REASONS: Record<StorageProbeFailure['reason'], string> = {
  unsupported: '当前环境完全没有提供本地数据库能力。',
  denied: '当前环境拒绝了本地存储权限。',
  quota: '本地存储空间已满或配额被限制。',
  unknown: '打开本地数据库时出现未知错误。',
};

interface Props {
  failure: StorageProbeFailure;
  onRetry: () => void;
}

export function StorageBlocked({ failure, onRetry }: Props): JSX.Element {
  const [copied, setCopied] = useState(false);
  const currentUrl = typeof location !== 'undefined' ? location.href : '';

  const copyUrl = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(currentUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Box sx={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', p: 2 }}>
      <Paper elevation={0} sx={{ maxWidth: 560, width: '100%', p: { xs: 2.5, sm: 4 }, border: 1, borderColor: 'divider' }}>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
          这个环境不让我们存数据
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          账目全部存在你这台设备的浏览器里，不上传任何服务器。但当前环境拒绝了本地存储，
          所以现在记的每一笔都存不住 —— 与其让你白记，不如先停在这里。
        </Typography>

        <Alert severity="warning" sx={{ mb: 2 }}>
          {REASONS[failure.reason]}
        </Alert>

        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          常见的三种情况
        </Typography>
        <Stack component="ol" spacing={0.75} sx={{ pl: 2.5, mb: 2.5, typography: 'body2', color: 'text.secondary' }}>
          <li>
            <strong>在预览面板 / 嵌入窗口里打开</strong>：这类容器通常以受限 iframe 运行，浏览器会拒绝它的存储请求。
            请把下面的地址复制到系统浏览器（Chrome / Edge / Safari）里打开。
          </li>
          <li>
            <strong>无痕或隐私模式</strong>：部分浏览器会临时禁用 IndexedDB。换普通窗口即可。
          </li>
          <li>
            <strong>浏览器设置了「阻止所有 Cookie 和站点数据」</strong>：在站点设置里允许本站存储，然后重试。
          </li>
        </Stack>

        <Paper variant="outlined" sx={{ p: 1.5, mb: 2, wordBreak: 'break-all', typography: 'body2', fontFamily: 'ui-monospace, monospace' }}>
          {currentUrl}
        </Paper>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button variant="contained" onClick={onRetry}>
            重新检测
          </Button>
          <Button variant="outlined" onClick={() => void copyUrl()}>
            {copied ? '已复制' : '复制地址'}
          </Button>
        </Stack>

        {failure.reason === 'unknown' || failure.detail ? (
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 2, wordBreak: 'break-all' }}>
            技术细节：{failure.detail}
          </Typography>
        ) : null}
      </Paper>
    </Box>
  );
}
