import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  LinearProgress,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useLiveQuery } from 'dexie-react-hooks';
import { nanoid } from 'nanoid';
import { useMemo, useRef, useState } from 'react';
import * as planRepo from '../../db/repos/planRepo';
import * as settingsRepo from '../../db/repos/settingsRepo';
import * as transactionRepo from '../../db/repos/transactionRepo';
import { describeError } from '../../domain/errors';
import { asCents, formatCents, yuanToCents } from '../../domain/money';
import { groupEntriesByPlan, planProgress, progressSummary } from '../../domain/planProgress';
import { useUiStore } from '../../store/uiStore';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { SectionCard } from '../components/SectionCard';
import { useDragSource, useDropTarget } from '../dnd/useDragSource';
import { PLAN_KIND_LABEL, type Plan, type PlanKind, type Transaction } from '../../types';

/**
 * 消费计划备忘录。
 *
 * 解决的是「攒钱」这件事在记账工具里长期缺位：预算只管每月上限，
 * 储蓄目标只有一个总数，两者都回答不了「我想买台主机，攒够了没、买了多少、最后省下多少」。
 *
 * 设计上**攒钱与消费是两条独立计划**（用户明确选择）：
 * 「攒钱买主机」只累计收入，「主机采购」只累计支出。合成一个双向账本看着聪明，
 * 实际上会把「攒的钱转去买别的了」和「超支了」混成同一个数字，谁也说不清。
 */
