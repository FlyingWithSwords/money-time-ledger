import FitScreenIcon from '@mui/icons-material/FitScreen';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import { useEffect, useRef, useState } from 'react';
import type { OcrBbox } from '../../../import/ocrTypes';

/**
 * 图片预览 / 缩放平移（自己写，不引第三方缩放库）。
 *
 * 为什么手写：只需要"双指/滚轮缩放 + 拖拽 + 复位 + 定位到某个 bbox"，
 * 引一个库要几十 KB，还要和 MUI 的布局、触屏滚动打架；
 * pointer events + CSS transform 大约一百行就能覆盖，且行为完全可控。
 *
 * 坐标系：stage 的尺寸就是**图片的自然像素尺寸**，bbox 直接按像素定位在 stage 里，
 * 外层只做 translate + scale。这样高亮框永远和字对齐，不需要任何换算。
 */

export interface OcrImageBox {
  rowIndex: number;
  bbox: OcrBbox;
}

export interface OcrFocusRequest {
  bbox: OcrBbox;
  /** 每次请求递增；相同 bbox 再点一次也要重新聚焦 */
  token: number;
}

interface Props {
  src: string;
  /** 所有可点击的框（与表格行一一对应） */
  boxes: OcrImageBox[];
  activeRowIndex: number | null;
  focusRequest: OcrFocusRequest | null;
  onSelectRow: (rowIndex: number) => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;
const WHEEL_SENSITIVITY = 0.0015;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface ViewState {
  /** 相对"适应窗口"的倍率，1 = 整图可见 */
  zoom: number;
  tx: number;
  ty: number;
}

export function OcrImageViewer({
  src,
  boxes,
  activeRowIndex,
  focusRequest,
  onSelectRow,
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<ViewState>({ zoom: 1, tx: 0, ty: 0 });

  // 事件回调（wheel/pointer）里要读最新值，但不想每次重建监听器 → 用 ref 镜像
  const viewRef = useRef(view);
  viewRef.current = view;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const naturalRef = useRef(natural);
  naturalRef.current = natural;

  const fitScale =
    natural.width > 0 && viewport.width > 0
      ? Math.min(viewport.width / natural.width, viewport.height / natural.height)
      : 1;
  const fitScaleRef = useRef(fitScale);
  fitScaleRef.current = fitScale;

  const scaleAbs = fitScale * view.zoom;

  /** 平移不越界：比容器小的方向居中，比容器大的方向不允许拉出空白 */
  function clampTranslate(tx: number, ty: number, scale: number): ViewState['tx'][] {
    const { width: cw, height: ch } = viewportRef.current;
    const { width: nw, height: nh } = naturalRef.current;
    const sw = nw * scale;
    const sh = nh * scale;
    const nextTx = sw <= cw ? (cw - sw) / 2 : clamp(tx, cw - sw, 0);
    const nextTy = sh <= ch ? (ch - sh) / 2 : clamp(ty, ch - sh, 0);
    return [nextTx, nextTy];
  }

  function fitView(): void {
    const { width: nw, height: nh } = natural;
    const { width: cw, height: ch } = viewportRef.current;
    if (!nw || !nh || !cw || !ch) {
      setView({ zoom: 1, tx: 0, ty: 0 });
      return;
    }
    const scale = Math.min(cw / nw, ch / nh);
    setView({ zoom: 1, tx: (cw - nw * scale) / 2, ty: (ch - nh * scale) / 2 });
  }

  /** 以容器内某点为锚点缩放到指定倍率（滚轮、双指、按钮共用） */
  function commitZoom(zoomRaw: number, anchor?: { x: number; y: number }): void {
    setView((prev) => {
      const nextZoom = clamp(zoomRaw, MIN_ZOOM, MAX_ZOOM);
      const scale = fitScaleRef.current * prev.zoom;
      const nextScale = fitScaleRef.current * nextZoom;
      if (!scale || !nextScale) return prev;
      const point = anchor ?? {
        x: viewportRef.current.width / 2,
        y: viewportRef.current.height / 2,
      };
      const imageX = (point.x - prev.tx) / scale;
      const imageY = (point.y - prev.ty) / scale;
      const [tx, ty] = clampTranslate(point.x - imageX * nextScale, point.y - imageY * nextScale, nextScale);
      return { zoom: nextZoom, tx, ty };
    });
  }

  // 容器尺寸：手机横竖屏切换、桌面窗口缩放都要重新适应
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = (): void => setViewport({ width: element.clientWidth, height: element.clientHeight });
    update();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(update);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // 图片或容器变化时回到"适应窗口"
  useEffect(() => {
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [natural.width, natural.height, viewport.width, viewport.height]);

  // 表格点「定位」→ 把 bbox 放大居中
  useEffect(() => {
    if (!focusRequest) return;
    const { bbox } = focusRequest;
    const { width: nw, height: nh } = naturalRef.current;
    const { width: cw, height: ch } = viewportRef.current;
    if (!nw || !nh || !cw || !ch || fitScaleRef.current <= 0) return;
    const boxWidth = Math.max(1, bbox.x1 - bbox.x0);
    const boxHeight = Math.max(1, bbox.y1 - bbox.y0);
    // 留 20% 余量，避免框紧贴边缘看不出上下文
    const targetScale = Math.min(cw / boxWidth, ch / boxHeight) * 0.8;
    const zoom = clamp(targetScale / fitScaleRef.current, MIN_ZOOM, MAX_ZOOM);
    const scale = fitScaleRef.current * zoom;
    const centerX = (bbox.x0 + bbox.x1) / 2;
    const centerY = (bbox.y0 + bbox.y1) / 2;
    const [tx, ty] = clampTranslate(cw / 2 - centerX * scale, ch / 2 - centerY * scale, scale);
    setView({ zoom, tx, ty });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.token, focusRequest?.bbox.x0, focusRequest?.bbox.y0, natural.width, viewport.width]);

  // 滚轮缩放：必须 passive:false，否则浏览器会先滚页面
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const handler = (event: WheelEvent): void => {
      if (!naturalRef.current.width) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      commitZoom(
        viewRef.current.zoom * Math.exp(-event.deltaY * WHEEL_SENSITIVITY),
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
      );
    };
    element.addEventListener('wheel', handler, { passive: false });
    return () => element.removeEventListener('wheel', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 双指：记录起始距离与倍率，按距离比例缩放 */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) {
      drag.current = { x: event.clientX, y: event.clientY };
    } else if (pointers.current.size === 2) {
      const [first, second] = [...pointers.current.values()];
      pinch.current = {
        distance: Math.hypot(first.x - second.x, first.y - second.y),
        zoom: viewRef.current.zoom,
      };
      drag.current = null;
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.current.size >= 2 && pinch.current) {
      const [first, second] = [...pointers.current.values()];
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      if (pinch.current.distance > 0) {
        const rect = containerRef.current?.getBoundingClientRect();
        const anchor = {
          x: (first.x + second.x) / 2 - (rect?.left ?? 0),
          y: (first.y + second.y) / 2 - (rect?.top ?? 0),
        };
        commitZoom((pinch.current.zoom * distance) / pinch.current.distance, anchor);
      }
      return;
    }

    if (!drag.current) return;
    const deltaX = event.clientX - drag.current.x;
    const deltaY = event.clientY - drag.current.y;
    drag.current = { x: event.clientX, y: event.clientY };
    setView((prev) => {
      const [tx, ty] = clampTranslate(prev.tx + deltaX, prev.ty + deltaY, fitScaleRef.current * prev.zoom);
      return { ...prev, tx, ty };
    });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const stageWidth = natural.width || viewport.width || '100%';
  const stageHeight = natural.height || viewport.height || '100%';
  const zoomPercent = Math.round(view.zoom * 100);

  return (
    <Box
      sx={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        borderRadius: 2,
        bgcolor: (theme) => (theme.palette.mode === 'dark' ? 'grey.900' : 'grey.100'),
      }}
    >
      <Box
        ref={containerRef}
        data-testid="ocr-image-stage"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={fitView}
        sx={{
          position: 'absolute',
          inset: 0,
          // touchAction: none 才能让双指缩放走我们自己的逻辑而不是页面缩放
          touchAction: 'none',
          cursor: view.zoom > 1 ? 'grab' : 'default',
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: stageWidth,
            height: stageHeight,
            transform: `translate3d(${view.tx}px, ${view.ty}px, 0) scale(${scaleAbs})`,
            transformOrigin: '0 0',
            willChange: 'transform',
          }}
        >
          <Box
            component="img"
            src={src}
            alt="待核对的原图"
            draggable={false}
            onLoad={(event) => {
              const image = event.currentTarget as HTMLImageElement;
              setNatural({ width: image.naturalWidth, height: image.naturalHeight });
            }}
            sx={{
              display: 'block',
              width: '100%',
              height: '100%',
              // 还没测到自然尺寸前先 contain，避免第一帧被拉伸
              objectFit: natural.width ? 'fill' : 'contain',
              userSelect: 'none',
            }}
          />
          {boxes.map((box) => {
            const active = box.rowIndex === activeRowIndex;
            // 边框反过来除以缩放倍率，视觉上始终是 2px，不随放大变成粗黑框
            const borderWidth = 2 / (scaleAbs || 1);
            return (
              <Box
                key={`${box.rowIndex}-${box.bbox.x0}-${box.bbox.y0}`}
                component="button"
                type="button"
                aria-label={`定位到第 ${box.rowIndex} 行`}
                onPointerDown={(event: React.PointerEvent) => event.stopPropagation()}
                onClick={() => onSelectRow(box.rowIndex)}
                sx={{
                  position: 'absolute',
                  left: box.bbox.x0,
                  top: box.bbox.y0,
                  width: Math.max(2, box.bbox.x1 - box.bbox.x0),
                  height: Math.max(2, box.bbox.y1 - box.bbox.y0),
                  p: 0,
                  cursor: 'pointer',
                  borderRadius: `${4 / (scaleAbs || 1)}px`,
                  border: `${borderWidth}px solid`,
                  borderColor: active ? 'warning.main' : 'transparent',
                  bgcolor: active ? 'rgba(255, 176, 32, 0.22)' : 'transparent',
                  transition: 'background-color 120ms',
                  '&:hover': { bgcolor: 'rgba(255, 176, 32, 0.16)' },
                }}
              />
            );
          })}
        </Box>
      </Box>

      <Box
        sx={{
          position: 'absolute',
          top: 6,
          right: 6,
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
          px: 0.5,
          py: 0.25,
          borderRadius: 2,
          bgcolor: 'rgba(0,0,0,0.55)',
          color: '#fff',
        }}
      >
        <Tooltip title="缩小">
          <span>
            <IconButton
              size="small"
              aria-label="缩小图片"
              sx={{ color: '#fff' }}
              disabled={view.zoom <= MIN_ZOOM}
              onClick={() => commitZoom(view.zoom / ZOOM_STEP)}
            >
              <ZoomOutIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Typography sx={{ fontSize: 11, minWidth: 34, textAlign: 'center' }} className="tabular">
          {zoomPercent}%
        </Typography>
        <Tooltip title="放大">
          <span>
            <IconButton
              size="small"
              aria-label="放大图片"
              sx={{ color: '#fff' }}
              disabled={view.zoom >= MAX_ZOOM}
              onClick={() => commitZoom(view.zoom * ZOOM_STEP)}
            >
              <ZoomInIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="适应窗口（双击图片同样复位）">
          <IconButton size="small" aria-label="适应窗口" sx={{ color: '#fff' }} onClick={fitView}>
            <FitScreenIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      <Typography
        variant="caption"
        sx={{
          position: 'absolute',
          left: 6,
          bottom: 4,
          px: 0.75,
          borderRadius: 1,
          bgcolor: 'rgba(0,0,0,0.45)',
          color: '#fff',
          fontSize: 10,
          pointerEvents: 'none',
        }}
      >
        滚轮/双指缩放 · 拖拽平移 · 双击复位
      </Typography>
    </Box>
  );
}
