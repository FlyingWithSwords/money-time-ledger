import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrong';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useEffect, useMemo, useRef, useState } from 'react';
import { yuanToCents } from '../../../domain/money';
import type { RawRow } from '../../../import/base';
import { LOW_LINE_CONFIDENCE } from '../../../import/ocrQuality';
import { OCR_DATE_INFERRED_CELL, type OcrMode } from '../../../import/ocrTypes';
import type { OcrRowAnnotation, OcrScan } from '../../../import/parsers/ocr';
import { OcrImageViewer, type OcrFocusRequest } from './OcrImageViewer';

/**
 * 截图识别结果的人工校对台：左图右表（手机上下排），行与图互相定位。
 *
 * 为什么值得做图片联动：OCR 的错法很有规律——把「1」认成「7」、把「8.00」认成「8.0O」。
 * 只看表格时用户没有参照物，只能凭记忆判断；对着原图的框看，一秒就能确认。
 * 所以定位按钮不是"锦上添花"，它是把"要不要信这一行"的成本从 10 秒降到 1 秒。
 */

interface Props {
  rows: RawRow[];
  scan: OcrScan | null;
  busy: boolean;
  onChange: (rows: RawRow[]) => void;
  onRecognizeAgain: (mode: OcrMode) => void;
}

const MODE_LABEL: Record<OcrMode, string> = {
  block: '整块文字',
  sparse: '表格截图',
};