export function PlansPage(): JSX.Element {
  const showSnack = useUiStore((state) => state.showSnack);
  const plans = useLiveQuery(() => planRepo.list(), [], []) ?? [];
  const entries = useLiveQuery(() => planRepo.allEntries(), [], []) ?? [];
  const txs = useLiveQuery(() => transactionRepo.listAll(), [], []) ?? [];

  const txById = useMemo(() => new Map(txs.map((tx) => [tx.id, tx])), [txs]);
  const linkedByPlan = useMemo(() => groupEntriesByPlan(entries, txById), [entries, txById]);

  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [kind, setKind] = useState<PlanKind>('save');
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Plan | null>(null);
  /** 正在给哪条计划挑流水 */
  const [pickingFor, setPickingFor] = useState<Plan | null>(null);

  const activePlans = plans.filter((plan) => plan.status === 'active');
  const donePlans = plans.filter((plan) => plan.status === 'done');

  const createPlan = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      if (!title.trim()) throw new Error('给它起个名字，例如「台式主机」');
      const cents = yuanToCents(target);
      if (cents <= 0) throw new Error('计划金额要大于 0');
      await planRepo.create({ id: nanoid(12), title: title.trim(), kind, target_cents: cents });
      await settingsRepo.bumpDataVersion();
      setCreateOpen(false);
      setTitle('');
      setTarget('');
      showSnack({ message: '计划已建好，把流水拖进卡片就能开始累计', severity: 'success' });
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const addTx = async (plan: Plan, txIds: string[]): Promise<void> => {
    const items = txIds.map((id) => txById.get(id)).filter((tx): tx is Transaction => !!tx);
    const compatible = plan.kind === 'save' ? items.filter((tx) => tx.direction === 'income') : items.filter((tx) => tx.direction === 'expense' || tx.direction === 'refund');
    if (compatible.length === 0) {
      showSnack({
        message: plan.kind === 'save' ? '攒钱计划只累计收入记录' : '消费计划只累计支出记录',
        severity: 'warning',
      });
      return;
    }
    try {
      const added = await planRepo.link(
        plan.id,
        compatible.map((tx) => tx.id),
      );
      await settingsRepo.bumpDataVersion();
      const skipped = items.length - compatible.length;
      showSnack({
        message: skipped > 0 ? `已加入 ${added} 笔（${skipped} 笔方向不符，未计入）` : `已加入 ${added} 笔`,
        severity: added > 0 ? 'success' : 'info',
      });
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    }
  };

  const completePlan = async (plan: Plan): Promise<void> => {
    try {
      // 先算一遍再冻结：complete() 内部会写 settled_cents，省下多少钱按冻结值算
      const before = planProgress(plan, linkedByPlan.get(plan.id) ?? []);
      await planRepo.complete(plan.id);
      await settingsRepo.bumpDataVersion();
      const saved = plan.kind === 'spend' && before.linked_cents < plan.target_cents ? plan.target_cents - before.linked_cents : 0;
      showSnack({
        message:
          saved > 0
            ? `预算内完成，省下 ${formatCents(asCents(saved))}。已归入完成列表`
            : '已标记完成，归入完成列表',
        severity: 'success',
      });
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    }
  };

  const reopenPlan = async (plan: Plan): Promise<void> => {
    try {
      await planRepo.reopen(plan.id);
      await settingsRepo.bumpDataVersion();
      showSnack({ message: '已回到进行中', severity: 'info' });
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget || busy) return;
    setBusy(true);
    try {
      await planRepo.remove(deleteTarget.id);
      await settingsRepo.bumpDataVersion();
      showSnack({ message: '计划已删除，关联的流水还在账本里', severity: 'info' });
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    } finally {
      setBusy(false);
      setDeleteTarget(null);
    }
  };

  const unlinkTx = async (plan: Plan, txId: string): Promise<void> => {
    try {
      await planRepo.unlink(plan.id, txId);
      await settingsRepo.bumpDataVersion();
      showSnack({ message: '已移出这个计划', severity: 'info' });
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    }
  };

  const dragCandidates = useMemo(
    () =>
      txs
        .filter((tx) => !tx.deleted_at && (tx.direction === 'income' || tx.direction === 'expense' || tx.direction === 'refund'))
        .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))
        .slice(0, 12),
    [txs],
  );

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Box>
          <Typography variant="h6" sx={{ fontSize: 20 }}>
            消费计划
          </Typography>
          <Typography variant="caption" color="text.secondary">
            攒钱看收入累计，消费看支出累计；两条计划互不影响
          </Typography>
        </Box>
        <Button size="small" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
          新建
        </Button>
      </Box>

      {activePlans.length === 0 && donePlans.length === 0 ? (
        <EmptyState
          icon="🎯"
          title="还没有计划"
          description="建一条「攒钱买台式主机 8000 元」，把收入记录拖进去看进度；再建一条「主机采购」，把机箱显卡这些支出拖进去。"
          primary={{ label: '新建计划', onClick: () => setCreateOpen(true) }}
        />
      ) : (
        <Stack spacing={1.5}>
          {activePlans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              linked={linkedByPlan.get(plan.id) ?? []}
              onComplete={() => void completePlan(plan)}
              onDelete={() => setDeleteTarget(plan)}
              onPick={() => setPickingFor(plan)}
              onUnlink={(txId) => void unlinkTx(plan, txId)}
              onDropTx={(txIds) => void addTx(plan, txIds)}
            />
          ))}
        </Stack>
      )}

      {dragCandidates.length > 0 && activePlans.length > 0 && (
        <Box sx={{ mt: 2 }}>
          <SectionCard title="最近流水" subtitle="按住一行拖到上面的计划卡片里；手机上长按约 0.3 秒" dense>
            <Stack divider={<Divider flexItem />} spacing={0}>
              {dragCandidates.map((tx) => (
                <DraggableTxRow key={tx.id} tx={tx} />
              ))}
            </Stack>
          </SectionCard>
        </Box>
      )}

      {donePlans.length > 0 && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2" sx={{ mb: 0.75, color: 'text.secondary' }}>
            已完成（{donePlans.length}）
          </Typography>
          <Stack spacing={1}>
            {donePlans.map((plan) => (
              <DonePlanRow
                key={plan.id}
                plan={plan}
                linked={linkedByPlan.get(plan.id) ?? []}
                onReopen={() => void reopenPlan(plan)}
                onDelete={() => setDeleteTarget(plan)}
              />
            ))}
          </Stack>
        </Box>
      )}

      <Dialog open={createOpen} onClose={() => (busy ? undefined : setCreateOpen(false))} fullWidth maxWidth="xs">
        <DialogTitle>新建计划</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <TextField
              label="计划名称"
              placeholder="台式主机 / 换手机 / 房租押金"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              InputLabelProps={{ shrink: true }}
            />
            <ToggleButtonGroup
              size="small"
              exclusive
              value={kind}
              onChange={(_, value: PlanKind | null) => value && setKind(value)}
              fullWidth
            >
              <ToggleButton value="save">攒钱</ToggleButton>
              <ToggleButton value="spend">消费</ToggleButton>
            </ToggleButtonGroup>
            <Typography variant="caption" color="text.secondary">
              {kind === 'save'
                ? '攒钱：收入记录拖进来累计，攒够目标就可以准备买了。'
                : '消费：支出记录拖进来累计，实际花得比预算少，完成时会记下省了多少。'}
            </Typography>
            <TextField
              label="计划金额（元）"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              inputProps={{ inputMode: 'decimal' }}
              InputLabelProps={{ shrink: true }}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setCreateOpen(false)}>
            取消
          </Button>
          <Button variant="contained" disabled={busy} onClick={() => void createPlan()}>
            {busy ? '保存中…' : '创建'}
          </Button>
        </DialogActions>
      </Dialog>

      <PickTxDialog
        plan={pickingFor}
        txs={txs}
        linkedIds={new Set((pickingFor ? linkedByPlan.get(pickingFor.id) ?? [] : []).map((tx) => tx.id))}
        onClose={() => setPickingFor(null)}
        onConfirm={(ids) => {
          if (pickingFor) void addTx(pickingFor, ids);
          setPickingFor(null);
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除这个计划？"
        message={
          <Typography variant="body2">
            「{deleteTarget?.title ?? ''}」和它的进度记录会被删除；已入账的流水不受影响，只是不再挂在这个计划下。
          </Typography>
        }
        confirmLabel="删除"
        destructive
        busy={busy}
        onConfirm={() => void confirmDelete()}
        onClose={() => {
          if (!busy) setDeleteTarget(null);
        }}
      />

      {/*
        给右下角「记一笔」悬浮球让位。
        它是 fixed 在视口底部上方 80px，正好压住列表最后一行右侧的图标按钮；
        这里补一段占位，让最后一条计划滚到底时能完整露出来。
      */}
      <Box sx={{ height: { xs: 64, md: 8 } }} />
    </>
  );
}

