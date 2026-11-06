import DashboardIcon from '@mui/icons-material/Dashboard';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import InsightsIcon from '@mui/icons-material/Insights';
import TimelineIcon from '@mui/icons-material/Timeline';
import SettingsIcon from '@mui/icons-material/Settings';
import type { ReactElement } from 'react';

export interface NavItem {
  to: string;
  label: string;
  short: string;
  icon: ReactElement;
}

/** 手机底部 6 Tab（P1–P6）；设置从总览右上角或桌面左侧进入。 */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: '总览', short: '总览', icon: <DashboardIcon /> },
  { to: '/ledger', label: '流水', short: '流水', icon: <ReceiptLongIcon /> },
  { to: '/import', label: '导入', short: '导入', icon: <UploadFileIcon /> },
  { to: '/funds', label: '基金', short: '基金', icon: <ShowChartIcon /> },
  { to: '/insight', label: '洞察', short: '洞察', icon: <InsightsIcon /> },
  { to: '/trends', label: '趋势', short: '趋势', icon: <TimelineIcon /> },
];

export const SETTINGS_ITEM: NavItem = { to: '/settings', label: '设置与分类', short: '设置', icon: <SettingsIcon /> };
