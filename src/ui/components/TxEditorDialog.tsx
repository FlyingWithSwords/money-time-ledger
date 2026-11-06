import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  MenuItem,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useLiveQuery } from 'dexie-react-hooks';
import { nanoid } from 'nanoid';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SETTING_KEYS } from '../../db/settingKeys';
import * as ruleRepo from '../../db/repos/ruleRepo';
import * as settingsRepo from '../../db/repos/settingsRepo';
import * as transactionRepo from '../../db/repos/transactionRepo';
import { learn, normalizeText } from '../../domain/classify';
import { buildLocalIso, deriveDateFields, nowIso, todayDateString } from '../../domain/date';
import { describeError } from '../../domain/errors';
import { INVEST_PRINCIPAL_FLAG } from '../../domain/investPrincipal';
import { centsToYuan, formatCents, yuanToCents } from '../../domain/money';
import { CHANNEL_LABEL, type Direction, type PaymentChannel, type Transaction } from '../../types';
import { useUiStore } from '../../store/uiStore';
import { ConfirmDialog } from './ConfirmDialog';
import { useAccounts, useCategories } from '../hooks/useLedgerData';

const DIRECTIONS: Array<{ value: Direction; label: string }> = [
  { value: 'expense', label: '支出' },
  { value: 'income', label: '收入' },
  { value: 'refund', label: '退款' },
  { value: 'transfer', label: '转账' },
];

const CHANNELS: PaymentChannel[] = ['wechat', 'alipay', 'huabei', 'card', 'cash', 'unknown'];

/**
 * 手动快速记账 / 编辑。目标：金额 → 分类 → 保存 ≤3 次点击（PRD §10）。
 * 记住上次分类；改过分类后同商户下次自动套用（学习规则）。
 */
