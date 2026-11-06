import { useEffect, useState } from 'react';
import { Box } from '@mui/material';

/** 离线横幅：让用户知道"现在记的账不会丢，只是行情刷不了"。 */
export function OfflineBanner(): JSX.Element | null {
  const [online, setOnline] = useState<boolean>(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  if (online) return null;

  return (
    <Box
      className="no-print"
      sx={{
        position: 'sticky',
        top: 0,
        zIndex: 1200,
        px: 2,
        py: 0.75,
        bgcolor: 'warning.main',
        color: 'warning.contrastText',
        fontSize: 13,
        textAlign: 'center',
      }}
      role="status"
    >
      当前离线：记账、流水、洞察照常可用；基金净值显示最近一次获取的数据
    </Box>
  );
}
