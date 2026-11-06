import {
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as categoryRepo from '../../../db/repos/categoryRepo';
import type { CategoryTree } from '../../../db/repos/categoryRepo';
import * as ruleRepo from '../../../db/repos/ruleRepo';
import { l1Name } from '../../../domain/categoryTree';
import { describeError } from '../../../domain/errors';
import { useUiStore } from '../../../store/uiStore';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SectionCard } from '../../components/SectionCard';
import type { CategoryRule } from '../../../types';

const EMPTY_TREE: CategoryTree = { l1List: [], byL1: new Map(), all: [] };

/** 关键词自动归类规则：可见、可编辑、可停用（PRD §6-3）。 */
export function RulesPage(): JSX.Element {
  const navigate = useNavigate();
  const showSnack = useUiStore((state) => state.showSnack);
  const rules = useLiveQuery(() => ruleRepo.list(), [], []) ?? [];
  const tree = useLiveQuery(() => categoryRepo.loadTree(), [], EMPTY_TREE);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CategoryRule | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  /** 所有规则写操作共用一条「锁 → 成功/失败提示 → 解锁」路径，避免静默失败。 */
  const runRuleWrite = async (
    ruleId: string,
    work: () => Promise<void>,
    successMessage: string,
  ): Promise<void> => {
    if (busyId !== null) return;
    setBusyId(ruleId);
    try {
      await work();
      showSnack({ message: successMessage, severity: 'success' });
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const toggle = (rule: CategoryRule, enabled: boolean): void => {
    void runRuleWrite(rule.id, () => ruleRepo.toggle(rule.id, enabled), enabled ? '规则已启用' : '规则已停用');
  };

  const changeTarget = (rule: CategoryRule, l1: string, l2: string): void => {
    void runRuleWrite(
      rule.id,
      () =>
        ruleRepo.upsert({
          ...rule,
          target_l1: l1,
          target_l2: l2 || undefined,
          updated_at: new Date().toISOString(),
        }),
      '规则已更新',
    );
  };

  const closeDeleteDialog = (): void => {
    if (deleteBusy) return;
    setDeleteTarget(null);
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await ruleRepo.remove(deleteTarget.id);
      showSnack({ message: '规则已删除', severity: 'success' });
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    } finally {
      setDeleteBusy(false);
      setDeleteTarget(null);
    }
  };

  const groups: Array<{ title: string; subtitle: string; items: CategoryRule[] }> = [
    {
      title: '学习规则',
      subtitle: '你手改分类后自动生成，命中越多置信度越高',
      items: rules.filter((rule) => rule.source === 'learned'),
    },
    {
      title: '内置关键词规则',
      subtitle: '按「关键词更长者胜」排序，二级留空的由时间窗口补全',
      items: rules.filter((rule) => rule.source === 'builtin' && rule.kind === 'keyword'),
    },
    {
      title: '时间窗口规则',
      subtitle: '11:00–14:00 且 ≤50 元 → 午餐；17:00–21:00 且 ≤80 元 → 晚餐',
      items: rules.filter((rule) => rule.kind === 'time_window'),
    },
    {
      title: '自定义规则',
      subtitle: '优先级数字越小越先命中',
      items: rules.filter((rule) => rule.source === 'user'),
    },
  ];

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Typography variant="h6" sx={{ fontSize: 20 }}>
          自动归类规则
        </Typography>
        <Button size="small" onClick={() => navigate('/settings')}>
          返回
        </Button>
      </Box>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        判定顺序：已锁定分类 → 自定义规则 → 学习规则 → 内置关键词 → 时间窗口 → 兜底「其他/待分类」
      </Typography>

      <Stack spacing={1.5}>
        {groups.map((group) => (
          <SectionCard key={group.title} title={group.title} subtitle={group.subtitle} dense>
            {group.items.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                暂无
              </Typography>
            ) : (
              <Stack divider={<Divider />} spacing={1}>
                {group.items.map((rule) => (
                  <Box key={rule.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Box sx={{ flex: 1, minWidth: 150 }}>
                      <Typography variant="body2" fontWeight={600}>
                        {rule.match.keywords?.join(' / ') ??
                          rule.match.merchant_pattern ??
                          `${rule.match.time_from ?? '00:00'}–${rule.match.time_to ?? '24:00'}`}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        → {l1Name(rule.target_l1)}
                        {rule.target_l2 ? `.${rule.target_l2}` : '（二级由时间补全）'} · 置信度{' '}
                        {(rule.confidence * 100).toFixed(0)}% · 命中 {rule.hit_count}
                      </Typography>
                    </Box>
                    <TextField
                      select
                      size="small"
                      value={rule.target_l1}
                      disabled={busyId === rule.id || deleteBusy}
                      onChange={(event) => changeTarget(rule, event.target.value, rule.target_l2 ?? '')}
                      sx={{ width: 120 }}
                    >
                      {tree.l1List.map((l1) => (
                        <MenuItem key={l1.id} value={l1.id}>
                          {l1.name}
                        </MenuItem>
                      ))}
                    </TextField>
                    <Switch
                      size="small"
                      checked={rule.enabled}
                      disabled={busyId === rule.id || deleteBusy}
                      onChange={(event) => toggle(rule, event.target.checked)}
                    />
                    {rule.source !== 'builtin' && (
                      <IconButton
                        size="small"
                        aria-label="删除规则"
                        disabled={busyId === rule.id || deleteBusy}
                        onClick={() => setDeleteTarget(rule)}
                      >
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    )}
                  </Box>
                ))}
              </Stack>
            )}
          </SectionCard>
        ))}
      </Stack>

      <Box sx={{ mt: 1.5 }}>
        <Chip size="small" variant="outlined" label="改一次分类就会自动记住同商户" />
      </Box>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除这条自动归类规则？"
        message={
          <>
            <Typography variant="body2" gutterBottom>
              「{deleteTarget?.match.keywords?.join(' / ') ?? deleteTarget?.match.merchant_pattern ?? '这条规则'}」删除后不可恢复，
              同商户以后不会再自动套用这个分类。
            </Typography>
            <Typography variant="body2" color="error.main" fontWeight={600}>
              此操作不可撤销；已经归好类的历史流水不受影响。
            </Typography>
          </>
        }
        confirmLabel="确认删除"
        destructive
        busy={deleteBusy}
        onConfirm={() => {
          void confirmDelete();
        }}
        onClose={closeDeleteDialog}
      />
    </>
  );
}