export function TxEditorDialog(): JSX.Element {
  const quickAddOpen = useUiStore((state) => state.quickAddOpen);
  const editingId = useUiStore((state) => state.editingTxId);
  const setQuickAddOpen = useUiStore((state) => state.setQuickAddOpen);
  const setEditingTxId = useUiStore((state) => state.setEditingTxId);
  const showSnack = useUiStore((state) => state.showSnack);

  const open = quickAddOpen || editingId !== null;
  const categories = useCategories();
  const accounts = useAccounts();
  const lastCategory = useLiveQuery(() => settingsRepo.get<string>(SETTING_KEYS.lastCategory, ''), [], '');
  const editing = useLiveQuery(
    () => (editingId ? transactionRepo.getById(editingId) : Promise.resolve(undefined)),
    [editingId],
  );

  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<Direction>('expense');
  const [date, setDate] = useState(todayDateString());
  const [time, setTime] = useState('12:00');
  const [l1, setL1] = useState('');
  const [l2, setL2] = useState('');
  const [accountId, setAccountId] = useState('acc_cash');
  const [channel, setChannel] = useState<PaymentChannel>('huabei');
  const [counterparty, setCounterparty] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  /** 删除是破坏性操作：先走二次确认框，写库期间锁住按钮。 */
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  /** Snackbar 的「撤销」只应生效一次，防止连点把同一笔恢复两遍。 */
  const restoringRef = useRef(false);

  const scope: 'expense' | 'income' = direction === 'income' ? 'income' : 'expense';
  const scoped = useMemo(() => categories.filter((item) => item.direction_scope === scope), [categories, scope]);
  const l1Options = useMemo(() => {
    const map = new Map<string, { id: string; name: string; icon: string }>();
    for (const item of scoped) {
      if (!map.has(item.l1_id)) map.set(item.l1_id, { id: item.l1_id, name: item.l1_name, icon: item.icon });
    }
    return [...map.values()];
  }, [scoped]);
  const l2Options = useMemo(() => scoped.filter((item) => item.l1_id === l1), [scoped, l1]);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setAmount(centsToYuan(editing.amount_cents));
      setDirection(editing.direction);
      setDate(editing.occurred_date);
      setTime(editing.occurred_at.slice(11, 16));
      setL1(editing.category_l1);
      setL2(editing.category_l2);
      setAccountId(editing.account_id);
      setChannel((editing.payment_channel as PaymentChannel) ?? 'unknown');
      setCounterparty(editing.counterparty ?? '');
      setNote(editing.note ?? '');
      return;
    }
    const now = new Date();
    setAmount('');
    setDirection('expense');
    setDate(todayDateString());
    setTime(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
    const remembered = String(lastCategory ?? '');
    if (remembered.includes('.')) {
      const [rl1, rl2] = remembered.split('.');
      setL1(rl1);
      setL2(rl2);
    } else {
      setL1('');
      setL2('');
    }
    setAccountId('acc_cash');
    setChannel('huabei');
    setCounterparty('');
    setNote('');
  }, [open, editing, lastCategory]);

  const close = (): void => {
    setQuickAddOpen(false);
    setEditingTxId(null);
  };

  const handleDirection = (next: Direction): void => {
    setDirection(next);
    const nextScope = next === 'income' ? 'income' : 'expense';
    const stillValid = categories.some(
      (item) => item.direction_scope === nextScope && item.l1_id === l1 && item.l2_id === l2,
    );
    if (!stillValid) {
      setL1('');
      setL2('');
    }
  };

  const handleSave = async (): Promise<void> => {
    if (busy) return;
    try {
      setBusy(true);
      const cents = yuanToCents(amount);
      if (cents <= 0) throw new Error('金额要大于 0');
      if (!l1 || !l2) throw new Error('请选择分类（二级必须选）');
      const iso = buildLocalIso(date, time);
      const fields = deriveDateFields(iso);
      const stamp = nowIso();

      /**
       * 投资本金的标记只在「不计收支」时成立。
       * 用户把方向改回支出（说明这笔钱其实该算消费），标记必须一起摘掉，
       * 否则流水里会挂着一个「投资本金」却算在支出里，自相矛盾。
       */
      const keepFlags = (editing?.flags ?? []).filter(
        (flag) => !(flag === INVEST_PRINCIPAL_FLAG && direction !== 'transfer'),
      );

      const payload: Transaction = {
        id: editing?.id ?? nanoid(12),
        external_id: editing?.external_id ?? `m${nanoid(10)}`,
        dedupe_key: editing?.dedupe_key ?? `m${nanoid(12)}`,
        source: editing?.source ?? 'manual',
        direction,
        amount_cents: cents,
        occurred_at: iso,
        occurred_date: fields.occurred_date,
        month_key: fields.month_key,
        category_l1: l1,
        category_l2: l2,
        account_id: accountId,
        payment_channel: channel,
        counterparty: counterparty.trim() || undefined,
        note: note.trim() || undefined,
        flags: keepFlags,
        manual_edited: true,
        category_locked: true,
        refund_of_id: editing?.refund_of_id,
        dedupe_status: editing?.dedupe_status ?? 'clean',
        duplicate_of: editing?.duplicate_of,
        import_batch_id: editing?.import_batch_id,
        imported_at: editing?.imported_at ?? stamp,
        created_at: editing?.created_at ?? stamp,
        updated_at: stamp,
        deleted_at: editing?.deleted_at,
      };

      if (editing) await transactionRepo.updateTx(editing.id, payload);
      else await transactionRepo.add(payload);

      // 学习规则：同一个商户下次直接套用
      const merchant = normalizeText(payload.counterparty ?? '');
      if (merchant) {
        const existing = await ruleRepo.findByMerchantPattern(merchant);
        await ruleRepo.saveLearned(learn({ counterparty: payload.counterparty, direction }, { l1, l2 }, existing));
      }

      await settingsRepo.set(SETTING_KEYS.lastCategory, `${l1}.${l2}`);
      await settingsRepo.bumpDataVersion();
      showSnack({ message: `${editing ? '已更新' : '已记一笔'} ${formatCents(cents)}`, severity: 'success' });
      close();
    } catch (error) {
      showSnack({ message: describeError(error), severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  /** 撤销删除：复用 transactionRepo.restore（软删的逆操作），失败也给出可读原因。 */
  const restoreDeleted = async (txId: string): Promise<void> => {
    if (restoringRef.current) return;
    restoringRef.current = true;
    try {
      await transactionRepo.restore(txId);
      await settingsRepo.bumpDataVersion();
      showSnack({ message: '已恢复这一笔', severity: 'success' });
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    } finally {
      restoringRef.current = false;
    }
  };

  const closeDeleteDialog = (): void => {
    if (deleteBusy) return;
    setDeleteOpen(false);
  };

  /** 确认后才写库；成功后 Snackbar 带「撤销」，回调真正恢复这一笔。 */
  const handleConfirmDelete = async (): Promise<void> => {
    const txId = editing?.id;
    if (!txId || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await transactionRepo.softDelete(txId);
      await settingsRepo.bumpDataVersion();
      showSnack({
        message: '已删除',
        severity: 'success',
        actionLabel: '撤销',
        onAction: () => {
          void restoreDeleted(txId);
        },
      });
      close();
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    } finally {
      setDeleteBusy(false);
      setDeleteOpen(false);
    }
  };

  return (
    <>
      <Dialog open={open} onClose={close} fullWidth maxWidth="xs" keepMounted>
        <DialogTitle component="div" sx={{ pb: 1 }}>
          <Typography variant="subtitle1" fontWeight={700}>
            {editing ? '编辑这一笔' : '记一笔'}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            数据只存这台设备，不会上传
          </Typography>
        </DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <TextField
              label="金额（元）"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputProps={{ inputMode: 'decimal', placeholder: '0.00', autoFocus: !editing }}
              fullWidth
              helperText={amount ? formatCents(safeCents(amount)) : ' '}
            />

            <ToggleButtonGroup
              value={direction}
              exclusive
              onChange={(_, value) => value && handleDirection(value as Direction)}
              size="small"
              fullWidth
            >
              {DIRECTIONS.map((item) => (
                <ToggleButton key={item.value} value={item.value} sx={{ py: 0.75 }}>
                  {item.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>

            <Stack direction="row" spacing={1}>
              <TextField
                label="日期"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                fullWidth
                InputLabelProps={{ shrink: true }}
              />
              <TextField
                label="时间"
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
                fullWidth
                InputLabelProps={{ shrink: true }}
              />
            </Stack>

            <Stack direction="row" spacing={1}>
              <TextField
                select
                label="一级分类"
                value={l1}
                onChange={(event) => {
                  setL1(event.target.value);
                  const first = scoped.find((item) => item.l1_id === event.target.value);
                  setL2(first ? first.l2_id : '');
                }}
                fullWidth
                size="small"
              >
                {l1Options.map((item) => (
                  <MenuItem key={item.id} value={item.id}>
                    {item.icon} {item.name}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                label="二级分类"
                value={l2}
                onChange={(event) => setL2(event.target.value)}
                fullWidth
                size="small"
                disabled={!l1}
              >
                {l2Options.map((item) => (
                  <MenuItem key={item.id} value={item.l2_id}>
                    {item.l2_name}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>

            <Stack direction="row" spacing={1}>
              <TextField
                select
                label="账户"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                fullWidth
                size="small"
              >
                {accounts.map((account) => (
                  <MenuItem key={account.id} value={account.id}>
                    {account.name}
                    {account.is_liability ? '（负债）' : ''}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                label="渠道"
                value={channel}
                onChange={(event) => setChannel(event.target.value as PaymentChannel)}
                fullWidth
                size="small"
              >
                {CHANNELS.map((item) => (
                  <MenuItem key={item} value={item}>
                    {CHANNEL_LABEL[item]}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>

            <TextField
              label="交易对方（可选）"
              value={counterparty}
              onChange={(event) => setCounterparty(event.target.value)}
              size="small"
              fullWidth
              helperText="填了之后，同一商户下次会自动归到这个分类"
            />
            <TextField
              label="备注（可选）"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              size="small"
              fullWidth
              helperText="备注只用于展示，不参与任何计算"
            />
          </Stack>
        </DialogContent>
        <Divider />
        <DialogActions sx={{ px: 2, py: 1.5 }}>
          {editing && (
            <Button
              color="error"
              onClick={() => setDeleteOpen(true)}
              disabled={busy || deleteBusy}
              sx={{ mr: 'auto' }}
            >
              删除
            </Button>
          )}
          <Button onClick={close} disabled={deleteBusy}>
            取消
          </Button>
          <Button variant="contained" onClick={handleSave} disabled={busy || deleteBusy}>
            保存
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={deleteOpen}
        title="删除这一笔？"
        message={
          <>
            <Typography variant="body2" gutterBottom>
              这笔流水会从统计与流水列表里消失，但记录本身不会真正抹掉。
            </Typography>
            <Typography variant="body2" color="text.secondary">
              删除后可以点提示里的「撤销」恢复，也可以之后到流水页底部「已删除」里逐笔恢复。
            </Typography>
          </>
        }
        confirmLabel="确认删除"
        destructive
        busy={deleteBusy}
        onConfirm={() => {
          void handleConfirmDelete();
        }}
        onClose={closeDeleteDialog}
      />
    </>
  );
}

function safeCents(amount: string): number {
  try {
    return yuanToCents(amount);
  } catch {
    return 0;
  }
}
