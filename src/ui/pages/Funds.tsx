import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useLiveQuery } from 'dexie-react-hooks';
import { nanoid } from 'nanoid';
import { lazy, Suspense, useState } from 'react';
import * as holdingRepo from '../../db/repos/holdingRepo';
import { formatCents, yuanToCents } from '../../domain/money';
import { describeError } from '../../domain/errors';
import { isTradingHours } from '../../quotes/scheduler';
import { fundsService } from '../../quotes/fundService';
import { saveManualNav } from '../../quotes/manual';
import { fetchFundName } from '../../quotes/pzdata';
import type { QuoteRange } from '../../quotes/types';
import { todayDateString } from '../../domain/date';
import { displayHoldingCode, isPlaceholderCode } from '../../domain/holdingIdentity';
import { HOLDING_PLATFORM_LABEL, type Holding, type HoldingPlatform } from '../../types';
import { FillHoldingDialog } from './funds/FillHoldingDialog';
import { ImportHoldingsDialog } from './funds/ImportHoldingsDialog';
import { useUiStore } from '../../store/uiStore';
import { EmptyState } from '../components/EmptyState';
import { SectionCard } from '../components/SectionCard';
import { MoneyText } from '../components/MoneyText';

const NavLine = lazy(() => import('../charts/NavLine'));

/**
 * P4 基金：持仓、市值、收益，并入净资产。
 * 估值口径（主理人裁定）：交易时段显示「最近净值 + 净值日期」；场内 LOF/ETF 才显示「场内价」。
 * 不插值、不伪造、不显示 0。
 */
