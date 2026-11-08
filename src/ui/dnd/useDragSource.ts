import { useCallback, useEffect, useRef } from 'react';
import type * as React from 'react';
import {
  dispatchDrop,
  markDragFinished,
  registerDropTarget,
  useDragStore,
  type DragPayload,
} from '../../store/dragStore';

/**
 * 拖源与投放区的原生实现（Pointer Events）。
 *
 * 不引入 @dnd-kit 之类的库：这里只要「按住一行、拖到另一个方块上松手」，
 * 而库会带来 40KB+、自己的 DOM 包裹层、以及在 jsdom 里几乎无法测的抽象。
 * 原生实现的核心只有两件事：什么时候算「开始拖」、指针在哪。
 *
 * 两种触发方式（用户明确要求「电脑手机都能用」）：
 * - 鼠标：按下后移动超过 6px 就算拖。桌面上按住不动不是拖，移动才是。
 * - 触摸：必须**长按 220ms** 才算拖。否则每次上下滑列表都会变成「拖走一笔账」，
 *   这个误触在手机上几乎无法忍受。长按激活前手指移动超过 10px 视为滚动，直接放弃。
 */

const LONG_PRESS_MS = 220;
const MOUSE_THRESHOLD = 6;
const TOUCH_CANCEL_THRESHOLD = 10;

/** 指针位置下最近的投放区 key；没有则 null。 */
export function dropKeyAt(x: number, y: number): string | null {
  if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return null;
  const element = document.elementFromPoint(x, y);
  const target = element?.closest?.('[data-drop-key]');
  if (!(target instanceof HTMLElement)) return null;
  return target.dataset.dropKey ?? null;
}

export function useDragSource(payload: DragPayload | null): {
  onPointerDown: (event: React.PointerEvent) => void;
} {
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const teardownRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      teardownRef.current?.();
    },
    [],
  );

  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (!payloadRef.current) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // 已经在拖了（上一根手指没抬起来）：不再开一条新的拖拽会话
    if (teardownRef.current) return;

    const pointerId = event.pointerId;
    const startPoint = { x: event.clientX, y: event.clientY };
    let dragging = false;
    let timer: number | null = null;

    const activate = (point: { x: number; y: number }): void => {
      const current = payloadRef.current;
      if (dragging || !current) return;
      dragging = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      document.body.classList.add('dnd-active');
      useDragStore.getState().start(current, point);
      useDragStore.getState().move(point, dropKeyAt(point.x, point.y));
    };

    const teardown = (): void => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('dnd-active');
      teardownRef.current = null;
      if (!dragging) return;
      const state = useDragStore.getState();
      const dropped = dispatchDrop(state.overKey, state.payload ?? payloadRef.current ?? ({} as DragPayload));
      state.end();
      markDragFinished();
      // 落到空白处：什么都不做，界面自然回弹，不给「失败了」的报错——
      // 用户只是想放回去，弹错反而让他以为数据动了
      void dropped;
    };

    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      const point = { x: ev.clientX, y: ev.clientY };
      const distance = Math.hypot(point.x - startPoint.x, point.y - startPoint.y);
      if (!dragging) {
        if (ev.pointerType === 'mouse') {
          if (distance > MOUSE_THRESHOLD) activate(point);
        } else if (distance > TOUCH_CANCEL_THRESHOLD) {
          // 触摸且没到长按时长就动了 → 这是一次滚动，不是拖拽
          teardown();
        }
        return;
      }
      // 拖拽中阻止页面跟着滚：body 上的 .dnd-active 已经把 touch-action 关掉，
      // 这里再兜一次桌面端的选区拖影
      ev.preventDefault();
      useDragStore.getState().move(point, dropKeyAt(point.x, point.y));
    };

    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      teardown();
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    teardownRef.current = teardown;

    if (event.pointerType !== 'mouse') {
      timer = window.setTimeout(() => activate(startPoint), LONG_PRESS_MS);
    }
  }, []);

  return { onPointerDown };
}

/**
 * 投放区：挂上 key 与回调，指针悬停时自动高亮。
 *
 * 返回的 `active` 用来给元素加边框/底色——高亮是拖拽能不能成功的唯一预告，
 * 没有它用户不知道松手会不会生效。
 */
export function useDropTarget(key: string, onDrop: (payload: DragPayload) => void): {
  active: boolean;
  dropProps: { 'data-drop-key': string };
} {
  const active = useDragStore((state) => state.overKey === key);
  const handler = useRef(onDrop);
  handler.current = onDrop;

  useEffect(() => registerDropTarget(key, (payload) => handler.current(payload)), [key]);

  return { active, dropProps: { 'data-drop-key': key } };
}
