import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import {
  Box,
  Button,
  Divider,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../../../db/db';
import * as settingsRepo from '../../../db/repos/settingsRepo';
import * as transactionRepo from '../../../db/repos/transactionRepo';
import { describeError } from '../../../domain/errors';
import { detectInvestPrincipal, INVEST_PRINCIPAL_FLAG } from '../../../domain/investPrincipal';
import { formatCents } from '../../../domain/money';
import { resolveHourlyWage, WAGE_BASIS_LABEL } from '../../../domain/timecost';
import { estimateStorageMb } from '../../../pwa/registerSW';
import { useUiStore } from '../../../store/uiStore';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SectionCard } from '../../components/SectionCard';
import { useWageSettings } from '../../hooks/useLedgerData';

const THEME_LABEL: Record<'light' | 'dark' | 'system', string> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
};

export function SettingsPage(): JSX.Element {
  const navigate = useNavigate();
  const themeMode = useUiStore((state) => state.themeMode);
  const setThemeMode = useUiStore((state) => state.setThemeMode);
  const showSnack = useUiStore((state) => state.showSnack);
  const settings = useWageSettings();
  const wage = resolveHourlyWage(settings, null);
  const count = useLiveQuery(() => transactionRepo.countAll(), [], 0) ?? 0;
  const size = useLiveQuery(() => estimateStorageMb(), [], 0) ?? 0;
  const lastBackup = useLiveQuery(() => settingsRepo.getLastBackupAt(), [], null);

  const [clearOpen, setClearOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  /** 扫描出来的历史投资本金（改判前先让用户确认笔数与金额） */
  const [investScan, setInvestScan] = useState<{ ids: string[]; cents: number } | null>(null);
  const [investBusy, setInvestBusy] = useState(false);

  const changeTheme = async (mode: 'light' | 'dark' | 'system'): Promise<void> => {
    try {
      setThemeMode(mode);
      await settingsRepo.setThemeMode(mode);
      showSnack({ message: `已切换为${THEME_LABEL[mode]}模式`, severity: 'success' });
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    }
  };

  /** 写库期间不允许关闭确认框，避免用户以为「取消了但数据其实删了一半」。 */
  const closeClearDialog = (): void => {
    if (clearBusy) return;
    setClearOpen(false);
  };

  /** 清空全部账目：确认后执行，写库期间锁按钮，失败给可读原因，finally 收尾。 */
  const doClearLedger = async (): Promise<void> => {
    if (clearBusy) return;
    setClearBusy(true);
    try {
      await Promise.all([
        db.transactions.clear(),
        db.batches.clear(),
        db.holdings.clear(),
        db.quotes.clear(),
        db.goals.clear(),
        db.reviews.clear(),
      ]);
      await settingsRepo.bumpDataVersion();
      showSnack({ message: '账目已清空', severity: 'info' });
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    } finally {
      setClearBusy(false);
      setClearOpen(false);
    }
  };

  /**
   * 扫描历史记录里的投资本金。
   *
   * 为什么要单独给这个入口：导入时会自动排除，但**已经入过账**的记录不会自己变。
   * 那几笔停在支出侧，趋势页的「整体收益」就会把本金重复扣一遍，看着像巨亏。
   */
  const scanInvestPrincipal = async (): Promise<void> => {
    try {
      const all = await transactionRepo.listAll();
      const hits = all.filter(
        (tx) =>
          !tx.deleted_at &&
          detectInvestPrincipal({ direction: tx.direction, counterparty: tx.counterparty, note: tx.note }).matched,
      );
      if (hits.length === 0) {
        showSnack({ message: '没有找到被记成支出的投资本金', severity: 'info' });
        return;
      }
      setInvestScan({
        ids: hits.map((tx) => tx.id),
        cents: hits.reduce((sum, tx) => sum + tx.amount_cents, 0),
      });
    } catch (error) {
      showSnack({ message: `扫描失败：${describeError(error)}`, severity: 'error' });
    }
  };

  /** 改判：只改方向与标记，金额不动；写库期间锁按钮，失败给可读原因。 */
  const doMarkInvestPrincipal = async (): Promise<void> => {
    if (!investScan || investBusy) return;
    setInvestBusy(true);
    try {
      const changed = await transactionRepo.markInvestPrincipal(investScan.ids, INVEST_PRINCIPAL_FLAG);
      await settingsRepo.bumpDataVersion();
      showSnack({
        message: `已把 ${changed} 笔改成「不计收支」，支出与整体收益都会跟着修正`,
        severity: 'success',
      });
      setInvestScan(null);
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    } finally {
      setInvestBusy(false);
    }
  };

  return (
    <>
      <Typography variant="h6" sx={{ fontSize: 20, mb: 1.5 }}>
        设置与分类
      </Typography>

      <SectionCard title="时薪口径" dense>
        <Typography variant="body2">
          {wage.cents !== null
            ? `${formatCents(wage.cents)} / 小时（${WAGE_BASIS_LABEL[wage.basis ?? 'manual']}）`
            : '还没设置，时间成本不会显示'}
        </Typography>
        <Button size="small" sx={{ mt: 0.5 }} onClick={() => navigate('/settings/wage')}>
          修改口径与月工时
        </Button>
      </SectionCard>

      <Box sx={{ mt: 1.5 }}>
        <SectionCard title="深色模式" dense>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={themeMode}
            onChange={(_, value) => value && void changeTheme(value)}
          >
            <ToggleButton value="light">浅色</ToggleButton>
            <ToggleButton value="dark">深色</ToggleButton>
            <ToggleButton value="system">跟随系统</ToggleButton>
          </ToggleButtonGroup>
        </SectionCard>
      </Box>

      <Box sx={{ mt: 1.5 }}>
        <SectionCard dense>
          <List disablePadding>
            <Item label="一级/二级分类" hint="改名、加二级、合并" onClick={() => navigate('/settings/categories')} />
            <Divider />
            <Item label="关键词自动归类规则" hint="可见、可编辑、可停用" onClick={() => navigate('/settings/rules')} />
            <Divider />
            <Item
              label="工资与补贴来源"
              hint="哪些转账记录算收入（银行卡转微信/支付宝常被记成转账）"
              onClick={() => navigate('/settings/income')}
            />
            <Divider />
            <Item label="储蓄目标" hint="换手机 3000 元 / 12 月底" onClick={() => navigate('/settings/goals')} />
            <Divider />
            <Item label="备份与导出" hint="加密备份 / 未加密 CSV" onClick={() => navigate('/settings/backup')} />
            <Divider />
            <Item label="AI 分析数据包" hint="脱敏后自行交给任何 AI，全程不上传" onClick={() => navigate('/settings/ai')} />
            <Divider />
            <Item label="隐私说明" hint="数据存在哪、什么会联网" onClick={() => navigate('/settings/privacy')} />
          </List>
        </SectionCard>
      </Box>

      <Box sx={{ mt: 1.5 }}>
        <SectionCard title="投资本金" dense>
          <Typography variant="body2">
            买基金、理财、黄金的钱不是消费，是钱从现金变成持仓。导入账单时会自动按「不计收支」处理。
          </Typography>
          <Button size="small" sx={{ mt: 0.5 }} onClick={() => void scanInvestPrincipal()} disabled={investBusy}>
            改正已经入账的历史记录
          </Button>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            只改方向、不改金额；改完可在流水里逐笔看到并改回来。
          </Typography>
        </SectionCard>
      </Box>

      <Box sx={{ mt: 1.5 }}>
        <SectionCard title="本机存储" dense>
          <Stack spacing={0.5}>
            <Row label="流水笔数" value={`${count} 笔`} />
            <Row label="占用体积" value={`约 ${size} MB`} />
            <Row label="最近一次备份" value={lastBackup ? lastBackup.slice(0, 10) : '还没备份过'} />
            {count > 50000 && (
              <Typography variant="caption" color="warning.main">
                超过 5 万笔，建议导出备份后归档旧年份
              </Typography>
            )}
            {!lastBackup && (
              <Typography variant="caption" color="text.secondary">
                建议每月导出一次加密备份：清浏览器数据会让本地账目消失
              </Typography>
            )}
          </Stack>
        </SectionCard>
      </Box>

      <Box sx={{ mt: 1.5 }}>
        <SectionCard dense>
          <Button color="error" onClick={() => setClearOpen(true)} disabled={clearBusy}>
            清空账目数据
          </Button>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            无服务器、无云备份。清空后数据不可恢复。
          </Typography>
        </SectionCard>
      </Box>

      <ConfirmDialog
        open={investScan !== null}
        title="改成不计收支？"
        message={
          <>
            <Typography variant="body2" gutterBottom>
              找到 {investScan?.ids.length ?? 0} 笔疑似投资本金，合计 {formatCents(investScan?.cents ?? 0)}。
            </Typography>
            <Typography variant="body2" gutterBottom>
              会把它们从「支出」改成「不计收支」，支出合计与整体收益随之修正；金额、日期、分类都不动。
            </Typography>
            <Typography variant="caption" color="text.secondary">
              判断依据是商户名/商品名里的基金、理财、蚂蚁财富、积存金等特征词。若其中有你自己记的真实消费被误判，
              改完在流水里点开那一笔改回「支出」即可。
            </Typography>
          </>
        }
        confirmLabel="确认改判"
        busy={investBusy}
        onConfirm={() => {
          void doMarkInvestPrincipal();
        }}
        onClose={() => {
          if (!investBusy) setInvestScan(null);
        }}
      />

      <ConfirmDialog
        open={clearOpen}
        title="清空全部账目？"
        message={
          <>
            <Typography variant="body2" gutterBottom>
              会永久删除本机所有流水、持仓、导入记录与复盘卡；分类、规则与设置会保留。
            </Typography>
            <Typography variant="body2" color="error.main" fontWeight={600}>
              此操作不可撤销，也没有云端副本。建议先到「备份与导出」导出一份加密备份。
            </Typography>
          </>
        }
        confirmLabel="确认清空"
        destructive
        busy={clearBusy}
        onConfirm={() => {
          void doClearLedger();
        }}
        onClose={closeClearDialog}
      />
    </>
  );
}

function Item({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }): JSX.Element {
  return (
    <ListItemButton onClick={onClick}>
      <ListItemText primary={label} secondary={hint} primaryTypographyProps={{ fontSize: 14 }} secondaryTypographyProps={{ fontSize: 12 }} />
      <ChevronRightIcon fontSize="small" />
    </ListItemButton>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2">{value}</Typography>
    </Box>
  );
}
