import { Box, Skeleton, Stack } from '@mui/material';

/**
 * 数据到达前的占位，替代「先闪一下『还没有数据』再突然变成真实内容」。
 *
 * 形状刻意贴合真实页面（标题 + 概览卡 + 图表 + 列表），数据到达时不会大幅跳动。
 * 纯展示组件，不读任何业务数据。
 */
export function PageSkeleton({ rows = 5 }: { rows?: number }): JSX.Element {
  return (
    <Box sx={{ pt: 0.5 }} aria-busy="true" aria-label="正在读取本机账本">
      <Skeleton variant="text" width={150} height={34} sx={{ mb: 0.5 }} />
      <Skeleton variant="text" width={220} height={20} sx={{ mb: 2.5 }} />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 2.5 }}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} variant="rounded" height={104} sx={{ flex: 1, borderRadius: 3 }} />
        ))}
      </Stack>
      <Skeleton variant="rounded" height={190} sx={{ borderRadius: 3, mb: 2.5 }} />
      <Stack spacing={1}>
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} variant="rounded" height={56} sx={{ borderRadius: 2 }} />
        ))}
      </Stack>
    </Box>
  );
}

/** 只需要列表的页面（流水 / 设置子页）用这个轻量版本。 */
export function ListSkeleton({ rows = 6 }: { rows?: number }): JSX.Element {
  return (
    <Box aria-busy="true" aria-label="正在读取本机账本">
      <Skeleton variant="text" width={150} height={34} sx={{ mb: 2.5 }} />
      <Stack spacing={1}>
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} variant="rounded" height={64} sx={{ borderRadius: 2 }} />
        ))}
      </Stack>
    </Box>
  );
}
