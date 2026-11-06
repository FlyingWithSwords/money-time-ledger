import AddPhotoAlternateIcon from '@mui/icons-material/AddPhotoAlternate';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as holdingRepo from '../../../db/repos/holdingRepo';
import { describeError } from '../../../domain/errors';
import { todayDateString } from '../../../domain/date';
import { placeholderCode } from '../../../domain/holdingIdentity';
import { yuanToCents } from '../../../domain/money';
import { extractHoldingCandidates, extractHoldingRows } from '../../../import/holdingOcr';
import { recognizeLongImage, type LongOcrProgress } from '../../../import/ocrPipeline';
import { assessSourceSize } from '../../../import/ocrTiles';
import { useUiStore } from '../../../store/uiStore';
import { HOLDING_PLATFORM_LABEL, type Cents, type HoldingPlatform } from '../../../types';

/**
 * 持仓截图导入：选平台+截图 → 本机 OCR → 逐行校对 → 幂等入库。
 *
 * 平台必须在选图**前**定下来：(platform, fund_code) 是幂等键，
 * 同一张截图挂在「支付宝」和「天天基金」下就是两套独立持仓，
 * 事后再问「这是哪个平台的」等于让用户替系统记住状态。
 *
 * 隐私红线与 Import.tsx 的账单 OCR 一致：识别全在本机（tesseract WASM），
 * 截图不上传；识别结果一律过人工校对，绝不静默入库。
 */

/** 截图里能出现的平台（manual 只留给 Funds 页的手动添加入口） */
const PLATFORM_OPTIONS: readonly HoldingPlatform[] = ['alipay', 'tiantian', 'bank', 'broker', 'other'];

type Step = 'select' | 'recognizing' | 'review';

/** 校对行：OCR 结果的可编辑形态。数值一律存字符串，入库那一刻才解析。 */
interface EditableRow {
  fund_code: string;
  fund_name: string;
  shares: string;
  amountYuan: string;
  current_nav?: number;
  confidence: number;
  raw: string;
}

/** 金额字符串 → 分。空串返回 undefined（没识别到金额）；解析不了返回 null（行作废，不许静默丢）。 */
function amountTextToCents(text: string): Cents | null | undefined {
  const cleaned = text.trim().replace(/,/g, '');
  if (cleaned === '') return undefined;
  if (!/^[+-]?\d+(?:\.\d{1,4})?$/.test(cleaned)) return null;
  try {
    return yuanToCents(cleaned);
  } catch {
    return null;
  }
}

/**
 * 0 笔时的空态文案。长截图（tileCount > 1）已经分段识别过还是 0 笔，
 * 「换一张更清晰的截图」是无效建议——要给可行动的：分屏截图。
 */
export function emptyHoldingsHint(tileCount: number): string {
  return tileCount > 1
    ? '长截图已分段识别但没认出持仓行。这张页面文字太密，试试分屏截图（每次截一屏持仓列表）。'
    : '没有解析出持仓行，可以点「重新识别」换一张更清晰的截图。';
}

/**
 * 未识别行是否「像乱码」：连续英文碎片（won / ore / ann）占行文本的大头。
 * 这是「原图分辨率太低、文字被压糊」的典型输出——分片也救不回来的那种，
 * 提示用户换分辨率更高的原图，而不是怀疑识别引擎。
 */
export function looksLikeGarbage(lines: readonly string[]): boolean {
  if (lines.length === 0) return false;
  const garbageCount = lines.filter((line) => {
    const fragments = line.match(/[a-zA-Z]{2,}/g) ?? [];
    const garbageLength = fragments.join('').length;
    const total = line.replace(/\s+/g, '').length;
    return total > 0 && garbageLength / total >= 0.5;
  }).length;
  return garbageCount / lines.length >= 0.5;
}

