import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as categoryRepo from '../../../db/repos/categoryRepo';
import type { CategoryTree } from '../../../db/repos/categoryRepo';
import { describeError } from '../../../domain/errors';
import { useUiStore } from '../../../store/uiStore';
import { SectionCard } from '../../components/SectionCard';

const EMPTY_TREE: CategoryTree = { l1List: [], byL1: new Map(), all: [] };

/** 分类维护：内置项只可改名与排序、不可删除；二级不允许自由文本入账。 */
export function CategoriesPage(): JSX.Element {
  const navigate = useNavigate();
  const showSnack = useUiStore((state) => state.showSnack);
  const tree = useLiveQuery(() => categoryRepo.loadTree(), [], EMPTY_TREE);
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [addFor, setAddFor] = useState<string | null>(null);
  const [addName, setAddName] = useState('');
  const [busy, setBusy] = useState(false);

  const doRename = async (): Promise<void> => {
    if (!renameTarget || !renameValue.trim() || busy) return;
    setBusy(true);
    try {
      await categoryRepo.rename(renameTarget.id, renameValue.trim());
      showSnack({ message: '已改名（历史数据同步生效）', severity: 'success' });
      setRenameTarget(null);
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const doAdd = async (): Promise<void> => {
    if (!addFor || !addName.trim() || busy) return;
    setBusy(true);
    try {
      const l2Id = addName.trim().replace(/\s+/g, '_');
      await categoryRepo.addChild(addFor, l2Id, addName.trim());
      showSnack({ message: '已新增二级分类', severity: 'success' });
      setAddFor(null);
      setAddName('');
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
          分类
        </Typography>
        <Button size="small" onClick={() => navigate('/settings')}>
          返回
        </Button>
      </Box>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        一级固定 10 个（支出）+ 6 个（收入）；二级从固定清单选。未识别进「其他/待分类」，不允许自由文本分类直接入账。
      </Typography>

      <Stack spacing={1.5}>
        {(tree.l1List ?? []).map((l1) => (
          <SectionCard
            key={l1.id}
            title={`${l1.icon} ${l1.name}`}
            subtitle={l1.scope === 'income' ? '收入侧' : '支出侧'}
            action={
              <Button size="small" disabled={busy} onClick={() => setAddFor(l1.id)}>
                加二级
              </Button>
            }
            dense
          >
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
              {(tree.byL1.get(l1.id) ?? []).map((l2) => (
                <Chip
                  key={l2.id}
                  label={l2.l2_name}
                  size="small"
                  variant="outlined"
                  disabled={busy}
                  onClick={() => {
                    setRenameTarget({ id: l2.id, name: l2.l2_name });
                    setRenameValue(l2.l2_name);
                  }}
                />
              ))}
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              点任意二级可改名；内置分类不能删除（历史数据要有归宿）
            </Typography>
          </SectionCard>
        ))}
      </Stack>

      <Dialog
        open={renameTarget !== null}
        onClose={() => {
          if (!busy) setRenameTarget(null);
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>改名</DialogTitle>
        <DialogContent>
          <TextField autoFocus fullWidth value={renameValue} onChange={(e) => setRenameValue(e.target.value)} sx={{ mt: 1 }} />
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setRenameTarget(null)}>
            取消
          </Button>
          <Button variant="contained" disabled={busy} onClick={doRename}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={addFor !== null}
        onClose={() => {
          if (!busy) setAddFor(null);
        }}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>新增二级分类</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="二级分类名称"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            sx={{ mt: 1 }}
            helperText="例如「自习室」「共享充电宝」"
          />
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setAddFor(null)}>
            取消
          </Button>
          <Button variant="contained" disabled={busy} onClick={doAdd}>
            {busy ? '新增中…' : '新增'}
          </Button>
        </DialogActions>
      </Dialog>

      <Divider sx={{ my: 2 }} />
      <Typography variant="caption" color="text.secondary">
        合并分类：把旧分类的账并到新分类（保留历史金额，不删除任何流水）
      </Typography>
    </>
  );
}