interface PlanCardProps {
  plan: Plan;
  linked: Transaction[];
  onComplete: () => void;
  onDelete: () => void;
  onPick: () => void;
  onUnlink: (txId: string) => void;
  onDropTx: (txIds: string[]) => void;
}

function PlanCard({ plan, linked, onComplete, onDelete, onPick, onUnlink, onDropTx }: PlanCardProps): JSX.Element {
  const progress = planProgress(plan, linked);
  const [open, setOpen] = useState(false);
  const touchStart = useRef<number | null>(null);

  const { active, dropProps } = useDropTarget(`plan:${plan.id}`, (payload) => onDropTx(payload.txIds));

  return (
    <SectionCard
      dense
      sx={{
        border: '1px solid',
        borderColor: active ? 'primary.main' : 'divider',
        bgcolor: active ? 'action.selected' : undefined,
        transition: 'background-color 120ms ease, border-color 120ms ease',
      }}
    >
      <Box
        {...dropProps}
        onTouchStart={(event) => {
          touchStart.current = event.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(event) => {
          if (touchStart.current === null) return;
          const delta = (event.changedTouches[0]?.clientX ?? 0) - touchStart.current;
          touchStart.current = null;
          // 右滑 = 完成。与流水页「右滑标记」同一方向，用户不用记两套手势
          if (delta > 70) onComplete();
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, fontSize: 16 }} noWrap>
              {plan.title}
            </Typography>
            <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.25 }}>
              <Chip
                label={PLAN_KIND_LABEL[plan.kind]}
                size="small"
                color={plan.kind === 'save' ? 'primary' : 'secondary'}
                variant="outlined"
                sx={{ height: 18, fontSize: 10, '& .MuiChip-label': { px: 0.75 } }}
              />
              <Typography variant="caption" color="text.secondary">
                {progress.linked_count} 笔已关联
              </Typography>
              {progress.skipped_count > 0 && (
                <Typography variant="caption" color="warning.main">
                  {progress.skipped_count} 笔方向不符已忽略
                </Typography>
              )}
            </Stack>
          </Box>
          <IconButton size="small" aria-label="删除计划" onClick={onDelete}>
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </Box>

        <LinearProgress
          variant="determinate"
          value={Math.min(100, Math.max(0, progress.percent))}
          sx={{ height: 8, borderRadius: 4, mt: 1.25 }}
          color={progress.reached ? 'success' : plan.kind === 'save' ? 'primary' : 'secondary'}
        />
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.5 }}>
          <Typography variant="body2" className="tabular">
            {formatCents(progress.linked_cents)} / {formatCents(progress.target_cents)}
          </Typography>
          <Typography variant="caption" color="text.secondary" className="tabular">
            {progress.percent}%
          </Typography>
        </Box>
        <Typography variant="caption" color={progress.reached ? 'success.main' : 'text.secondary'} sx={{ display: 'block' }}>
          {progressSummary(plan, progress)}
        </Typography>

        <Box sx={{ display: 'flex', gap: 1, mt: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button size="small" variant={progress.reached ? 'contained' : 'outlined'} onClick={onComplete}>
            打勾完成
          </Button>
          <Button size="small" onClick={onPick}>
            从流水挑选
          </Button>
          {linked.length > 0 && (
            <Button size="small" endIcon={<ExpandMoreIcon />} onClick={() => setOpen((value) => !value)}>
              {open ? '收起' : `看关联的 ${linked.length} 笔`}
            </Button>
          )}
        </Box>

        <Collapse in={open} unmountOnExit>
          <Stack divider={<Divider flexItem />} sx={{ mt: 1 }}>
            {linked.map((tx) => (
              <Box key={tx.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 0.5 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" noWrap sx={{ fontSize: 13 }}>
                    {tx.counterparty || tx.category_l2}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {tx.occurred_date} · {tx.category_l2}
                  </Typography>
                </Box>
                <Typography variant="body2" className="tabular" sx={{ fontSize: 13 }}>
                  {tx.direction === 'expense' ? '-' : tx.direction === 'income' ? '+' : ''}
                  {formatCents(tx.amount_cents, { symbol: false })}
                </Typography>
                <IconButton size="small" aria-label="移出计划" onClick={() => onUnlink(tx.id)}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Box>
            ))}
          </Stack>
        </Collapse>
      </Box>
    </SectionCard>
  );
}

function DonePlanRow({
  plan,
  linked,
  onReopen,
  onDelete,
}: {
  plan: Plan;
  linked: Transaction[];
  onReopen: () => void;
  onDelete: () => void;
}): JSX.Element {
  const progress = planProgress(plan, linked);
  return (
    <Box
      sx={{
        px: 1.5,
        py: 1,
        borderRadius: 2,
        border: '1px dashed',
        borderColor: 'divider',
        display: 'flex',
        alignItems: 'center',
        gap: 1,
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          ✓ {plan.title}
        </Typography>
        <Typography variant="caption" color={progress.saved_cents ? 'success.main' : 'text.secondary'}>
          {progressSummary(plan, progress)} · {formatCents(progress.linked_cents)}
        </Typography>
      </Box>
      <Button size="small" onClick={onReopen}>
        恢复
      </Button>
      <IconButton size="small" aria-label="删除" onClick={onDelete}>
        <DeleteOutlineIcon fontSize="small" />
      </IconButton>
    </Box>
  );
}

/** 可拖动的候选流水行：桌面移动即拖，手机长按再拖。 */
function DraggableTxRow({ tx }: { tx: Transaction }): JSX.Element {
  const { onPointerDown } = useDragSource({
    kind: 'tx',
    txIds: [tx.id],
    label: tx.counterparty || tx.category_l2,
    direction: tx.direction,
    cents: tx.amount_cents,
  });
  return (
    <Box
      onPointerDown={onPointerDown}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        py: 0.75,
        px: 0.5,
        cursor: 'grab',
        // 触摸拖动的前提：不把纵向滑动交给浏览器
        touchAction: 'pan-y',
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ width: 74, flexShrink: 0 }}>
        {tx.occurred_date.slice(5)}
      </Typography>
      <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0, fontSize: 13 }}>
        {tx.counterparty || tx.category_l2}
      </Typography>
      <Typography variant="body2" className="tabular" sx={{ fontSize: 13 }}>
        {tx.direction === 'expense' ? '-' : tx.direction === 'income' ? '+' : ''}
        {formatCents(tx.amount_cents, { symbol: false })}
      </Typography>
    </Box>
  );
}

