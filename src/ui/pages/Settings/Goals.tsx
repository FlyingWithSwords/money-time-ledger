import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useLiveQuery } from 'dexie-react-hooks';
import { nanoid } from 'nanoid';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as goalRepo from '../../../db/repos/goalRepo';
import * as transactionRepo from '../../../db/repos/transactionRepo';
import { totalsOf } from '../../../domain/aggregate';
import { daysInMonth, shiftMonth, todayDateString } from '../../../domain/date';
import { describeError } from '../../../domain/errors';
import { formatCents, yuanToCents } from '../../../domain/money';
import { useUiStore } from '../../../store/uiStore';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SectionCard } from '../../../ui/components/SectionCard';
import type { Goal } from '../../../types';

/** M4 储蓄目标与进度：进度 = 累计结余增量 ÷ 目标；落后时给一个可执行的最小动作。 */
export function GoalsPage(): JSX.Element {
  const navigate = useNavigate();
  const showSnack = useUiStore((state) => state.showSnack);
  const goals = useLiveQuery(() => goalRepo.list(), [], []);
  const allTxs = useLiveQuery(() => transactionRepo.listAll(), [], []);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [deadline, setDeadline] = useState(() => {
    const month = shiftMonth(todayDateString().slice(0, 7), 3);
    return `${month}-${daysInMonth(month)}`;
  });
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Goal | null>(null);

  const saved = totalsOf(allTxs).balance_cents;

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      if (!name.trim()) throw new Error('填个目标名字，例如「换手机」');
      const cents = yuanToCents(target);
      if (cents <= 0) throw new Error('目标金额要大于 0');
      await goalRepo.upsert({
        id: nanoid(12),
        name: name.trim(),
        target_cents: cents,
        deadline,
        status: 'active',
        created_at: new Date().toISOString(),
      });
      setOpen(false);
      setName('');
      setTarget('');
      showSnack({ message: '目标已保存', severity: 'success' });
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const markAchieved = async (goalId: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await goalRepo.markAchieved(goalId);
      showSnack({ message: '已标记达成', severity: 'success' });
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const closeDeleteDialog = (): void => {
    if (busy) return;
    setDeleteTarget(null);
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget || busy) return;
    setBusy(true);
    try {
      await goalRepo.remove(deleteTarget.id);
      showSnack({ message: '目标已删除', severity: 'success' });
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    } finally {
      setBusy(false);
      setDeleteTarget(null);
    }
  };

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Typography variant="h6" sx={{ fontSize: 20 }}>
          储蓄目标
        </Typography>
        <Button size="small" onClick={() => navigate('/settings')}>
          返回
        </Button>
      </Box>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        进度按「累计结余」算（收入 − 支出净额，全部月份累加）。不做打卡、不做惩罚。
      </Typography>

      <Stack spacing={1.5}>
        {(goals ?? []).length === 0 ? (
          <SectionCard dense>
            <Typography variant="body2" color="text.secondary">
              还没有目标。设一个「换手机 3000 元 / 12 月底」，进度条会自动跟着结余走。
            </Typography>
          </SectionCard>
        ) : (
          (goals ?? []).map((goal) => {
            const percent = goal.target_cents > 0 ? Math.min(1, Math.max(0, saved / goal.target_cents)) : 0;
            const behind = Math.max(0, goal.target_cents - saved);
            return (
              <SectionCard key={goal.id} title={goal.name} subtitle={`${goal.deadline} 到期`} dense>
                <LinearProgress
                  variant="determinate"
                  value={percent * 100}
                  sx={{ height: 8, borderRadius: 4, mb: 1 }}
                  color={percent >= 1 ? 'success' : 'primary'}
                />
                <Typography variant="body2">
                  {formatCents(saved)} / {formatCents(goal.target_cents)}（{Math.round(percent * 100)}%）
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {behind === 0
                    ? '已达成，可以庆祝一下'
                    : `还差 ${formatCents(behind)}。具体一点：本周少 2 次外卖 ≈ 追平 80 元`}
                </Typography>
                <Box sx={{ mt: 1, display: 'flex', gap: 1 }}>
                  <Button size="small" disabled={busy} onClick={() => void markAchieved(goal.id)}>
                    标记达成
                  </Button>
                  <Button size="small" color="error" disabled={busy} onClick={() => setDeleteTarget(goal)}>
                    删除
                  </Button>
                </Box>
              </SectionCard>
            );
          })
        )}
      </Stack>

      <Box sx={{ mt: 1.5 }}>
        <Button variant="contained" disabled={busy} onClick={() => setOpen(true)}>
          新增目标
        </Button>
      </Box>

      <Dialog
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>新增储蓄目标</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <TextField label="目标名字" value={name} onChange={(e) => setName(e.target.value)} />
            <TextField
              label="目标金额（元）"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              inputProps={{ inputMode: 'decimal' }}
            />
            <TextField
              label="截止日期"
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              InputLabelProps={{ shrink: true }}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button variant="contained" disabled={busy} onClick={save}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除这个储蓄目标？"
        message={
          <>
            <Typography variant="body2" gutterBottom>
              「{deleteTarget?.name ?? ''}」及其进度跟踪会被移除，已记过的流水不受影响。
            </Typography>
            <Typography variant="body2" color="error.main" fontWeight={600}>
              此操作不可撤销，删除后无法恢复，需要重新新增目标。
            </Typography>
          </>
        }
        confirmLabel="确认删除"
        destructive
        busy={busy}
        onConfirm={() => {
          void confirmDelete();
        }}
        onClose={closeDeleteDialog}
      />
    </>
  );
}
