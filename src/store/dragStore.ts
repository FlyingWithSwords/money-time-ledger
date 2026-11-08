import { create } from 'zustand';
import type { Direction } from '../types';

/**
 * 拖拽的全局状态。
 *
 * 为什么放在 zustand 而不是 React Context：拖拽过程中指针每移动一次就要更新浮层位置，
 * 用 Context 会让整棵树订阅它的组件全部重渲染——流水列表几百行，拖一下就卡。
 * 这里只有 DragGhost 与投放区订阅自己关心的字段。
 */

export interface DragPayload {
  /** 目前只有「拖流水」一种；留成联合类型便于以后拖计划项 */
  kind: 'tx';
  txIds: string[];
  /** 浮层上显示的一行摘要 */
  label: string;
  direction: Direction;
  cents: number;
}

export interface DragPoint {
  x: number;
  y: number;
}

interface DragState {
  payload: DragPayload | null;
  point: DragPoint;
  /** 指针当前悬停的投放区 key（来自元素上的 data-drop-key） */
  overKey: string | null;
  start: (payload: DragPayload, point: DragPoint) => void;
  move: (point: DragPoint, overKey: string | null) => void;
  end: () => void;
}

export const useDragStore = create<DragState>((set) => ({
  payload: null,
  point: { x: 0, y: 0 },
  overKey: null,
  start: (payload, point) => set({ payload, point, overKey: null }),
  move: (point, overKey) => set((state) => (state.payload ? { point, overKey } : state)),
  end: () => set({ payload: null, overKey: null }),
}));

/**
 * 投放处理器注册表。
 *
 * 拖拽结束时只有「指针底下那个元素」知道自己是分类还是计划、该做什么，
 * 所以由投放区自己注册回调，拖源只负责按 key 派发。
 * 不用 React 事件冒泡：拖动时没有真实的 drop 事件，指针也不一定落在同一个 React 树上。
 */
type DropHandler = (payload: DragPayload) => void;
const dropHandlers = new Map<string, DropHandler>();

export function registerDropTarget(key: string, handler: DropHandler): () => void {
  dropHandlers.set(key, handler);
  return () => {
    // 只删自己：同一个 key 可能被新挂载的组件覆盖过，删前确认还是自己
    if (dropHandlers.get(key) === handler) dropHandlers.delete(key);
  };
}

/** 派发投放；返回是否有人接住。没人接住时界面必须什么都不做，不能当成功。 */
export function dispatchDrop(key: string | null, payload: DragPayload): boolean {
  if (!key) return false;
  const handler = dropHandlers.get(key);
  if (!handler) return false;
  handler(payload);
  return true;
}

/**
 * 刚刚发生过拖拽 → 抑制紧随其后的 click。
 *
 * 不抑制的话，在桌面上拖完松手会触发一次 click：用户把一笔账拖到「删除」，
 * 松手后又被当成「点开了那一行」，弹出一个编辑框盖住刚给的反馈。
 */
let suppressClickUntil = 0;

export function markDragFinished(): void {
  suppressClickUntil = Date.now() + 350;
}

export function shouldSuppressClick(): boolean {
  if (Date.now() > suppressClickUntil) return false;
  suppressClickUntil = 0;
  return true;
}
