import {
  Alert,
  Box,
  Button,
  Divider,
  Stack,
  Switch,
  FormControlLabel,
  Typography,
} from '@mui/material';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as reviewRepo from '../../db/repos/reviewRepo';
import { l1Name } from '../../domain/categoryTree';
import { formatMonthLabel } from '../../domain/date';
import { formatCents } from '../../domain/money';
import { shareLinesWithoutAmount } from '../../domain/review';
import { generateReviewCard } from '../../services/reviewService';
import { useUiStore } from '../../store/uiStore';
import { EmptyState } from '../components/EmptyState';
import { SectionCard } from '../components/SectionCard';

/**
 * M3 月度复盘卡：8 项内容逐屏卡片。
 * **分享图默认隐藏绝对金额**（PRD §4 边界），需要显式打开才显示。
 */
export function ReviewPage(): JSX.Element {
  const navigate = useNavigate();
  const params = useParams();
  const monthKey = params.monthKey ?? '';
  const showSnack = useUiStore((state) => state.showSnack);
  const card = useLiveQuery(() => (monthKey ? reviewRepo.getByMonth(monthKey) : Promise.resolve(undefined)), [monthKey]);
  const [showAmount, setShowAmount] = useState(false);
  /** 生成中禁用 EmptyState 的主按钮，避免重复生成；文案同步切换。 */
  const [generating, setGenerating] = useState(false);

  if (!card) {
    return (
      <EmptyState
        icon="🗂"
        title={`${monthKey || '这个月'}还没有复盘卡`}
        description="复盘卡是对已发生月份的冻结结论，生成之后不会被后续补录改写。"
        primary={{
          label: generating ? '生成中…' : '现在生成',
          disabled: generating,
          onClick: async () => {
            setGenerating(true);
            try {
              await generateReviewCard(monthKey);
              showSnack({ message: '复盘卡已生成', severity: 'success' });
            } catch (error) {
              showSnack({ message: `操作失败：${error instanceof Error ? error.message : String(error)}`, severity: 'error' });
            } finally {
              setGenerating(false);
            }
          },
        }}
        secondary={{ label: '回洞察', onClick: () => navigate('/insight') }}
      />
    );
  }

  const payload = card.payload;
  const amount = (cents: number): string => (showAmount ? formatCents(cents) : '金额已隐藏');

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Box>
          <Typography variant="h6" sx={{ fontSize: 20 }}>
            {formatMonthLabel(card.month_key)}复盘
          </Typography>
          <Typography variant="caption" color="text.secondary">
            生成于 {card.generated_at.slice(0, 10)} · 快照不会被后续补录改写
          </Typography>
        </Box>
        <Button size="small" onClick={() => navigate('/insight')}>
          返回
        </Button>
      </Box>

      <FormControlLabel
        control={<Switch checked={showAmount} onChange={(event) => setShowAmount(event.target.checked)} />}
        label={<Typography variant="body2">显示绝对金额（分享给他人时建议关闭）</Typography>}
        sx={{ mb: 1 }}
      />

      <Stack spacing={1.5}>
        <SectionCard title="① 这个月的收支">
          <Row label="支出" value={amount(payload.totals.expense_cents)} />
          <Row label="收入" value={amount(payload.totals.income_cents)} />
          <Row label="结余" value={amount(payload.totals.net_cents)} />
        </SectionCard>

        <SectionCard title="② 花得最多的三类">
          {payload.top3.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              没有支出记录。
            </Typography>
          ) : (
            payload.top3.map((item) => (
              <Row
                key={item.category_l1}
                label={`${l1Name(item.category_l1)} · ${Math.round(item.ratio * 100)}%`}
                value={amount(item.cents)}
              />
            ))
          )}
        </SectionCard>

        <SectionCard title="③ 最贵的一笔">
          {payload.priciest ? (
            <>
              <Typography variant="body2">
                {payload.priciest.date} · {payload.priciest.category_l2}
              </Typography>
              <Typography variant="h6" className="tabular">
                {amount(payload.priciest.cents)}
              </Typography>
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">
              没有支出。
            </Typography>
          )}
        </SectionCard>

        <SectionCard title="④ 你标记的「最不值」">
          {payload.most_worthless.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              这个月没有标记。下个月可以在流水里右滑标记。
            </Typography>
          ) : (
            <>
              <Typography variant="body2">共 {payload.most_worthless.length} 笔</Typography>
              <Typography variant="body2" color="text.secondary">
                合计 {amount(payload.most_worthless.reduce((acc, item) => acc + item.cents, 0))}
              </Typography>
            </>
          )}
        </SectionCard>

        <SectionCard title="⑤ 冲动消费">
          <Typography variant="body2">
            {payload.impulse.count} 笔 · 占支出 {Math.round(payload.impulse.ratio * 100)}%
          </Typography>
          <Typography variant="body2" color="text.secondary">
            合计 {amount(payload.impulse.cents)}
          </Typography>
        </SectionCard>

        <SectionCard title="⑥ 与上月对比">
          <Typography variant="body2">
            支出{payload.mom.expense_delta_cents <= 0 ? '减少' : '增加'} {amount(Math.abs(payload.mom.expense_delta_cents))}
            {payload.mom.expense_delta_ratio !== 0 && `（${Math.abs(payload.mom.expense_delta_ratio * 100).toFixed(1)}%）`}
          </Typography>
        </SectionCard>

        <SectionCard title="⑦ 储蓄目标进度">
          {payload.goal_progress.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              还没设目标。设一个"换手机 3000 元 / 12 月底"，进度会按结余自动算。
            </Typography>
          ) : (
            payload.goal_progress.map((goal) => (
              <Row
                key={goal.goal_id}
                label={`完成 ${Math.round(goal.percent * 100)}%`}
                value={goal.behind_cents > 0 ? `落后 ${amount(goal.behind_cents)}` : '按计划'}
              />
            ))
          )}
        </SectionCard>

        <SectionCard title="⑧ 一句时间成本">
          <Typography variant="body2">
            {payload.time_cost_line.hours > 0
              ? `这个月的支出 ≈ 你工作 ${payload.time_cost_line.hours} 小时（口径：${payload.time_cost_line.basis}）`
              : '还没有设置时薪，暂时算不出时间成本。'}
          </Typography>
          {payload.pending_uncategorized > 0 && (
            <Alert severity="info" sx={{ mt: 1 }}>
              有 {payload.pending_uncategorized} 笔当时未分类，分类占比会偏一点。
            </Alert>
          )}
        </SectionCard>

        <SectionCard title="分享文案（默认不含金额）">
          <Box sx={{ p: 1.5, borderRadius: 2, bgcolor: 'action.hover' }}>
            {shareLinesWithoutAmount(card).map((line) => (
              <Typography key={line} variant="body2" sx={{ mb: 0.5 }}>
                {line}
              </Typography>
            ))}
          </Box>
        </SectionCard>
      </Stack>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', py: 0.4 }}>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="body2" className="tabular" fontWeight={600}>
          {value}
        </Typography>
      </Box>
      <Divider />
    </>
  );
}
