import { Alert, Box, Button, Radio, RadioGroup, FormControlLabel, Stack, TextField, Typography } from '@mui/material';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as settingsRepo from '../../../db/repos/settingsRepo';
import { centsToYuan, formatCents, yuanToCents } from '../../../domain/money';
import { resolveHourlyWage, WAGE_BASIS_LABEL, type WageBasis } from '../../../domain/timecost';
import { useUiStore } from '../../../store/uiStore';
import { SectionCard } from '../../components/SectionCard';
import { useWageSettings } from '../../hooks/useLedgerData';

/** 时薪三档口径 + 月工时 + 阈值。改完全站即时重算（data_version 递增触发）。 */
export function WagePage(): JSX.Element {
  const navigate = useNavigate();
  const showSnack = useUiStore((state) => state.showSnack);
  const settings = useWageSettings();
  const realHours = useLiveQuery(() => settingsRepo.getRealWageHours(), [], 0) ?? 0;

  const [mode, setMode] = useState<WageBasis>(settings.hourly_wage_mode);
  const [salary, setSalary] = useState(centsToYuan(settings.monthly_salary_cents));
  const [hours, setHours] = useState(String(settings.monthly_hours));
  const [manual, setManual] = useState(
    settings.hourly_wage_manual_cents !== null ? centsToYuan(settings.hourly_wage_manual_cents) : '',
  );
  const [workday, setWorkday] = useState(String(settings.workday_hours));
  const [threshold, setThreshold] = useState(centsToYuan(settings.time_cost_threshold_cents));
  const [realHoursInput, setRealHoursInput] = useState(String(realHours || ''));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMode(settings.hourly_wage_mode);
    setSalary(centsToYuan(settings.monthly_salary_cents));
    setHours(String(settings.monthly_hours));
    setManual(settings.hourly_wage_manual_cents !== null ? centsToYuan(settings.hourly_wage_manual_cents) : '');
    setWorkday(String(settings.workday_hours));
    setThreshold(centsToYuan(settings.time_cost_threshold_cents));
  }, [settings]);

  const preview = ((): string => {
    try {
      const resolved = resolveHourlyWage({
        hourly_wage_mode: mode,
        monthly_salary_cents: yuanToCents(salary || '0'),
        monthly_hours: Number(hours) || 0,
        hourly_wage_manual_cents: manual ? yuanToCents(manual) : null,
        workday_hours: Number(workday) || 8,
        time_cost_threshold_cents: yuanToCents(threshold || '0'),
      });
      return resolved.cents !== null
        ? `${formatCents(resolved.cents)} / 小时（${WAGE_BASIS_LABEL[resolved.basis ?? 'manual']}）`
        : '当前口径算不出时薪，时间成本不会显示';
    } catch {
      return '输入有误，请检查数字';
    }
  })();

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await settingsRepo.setWageSettings({
        hourly_wage_mode: mode,
        monthly_salary_cents: yuanToCents(salary || '0'),
        monthly_hours: Number(hours) || 0,
        hourly_wage_manual_cents: manual ? yuanToCents(manual) : null,
        workday_hours: Number(workday) || 8,
        time_cost_threshold_cents: yuanToCents(threshold || '0'),
      });
      await settingsRepo.setRealWageHours(Number(realHoursInput) || 0);
      showSnack({ message: '已保存，全站时间成本已重算', severity: 'success' });
      navigate('/settings');
    } catch (error) {
      showSnack({ message: `操作失败：${error instanceof Error ? error.message : String(error)}`, severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Typography variant="h6" sx={{ fontSize: 20, mb: 1.5 }}>
        时薪与时间成本
      </Typography>

      <SectionCard title="口径" dense>
        <RadioGroup value={mode} onChange={(event) => setMode(event.target.value as WageBasis)}>
          <FormControlLabel value="salary_div_hours" control={<Radio size="small" />} label="月薪 ÷ 月工时（默认）" />
          <FormControlLabel value="manual" control={<Radio size="small" />} label="直接填时薪" />
          <FormControlLabel value="real" control={<Radio size="small" />} label="真实时薪 = 近 3 笔接单收入 ÷ 填报工时" />
        </RadioGroup>
        <Alert severity="info" sx={{ mt: 1 }}>
          用户选定的口径优先；数据不足时会自动回落到下一个可用口径，并在页面上标注实际口径。
        </Alert>
      </SectionCard>

      <Box sx={{ mt: 1.5 }}>
        <SectionCard title="参数" dense>
          <Stack spacing={1.5}>
            <TextField label="月薪（元）" value={salary} onChange={(e) => setSalary(e.target.value)} inputProps={{ inputMode: 'decimal' }} />
            <TextField
              label="月工时（小时）"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              inputProps={{ inputMode: 'numeric' }}
              helperText="默认 174 小时 ≈ 21.75 天 × 8 小时"
            />
            <TextField
              label="直填时薪（元/小时）"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              inputProps={{ inputMode: 'decimal' }}
              helperText="选择「直接填时薪」时使用"
            />
            <TextField
              label="近 3 笔接单的工时合计（小时）"
              value={realHoursInput}
              onChange={(e) => setRealHoursInput(e.target.value)}
              inputProps={{ inputMode: 'decimal' }}
              helperText="真实时薪口径需要它；留 0 表示暂时不用这个口径"
            />
            <TextField
              label="一个工作日多少小时"
              value={workday}
              onChange={(e) => setWorkday(e.target.value)}
              inputProps={{ inputMode: 'numeric' }}
              helperText="换算 ≥8 小时时改显示「工作日」，基准固定这里填的值"
            />
            <TextField
              label="流水行显示时间成本的阈值（元）"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              inputProps={{ inputMode: 'decimal' }}
              helperText="低于这个金额的支出不显示小时数，避免每行都是 0.0x"
            />
          </Stack>
        </SectionCard>
      </Box>

      <Box sx={{ mt: 1.5 }}>
        <SectionCard dense>
          <Typography variant="body2" color="text.secondary">
            当前口径
          </Typography>
          <Typography variant="subtitle1" fontWeight={700}>
            {preview}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
            <Button variant="contained" onClick={save} disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </Button>
            <Button onClick={() => navigate('/settings')} disabled={busy}>
              返回
            </Button>
          </Box>
        </SectionCard>
      </Box>

      <MenuExample />
    </>
  );
}

function MenuExample(): JSX.Element {
  return (
    <Box sx={{ mt: 1.5 }}>
      <SectionCard title="换算规则" dense>
        <Typography variant="body2" color="text.secondary">
          小时数 = 金额 ÷ 时薪，保留 2 位小数并向下取整（避免夸大）；达到「一个工作日」时长后改显示工作日数。
          如果所有口径都算不出时薪，页面不显示 0，而是给一次性引导。
        </Typography>
        <Box component="ul" sx={{ pl: 2.5, mt: 1, mb: 0 }}>
          <MenuItemEx>只做参照，不做「你真浪费」式评判</MenuItemEx>
          <MenuItemEx>阈值与口径随时可关闭或修改</MenuItemEx>
          <MenuItemEx>改完立刻生效，不需要重算历史数据</MenuItemEx>
        </Box>
      </SectionCard>
    </Box>
  );
}

function MenuItemEx({ children }: { children: string }): JSX.Element {
  return (
    <Typography component="li" variant="body2" color="text.secondary">
      {children}
    </Typography>
  );
}