/** 从流水里挑选：搜索 + 多选，手机上是比拖拽更快的路径。 */
function PickTxDialog({
  plan,
  txs,
  linkedIds,
  onClose,
  onConfirm,
}: {
  plan: Plan | null;
  txs: Transaction[];
  linkedIds: Set<string>;
  onClose: () => void;
  onConfirm: (ids: string[]) => void;
}): JSX.Element {
  const [keyword, setKeyword] = useState('');
  const [picked, setPicked] = useState<string[]>([]);

  const options = useMemo(() => {
    if (!plan) return [];
    const needle = keyword.trim().toLowerCase();
    return txs
      .filter((tx) => !tx.deleted_at && !linkedIds.has(tx.id))
      .filter((tx) => (plan.kind === 'save' ? tx.direction === 'income' : tx.direction === 'expense' || tx.direction === 'refund'))
      .filter((tx) => (needle ? `${tx.counterparty ?? ''}${tx.note ?? ''}${tx.category_l2}`.toLowerCase().includes(needle) : true))
      .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))
      .slice(0, 80);
  }, [plan, txs, linkedIds, keyword]);

  const close = (): void => {
    setPicked([]);
    setKeyword('');
    onClose();
  };

  return (
    <Dialog open={plan !== null} onClose={close} fullWidth maxWidth="xs">
      <DialogTitle>挑选流水 · {plan?.title ?? ''}</DialogTitle>
      <DialogContent>
        <TextField
          size="small"
          placeholder="搜索对方、备注、分类"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          fullWidth
          sx={{ mb: 1 }}
        />
        <Typography variant="caption" color="text.secondary">
          {plan?.kind === 'save' ? '只列收入记录' : '只列支出与退款记录'}（方向匹配才会计入进度）
        </Typography>
        <Stack sx={{ mt: 0.5 }}>
          {options.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
              没有可选的流水
            </Typography>
          ) : (
            options.map((tx) => {
              const checked = picked.includes(tx.id);
              return (
                <Box
                  key={tx.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setPicked((prev) => (checked ? prev.filter((id) => id !== tx.id) : [...prev, tx.id]))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setPicked((prev) => (checked ? prev.filter((id) => id !== tx.id) : [...prev, tx.id]));
                    }
                  }}
                  sx={{ display: 'flex', alignItems: 'center', gap: 0.5, py: 0.25, cursor: 'pointer' }}
                >
                  <Checkbox size="small" checked={checked} sx={{ p: 0.5 }} onChange={() => undefined} />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" noWrap sx={{ fontSize: 13 }}>
                      {tx.counterparty || tx.category_l2}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {tx.occurred_date} · {tx.category_l2}
                    </Typography>
                  </Box>
                  <Typography variant="body2" className="tabular" sx={{ fontSize: 13 }}>
                    {formatCents(tx.amount_cents, { symbol: false })}
                  </Typography>
                </Box>
              );
            })
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>取消</Button>
        <Button variant="contained" disabled={picked.length === 0} onClick={() => onConfirm(picked)}>
          加入 {picked.length} 笔
        </Button>
      </DialogActions>
    </Dialog>
  );
}
