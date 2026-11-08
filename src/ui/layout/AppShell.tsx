import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import {
  Box,
  Button,
  Divider,
  Drawer,
  Fab,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Snackbar,
  Alert,
  Stack,
  Toolbar,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { useMemo } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { OfflineBanner } from '../../pwa/OfflineBanner';
import { useUiStore } from '../../store/uiStore';
import { DataGate } from '../hooks/useDataReady';
import { TxEditorDialog } from '../components/TxEditorDialog';
import { DragGhost } from '../dnd/DragGhost';
import { NAV_ITEMS, SETTINGS_ITEM } from './navItems';

const DRAWER_WIDTH = 228;

/**
 * 三端响应式：手机底部 5 Tab + FAB；平板/桌面左侧固定导航 + 右侧内容双栏。
 * 主操作在屏幕下 1/3，不用汉堡菜单。
 */
export function AppShell(): JSX.Element {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const navigate = useNavigate();
  const location = useLocation();
  const snack = useUiStore((state) => state.snack);
  const clearSnack = useUiStore((state) => state.clearSnack);
  const setQuickAddOpen = useUiStore((state) => state.setQuickAddOpen);
  const fabHidden = useUiStore((state) => state.fabHidden);

  const active = useMemo(() => {
    const path = location.pathname;
    if (path === '/') return '/';
    const hit = [...NAV_ITEMS, SETTINGS_ITEM].find((item) => item.to !== '/' && path.startsWith(item.to));
    return hit ? hit.to : path;
  }, [location.pathname]);

  const navList = (
    <List sx={{ px: 1, py: 1 }}>
      {[...NAV_ITEMS, SETTINGS_ITEM].map((item) => (
        <ListItemButton
          key={item.to}
          selected={active === item.to}
          onClick={() => navigate(item.to)}
          sx={{ mb: 0.5 }}
        >
          <ListItemIcon sx={{ minWidth: 38 }}>{item.icon}</ListItemIcon>
          <ListItemText primary={item.label} primaryTypographyProps={{ fontSize: 14 }} />
        </ListItemButton>
      ))}
    </List>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100dvh', bgcolor: 'background.default' }}>
      {isDesktop && (
        <Drawer
          variant="permanent"
          sx={{
            width: DRAWER_WIDTH,
            flexShrink: 0,
            '& .MuiDrawer-paper': {
              width: DRAWER_WIDTH,
              boxSizing: 'border-box',
              borderRight: '1px solid',
              borderColor: 'divider',
              bgcolor: 'background.paper',
            },
          }}
        >
          <Toolbar sx={{ px: 2 }}>
            <Box>
              <Typography variant="subtitle1" fontWeight={700}>
                快记账
              </Typography>
              <Typography variant="caption" color="text.secondary">
                数据只存本机
              </Typography>
            </Box>
          </Toolbar>
          <Divider />
          {navList}
          <Box sx={{ flexGrow: 1 }} />
          <Box sx={{ px: 2, py: 2 }}>
            <Typography variant="caption" color="text.secondary">
              无账号 · 无上传 · 离线可用
            </Typography>
          </Box>
        </Drawer>
      )}

      <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <OfflineBanner />
        <Box
          component="main"
          sx={{
            flexGrow: 1,
            px: { xs: 2, md: 3 },
            pt: { xs: 2, md: 2.5 },
            /*
              底部留白要盖住两样东西：底部导航（56 + 安全区）与它上方 24px 处的悬浮球（56 直径）。
              原来按 112px 算，只够让最后一行停在球的下沿之外；
              但球是圆的、行的右侧还常有图标按钮，实际仍会压住最右边的删除/编辑。
              这里提到 148px，让最后一行整体落在球的上方。
            */
            pb: { xs: 'calc(148px + env(safe-area-inset-bottom, 0px))', md: 10 },
            maxWidth: 1080,
            width: '100%',
            mx: 'auto',
          }}
        >
          <DataGate>
            <Outlet />
          </DataGate>
        </Box>
      </Box>

      {!fabHidden && (
        <Fab
          color="primary"
          aria-label="记一笔"
          onClick={() => setQuickAddOpen(true)}
          sx={{
            position: 'fixed',
            right: { xs: 16, md: 32 },
            bottom: { xs: 'calc(80px + env(safe-area-inset-bottom, 0px))', md: 32 },
            zIndex: 1300,
          }}
        >
          <AddIcon />
        </Fab>
      )}

      {!isDesktop && (
        <Box
          component="nav"
          aria-label="主导航"
          sx={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 1200,
            bgcolor: 'background.paper',
            borderTop: '1px solid',
            borderColor: 'divider',
            pb: 'env(safe-area-inset-bottom, 0px)',
          }}
        >
          <Box sx={{ display: 'flex', height: 56 }}>
            {NAV_ITEMS.map((item) => {
              const selected = active === item.to;
              return (
                <Box
                  key={item.to}
                  role="button"
                  tabIndex={0}
                  aria-current={selected ? 'page' : undefined}
                  aria-label={item.label}
                  onClick={() => navigate(item.to)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      navigate(item.to);
                    }
                  }}
                  sx={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 0.25,
                    cursor: 'pointer',
                    color: selected ? 'primary.main' : 'text.secondary',
                    '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
                  }}
                >
                  <Box sx={{ '& svg': { fontSize: 22 } }}>{item.icon}</Box>
                  <Typography sx={{ fontSize: 11, fontWeight: selected ? 700 : 500 }}>{item.short}</Typography>
                </Box>
              );
            })}
          </Box>
        </Box>
      )}

      <TxEditorDialog />
      {/* 拖拽浮层挂在最外层：它用 portal 定位到 body，放在这里只为跟随时钟/主题一致 */}
      <DragGhost />

      <Snackbar
        key={snack?.id ?? 'idle'}
        open={snack !== null}
        autoHideDuration={snack?.duration ?? (snack?.onAction ? 6000 : 3200)}
        onClose={clearSnack}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        sx={{ bottom: { xs: 'calc(72px + env(safe-area-inset-bottom, 0px))', md: 24 } }}
      >
        <Alert
          severity={snack?.severity ?? 'info'}
          variant="filled"
          action={
            <Stack direction="row" spacing={0.5} alignItems="center">
              {snack?.onAction && (
                <Button
                  color="inherit"
                  size="small"
                  sx={{ fontWeight: 700, whiteSpace: 'nowrap', px: 1 }}
                  onClick={() => {
                    snack.onAction?.();
                    clearSnack();
                  }}
                >
                  {snack.actionLabel ?? '撤销'}
                </Button>
              )}
              <IconButton size="small" color="inherit" aria-label="关闭提示" onClick={clearSnack}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>
          }
        >
          {snack?.message ?? ''}
        </Alert>
      </Snackbar>
    </Box>
  );
}
