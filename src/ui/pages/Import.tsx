import CameraAltIcon from '@mui/icons-material/CameraAlt';
import DescriptionIcon from '@mui/icons-material/Description';
import TableChartIcon from '@mui/icons-material/TableChart';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  LinearProgress,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as batchRepo from '../../db/repos/batchRepo';
import * as dismissalRepo from '../../db/repos/dismissalRepo';
import * as transactionRepo from '../../db/repos/transactionRepo';
import { findCrossSourcePairs } from '../../domain/crossMatch';
import { describeError } from '../../domain/errors';
import { formatCents } from '../../domain/money';
import { TARGET_FIELDS, makeImportFile, type ImportFile, type Parser, type ParseOutcome, type TargetField } from '../../import/base';
import { detectParser } from '../../import/parsers';
import type { OcrMode, OcrProgress } from '../../import/ocrTypes';
import type { OcrScan } from '../../import/parsers/ocr';
import { runImport, undoImport, type ImportReport } from '../../import/pipeline';
import { checkLangPack } from '../../import/ocrPack';
import { SOURCE_LABEL } from '../../types';
import { useUiStore } from '../../store/uiStore';
import { OcrReview } from '../components/ocr/OcrReview';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { SectionCard } from '../components/SectionCard';

type EntryKind = 'bill' | 'ocr' | 'legacy';

/**
 * P3 导入：三入口（官方账单文件 / 截图识别 / 旧表格迁移）+ 字段映射预览
 * + 对账结果（明细合计 vs 文件合计，差一分红字）+ 导入历史与「撤销本次导入」。
 */
