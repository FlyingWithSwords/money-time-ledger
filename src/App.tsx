import { CssBaseline, ThemeProvider, useMediaQuery } from '@mui/material';
import { useEffect, useMemo } from 'react';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import { buildTheme } from './ui/theme';
import { ErrorBoundary } from './ui/components/ErrorBoundary';
import { AppShell } from './ui/layout/AppShell';
import { Overview } from './ui/pages/Overview';
import { Ledger } from './ui/pages/Ledger';
import { ImportPage } from './ui/pages/Import';
import { Funds } from './ui/pages/Funds';
import { Insight } from './ui/pages/Insight';
import { Trends } from './ui/pages/Trends';
import { SettingsPage } from './ui/pages/Settings';
import { WagePage } from './ui/pages/Settings/Wage';
import { IncomeSourcesPage } from './ui/pages/Settings/IncomeSources';
import { CategoriesPage } from './ui/pages/Settings/Categories';
import { RulesPage } from './ui/pages/Settings/Rules';
import { BackupPage } from './ui/pages/Settings/Backup';
import { PrivacyPage } from './ui/pages/Settings/Privacy';
import { ReviewPage } from './ui/pages/Review';
import { ReconcilePage } from './ui/pages/Reconcile';
import { AiExportPage } from './ui/pages/Settings/AiExport';
import { PlansPage } from './ui/pages/Plans';
import { useUiStore } from './store/uiStore';
import * as settingsRepo from './db/repos/settingsRepo';

/** 用 hash 路由：静态托管不需要任何 404 重写配置。 */
const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Overview /> },
      { path: 'ledger', element: <Ledger /> },
      { path: 'import', element: <ImportPage /> },
      { path: 'reconcile', element: <ReconcilePage /> },
      { path: 'funds', element: <Funds /> },
      { path: 'insight', element: <Insight /> },
      { path: 'trends', element: <Trends /> },
      { path: 'plans', element: <PlansPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'settings/wage', element: <WagePage /> },
      { path: 'settings/income', element: <IncomeSourcesPage /> },
      { path: 'settings/categories', element: <CategoriesPage /> },
      { path: 'settings/rules', element: <RulesPage /> },
      { path: 'settings/backup', element: <BackupPage /> },
      { path: 'settings/ai', element: <AiExportPage /> },
      { path: 'settings/privacy', element: <PrivacyPage /> },
      { path: 'review/:monthKey', element: <ReviewPage /> },
    ],
  },
]);

export default function App(): JSX.Element {
  // 初值来自 uiStore 的 localStorage 同步镜像，首屏不会「先亮后暗」；
  // 下面的异步读取只是以 IndexedDB 为准做一次校正（跨设备/清缓存场景）。
  const themeMode = useUiStore((state) => state.themeMode);
  const setThemeMode = useUiStore((state) => state.setThemeMode);
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');

  useEffect(() => {
    let alive = true;
    settingsRepo.getThemeMode().then((mode) => {
      if (alive && mode !== useUiStore.getState().themeMode) setThemeMode(mode);
    });
    return () => {
      alive = false;
    };
  }, [setThemeMode]);

  const mode = themeMode === 'system' ? (prefersDark ? 'dark' : 'light') : themeMode;
  const theme = useMemo(() => buildTheme(mode), [mode]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', mode === 'dark');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', mode === 'dark' ? '#0f1115' : '#f7f7f5');
  }, [mode]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ErrorBoundary>
        <RouterProvider router={router} />
      </ErrorBoundary>
    </ThemeProvider>
  );
}
