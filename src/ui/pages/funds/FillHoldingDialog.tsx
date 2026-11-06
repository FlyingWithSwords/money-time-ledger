import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import * as holdingRepo from '../../../db/repos/holdingRepo';
import { describeError } from '../../../domain/errors';
import { formatCents } from '../../../domain/money';
import { useUiStore } from '../../../store/uiStore';
import type { Holding } from '../../../types';

/**
 * 补全「仅市值」持仓（列表页截图导入的记录）。
 *
 * 为什么单独一个对话框而不是复用「添加持仓」：添加是新建/加仓（会叠加成本），
 * 补全是把已有的一条记录从「只有市值」变成「有份额」，语义完全不同。
 *
 * 两项输入的含义：
 * - 份额：必填。没有份额就永远算不出市值和收益。
 * - 成本净值：可选。留空则沿用截图金额当成本（收益仍为 0，但不造假）；
 *   填了真实成本，收益立刻按「现价 − 成本」计算。
 */
export function FillHoldingDialog({
  open,
  holding,
  onClose,
}: {
  open: boolean;
  holding: Holding;
  onClose: () => void;
}): JSX.Element {
  const showSnack = useUiStore((state) => state.showSnack);
  const [shares, setShares] = useState('');
  const [costNav, setCostNav] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 每次打开都清空：上一只基金的份额不能残留到下一只
  useEffect(() => {
    if (!open) return;
    setShares('');
    setCostNav('');
    setError(null);
    setBusy(false);
  }, [open, holding.id]);

  const sharesValue = Number(shares);
  const sharesInvalid = shares.trim() !== '' && (!Number.isFinite(sharesValue) || sharesValue <= 0);
  const costNavValue = costNav.trim() === '' ? null : Number(costNav);
  const costNavInvalid =
    costNav.trim() !== '' && (!Number.isFinite(costNavValue) || (costNavValue ?? 0) <= 0);

  const save = async (): Promise<void> => {
    if (busy) return;
    if (shares.trim() === '' || !Number.isFinite(sharesValue) || sharesValue <= 0) {
      setError('份额要填大于 0 的数字');
      return;
    }
    if (costNavInvalid) {
      setError('成本净值要填大于 0 的数字（不知道就留空）');
      return;
    }
    const totalCost =
      costNavValue !== null ? Math.round(sharesValue * costNavValue * 100) : holding.total_cost_cents;
    setBusy(true);
    try {
      await holdingRepo.updatePosition(holding.id, { shares: sharesValue, total_cost_cents: totalCost });
      showSnack({ message: '已补全份额，收益会按最新净值计算', severity: 'success' });
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>补全持仓</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ pt: 0.5 }}>
          <Typography variant="body2" fontWeight={600}>
            {holding.fund_name}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            截图金额 {formatCents(holding.total_cost_cents)} 已按市值记下。补上份额后，
            市值和收益才会按真实行情计算。
          </Typography>
          <TextField
            size="small"
            label="持有份额 / 克"
            value={shares}
            onChange={(event) => setShares(event.target.value)}
            inputProps={{ inputMode: 'decimal' }}
            error={sharesInvalid || (shares.trim() === '' && error !== null)}
            helperText={sharesInvalid ? '份额需大于 0' : ' '}
            autoFocus
          />
          <TextField
            size="small"
            label="成本净值（可选）"
            value={costNav}
            onChange={(event) => setCostNav(event.target.value)}
            inputProps={{ inputMode: 'decimal' }}
            error={costNavInvalid}
            helperText={
              costNavInvalid ? '成本净值需大于 0' : '不知道就留空，收益会记为 0，之后还能再改'
            }
          />
          <Alert severity="info" sx={{ py: 0.25 }}>
            这只持仓没有基金代码，行情查不到时可以用持仓页的「填净值」手动补一次。
          </Alert>
          {error && (
            <Alert severity="error" sx={{ py: 0.25 }}>
              {error}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit" disabled={busy}>
          取消
        </Button>
        <Button variant="contained" onClick={() => void save()} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