export function ImportPage(): JSX.Element {
  const showSnack = useUiStore((state) => state.showSnack);
  const inputRef = useRef<HTMLInputElement>(null);
  const [entry, setEntry] = useState<EntryKind>('bill');
  const [file, setFile] = useState<ImportFile | null>(null);
  const [parser, setParser] = useState<Parser | null>(null);
  const [outcome, setOutcome] = useState<ParseOutcome | null>(null);
  const [mapOverride, setMapOverride] = useState<Partial<Record<TargetField, string>>>({});
  const [defaultYear, setDefaultYear] = useState<number>(new Date().getFullYear());
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 撤销整批导入：先确认，写库期间锁按钮；与解析用的 busy 分开避免串状态。 */
  const [undoTarget, setUndoTarget] = useState<string | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  /** OCR 专用：预处理/引擎/识别三阶段的进度，只为了不让人对着转圈猜"是不是卡了" */
  const [ocrProgress, setOcrProgress] = useState<OcrProgress | null>(null);
  const [ocrScan, setOcrScan] = useState<OcrScan | null>(null);

  const batches = useLiveQuery(() => batchRepo.listRecent(12), [], []);
  const pack = useLiveQuery(() => checkLangPack(), [], null);
  const navigate = useNavigate();
  /**
   * 跨平台对账的实时候选组数。导入是产生跨来源重复的主要入口，
   * 数字在这里跟着导入结果动，用户刚导完账就能看到「有 N 组待对」。
   */
  const reconcileCandidateCount = useLiveQuery(async () => {
    const [allTxs, keys] = await Promise.all([
      transactionRepo.listAll(),
      dismissalRepo.listDismissedKeys(),
    ]);
    return findCrossSourcePairs(allTxs, new Set(keys)).length;
  }, [], 0);

  const headers = useMemo(() => {
    if (!outcome || outcome.rows.length === 0) return [];
    return Object.keys(outcome.rows[0].cells);
  }, [outcome]);

  const effectiveOutcome = useMemo<ParseOutcome | null>(() => {
    if (!outcome) return null;
    return { ...outcome, headerMap: { ...outcome.headerMap, ...mapOverride } };
  }, [outcome, mapOverride]);

  const openPicker = (kind: EntryKind): void => {
    setEntry(kind);
    setError(null);
    if (inputRef.current) {
      inputRef.current.accept = kind === 'ocr' ? 'image/*' : '.csv,.xlsx,.xls';
      inputRef.current.value = '';
      inputRef.current.click();
    }
  };

  const handleFile = async (selected: File): Promise<void> => {
    setBusy(true);
    setError(null);
    setReport(null);
    setOutcome(null);
    setOcrScan(null);
    setOcrProgress(null);
    setMapOverride({});
    try {
      const wrapped = makeImportFile(selected);
      setFile(wrapped);
      const detected = await detectParser(wrapped);
      if (!detected) {
        setParser(null);
        throw new Error('认不出这个文件格式。支持：微信/支付宝导出的 CSV、支付宝 XLSX、旧 Excel、账单截图');
      }
      setParser(detected);
      if (detected.id === 'ocr_image') {
        // 截图路径单独走：要拿到带 bbox/置信度的扫描结果，还要把引擎加载进度显示出来
        const ocr = await import('../../import/parsers/ocr');
        const parsed = await ocr.analyzeImportFile(wrapped, { mode: 'block', onProgress: setOcrProgress });
        setOutcome(parsed);
        setOcrScan(parsed.ocrScan ?? null);
        showSnack({ message: `识别出 ${parsed.rows.length} 行，请对照原图核对后再导入`, severity: 'info' });
        return;
      }
      const parsed = await detected.parse(wrapped, { defaultYear });
      setOutcome(parsed);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
      setOcrProgress(null);
    }
  };

  /**
   * 换模式重跑识别（整块 / 表格）。
   * 重跑会**整体替换**表格内容（包括用户已经改过的字段）：
   * 两套识别结果的行数、行边界都可能不同，硬做行级合并会把改对的值又冲掉一半。
   * 所以这里是明确的"重来"操作，snack 里要说清楚让人重新核对。
   */
  const handleRecognizeAgain = async (mode: OcrMode): Promise<void> => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setOcrProgress(null);
    try {
      const ocr = await import('../../import/parsers/ocr');
      const next = await ocr.analyzeImportFile(file, { mode, onProgress: setOcrProgress });
      setOutcome(next);
      setOcrScan(next.ocrScan ?? null);
      showSnack({
        message: `已用「${mode === 'sparse' ? '表格截图' : '整块文字'}」模式重新识别出 ${next.rows.length} 行，表格已重置，请重新核对`,
        severity: 'info',
      });
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
      setOcrProgress(null);
    }
  };

  const startImport = async (): Promise<void> => {
    if (!parser || !file || !effectiveOutcome) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runImport(file, {
        parser,
        preParsed: effectiveOutcome,
        defaultYear,
        fileName: file.name,
      });
      setReport(result);
      setOutcome(null);
      setOcrScan(null);
      setFile(null);
      setParser(null);
      showSnack({
        message: result.comparable && result.reconciled ? '导入完成，已对平' : '导入完成，请查看对账结果',
        severity: result.comparable && !result.reconciled ? 'warning' : 'success',
      });
    } catch (caught) {
      const reason = describeError(caught);
      setError(reason);
      showSnack({ message: `操作失败：${reason}`, severity: 'error' });
    } finally {
      setBusy(false);
    }
  };

  /** 点「撤销」只开确认框，不直接写库。 */
  const requestUndo = (batchId: string): void => {
    if (undoBusy) return;
    setUndoTarget(batchId);
  };

  const closeUndoDialog = (): void => {
    if (undoBusy) return;
    setUndoTarget(null);
  };

  /** 撤销整批导入：批量软删该批次的流水，失败不再静默。 */
  const doUndo = async (): Promise<void> => {
    if (!undoTarget || undoBusy) return;
    setUndoBusy(true);
    try {
      const count = await undoImport(undoTarget);
      showSnack({ message: `已撤销本次导入（${count} 笔）`, severity: 'info' });
    } catch (caught) {
      showSnack({ message: `操作失败：${describeError(caught)}`, severity: 'error' });
    } finally {
      setUndoBusy(false);
      setUndoTarget(null);
    }
  };

  const groups = [
    { kind: 'bill' as EntryKind, icon: <DescriptionIcon />, title: '官方账单文件', desc: '微信/支付宝导出 CSV，一次补齐几个月' },
    { kind: 'ocr' as EntryKind, icon: <CameraAltIcon />, title: '截图识别', desc: '本地 OCR，图片不出设备，结果需人工确认' },
    { kind: 'legacy' as EntryKind, icon: <TableChartIcon />, title: '旧表格迁移', desc: '把过去的 Excel 账还原成真实日期' },
  ];

  return (
    <>
      <Typography variant="h6" sx={{ fontSize: 20, mb: 0.5 }}>
        导入
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        文件全程在本机解析，不上传；重复的账不会静默丢弃，会列出来让你裁决
      </Typography>

      <input
        ref={inputRef}
        type="file"
        hidden
        onChange={(event) => {
          const selected = event.target.files?.[0];
          if (selected) void handleFile(selected);
        }}
      />

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' }, gap: 1.25 }}>
        {groups.map((group) => (
          <Box
            key={group.kind}
            role="button"
            tabIndex={0}
            onClick={() => openPicker(group.kind)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                // 空格默认滚动页面，拦掉才能让键盘用户安全地「按空格打开」
                event.preventDefault();
                openPicker(group.kind);
              }
            }}
            sx={{
              p: 1.75,
              borderRadius: 3,
              border: '1px solid',
              borderColor: 'divider',
              bgcolor: 'background.paper',
              cursor: 'pointer',
              '&:hover': { borderColor: 'primary.main' },
            }}
          >
            <Box sx={{ color: 'primary.main', mb: 0.5 }}>{group.icon}</Box>
            <Typography variant="subtitle2">{group.title}</Typography>
            <Typography variant="caption" color="text.secondary">
              {group.desc}
            </Typography>
          </Box>
        ))}
      </Box>

      {/*
        跨平台对账入口：只加这一块，不与上面的导入/OCR 逻辑发生任何耦合。
        候选数是 liveQuery 派生值，导入完成/裁决后自动刷新。
      */}
      <Box sx={{ mt: 1.5 }}>
        <SectionCard
          title="跨平台对账"
          subtitle="微信、支付宝、自制表格里的同一笔会被认出来，逐条确认"
          action={
            <Button size="small" onClick={() => navigate('/reconcile')}>
              去对账
            </Button>
          }
        >
          <Typography variant="body2" color={reconcileCandidateCount > 0 ? 'warning.main' : 'text.secondary'}>
            {reconcileCandidateCount > 0 ? `发现 ${reconcileCandidateCount} 组疑似同一笔` : '暂无疑似重复'}
          </Typography>
        </SectionCard>
      </Box>

      {entry === 'ocr' && pack && (
        <Alert severity={pack.available && !pack.degraded ? 'success' : 'warning'} sx={{ mt: 1.5 }}>
          {pack.hint}
          {!pack.available && (
            <Box sx={{ mt: 0.5 }}>
              <Typography variant="caption">下载后即可离线识别。命令：npm run fetch:tessdata</Typography>
            </Box>
          )}
        </Alert>
      )}

      {error && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {error}
        </Alert>
      )}

      {busy && (
        <Box sx={{ mt: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CircularProgress size={18} />
            <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
              {ocrProgress ? ocrProgress.label : '正在本地解析…'}
            </Typography>
            {ocrProgress && ocrProgress.progress > 0 && (
              <Typography variant="caption" color="text.secondary" className="tabular">
                {Math.round(ocrProgress.progress * 100)}%
              </Typography>
            )}
          </Box>
          {ocrProgress && (
            <LinearProgress
              variant={ocrProgress.progress > 0 ? 'determinate' : 'indeterminate'}
              value={Math.round(ocrProgress.progress * 100)}
              sx={{ mt: 1, borderRadius: 1 }}
            />
          )}
        </Box>
      )}

      {effectiveOutcome && parser && (
        <Box sx={{ mt: 2 }}>
          <SectionCard
            title={`${parser.label} · 解析到 ${effectiveOutcome.rows.length} 行`}
            subtitle={file ? file.name : undefined}
            action={
              <Button variant="contained" size="small" onClick={startImport} disabled={busy}>
                确认导入
              </Button>
            }
          >
            <Stack spacing={1.25}>
              {(parser.id === 'legacy_xlsx' || parser.id === 'alipay_xlsx') && (
                <TextField
                  size="small"
                  label="表格起始年份（旧表没有年份）"
                  type="number"
                  value={defaultYear}
                  onChange={(event) => setDefaultYear(Number(event.target.value))}
                  helperText="表里只有「2日」这种日期，用起始年份 + 月份分隔行推断真实日期"
                />
              )}

              {headers.length > 0 && parser.id !== 'ocr_image' && (
                <>
                  <Typography variant="caption" color="text.secondary">
                    字段映射（可以改；不改就用自动识别的结果）
                  </Typography>
                  <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1 }}>
                    {TARGET_FIELDS.map((field) => (
                      <TextField
                        key={field.key}
                        select
                        size="small"
                        label={`${field.label}${field.required ? ' *' : ''}`}
                        value={effectiveOutcome.headerMap[field.key] ?? ''}
                        onChange={(event) =>
                          setMapOverride((prev) => ({ ...prev, [field.key]: event.target.value }))
                        }
                      >
                        <MenuItem value="">不导入</MenuItem>
                        {headers.map((header) => (
                          <MenuItem key={header} value={header}>
                            {header}
                          </MenuItem>
                        ))}
                      </TextField>
                    ))}
                  </Box>
                </>
              )}

              {parser.id === 'ocr_image' ? (
                <OcrReview
                  rows={effectiveOutcome.rows}
                  scan={ocrScan}
                  busy={busy}
                  onChange={(rows) => setOutcome((prev) => (prev ? { ...prev, rows } : prev))}
                  onRecognizeAgain={(mode) => {
                    void handleRecognizeAgain(mode);
                  }}
                />
              ) : (
                <Box sx={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr>
                        {headers.slice(0, 6).map((header) => (
                          <th key={header} style={{ textAlign: 'left', padding: '4px 6px', opacity: 0.7 }}>
                            {header}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {effectiveOutcome.rows.slice(0, 5).map((row) => (
                        <tr key={row.rowIndex}>
                          {headers.slice(0, 6).map((header) => (
                            <td key={header} style={{ padding: '4px 6px', borderTop: '1px solid rgba(128,128,128,0.2)' }}>
                              {row.cells[header]}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Typography variant="caption" color="text.secondary">
                    仅预览前 5 行；汇总行会被自动跳过，不会入库
                  </Typography>
                </Box>
              )}

              {effectiveOutcome.issues.length > 0 && (
                <Alert severity="info">
                  {effectiveOutcome.issues.length} 条提示：
                  {effectiveOutcome.issues.slice(0, 3).map((issue) => (
                    <div key={`${issue.row}-${issue.reason}`}>
                      第 {issue.row} 行 · {issue.reason}
                    </div>
                  ))}
                </Alert>
              )}
            </Stack>
          </SectionCard>
        </Box>
      )}

      {report && (
        <Box sx={{ mt: 2 }}>
          <SectionCard title="导入完成">
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, mb: 1.5 }}>
              <Metric label="成功" value={String(report.insertedRows)} />
              <Metric label="疑似重复" value={String(report.duplicateRows)} tone="warning" />
              <Metric label="失败" value={String(report.failedRows)} tone="error" />
            </Box>
            <Stack spacing={0.75}>
              <Row label="明细合计（支出毛额）" value={formatCents(report.sumExpense)} />
              <Row label="退款冲正合计" value={formatCents(report.sumRefund)} />
              {report.investRows > 0 && (
                <Row
                  label={`其中投资本金 ${report.investRows} 笔（不计支出）`}
                  value={formatCents(report.investCents)}
                  tone="text.secondary"
                />
              )}
              <Row label="收入合计" value={formatCents(report.sumIncome)} />
              <Row
                label="文件声明支出合计"
                value={report.fileTotal?.expense !== undefined ? formatCents(report.fileTotal.expense) : '文件未提供'}
              />
              <Divider />
              <Row
                label="差异（文件 − 明细）"
                value={
                  report.diffExpense === null
                    ? '无法自动对账'
                    : report.diffExpense === 0
                      ? '✓ 对平'
                      : formatCents(report.diffExpense)
                }
                tone={report.diffExpense === null ? 'text.secondary' : report.diffExpense === 0 ? 'success.main' : 'error.main'}
              />
              {/*
                差异诊断就在差异行下面给出。
                月级结论已由 notes 统一列出（旧表解析器逐月比对后写入），
                这里只补 notes 覆盖不到的情形：单笔线索、以及定位不到的情况，
                免得同一句话在卡片里出现两遍。
              */}
              {report.diffHint && report.diffHint.scope !== 'month' && (
                <Typography variant="caption" color="error.main" display="block">
                  {report.diffHint.message}
                </Typography>
              )}
              {report.notes.length > 0 && (
                <Alert severity={report.diffExpense !== null && report.diffExpense !== 0 ? 'warning' : 'info'} sx={{ mt: 1 }}>
                  {report.notes.map((note) => (
                    <Typography key={note} variant="caption" display="block">
                      {note}
                    </Typography>
                  ))}
                </Alert>
              )}
              {report.pendingUncategorized > 0 && (
                <Alert severity="warning" sx={{ mt: 1 }}>
                  {report.pendingUncategorized} 笔未识别分类，已落到「其他/待分类」。去流水批量归位。
                </Alert>
              )}
              {report.issues.length > 0 && (
                <Box sx={{ mt: 1 }}>
                  <Typography variant="caption" color="text.secondary">
                    提示（{report.issues.length}）：
                  </Typography>
                  {report.issues.slice(0, 5).map((issue) => (
                    <Typography key={`${issue.row}-${issue.reason}`} variant="caption" color="text.secondary" display="block">
                      第 {issue.row} 行 · {issue.reason}
                    </Typography>
                  ))}
                </Box>
              )}
              <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                <Button variant="outlined" color="error" disabled={undoBusy} onClick={() => requestUndo(report.batchId)}>
                  撤销本次导入
                </Button>
              </Box>
            </Stack>
          </SectionCard>
        </Box>
      )}

      <Box sx={{ mt: 2 }}>
        <SectionCard title="导入历史" dense>
          {(batches ?? []).length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              还没有导入记录。
            </Typography>
          ) : (
            <Stack divider={<Divider />} spacing={1}>
              {(batches ?? []).map((batch) => (
                <Box key={batch.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Box sx={{ flex: 1, minWidth: 160 }}>
                    <Typography variant="body2" fontWeight={600}>
                      {batch.file_name ?? SOURCE_LABEL[batch.source]}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {batch.created_at.slice(0, 16).replace('T', ' ')} · 成功 {batch.inserted_rows} / 重复{' '}
                      {batch.duplicate_rows} / 失败 {batch.failed_rows} · 合计 {formatCents(batch.sum_expense_cents)}
                    </Typography>
                  </Box>
                  {batch.reconciled ? (
                    <Chip size="small" color="success" variant="outlined" label="已对平" />
                  ) : (
                    <Chip size="small" color="warning" variant="outlined" label="未对平" />
                  )}
                  {batch.undone_at ? (
                    <Chip size="small" label="已撤销" />
                  ) : (
                    <Button size="small" disabled={undoBusy} onClick={() => requestUndo(batch.id)}>
                      撤销
                    </Button>
                  )}
                </Box>
              ))}
            </Stack>
          )}
        </SectionCard>
      </Box>

      <ConfirmDialog
        open={undoTarget !== null}
        title="撤销本次导入？"
        message={
          <>
            <Typography variant="body2" gutterBottom>
              会把该批次导入的流水全部标记为已删除，从统计与流水列表里消失，批次会被记为「已撤销」。
            </Typography>
            <Typography variant="body2" color="text.secondary">
              数据不会真正抹掉：可以之后到流水页底部「已删除」里逐笔恢复，但这一步本身没有一键撤销。
            </Typography>
          </>
        }
        confirmLabel="确认撤销"
        destructive
        busy={undoBusy}
        onConfirm={() => {
          void doUndo();
        }}
        onClose={closeUndoDialog}
      />
    </>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }): JSX.Element {
  return (
    <Box sx={{ p: 1.25, borderRadius: 2, border: '1px solid', borderColor: 'divider', textAlign: 'center' }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography sx={{ fontSize: 20, fontWeight: 700, color: tone }} className="tabular">
        {value}
      </Typography>
    </Box>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }): JSX.Element {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontWeight: 600, color: tone }} className="tabular">
        {value}
      </Typography>
    </Box>
  );
}