export function Funds(): JSX.Element {
  const showSnack = useUiStore((state) => state.showSnack);
  const state = useLiveQuery(() => fundsService.loadFundsState(), [], null);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [manualFor, setManualFor] = useState<string | null>(null);
  const [range, setRange] = useState<QuoteRange>('1y');
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  /** 正在补份额的「仅市值」持仓 */
  const [fillHolding, setFillHolding] = useState<Holding | null>(null);

  const trading = isTradingHours();
  const views = state?.views ?? [];
  /** 只有名称和市值、还没填份额的持仓数（列表页截图导入的降级记录） */
  const placeholderCount = views.filter((view) => view.holding.shares <= 0).length;
  // 净值曲线优先选有真实代码的持仓：占位代码查不到任何行情
  const firstRealCode = views.find((view) => !isPlaceholderCode(view.holding.fund_code))?.holding.fund_code;
  const activeCode = selectedCode ?? firstRealCode ?? views[0]?.holding.fund_code ?? null;
  const series = useLiveQuery(
    () => (activeCode ? fundsService.loadSeries(activeCode, range) : Promise.resolve([])),
    [activeCode, range],
    [],
  );

  const handleRefresh = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await fundsService.refreshFunds();
      const failed = result.outcomes.filter((outcome) => outcome.degraded === 'unavailable');
      showSnack({
        message: failed.length === 0 ? '行情已刷新' : `${failed.length} 只基金暂时取不到价格，已用手填/缓存`,
        severity: failed.length === 0 ? 'success' : 'warning',
      });
    } catch (error) {
      showSnack({ message: describeError(error), severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Box>
          <Typography variant="h6" sx={{ fontSize: 20 }}>
            基金
          </Typography>
          <Typography variant="caption" color="text.secondary">
            市值并入净资产 · 数据只存本机
          </Typography>
        </Box>
        <Button
          size="small"
          startIcon={busy ? <CircularProgress size={14} /> : <RefreshIcon />}
          onClick={handleRefresh}
          disabled={busy}
        >
          刷新
        </Button>
      </Box>

      <SectionCard dense>
        <Typography variant="caption" color="text.secondary">
          总市值
        </Typography>
        <MoneyText cents={state?.totalValueCents ?? 0} size="hero" />
        <Box sx={{ display: 'flex', gap: 2, mt: 0.5, flexWrap: 'wrap' }}>
          <Typography variant="caption" color="text.secondary">
            成本 {formatCents(state?.totalCostCents ?? 0)}
          </Typography>
          <Typography
            variant="caption"
            sx={{ color: (state?.totalProfitCents ?? 0) >= 0 ? 'success.main' : 'error.main' }}
          >
            持有收益 {formatCents(state?.totalProfitCents ?? 0)}
            {state?.totalProfitRatio != null ? `（${(state.totalProfitRatio * 100).toFixed(2)}%）` : ''}
          </Typography>
        </Box>
        {state?.hasStale && (
          <Alert severity="info" sx={{ mt: 1.25, py: 0.25 }}>
            部分持仓用的是本地缓存价格，数字旁边标注了净值日期。绝不用 0 代替。
          </Alert>
        )}
        {placeholderCount > 0 && (
          <Alert severity="info" sx={{ mt: 1.25, py: 0.25 }}>
            有 {placeholderCount} 只持仓是按「名称 + 市值」记录的（列表页截图没有份额），
            补上份额后才会计算收益。总收益里暂未计入它们的盈亏。
          </Alert>
        )}
      </SectionCard>

      <Box sx={{ mt: 1.5 }}>
        {views.length === 0 ? (
          <EmptyState
            icon="📈"
            title="还没有持仓"
            description="填基金代码、份额和成本，就能看到市值与收益，并自动并入净资产。"
            primary={{ label: '添加持仓', onClick: () => setAddOpen(true) }}
          />
        ) : (
          <SectionCard title="持仓" dense>
            <Stack divider={<Divider />} spacing={1.25}>
              {views.map((view) => (
                <ButtonBase
                  key={view.holding.id}
                  component="div"
                  aria-label={
                    isPlaceholderCode(view.holding.fund_code)
                      ? `${view.holding.fund_name}，份额待补`
                      : `查看 ${view.holding.fund_name || view.holding.fund_code} 的净值曲线`
                  }
                  onClick={() => {
                    // 占位代码没有行情，切过去只会让曲线区变成空的
                    if (!isPlaceholderCode(view.holding.fund_code)) setSelectedCode(view.holding.fund_code);
                  }}
                  sx={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    borderRadius: 1,
                    cursor: 'pointer',
                    '&:focus-visible, &.Mui-focusVisible': {
                      outline: (theme) => `2px solid ${theme.palette.primary.main}`,
                      outlineOffset: 2,
                    },
                  }}
                >
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2" fontWeight={600}>
                        {view.holding.fund_name || view.holding.fund_code}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {view.holding.shares > 0
                          ? `${displayHoldingCode(view.holding.fund_code)} · ${view.holding.shares} 份 · 成本净值 ${view.cost_nav.toFixed(4)}`
                          : `${displayHoldingCode(view.holding.fund_code)} · 按市值记录 · 份额待补`}
                      </Typography>
                      <Chip
                        size="small"
                        variant="outlined"
                        label={HOLDING_PLATFORM_LABEL[view.holding.platform] ?? view.holding.platform}
                        sx={{ height: 18, fontSize: 10, mt: 0.25, '& .MuiChip-label': { px: 0.75 } }}
                      />
                    </Box>
                    <Box sx={{ textAlign: 'right' }}>
                      <Typography variant="body2" className="tabular" fontWeight={600}>
                        {view.market_value_cents !== null ? formatCents(view.market_value_cents) : '暂无价格'}
                      </Typography>
                      <Typography
                        variant="caption"
                        sx={{
                          color:
                            view.profit_cents === null
                              ? 'text.secondary'
                              : view.profit_cents >= 0
                                ? 'success.main'
                                : 'error.main',
                        }}
                      >
                        {view.profit_cents !== null
                          ? `${formatCents(view.profit_cents)}（${((view.profit_ratio ?? 0) * 100).toFixed(2)}%）`
                          : view.holding.shares > 0
                            ? '—'
                            : '收益待补'}
                      </Typography>
                    </Box>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 0.75, mt: 0.5, alignItems: 'center', flexWrap: 'wrap' }}>
                    {view.holding.shares <= 0 ? (
                      <>
                        <Chip size="small" variant="outlined" label="份额待补" />
                        <Typography variant="caption" color="text.secondary">
                          补上份额后自动计算市值与收益
                        </Typography>
                        <Button
                          size="small"
                          onClick={(event) => {
                            // 行本身是 ButtonBase，不拦住会把点击当成「查看净值曲线」
                            event.stopPropagation();
                            setFillHolding(view.holding);
                          }}
                        >
                          补份额
                        </Button>
                      </>
                    ) : (
                      <>
                        <Chip
                          size="small"
                          variant="outlined"
                          label={
                            view.nav !== null
                              ? `${view.quote_kind === 'market_price' ? '场内价' : '净值'} ${view.nav.toFixed(4)}`
                              : '没有净值'
                          }
                        />
                        <Typography variant="caption" color="text.secondary">
                          {view.nav_date ? `数据截至 ${view.nav_date}` : '点「填净值」手动补'}
                        </Typography>
                        <Button size="small" onClick={() => setManualFor(view.holding.fund_code)}>
                          填净值
                        </Button>
                      </>
                    )}
                  </Box>
                </ButtonBase>
              ))}
            </Stack>
          </SectionCard>
        )}
      </Box>

      {views.length > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <SectionCard
            title="净值曲线"
            subtitle={activeCode ? `${activeCode} · ${trading ? '交易时段' : '非交易时段，显示最近净值'}` : undefined}
            action={
              <ToggleButtonGroup
                size="small"
                exclusive
                value={range}
                onChange={(_, value) => value && setRange(value as QuoteRange)}
              >
                <ToggleButton value="1m">月</ToggleButton>
                <ToggleButton value="1y">年</ToggleButton>
                <ToggleButton value="all">全部</ToggleButton>
              </ToggleButtonGroup>
            }
            dense
          >
            {(series ?? []).length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                还没有净值历史：先刷新一次，或手动填一次净值。
              </Typography>
            ) : (
              <Suspense fallback={<Box sx={{ height: 200 }} />}>
                <NavLine points={series ?? []} />
              </Suspense>
            )}
          </SectionCard>
        </Box>
      )}

      <Box sx={{ mt: 2, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setAddOpen(true)}>
          添加持仓
        </Button>
        <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setImportOpen(true)}>
          从截图导入持仓
        </Button>
      </Box>

      <AddHoldingDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={(message) => showSnack({ message, severity: 'success' })}
      />
      <ImportHoldingsDialog open={importOpen} onClose={() => setImportOpen(false)} />
      {fillHolding && (
        <FillHoldingDialog open holding={fillHolding} onClose={() => setFillHolding(null)} />
      )}
      <ManualNavDialog code={manualFor} onClose={() => setManualFor(null)} onSaved={(message) => showSnack({ message, severity: 'success' })} />
    </>
  );
}

function AddHoldingDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}): JSX.Element {
  const showSnack = useUiStore((state) => state.showSnack);
  const [code, setCode] = useState('');
  const [platform, setPlatform] = useState<HoldingPlatform>('manual');
  const [name, setName] = useState('');
  const [shares, setShares] = useState('');
  const [cost, setCost] = useState('');
  const [date, setDate] = useState(todayDateString());
  /** 保存是异步写，处理中锁住按钮，防连点生成重复持仓。 */
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    try {
      if (!/^\d{6}$/.test(code)) throw new Error('基金代码必须是 6 位数字');
      const shareValue = Number(shares);
      if (!Number.isFinite(shareValue) || shareValue <= 0) throw new Error('份额要大于 0');
      const costCents = yuanToCents(cost);
      if (costCents <= 0) throw new Error('成本要大于 0');
      const resolvedName = name.trim() || (await fetchFundName(code)) || code;
      await holdingRepo.addPosition({
        id: nanoid(12),
        platform,
        fund_code: code,
        fund_name: resolvedName,
        shares: shareValue,
        cost_cents: costCents,
        date,
      });
      onSaved('持仓已保存');
      onClose();
      setCode('');
      setName('');
      setShares('');
      setCost('');
    } catch (error) {
      showSnack({ message: describeError(error), severity: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>添加持仓</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ pt: 1 }}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={platform}
            onChange={(_, value) => value && setPlatform(value as HoldingPlatform)}
          >
            {(Object.keys(HOLDING_PLATFORM_LABEL) as HoldingPlatform[]).map((key) => (
              <ToggleButton key={key} value={key}>
                {HOLDING_PLATFORM_LABEL[key]}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <TextField label="基金代码（6 位）" value={code} onChange={(e) => setCode(e.target.value.trim())} inputProps={{ inputMode: 'numeric' }} />
          <TextField label="名称（可留空自动获取）" value={name} onChange={(e) => setName(e.target.value)} />
          <TextField label="份额" value={shares} onChange={(e) => setShares(e.target.value)} inputProps={{ inputMode: 'decimal' }} />
          <TextField
            label="总成本（元）"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            inputProps={{ inputMode: 'decimal' }}
            helperText="多次加仓会自动合并为加权成本"
          />
          <TextField label="买入日期" type="date" value={date} onChange={(e) => setDate(e.target.value)} InputLabelProps={{ shrink: true }} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>取消</Button>
        <Button variant="contained" onClick={() => void save()} disabled={saving}>
          保存
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ManualNavDialog({
  code,
  onClose,
  onSaved,
}: {
  code: string | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}): JSX.Element {
  const showSnack = useUiStore((state) => state.showSnack);
  const [nav, setNav] = useState('');
  const [date, setDate] = useState(todayDateString());
  /** 保存是异步写，处理中锁住按钮，防连点写入多条净值。 */
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    try {
      if (!code) return;
      const value = Number(nav);
      if (!Number.isFinite(value) || value <= 0) throw new Error('净值要大于 0');
      await saveManualNav({ code, nav: value, nav_date: date });
      onSaved('净值已记录');
      onClose();
      setNav('');
    } catch (error) {
      showSnack({ message: describeError(error), severity: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={code !== null} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>手动填净值 · {code}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5} sx={{ pt: 1 }}>
          <TextField label="单位净值" value={nav} onChange={(e) => setNav(e.target.value)} inputProps={{ inputMode: 'decimal' }} />
          <TextField label="净值日期" type="date" value={date} onChange={(e) => setDate(e.target.value)} InputLabelProps={{ shrink: true }} />
          <Typography variant="caption" color="text.secondary">
            手填的价格同样会参与市值计算，并标注来源为「手填」。
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>取消</Button>
        <Button variant="contained" onClick={() => void save()} disabled={saving}>
          保存
        </Button>
      </DialogActions>
    </Dialog>
  );
}