export function ImportHoldingsDialog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const showSnack = useUiStore((state) => state.showSnack);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [platform, setPlatform] = useState<HoldingPlatform>('alipay');
  const [step, setStep] = useState<Step>('select');
  const [fileName, setFileName] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState<LongOcrProgress | null>(null);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [meanConfidence, setMeanConfidence] = useState(0);
  const [tileCount, setTileCount] = useState(1);
  /** 源图窄于 MIN_USABLE_WIDTH：文字在压缩时已丢失，直接给原因而不是让用户看乱码 */
  const [tooSmallAdvice, setTooSmallAdvice] = useState<string | null>(null);
  const [showUnmatched, setShowUnmatched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 走的是「列表页候选」通道（只有名称 + 金额，缺代码和份额） */
  const [candidateMode, setCandidateMode] = useState(false);
  /** 识别到含中文的行数：为 0 说明中文没认出来（深色截图/字太小），用于给准确诊断 */
  const [chineseLineCount, setChineseLineCount] = useState(0);

  /** 识别会话号：关掉对话框 / 重新识别后，旧的异步结果一律作废 */
  const runIdRef = useRef(0);

  // objectURL 生命周期统一在这一处管理：换图/清空/卸载时 revoke，绝不泄漏
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  // 每次打开都回到第 1 步（一次导入会话一张截图；跨会话残留状态只会让人困惑）
  useEffect(() => {
    if (!open) return;
    runIdRef.current += 1;
    setPlatform('alipay');
    setStep('select');
    setFileName(null);
    setPreviewUrl(null);
    setProgress(null);
    setRows([]);
    setUnmatched([]);
    setMeanConfidence(0);
    setTileCount(1);
    setTooSmallAdvice(null);
    setShowUnmatched(false);
    setError(null);
    setBusy(false);
    setCandidateMode(false);
    setChineseLineCount(0);
  }, [open]);

  const recognize = useCallback(async (source: Blob): Promise<void> => {
    const runId = (runIdRef.current += 1);
    setStep('recognizing');
    setProgress(null);
    setError(null);
    try {
      // 持仓页是表格布局（多列稀疏），sparse 模式才不会把相邻两列粘成一行。
      // 长截图（宽高比 2.4+）由 pipeline 自动分段识别，进度会显示「第 N/M 段」。
      const result = await recognizeLongImage(source, {
        mode: 'sparse',
        onProgress: (info) => {
          if (runIdRef.current === runId) setProgress(info);
        },
      });
      if (runIdRef.current !== runId) return;
      const extracted = extractHoldingRows(result.lines);
      const candidateResult = extractHoldingCandidates(result.lines);
      // 严格通道（代码 + 份额）优先；一行都认不出来时才走列表页候选。
      // 候选行在 UI 上明确标为「缺代码/份额」，用户补齐之前永远不会入库。
      const useCandidates = extracted.rows.length === 0 && candidateResult.candidates.length > 0;

      if (useCandidates) {
        const candidates = candidateResult.candidates;
        setRows(
          candidates.map((candidate) => ({
            fund_code: candidate.fund_code ?? '',
            fund_name: candidate.fund_name,
            shares: candidate.shares !== undefined ? String(candidate.shares) : '',
            amountYuan:
              candidate.market_value_cents !== undefined
                ? (candidate.market_value_cents / 100).toFixed(2)
                : '',
            confidence: candidate.confidence,
            raw: candidate.raw,
          })),
        );
        setUnmatched(candidateResult.unmatched);
        setMeanConfidence(
          Math.round(
            (candidates.reduce((sum, item) => sum + item.confidence, 0) / candidates.length) * 10,
          ) / 10,
        );
      } else {
        setRows(
          extracted.rows.map((row) => ({
            fund_code: row.fund_code,
            fund_name: row.fund_name,
            shares: String(row.shares),
            amountYuan: row.market_value_cents !== undefined ? (row.market_value_cents / 100).toFixed(2) : '',
            current_nav: row.current_nav,
            confidence: row.confidence,
            raw: row.raw,
          })),
        );
        setUnmatched(extracted.unmatched);
        setMeanConfidence(extracted.meanConfidence);
      }
      setCandidateMode(useCandidates);
      setChineseLineCount(candidateResult.chineseLineCount);
      setTileCount(result.tileCount);
      setTooSmallAdvice(assessSourceSize(result.width, result.height).advice);
      setShowUnmatched(false);
      setStep('review');
    } catch (err) {
      if (runIdRef.current !== runId) return;
      setError(describeError(err));
      setStep('select');
    }
  }, []);

  const onFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const file = event.target.files && event.target.files.length > 0 ? event.target.files[0] : null;
      // 清空 value：同一张图重选也能重新触发 onChange
      event.target.value = '';
      if (!file) return;
      const isImage =
        file.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp)$/i.test(file.name);
      if (!isImage) {
        setError('请选择截图图片（PNG / JPG / WebP）');
        return;
      }
      setFileName(file.name);
      setPreviewUrl(URL.createObjectURL(file)); // 旧的 URL 由上面的 effect 自动 revoke
      void recognize(file);
    },
    [recognize],
  );

  /** 重新识别：保留平台（幂等键不变），只换截图 */
  const restart = useCallback((): void => {
    runIdRef.current += 1;
    setStep('select');
    setFileName(null);
    setPreviewUrl(null);
    setProgress(null);
    setRows([]);
    setUnmatched([]);
    setMeanConfidence(0);
    setTileCount(1);
    setTooSmallAdvice(null);
    setShowUnmatched(false);
    setError(null);
    setCandidateMode(false);
    setChineseLineCount(0);
  }, []);

  const updateRow = useCallback((index: number, patch: Partial<EditableRow>): void => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }, []);

  const removeRow = useCallback((index: number): void => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const validRows = useMemo(
    () =>
      rows.filter((row) => {
        if (row.fund_name.trim() === '') return false;
        // 金额是「仅记市值」的唯一依据，必须有；解析不了的行排除，按钮计数会体现
        const amount = amountTextToCents(row.amountYuan);
        if (amount === null || amount === undefined) return false;
        // 份额留空 = 按市值记录（收益待补）；填了就必须是正数
        if (row.shares.trim() !== '') {
          const sharesValue = Number(row.shares);
          if (!Number.isFinite(sharesValue) || sharesValue <= 0) return false;
        }
        return true;
      }),
    [rows],
  );

  const doImport = useCallback(async (): Promise<void> => {
    if (validRows.length === 0 || busy) return;
    setBusy(true);
    try {
      const importRows: holdingRepo.ImportHoldingRow[] = validRows.map((row) => {
        // 代码留空（持仓列表页不显示代码）→ 用 NAME:<名称> 占位，
        // 同平台同名幂等覆盖；不参与行情查询，收益等用户补份额后再算。
        const code = row.fund_code.trim() || placeholderCode(row.fund_name);
        const marketValueCents = amountTextToCents(row.amountYuan) ?? undefined;
        const sharesValue = Number(row.shares);
        const shares =
          row.shares.trim() !== '' && Number.isFinite(sharesValue) && sharesValue > 0 ? sharesValue : 0;
        return {
          platform,
          fund_code: code,
          fund_name: row.fund_name.trim() || code,
          shares,
          market_value_cents: marketValueCents,
          current_nav: row.current_nav,
          date: todayDateString(),
        };
      });
      const outcome = await holdingRepo.importHoldings(importRows);
      showSnack({
        message: `新增 ${outcome.created} · 更新 ${outcome.updated} · 批内合并 ${outcome.mergedInBatch}`,
        severity: 'success',
      });
      onClose();
    } catch (err) {
      showSnack({ message: describeError(err), severity: 'error' });
    } finally {
      setBusy(false);
    }
  }, [busy, onClose, platform, showSnack, validRows]);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>从截图导入持仓</DialogTitle>
      <DialogContent dividers sx={{ pb: 2 }}>
        {step === 'select' && (
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              第 1 步 · 选平台和截图。同一只基金在支付宝和天天基金是两笔独立持仓，
              平台决定这次导入覆盖谁——请按截图实际来源选。
            </Typography>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={platform}
              onChange={(_event, value: HoldingPlatform | null) => {
                if (value !== null) setPlatform(value);
              }}
            >
              {PLATFORM_OPTIONS.map((option) => (
                <ToggleButton key={option} value={option}>
                  {HOLDING_PLATFORM_LABEL[option]}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <Stack direction="row" spacing={1} alignItems="center">
              <Button
                variant="outlined"
                startIcon={<AddPhotoAlternateIcon />}
                onClick={() => fileInputRef.current?.click()}
              >
                选择持仓页截图
              </Button>
              {fileName && (
                <Typography variant="body2" color="text.secondary" noWrap>
                  {fileName}
                </Typography>
              )}
            </Stack>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={onFileChange} hidden />
            <Typography variant="body2" color="text.secondary">
              截图在本机识别，不上传。识别完可以逐行核对再入库。
            </Typography>
            {error && (
              <Alert severity="error" sx={{ py: 0.25 }}>
                {error}
              </Alert>
            )}
          </Stack>
        )}

        {step === 'recognizing' && (
          <Stack spacing={2} alignItems="center" sx={{ py: 4 }}>
            <CircularProgress size={28} />
            <Typography variant="body2">{progress?.label ?? '正在识别（首次加载引擎需要几秒）'}</Typography>
            <Box sx={{ width: '100%' }}>
              <LinearProgress
                variant={progress && progress.progress > 0 ? 'determinate' : 'indeterminate'}
                value={progress ? Math.round(progress.progress * 100) : undefined}
              />
            </Box>
            {previewUrl && (
              <Box
                component="img"
                src={previewUrl}
                alt="待识别的持仓截图"
                sx={{ maxHeight: 160, maxWidth: '100%', borderRadius: 1, border: '1px solid', borderColor: 'divider' }}
              />
            )}
          </Stack>
        )}

        {step === 'review' && (
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <Typography variant="body2">
              {candidateMode
                ? `识别到 ${rows.length} 只基金 · 按名称 + 市值记录（收益待补）`
                : `共识别 ${rows.length} 笔 · 平均置信度 ${Math.round(meanConfidence)}%`}
            </Typography>
            {tileCount > 1 && (
              <Typography variant="caption" color="text.secondary">
                这是一张长截图，已按 {tileCount} 段识别（重叠 8% 拼接），识别耗时约为普通截图的 {tileCount} 倍
              </Typography>
            )}
            {/*
              源图过小要排在所有提示最前面，且用 error 而不是 info：
              这是「这张图注定失败」的唯一原因，用户最需要立刻知道的是
              「重新截图」，而不是先读到一堆「没认出持仓行」再去猜。
            */}
            {tooSmallAdvice && (
              <Alert severity="error" sx={{ py: 0.25 }}>
                {tooSmallAdvice}
              </Alert>
            )}
            {candidateMode && (
              <Alert severity="info" sx={{ py: 0.5 }}>
                这是持仓<strong>列表页</strong>：已识别基金名称和金额。可以直接导入——会按「名称 + 市值」记录，
                收益显示为「待补」，之后补上份额就自动计算。想立刻看到收益，也可以就地填代码和份额。
              </Alert>
            )}
            {rows.length > 0 && meanConfidence < 70 && (
              <Alert severity="warning" sx={{ py: 0.25 }}>
                平均置信度低于 70%，请务必逐行核对（低置信度的行已标黄）。
              </Alert>
            )}
            {rows.length === 0 && !tooSmallAdvice && (
              <Alert severity={chineseLineCount === 0 ? 'warning' : 'info'} sx={{ py: 0.25 }}>
                {chineseLineCount === 0
                  ? '这次没有识别到任何中文——截图可能是深色模式或字太小。请换浅色模式、用原始分辨率重截一次；从聊天软件转发的图务必选「原图」，不要用预览图。'
                  : emptyHoldingsHint(tileCount)}
              </Alert>
            )}
            {rows.map((row, index) => {
              const lowConfidence = row.confidence < 60;
              const amountCents = amountTextToCents(row.amountYuan);
              // 金额现在是必填（「仅记市值」唯一依据），空串也算缺
              const amountInvalid = amountCents === null || amountCents === undefined;
              const sharesInvalid =
                row.shares.trim() !== '' &&
                (!Number.isFinite(Number(row.shares)) || Number(row.shares) <= 0);
              return (
                <Box key={`${row.raw}-${index}`} sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                  {/* 六列固定宽度在窄屏会溢出：外层横向滚动，内层保底宽度保证列不被压扁 */}
                  <Box sx={{ overflowX: 'auto' }}>
                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: '92px minmax(0, 1fr) 104px 104px auto 34px',
                        minWidth: 560,
                        gap: 1,
                        alignItems: 'center',
                        bgcolor: lowConfidence ? 'warning.light' : 'transparent',
                        borderRadius: 1,
                        p: 0.5,
                      }}
                    >
                      <TextField
                        size="small"
                        label="代码"
                        value={row.fund_code}
                        onChange={(event) => updateRow(index, { fund_code: event.target.value })}
                        helperText={row.fund_code.trim() === '' ? '留空按名称记录' : ' '}
                      />
                      <TextField
                        size="small"
                        label="名称"
                        value={row.fund_name}
                        onChange={(event) => updateRow(index, { fund_name: event.target.value })}
                        helperText=" "
                      />
                      <TextField
                        size="small"
                        label="份额/克"
                        value={row.shares}
                        onChange={(event) => updateRow(index, { shares: event.target.value })}
                        error={sharesInvalid}
                        helperText={
                          row.shares.trim() === ''
                            ? '留空则先记市值'
                            : sharesInvalid
                              ? '份额需填大于 0 的数字'
                              : ' '
                        }
                      />
                      <TextField
                        size="small"
                        label="金额(元)"
                        value={row.amountYuan}
                        onChange={(event) => updateRow(index, { amountYuan: event.target.value })}
                        error={amountInvalid}
                        helperText={amountInvalid ? '金额必填：填数字（最多 4 位小数）' : ' '}
                      />
                      <Typography
                        variant="caption"
                        noWrap
                        color={lowConfidence ? 'warning.dark' : 'text.secondary'}
                        title={`原始行：${row.raw}`}
                      >
                        {lowConfidence ? `⚠ ${Math.round(row.confidence)}%` : `${Math.round(row.confidence)}%`}
                      </Typography>
                      <IconButton size="small" onClick={() => removeRow(index)} aria-label="删除这一行">
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Box>
                  </Box>
                  {/* holdingRepo 的反推语义必须如实告知：市值记成本 → 收益恒为 0 */}
                  {!amountInvalid && (
                    <Typography variant="caption" color="text.secondary" sx={{ pl: 1 }}>
                      {row.shares.trim() === ''
                        ? '按市值记录，收益显示「待补」——补上份额后自动计算'
                        : '截图没有成本信息，将按当前市值记成本，收益暂记 0——建议之后手动补真实成本'}
                    </Typography>
                  )}
                </Box>
              );
            })}
            {unmatched.length > 0 && (
              <Box>
                <Stack direction="row" spacing={1} alignItems="baseline">
                  <Button size="small" onClick={() => setShowUnmatched((prev) => !prev)}>
                    {showUnmatched ? '收起' : '展开'}未识别行（{unmatched.length}）
                  </Button>
                  {looksLikeGarbage(unmatched) && (
                    <Typography variant="caption" color="text.secondary">
                      输出像乱码，通常是原图分辨率太低
                    </Typography>
                  )}
                </Stack>
                <Collapse in={showUnmatched}>
                  <Typography variant="body2" color="text.disabled" sx={{ mt: 0.5 }}>
                    这些行看起来像持仓但没解析成功，如需入库请手动添加：
                  </Typography>
                  {unmatched.map((text, index) => (
                    <Typography key={`${text}-${index}`} variant="body2" color="text.disabled" noWrap title={text}>
                      {text}
                    </Typography>
                  ))}
                </Collapse>
              </Box>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          取消
        </Button>
        {step === 'review' && (
          <Button color="inherit" onClick={restart}>
            重新识别
          </Button>
        )}
        <Button variant="contained" disabled={validRows.length === 0 || busy} onClick={() => void doImport()}>
          {busy
            ? '导入中…'
            : candidateMode && validRows.some((row) => row.shares.trim() === '')
              ? `导入 ${validRows.length} 笔（含待补份额）`
              : `导入 ${validRows.length} 笔`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
