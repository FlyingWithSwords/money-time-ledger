import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useLiveQuery } from 'dexie-react-hooks';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as settingsRepo from '../../../db/repos/settingsRepo';
import { SETTING_KEYS } from '../../../db/settingKeys';
import {
  downloadBlob,
  exportCsv,
  exportEncrypted,
  restoreFromFile,
  setDeviceLabel,
  type MergeReport,
  type RestoreMode,
} from '../../../backup/backup';
import { nowIso } from '../../../domain/date';
import { describeError } from '../../../domain/errors';
import { useUiStore } from '../../../store/uiStore';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SectionCard } from '../../components/SectionCard';

/**
 * 备份与导出。口令**不可找回**（无服务器），必须让用户看见这句话两次。
 * 另给"未加密 CSV"作次级本地逃生通道，并明确提示是明文。
 *
 * 恢复默认是**合并**而不是覆盖：覆盖式恢复在"手机导出→电脑导入"时会把电脑上
 * 已有的账整片冲掉，用户通常事后才发现。所以默认值必须是安全的那个，
 * 危险操作要多一次显式选择 + 二次确认框 + 红字提示。
 */
export function BackupPage(): JSX.Element {
  const navigate = useNavigate();
  const showSnack = useUiStore((state) => state.showSnack);
  const lastBackup = useLiveQuery(() => settingsRepo.getLastBackupAt(), [], null);
  const savedDeviceLabel = useLiveQuery(() => settingsRepo.get<string>(SETTING_KEYS.deviceLabel, ''), [], '');
  const restoreInput = useRef<HTMLInputElement>(null);

  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [restoreTarget, setRestoreTarget] = useState<File | null>(null);
  const [restorePass, setRestorePass] = useState('');
  const [restoreMode, setRestoreMode] = useState<RestoreMode>('merge');
  const [confirmReplaceOpen, setConfirmReplaceOpen] = useState(false);
  const [report, setReport] = useState<MergeReport | null>(null);
  const [busy, setBusy] = useState(false);

  // 编辑中的值优先，未编辑时跟随库里存的值
  const deviceValue = deviceName ?? savedDeviceLabel;

  const saveDeviceLabel = async (): Promise<void> => {
    if (deviceName === null) return;
    try {
      await setDeviceLabel(deviceName);
      showSnack({ message: '设备名已保存', severity: 'success' });
    } catch (error) {
      showSnack({ message: describeError(error), severity: 'error' });
    }
  };

  const doExport = async (): Promise<void> => {
    try {
      setBusy(true);
      if (passphrase.length < 6) throw new Error('口令至少 6 位');
      if (passphrase !== confirmPhrase) throw new Error('两次输入的口令不一致');
      const blob = await exportEncrypted(passphrase);
      const stamp = nowIso().slice(0, 10);
      downloadBlob(blob, `ledger-backup-${stamp}.mtlbk`);
      await settingsRepo.markBackupDone(nowIso());
      showSnack({ message: '加密备份已导出，请自己保存好这个文件', severity: 'success' });
      setExportOpen(false);
      setPassphrase('');
      setConfirmPhrase('');
    } catch (error) {
      showSnack({ message: describeError(error), severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  /** 真正执行恢复。合并与覆盖共用此路径，覆盖要先经过下面的二次确认框。 */
  const doRestore = async (): Promise<void> => {
    if (!restoreTarget) return;
    try {
      setBusy(true);
      const result = await restoreFromFile(restoreTarget, restorePass, { mode: restoreMode });
      await settingsRepo.bumpDataVersion();
      setReport(result);
      setRestoreTarget(null);
      setRestorePass('');
      setRestoreMode('merge');
    } catch (error) {
      showSnack({ message: describeError(error), severity: 'error' });
    } finally {
      setBusy(false);
      setConfirmReplaceOpen(false);
    }
  };

  /** 覆盖式恢复不可撤销：先弹确认框，确认后才进入写库路径。 */
  const startRestore = (): void => {
    if (!restoreTarget || busy) return;
    if (restoreMode === 'replace') {
      setConfirmReplaceOpen(true);
      return;
    }
    void doRestore();
  };

  const closeReplaceConfirm = (): void => {
    if (busy) return;
    setConfirmReplaceOpen(false);
  };

  const doCsv = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await exportCsv();
      downloadBlob(blob, `ledger-${nowIso().slice(0, 10)}.csv`);
      showSnack({ message: 'CSV 已导出（明文，请注意保管）', severity: 'info' });
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Typography variant="h6" sx={{ fontSize: 20 }}>
          备份与导出
        </Typography>
        <Button size="small" onClick={() => navigate('/settings')}>
          返回
        </Button>
      </Box>

      <Alert severity="warning" sx={{ mb: 1.5 }}>
        没有服务器，也没有云端副本。口令一旦忘记，备份文件就打不开，谁也帮不了你 —— 这就是「数据只存本机」的代价。
      </Alert>

      <Stack spacing={1.5}>
        <SectionCard title="本机设备名" subtitle="只写进备份文件，用来分辨哪份备份来自哪台设备" dense>
          <TextField
            label="本机设备名"
            placeholder="例如：我的手机"
            size="small"
            fullWidth
            value={deviceValue}
            onChange={(event) => setDeviceName(event.target.value)}
            onBlur={saveDeviceLabel}
            helperText="多台设备来回导备份时，靠这个名字分辨哪份是哪份。只写进备份文件，不发给任何人。"
          />
        </SectionCard>

        <SectionCard title="加密备份（推荐）" subtitle="AES-256-GCM + PBKDF2 600k，口令错误必然打不开" dense>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            换设备、清浏览器前，先导出一份。上次备份：{lastBackup ? lastBackup.slice(0, 10) : '还没备份过'}
          </Typography>
          <Button variant="contained" onClick={() => setExportOpen(true)} disabled={busy}>
            导出加密备份
          </Button>
        </SectionCard>

        <SectionCard title="恢复备份" subtitle="默认合并，不会删你现有的账" dense>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            多设备用法：手机导出 → 传到你的网盘 → 电脑下载 → 在这里选「合并」。全程不经过任何服务器，网盘只当搬运工。
          </Typography>
          <input
            ref={restoreInput}
            type="file"
            accept=".mtlbk,application/octet-stream"
            hidden
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) setRestoreTarget(selected);
            }}
          />
          <Button variant="outlined" onClick={() => restoreInput.current?.click()} disabled={busy}>
            选择备份文件
          </Button>
        </SectionCard>

        <SectionCard title="导出 CSV（明文）" subtitle="给 Excel 或别的工具用；内容是明文，注意保管" dense>
          <Button variant="outlined" color="warning" onClick={doCsv} disabled={busy}>
            导出明文 CSV
          </Button>
        </SectionCard>
      </Stack>

      <Dialog open={exportOpen} onClose={() => setExportOpen(false)} fullWidth maxWidth="xs">
        <DialogTitle>设置备份口令</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <TextField
              label="口令（至少 6 位）"
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete="new-password"
            />
            <TextField
              label="再输一次"
              type="password"
              value={confirmPhrase}
              onChange={(event) => setConfirmPhrase(event.target.value)}
              autoComplete="new-password"
            />
            <Typography variant="caption" color="text.secondary">
              口令不会被保存在任何地方，也不会发给任何人。忘了就真的找不回。
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setExportOpen(false)}>取消</Button>
          <Button variant="contained" onClick={doExport} disabled={busy}>
            导出
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={restoreTarget !== null}
        onClose={() => {
          setRestoreTarget(null);
          setRestorePass('');
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>恢复备份</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <Typography variant="body2">{restoreTarget?.name}</Typography>
            <TextField
              label="备份口令"
              type="password"
              value={restorePass}
              onChange={(event) => setRestorePass(event.target.value)}
              autoComplete="current-password"
            />
            <ToggleButtonGroup
              exclusive
              fullWidth
              size="small"
              value={restoreMode}
              onChange={(_event, next: RestoreMode | null) => {
                // 允许点已选项时不清空选择：null 表示用户点掉了，保持原模式更安全
                if (next !== null) setRestoreMode(next);
              }}
              orientation="vertical"
            >
              <ToggleButton value="merge" sx={{ justifyContent: 'flex-start', textAlign: 'left', py: 1 }}>
                <Box>
                  <Typography variant="body2" fontWeight={600}>
                    合并（推荐）
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    保留本机现有账目，只把备份里更新的、本机没有的补进来。多设备来回导不会丢账。
                  </Typography>
                </Box>
              </ToggleButton>
              <ToggleButton value="replace" sx={{ justifyContent: 'flex-start', textAlign: 'left', py: 1 }}>
                <Box>
                  <Typography variant="body2" fontWeight={600}>
                    完全覆盖
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    先清空本机所有数据，再写入备份内容。会丢掉本机有、备份里没有的账。
                  </Typography>
                </Box>
              </ToggleButton>
            </ToggleButtonGroup>
            {restoreMode === 'merge' ? (
              <Alert severity="info">
                分类、设置、目标以本机为准，不会被备份覆盖（只有本机缺的才会补上）。
              </Alert>
            ) : (
              <Alert severity="error">
                覆盖不可撤销。建议先点上面的『导出加密备份』存一份再操作。
              </Alert>
            )}
            <Divider />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setRestoreTarget(null);
              setRestorePass('');
            }}
          >
            取消
          </Button>
          <Button
            variant="contained"
            color={restoreMode === 'merge' ? 'primary' : 'warning'}
            onClick={startRestore}
            disabled={busy}
          >
            {restoreMode === 'merge' ? '开始合并' : '确认覆盖'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={report !== null} onClose={() => setReport(null)} fullWidth maxWidth="xs">
        <DialogTitle>恢复完成</DialogTitle>
        <DialogContent>
          {report && (
            <Stack spacing={1.5} sx={{ pt: 1 }}>
              {report.exportedAt && (
                <Typography variant="body2" color="text.secondary">
                  来自「{report.sourceDevice ?? '未命名设备'}」，导出于{' '}
                  {report.exportedAt.slice(0, 16).replace('T', ' ')}
                </Typography>
              )}
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 0.5 }}>
                <Typography variant="body2" color="text.secondary">
                  新增
                </Typography>
                <Typography variant="body2" sx={{ textAlign: 'right' }}>
                  {report.stats.inserted} 条
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  更新
                </Typography>
                <Typography variant="body2" sx={{ textAlign: 'right' }}>
                  {report.stats.updated} 条
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  跳过
                </Typography>
                <Typography variant="body2" sx={{ textAlign: 'right' }}>
                  {report.stats.skipped} 条
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  重复（已存在）
                </Typography>
                <Typography variant="body2" sx={{ textAlign: 'right' }}>
                  {report.stats.duplicate} 条
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  冲突
                </Typography>
                <Typography variant="body2" sx={{ textAlign: 'right' }}>
                  {report.stats.conflict} 条
                </Typography>
              </Box>
              <Typography variant="caption" color="text.secondary">
                设置类：本机没动过的会用备份里的值，你亲手改过的保留本机。设备名和 OCR 资产状态永远不跨设备。
              </Typography>
              {report.stats.conflict > 0 && (
                <Alert severity="warning">
                  有 {report.stats.conflict} 条记录时间戳相同但内容不同，已保留本机版本，没有自动覆盖。涉及{' '}
                  {report.conflictIds.slice(0, 5).join('、')}
                  {report.conflictIds.length > 5 ? ' 等' : ''}，需要你自己核对。
                </Alert>
              )}
              {report.checksumWarning && <Alert severity="error">{report.checksumWarning}</Alert>}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button variant="contained" onClick={() => setReport(null)}>
            知道了
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={confirmReplaceOpen}
        title="确认「完全覆盖」恢复？"
        message={
          <>
            <Typography variant="body2" gutterBottom>
              会先清空本机全部数据（流水、持仓、导入记录、复盘卡、目标等），再写入所选备份的内容。
              本机有、备份里没有的账会永久丢失。
            </Typography>
            <Typography variant="body2" color="error.main" fontWeight={600}>
              此操作不可撤销，也没有云端副本。若还没导出过本机备份，请先取消并导出一份。
            </Typography>
            {restoreTarget?.name && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                即将导入的文件：{restoreTarget.name}
              </Typography>
            )}
          </>
        }
        confirmLabel="确认覆盖"
        destructive
        busy={busy}
        onConfirm={() => {
          void doRestore();
        }}
        onClose={closeReplaceConfirm}
      />
    </>
  );
}