export function OcrReview({ rows, scan, busy, onChange, onRecognizeAgain }: Props): JSX.Element {
  const isDesktop = useMediaQuery('(min-width:900px)');
  const [mode, setMode] = useState<OcrMode>(scan?.mode ?? 'block');
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [focusRequest, setFocusRequest] = useState<OcrFocusRequest | null>(null);
  const [edited, setEdited] = useState<Set<number>>(() => new Set());
  const [collapsed, setCollapsed] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const imagePaneRef = useRef<HTMLDivElement | null>(null);
  const autoCollapsed = useRef(false);

  // 对象 URL 必须显式回收：连着传 10 张图不 revoke，手机上能吃掉几百 MB
  useEffect(() => {
    const blob = scan?.image.blob;
    if (!blob || typeof URL.createObjectURL !== 'function') {
      setImageUrl(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [scan?.image.blob]);

  // 重新识别之后是一份新结果：旧的"已改"标记和选中行都不再有意义。
  // 依赖整个 scan 对象是安全的：Import 侧把同一个引用透传下来，只有重新识别才会换对象。
  useEffect(() => {
    setEdited(new Set());
    setActiveRow(null);
    setFocusRequest(null);
    if (scan) setMode(scan.mode);
  }, [scan]);

  const annotations = useMemo(() => {
    const map = new Map<number, OcrRowAnnotation>();
    scan?.rows.forEach((annotation) => map.set(annotation.rowIndex, annotation));
    return map;
  }, [scan]);

  const boxes = useMemo(
    () =>
      rows
        .map((row) => {
          const annotation = annotations.get(row.rowIndex);
          return annotation?.bbox ? { rowIndex: row.rowIndex, bbox: annotation.bbox } : null;
        })
        .filter((item): item is { rowIndex: number; bbox: NonNullable<OcrRowAnnotation['bbox']> } => item !== null),
    [rows, annotations],
  );

  // 手机：滚到表格、图片整块离开视口时自动收起（只自动收一次，之后听用户的）
  useEffect(() => {
    if (isDesktop) {
      setCollapsed(false);
      return;
    }
    const handler = (): void => {
      if (autoCollapsed.current) return;
      const element = imagePaneRef.current;
      if (!element) return;
      if (element.getBoundingClientRect().bottom <= 8) {
        autoCollapsed.current = true;
        setCollapsed(true);
      }
    };
    window.addEventListener('scroll', handler, { passive: true });
    return () => window.removeEventListener('scroll', handler);
  }, [isDesktop]);

  const updateCell = (rowIndex: number, field: '金额' | '日期' | '项目', value: string): void => {
    onChange(
      rows.map((row) => {
        if (row.rowIndex !== rowIndex) return row;
        const cells = { ...row.cells, [field]: value };
        // 用户自己补了四位年份，「年份为推断」的提示就不成立了，必须撤掉，
        // 否则他会以为填错了、反复改一个本来就对的日期
        if (field === '日期' && /^\s*\d{4}/.test(value)) delete cells[OCR_DATE_INFERRED_CELL];
        return { ...row, cells };
      }),
    );
    setEdited((prev) => {
      const next = new Set(prev);
      next.add(rowIndex);
      return next;
    });
  };

  const removeRow = (rowIndex: number): void => {
    onChange(rows.filter((row) => row.rowIndex !== rowIndex));
    if (activeRow === rowIndex) setActiveRow(null);
  };

  /** 表格 → 图片：放大定位 + 画高亮框 */
  const locateRow = (rowIndex: number): void => {
    const annotation = annotations.get(rowIndex);
    if (!annotation?.bbox) return;
    setActiveRow(rowIndex);
    setFocusRequest({ bbox: annotation.bbox, token: Date.now() });
    setCollapsed(false);
  };

  /** 图片 → 表格：滚动到对应行并高亮 */
  const selectFromImage = (rowIndex: number): void => {
    setActiveRow(rowIndex);
    const node = rowRefs.current.get(rowIndex);
    node?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  };

  const quality = scan?.quality;
  const meanConfidence = scan?.meanConfidence ?? 0;
  const confidenceColor = (value: number): 'success' | 'warning' | 'default' => {
    if (value < LOW_LINE_CONFIDENCE) return 'warning';
    if (value >= 85) return 'success';
    return 'default';
  };

  return (
    <Box>
      {quality?.warnOverall && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          整体识别质量偏低（平均 {Math.round(meanConfidence)}%），建议放大图片后重试，或逐行核对
        </Alert>
      )}
      {scan?.degraded && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          缺少英文语言包，英文商户名与金额可能识别不准（运行 npm run fetch:tessdata 补齐）
        </Alert>
      )}
      {scan?.image.skipped && (
        <Alert severity="info" sx={{ mb: 1 }}>
          浏览器未能增强图片（{scan.preprocessNote ?? '环境不支持 canvas'}），已按原图识别；识别率可能偏低
        </Alert>
      )}

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        alignItems={{ xs: 'stretch', sm: 'center' }}
        sx={{ mb: 1 }}
      >
        <Stack direction="row" spacing={0.5} alignItems="center" sx={{ flex: 1, flexWrap: 'wrap' }}>
          <Typography variant="caption" color="text.secondary">
            识别参考，请核对金额
          </Typography>
          {scan && (
            <Chip
              size="small"
              variant="outlined"
              color={quality?.overall === 'poor' ? 'warning' : quality?.overall === 'good' ? 'success' : 'default'}
              label={`平均置信度 ${Math.round(meanConfidence)}%`}
            />
          )}
          {scan?.image.scaled && scan.image.scaled !== 1 && (
            <Chip size="small" variant="outlined" label={`图片已${scan.image.scaled > 1 ? '放大' : '缩小'} ${scan.image.scaled}×`} />
          )}
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          <ToggleButtonGroup
            size="small"
            exclusive
            value={mode}
            onChange={(_event, next: OcrMode | null) => {
              if (next) setMode(next);
            }}
            aria-label="识别模式"
          >
            <ToggleButton value="block" sx={{ py: 0.25, px: 1, fontSize: 12 }}>
              {MODE_LABEL.block}
            </ToggleButton>
            <ToggleButton value="sparse" sx={{ py: 0.25, px: 1, fontSize: 12 }}>
              {MODE_LABEL.sparse}
            </ToggleButton>
          </ToggleButtonGroup>
          <Button
            size="small"
            variant="outlined"
            startIcon={<RefreshIcon fontSize="small" />}
            disabled={busy}
            onClick={() => onRecognizeAgain(mode)}
          >
            重新识别
          </Button>
        </Stack>
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '45% 1fr' },
          gap: 1.5,
          alignItems: 'start',
        }}
      >
        <Box
          ref={imagePaneRef}
          sx={{
            position: { md: 'sticky' },
            top: { md: 8 },
            borderRadius: 2,
            border: '1px solid',
            borderColor: 'divider',
            overflow: 'hidden',
            bgcolor: 'background.paper',
          }}
        >
          <Box
            role="button"
            tabIndex={0}
            onClick={() => setCollapsed((prev) => !prev)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') setCollapsed((prev) => !prev);
            }}
            sx={{
              display: { xs: 'flex', md: 'none' },
              alignItems: 'center',
              gap: 0.5,
              px: 1,
              py: 0.75,
              cursor: 'pointer',
              bgcolor: 'action.hover',
            }}
          >
            <Typography variant="caption" sx={{ flex: 1, fontWeight: 600 }}>
              原图预览{scan?.image.width ? `（${scan.image.width}×${scan.image.height}）` : ''}
            </Typography>
            {collapsed ? <ExpandMoreIcon fontSize="small" /> : <ExpandLessIcon fontSize="small" />}
          </Box>
          {imageUrl && (!collapsed || isDesktop) ? (
            <Box sx={{ height: { xs: '40vh', md: '62vh' } }}>
              <OcrImageViewer
                src={imageUrl}
                boxes={boxes}
                activeRowIndex={activeRow}
                focusRequest={focusRequest}
                onSelectRow={selectFromImage}
              />
            </Box>
          ) : (
            !imageUrl && (
              <Box sx={{ p: 2 }}>
                <Typography variant="caption" color="text.secondary">
                  原图不可预览，但仍可按表格核对
                </Typography>
              </Box>
            )
          )}
        </Box>

        <Box sx={{ maxHeight: { md: '70vh' }, overflowY: { md: 'auto' }, pr: { md: 0.5 } }}>
          <Stack spacing={0.75}>
            {rows.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                没有可用的行，换一张更清晰的截图，或改用「手动记账」。
              </Typography>
            )}
            {rows.map((row) => {
              const annotation = annotations.get(row.rowIndex);
              const confidence = annotation?.confidence ?? null;
              const lowConfidence = confidence !== null && confidence < LOW_LINE_CONFIDENCE;
              const hasBox = Boolean(annotation?.bbox);
              const isActive = activeRow === row.rowIndex;
              const amountInvalid = (() => {
                try {
                  return yuanToCents(row.cells['金额'] ?? '') <= 0;
                } catch {
                  return true;
                }
              })();

              return (
                <Box
                  key={row.rowIndex}
                  ref={(node: HTMLDivElement | null) => {
                    if (node) rowRefs.current.set(row.rowIndex, node);
                    else rowRefs.current.delete(row.rowIndex);
                  }}
                  sx={{
                    p: 1,
                    borderRadius: 2,
                    border: '1px solid',
                    borderColor: isActive ? 'primary.main' : 'divider',
                    // 低置信行整行标黄（MUI v5 没有 warning.lighter，用 alpha 合成同效果）
                    bgcolor: lowConfidence ? (theme) => alpha(theme.palette.warning.main, 0.14) : 'background.paper',
                    transition: 'border-color 120ms, background-color 120ms',
                    '&:hover .ocr-locate': { opacity: 1 },
                  }}
                >
                  <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mb: 0.75, minWidth: 0 }}>
                    {lowConfidence && (
                      <Tooltip title="识别可能不准，请核对">
                        <WarningAmberIcon fontSize="small" color="warning" />
                      </Tooltip>
                    )}
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      title={annotation?.rawText ?? ''}
                      sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      原图文本：{annotation?.rawText || '（无）'}
                    </Typography>
                    {confidence !== null && (
                      <Chip size="small" variant="outlined" color={confidenceColor(confidence)} label={`${Math.round(confidence)}%`} />
                    )}
                    {edited.has(row.rowIndex) && <Chip size="small" variant="outlined" color="info" label="已改" />}
                    <Tooltip title={hasBox ? '在图上定位这一行' : '这一行无法定位到图上'}>
                      <span>
                        <IconButton
                          className="ocr-locate"
                          size="small"
                          disabled={!hasBox}
                          onClick={() => locateRow(row.rowIndex)}
                          sx={{ opacity: { xs: 1, md: 0.35 } }}
                          aria-label="在图上定位"
                        >
                          <CenterFocusStrongIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title="删除这一行">
                      <IconButton size="small" color="error" onClick={() => removeRow(row.rowIndex)} aria-label="删除这一行">
                        <DeleteOutlineIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>

                  <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', sm: '1fr 1fr 1.4fr' }, gap: 0.75 }}>
                    <TextField
                      size="small"
                      label="金额"
                      value={row.cells['金额'] ?? ''}
                      onChange={(event) => updateCell(row.rowIndex, '金额', event.target.value)}
                      error={amountInvalid}
                    />
                    <TextField
                      size="small"
                      label="日期"
                      value={row.cells['日期'] ?? ''}
                      onChange={(event) => updateCell(row.rowIndex, '日期', event.target.value)}
                      helperText={
                        row.cells['日期']
                          ? // 截图只写 10-19，年份是按"不晚于今天"推的，必须让用户知道
                            row.cells[OCR_DATE_INFERRED_CELL]
                            ? '年份为推断'
                            : undefined
                          : '需要手填'
                      }
                    />
                    <TextField
                      size="small"
                      label="商户"
                      value={row.cells['项目'] ?? ''}
                      onChange={(event) => updateCell(row.rowIndex, '项目', event.target.value)}
                      sx={{ gridColumn: { xs: 'span 2', sm: 'auto' } }}
                    />
                  </Box>
                </Box>
              );
            })}
          </Stack>

          {boxes.length > 0 && boxes.length < rows.length && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              {rows.length - boxes.length} 行没能和图片对上位置，定位按钮已禁用
            </Typography>
          )}
        </Box>
      </Box>
    </Box>
  );
}
