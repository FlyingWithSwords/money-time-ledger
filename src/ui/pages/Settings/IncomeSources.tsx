import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as settingsRepo from '../../../db/repos/settingsRepo';
import * as transactionRepo from '../../../db/repos/transactionRepo';
import { ALL_TREES } from '../../../domain/categoryTree';
import { describeError } from '../../../domain/errors';
import {
  mergeIncomeSources,
  scanIncomeCandidates,
  type IncomeCandidate,
  type IncomeSource,
} from '../../../domain/incomeSource';
import { formatCents } from '../../../domain/money';
import { useUiStore } from '../../../store/uiStore';
import { SectionCard } from '../../components/SectionCard';

/**
 * 工资/补贴来源设置。
 *
 * 这里解决一个很具体的账务问题：工资从银行卡转到微信/支付宝时，
 * 微信账单的「收/支」列写的是 `/`（中性交易），支付宝写「不计收支」。
 * 按平台口径这笔钱确实没花也没收，于是被安静地判成转账，
 * 一个月少看几千块收入，而支出侧一切正常——用户很难发现。
 *
 * 为什么不让程序自己猜：「转账」里还混着信用卡还款、零钱提现、亲友往来。
 * 猜错的后果是把还款记成收入，收入虚高比漏记更难发现。所以内置词表只用来找候选，
 * 由用户勾选确认；勾过之后写进设置，以后导入按白名单精确匹配。
 */

const L2_OPTIONS =
  ALL_TREES.find((item) => item.id === 'salary')?.l2 ?? [
    { id: 'monthly', name: '月薪' },
    { id: 'bonus', name: '奖金' },
    { id: 'other', name: '其他工资' },
  ];

