import { Box, Button, Chip, Divider, Paper, Stack, Typography } from '@mui/material';
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as dismissalRepo from '../../db/repos/dismissalRepo';
import * as transactionRepo from '../../db/repos/transactionRepo';
import { findCrossSourcePairs, type CandidatePair } from '../../domain/crossMatch';
import { formatCents } from '../../domain/money';
import { provenanceShortLabel } from '../../domain/provenance';
import { useUiStore } from '../../store/uiStore';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import type { Transaction } from '../../types';

/**
 * 跨平台对账页。
 *
 * 交互是用户亲自选定的「逐条确认」：自动配对不可信（两杯同价柠檬水是两笔
 * 真实消费），所以引擎只负责给候选与判定依据，两条路（确认/否定）都由用户
 * 逐条点。确认与否定都会让该组从列表消失——确认靠软删（数据驱动），
 * 否定靠 pair_dismissals 过滤（同样是数据驱动）。
 * 页面本地状态只管交互本身：待确认的组、写操作闸门，不复制任何业务数据。
 */
export function ReconcilePage(): JSX.Element {
  const navigate = useNavigate();
  const showSnack = useUiStore((state) => state.showSnack);
  const txs = useLiveQuery(() => transactionRepo.listAll(), [], []);
  const dismissedKeys = useLiveQuery(() => dismissalRepo.listDismissedKeys(), [], []);
  /** 待确认合并的组：非 null 即打开二次确认框。 */
  const [pendingPair, setPendingPair] = useState<CandidatePair | null>(null);
  /** 合并/否定都是异步写，共用一个闸门防连点重复提交。 */
  const [busy, setBusy] = useState(false);

  const pairs = useMemo(
    () => findCrossSourcePairs(txs ?? [], new Set(dismissedKeys ?? [])),
    [txs, dismissedKeys],
  );
  const byId = useMemo(() => {
    const map = new Map<string, Transaction>();
    for (const tx of txs ?? []) map.set(tx.id, tx);
    return map;
  }, [txs]);

  /** 引擎约定 a 是较早那笔 → keep 用 a：金额相同保留谁不影响数字，但来源合并顺序更自然。 */
  const performConfirm = async (pair: CandidatePair): Promise<void> => {
    try {
      await transactionRepo.confirmPairMatch(pair.a, pair.b);
      showSnack({ message: '已合并，另一笔进了已删除区', severity: 'success' });
    } catch {
      showSnack({ message: '合并失败，请重试', severity: 'error' });
    }
  };

  /** 确认框点「确认合并」后才走原有合并逻辑；finally 里统一收尾 busy 与弹窗。 */
  const handleConfirmMerge = async (): Promise<void> => {
    const pair = pendingPair;
    if (!pair) return;
    setBusy(true);
    try {
      await performConfirm(pair);
    } finally {
      setBusy(false);
      setPendingPair(null);
    }
  };

  const handleDismiss = async (pair: CandidatePair): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await dismissalRepo.dismissPair(pair.a, pair.b);
      showSnack({ message: '已记住，不会再提示这一对', severity: 'info' });
    } catch {
      showSnack({ message: '保存判断失败，请重试', severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Typography variant="h6" sx={{ fontSize: 20, mb: 0.5 }}>
        对账
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        发现 {pairs.length} 组疑似同一笔 —— 自动配对可能误判（两杯同样价格的柠檬水是两笔真实消费），所以每一条都由你确认
      </Typography>

      {pairs.length === 0 ? (
        <EmptyState
          compact
          icon="🧾"
          title="没有发现疑似重复的跨平台记录"
          description="导入微信、支付宝等账单后，这里会列出金额与日期吻合、但来自不同平台的疑似重复交易，由你逐条裁决。"
          primary={{ label: '去导入账单', onClick: () => navigate('/import') }}
        />
      ) : (
        <Stack spacing={1.5}>
          {pairs.map((pair) => {
            const earlier = byId.get(pair.a);
            const later = byId.get(pair.b);
            // liveQuery 刷新的间隙里可能有一边刚好被删（比如并机操作），跳过而不是渲染半张卡
            if (!earlier || !later) return null;
            return (
              <Paper key={`${pair.a}|${pair.b}`} variant="outlined" sx={{ p: 1.5, borderRadius: 3 }}>
                <Stack divider={<Divider flexItem />} spacing={0.75}>
                  <PairTxRow tx={earlier} />
                  <PairTxRow tx={later} />
                </Stack>

                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1.25 }}>
                  {pair.reasons.map((reason) => (
                    <Chip
                      key={reason}
                      label={reason}
                      size="small"
                      variant="outlined"
                      color="primary"
                      sx={{ height: 22, fontSize: 11, '& .MuiChip-label': { px: 0.75 } }}
                    />
                  ))}
                </Box>

                <Box sx={{ display: 'flex', gap: 1, mt: 1.25, flexWrap: 'wrap' }}>
                  <Button variant="contained" size="small" disabled={busy} onClick={() => setPendingPair(pair)}>
                    是同一笔，合并来源
                  </Button>
                  <Button variant="outlined" size="small" disabled={busy} onClick={() => void handleDismiss(pair)}>
                    不是，记住这个判断
                  </Button>
                </Box>
              </Paper>
            );
          })}
        </Stack>
      )}

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2, textAlign: 'center' }}>
        「合并」不会删掉任何数据——被合并那笔进了流水的「已删除」区，随时可恢复。
      </Typography>

      <ConfirmDialog
        open={pendingPair !== null}
        title="确认这两笔是同一笔？"
        message="确认后会保留较早那笔并合并来源，另一笔会被标记为重复并隐藏到流水的「已删除」区，随时可恢复。如果其实是两笔真实消费，请点取消。"
        confirmLabel="确认合并"
        busy={busy}
        onConfirm={() => void handleConfirmMerge()}
        onClose={() => {
          if (!busy) setPendingPair(null);
        }}
      />
    </>
  );
}

/** 候选卡里的一行交易：来源 Chip + 对手方 + 日期时间 + 金额（方向配色与流水页一致）。 */
function PairTxRow({ tx }: { tx: Transaction }): JSX.Element {
  const amountColor =
    tx.direction === 'income' ? 'success.main' : tx.direction === 'refund' ? 'text.secondary' : 'text.primary';
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      <Chip
        label={provenanceShortLabel(tx)}
        size="small"
        variant="outlined"
        sx={{ height: 20, fontSize: 11, '& .MuiChip-label': { px: 0.75, lineHeight: '20px' } }}
      />
      <Typography
        variant="body2"
        sx={{ fontWeight: 600, flex: 1, minWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {tx.counterparty || tx.category_l2}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
        {tx.occurred_date} {tx.occurred_at.slice(11, 16)}
      </Typography>
      <Typography variant="body2" className="tabular" sx={{ fontWeight: 600, color: amountColor, whiteSpace: 'nowrap' }}>
        {formatCents(tx.amount_cents, { symbol: false })}
      </Typography>
    </Box>
  );
}
