import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { downloadBlob } from '../../../backup/backup';
import * as txRepo from '../../../db/repos/transactionRepo';
import { describeError } from '../../../domain/errors';
import { buildAiPack, type CounterpartyMode } from '../../../export/aiPack';
import { useUiStore } from '../../../store/uiStore';
import { SectionCard } from '../../components/SectionCard';

/**
 * AI 分析数据包导出页。
 *
 * 产品铁律：**数据不离开本机**。本页只做「本地生成 → 用户自己复制/下载」，
 * 绝不出现任何上传入口（隐私 QA 会扫描网络调用点）。
 * 用户把 JSON 交给谁是用户的决定——页面的职责是让脱敏选项和内容预览
 * 足够透明，用户在点「下载/复制」之前就知道包里长什么样。
 */
export function AiExportPage(): JSX.Element {
  const navigate = useNavigate();
  const showSnack = useUiStore((state) => state.showSnack);

  // 只读查询：拿全部活跃交易在内存里构建（10 万笔量级足够，见 transactionRepo.search 注释）
  const txs = useLiveQuery(() => txRepo.listAll(), [], []);

  const [counterpartyMode, setCounterpartyMode] = useState<CounterpartyMode>('pseudonym');
  const [includeNotes, setIncludeNotes] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const txList = txs ?? [];
  // 预览与导出用同一份构建结果——所见即所得，不会「预览是脱敏的、文件里是原名」。
  const pack = useMemo(
    () =>
      buildAiPack(txList, {
        counterpartyMode,
        includeNotes,
        // 留空 = 全部数据：undefined 才触发「全部」语义，空字符串会被当成区间边界
        fromDate: fromDate === '' ? undefined : fromDate,
        toDate: toDate === '' ? undefined : toDate,
      }),
    [txList, counterpartyMode, includeNotes, fromDate, toDate],
  );
  const jsonText = useMemo(() => JSON.stringify(pack, null, 2), [pack]);
  const hasData = pack.summary.tx_count > 0;

  const doDownload = (): void => {
    try {
      const blob = new Blob([jsonText], { type: 'application/json' });
      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
        now.getDate(),
      ).padStart(2, '0')}`;
      // downloadBlob = URL.createObjectURL + a[download] + click 后立刻 revoke，与本页零网络承诺一致
      downloadBlob(blob, `快记账-AI分析包-${stamp}.json`);
      showSnack({ message: 'JSON 文件已生成，内容与预览一致', severity: 'success' });
    } catch (error) {
      showSnack({ message: describeError(error), severity: 'error' });
    }
  };

  const doCopy = async (): Promise<void> => {
    // navigator.clipboard 是浏览器本地 API，不经过网络；失败（非安全上下文/权限）降级为提示手动复制
    try {
      await navigator.clipboard.writeText(jsonText);
      showSnack({ message: '已复制到剪贴板，粘贴给你信任的 AI 即可', severity: 'success' });
    } catch {
      showSnack({ message: '复制失败，请手动选中下方预览文本复制', severity: 'warning' });
    }
  };

  const rangeLabel = `${pack.summary.range.from || '（无数据）'} ~ ${pack.summary.range.to || '（无数据）'}`;
  const sourcesLabel = pack.summary.sources_covered.join('、') || '无';

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
        <Typography variant="h6" sx={{ fontSize: 20 }}>
          AI 分析数据包
        </Typography>
        <Button size="small" onClick={() => navigate('/settings')}>
          返回
        </Button>
      </Box>

      <Alert severity="success" sx={{ mb: 1.5 }}>
        数据不离开本机：导出的是脱敏后的结构化 JSON，你复制给任何 AI（网页版大模型、本地模型都行），我们不替你上传。
      </Alert>

      <Stack spacing={1.5}>
        <SectionCard title="导出选项" subtitle="商户代号化 + 不含备注，是默认的稳妥组合" dense>
          <Stack spacing={1.5}>
            <div>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                商户名称
              </Typography>
              <ToggleButtonGroup
                exclusive
                size="small"
                value={counterpartyMode}
                onChange={(_event, next: CounterpartyMode | null) => {
                  // 允许点已选项时保持原选择：null 表示用户点掉了当前项，不切换更安全
                  if (next !== null) setCounterpartyMode(next);
                }}
              >
                <ToggleButton value="pseudonym">代号（推荐，默认）</ToggleButton>
                <ToggleButton value="strip">完全去除</ToggleButton>
                <ToggleButton value="full">保留原名</ToggleButton>
              </ToggleButtonGroup>
            </div>
            {counterpartyMode === 'full' && (
              <Alert severity="warning">真实商户名会进入数据包，请确认你交给的 AI 值得信任</Alert>
            )}
            <div>
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={includeNotes}
                    onChange={(event) => setIncludeNotes(event.target.checked)}
                  />
                }
                label="包含备注原文"
              />
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', ml: 4 }}>
                备注可能含地址、人名
              </Typography>
            </div>
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                label="开始"
                type="date"
                size="small"
                value={fromDate}
                onChange={(event) => setFromDate(event.target.value)}
                InputLabelProps={{ shrink: true }}
                inputProps={{ 'aria-label': '开始日期' }}
                sx={{ flex: 1, minWidth: 0 }}
              />
              <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                ~
              </Typography>
              <TextField
                label="结束"
                type="date"
                size="small"
                value={toDate}
                onChange={(event) => setToDate(event.target.value)}
                InputLabelProps={{ shrink: true }}
                inputProps={{ 'aria-label': '结束日期' }}
                sx={{ flex: 1, minWidth: 0 }}
              />
            </Stack>
            <Typography variant="caption" color="text.secondary">
              区间留空 = 全部数据。商户按支出净额从大到小分配代号（商户A、商户B…），两次导出代号一致。
            </Typography>
          </Stack>
        </SectionCard>

        <SectionCard title="内容预览" subtitle="导出前就能看到包里长什么样、脱敏是否生效（截取前 800 字符）" dense>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            范围 {rangeLabel} · {pack.summary.months} 个月 · {pack.summary.tx_count} 笔 · 来源：{sourcesLabel}
          </Typography>
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 1,
              bgcolor: 'action.hover',
              borderRadius: 1,
              fontFamily: 'ui-monospace, Consolas, monospace',
              fontSize: 11,
              lineHeight: 1.5,
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {jsonText.slice(0, 800)}
          </Box>
        </SectionCard>

        <SectionCard title="导出" subtitle="下载文件或复制全文，交给谁由你自己决定" dense>
          <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
            <Button variant="contained" onClick={doDownload} disabled={!hasData}>
              下载 JSON 文件
            </Button>
            <Button variant="outlined" onClick={doCopy} disabled={!hasData}>
              复制到剪贴板
            </Button>
          </Stack>
          <Typography variant="caption" color="text.secondary">
            字段词典与建议提示词都写在 JSON 里（field_dictionary / suggested_prompt），AI 能直接读懂。
          </Typography>
        </SectionCard>
      </Stack>
    </>
  );
}