export function IncomeSourcesPage(): JSX.Element {
  const navigate = useNavigate();
  const showSnack = useUiStore((state) => state.showSnack);
  const sources = useLiveQuery(() => settingsRepo.getIncomeSources(), [], []) ?? [];

  const [candidates, setCandidates] = useState<IncomeCandidate[] | null>(null);
  /** 已勾选的候选（key = 归一化关键词） */
  const [selected, setSelected] = useState<string[]>([]);
  /** 每行选中的二级分类，覆盖默认判断 */
  const [l2Overrides, setL2Overrides] = useState<Record<string, string>>({});
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);

  const scan = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const all = await transactionRepo.listAll();
      const found = scanIncomeCandidates(all);
      setCandidates(found);
      // 强特征词命中的默认全勾：这些几乎不可能是消费，让用户只需取消少数误判
      setSelected(found.map((item) => item.keyword));
      setL2Overrides({});
      if (found.length === 0) {
        showSnack({
          message: '没找到像工资/补贴的转账记录。可以手动添加来源关键词。',
          severity: 'info',
        });
      }
    } catch (error) {
      showSnack({ message: `扫描失败：${describeError(error)}`, severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const applyCandidates = async (): Promise<void> => {
    if (busy || !candidates) return;
    const chosen = candidates.filter((item) => selected.includes(item.keyword));
    if (chosen.length === 0) {
      setCandidates(null);
      return;
    }
    setBusy(true);
    try {
      const incoming: IncomeSource[] = chosen.map((item) => ({
        keyword: item.keyword,
        label: item.label,
        l1: 'salary',
        l2: l2Overrides[item.keyword] ?? item.l2,
      }));
      await settingsRepo.setIncomeSources(mergeIncomeSources(sources, incoming));

      let changed = 0;
      for (const item of chosen) {
        changed += await transactionRepo.markIncome(item.ids, 'salary', l2Overrides[item.keyword] ?? item.l2);
      }
      await settingsRepo.bumpDataVersion();
      showSnack({
        message: `已把 ${changed} 笔改判为「工资补贴」，以后导入同类记录会自动算收入`,
        severity: 'success',
      });
      setCandidates(null);
      setSelected([]);
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  /** 只加关键词、不改历史记录：用于「以后再说」的场景。 */
  const addManual = async (): Promise<void> => {
    const keyword = manual.trim();
    if (!keyword) return;
    setBusy(true);
    try {
      await settingsRepo.setIncomeSources(
        mergeIncomeSources(sources, [{ keyword, label: keyword, l1: 'salary', l2: 'monthly' }]),
      );
      setManual('');
      showSnack({ message: '已添加。之后导入的账单命中它就算收入', severity: 'success' });
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const removeSource = async (keyword: string): Promise<void> => {
    setBusy(true);
    try {
      await settingsRepo.setIncomeSources(sources.filter((item) => item.keyword !== keyword));
      showSnack({ message: '已移除。已入账的记录不受影响', severity: 'info' });
    } catch (error) {
      showSnack({ message: `操作失败：${describeError(error)}`, severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const toggle = (keyword: string): void => {
    setSelected((prev) => (prev.includes(keyword) ? prev.filter((item) => item !== keyword) : [...prev, keyword]));
  };

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Typography variant="h6" sx={{ fontSize: 20 }}>
          工资与补贴来源
        </Typography>
        <Button size="small" onClick={() => navigate('/settings')}>
          返回
        </Button>
      </Box>

      <Alert severity="info" sx={{ mb: 1.5 }}>
        工资从银行卡转到微信/支付宝时，账单会把它记成「转账」（收/支 = <code>/</code>），既不算收入也不算支出。
        在这里勾出哪些来源算收入，之后导入就自动按「工资补贴」入账。
      </Alert>

      <SectionCard title="已确认的来源" dense>
        {sources.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            还没有。点下面的「扫描历史记录」，从已导入的账单里找出像工资/补贴的转账。
          </Typography>
        ) : (
          <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: 0.75 }}>
            {sources.map((source) => (
              <Chip
                key={source.keyword}
                label={`${source.label} · ${L2_OPTIONS.find((item) => item.id === source.l2)?.name ?? source.l2}`}
                size="small"
                onDelete={busy ? undefined : () => void removeSource(source.keyword)}
              />
            ))}
          </Stack>
        )}
        <Button size="small" sx={{ mt: 1 }} disabled={busy} onClick={() => void scan()}>
          {candidates === null ? '扫描历史记录' : '重新扫描'}
        </Button>
      </SectionCard>

      {candidates !== null && (
        <Box sx={{ mt: 1.5 }}>
          <SectionCard
            title={`扫描到 ${candidates.length} 个疑似来源`}
            subtitle="默认全勾；哪条不是工资就取消勾选"
            dense
          >
            {candidates.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                没有命中工资/补贴特征词的转账记录。
              </Typography>
            ) : (
              <Stack divider={<Divider flexItem />} spacing={0.5}>
                {candidates.map((item) => {
                  const checked = selected.includes(item.keyword);
                  return (
                    <Box key={item.keyword} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, py: 0.25 }}>
                      <Checkbox
                        size="small"
                        checked={checked}
                        onChange={() => toggle(item.keyword)}
                        inputProps={{ 'aria-label': `把「${item.label}」算作收入` }}
                        sx={{ p: 0.5 }}
                      />
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography
                          variant="body2"
                          sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                          {item.label}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {item.count} 笔 · {formatCents(item.cents)} · 最近 {item.latest_date}
                          {item.directions.includes('transfer') ? ' · 现在记为转账' : ' · 现在记为支出'}
                        </Typography>
                      </Box>
                      <FormControl size="small" sx={{ width: 96, flexShrink: 0 }}>
                        <InputLabel shrink id={`l2-${item.keyword}`}>
                          归类
                        </InputLabel>
                        <Select
                          labelId={`l2-${item.keyword}`}
                          label="归类"
                          value={l2Overrides[item.keyword] ?? item.l2}
                          disabled={!checked}
                          onChange={(event) =>
                            setL2Overrides((prev) => ({ ...prev, [item.keyword]: event.target.value }))
                          }
                        >
                          {L2_OPTIONS.map((option) => (
                            <MenuItem key={option.id} value={option.id}>
                              {option.name}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    </Box>
                  );
                })}
              </Stack>
            )}
            <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
              <Button variant="contained" disabled={busy || selected.length === 0} onClick={() => void applyCandidates()}>
                确认这 {selected.length} 个来源
              </Button>
              <Button disabled={busy} onClick={() => setCandidates(null)}>
                取消
              </Button>
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              确认会同时做两件事：把已入账的这类记录改判为收入；把来源记下来，之后导入自动识别。
            </Typography>
          </SectionCard>
        </Box>
      )}

      <Box sx={{ mt: 1.5 }}>
        <SectionCard title="手动添加关键词" dense>
          <Stack direction="row" spacing={1} alignItems="flex-start">
            <TextField
              size="small"
              label="对方名里的关键词"
              placeholder="例如：XX 科技有限公司"
              value={manual}
              onChange={(event) => setManual(event.target.value)}
              fullWidth
              InputLabelProps={{ shrink: true }}
            />
            <Button variant="outlined" disabled={busy || !manual.trim()} onClick={() => void addManual()}>
              添加
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            只影响之后导入的账单，不改动已有记录。含「社保 / 公积金 / 个税」的行永远不会被算成收入。
          </Typography>
        </SectionCard>
      </Box>
    </>
  );
}
