import { createElement, Fragment, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import * as settingsRepo from '../../db/repos/settingsRepo';
import { ListSkeleton, PageSkeleton } from '../components/PageSkeleton';

/**
 * 区分「还在读库」和「真的没有账目」。
 *
 * useLiveQuery 首次返回 undefined；useLedgerData.ts 里的其它钩子用 `?? []` 兜底是为了
 * 让页面代码不必到处判空，但代价是页面会把「加载中」误判成「没有数据」，
 * 先闪一句『先记第一笔』再突然变成真实内容。这里保留 undefined 作为就绪信号，
 * 由 DataGate 统一在最外层拦截。
 */
export function useDataReady(): boolean {
  const version = useLiveQuery(
    () => settingsRepo.getDataVersion(),
    [],
    undefined as number | undefined,
  );
  return version !== undefined;
}

/**
 * 放在 AppShell 里包住 Outlet，而不是让每个页面自己 `if (!ready) return`：
 * 页面组件里 hooks 很多，提前 return 会破坏 hooks 调用顺序；父级包一层则只挂载一次，
 * 切换路由也不会反复闪骨架。
 *
 * 本文件是 .ts（不含 JSX 语法），用 createElement 组装返回值。
 */
export function DataGate({
  children,
  variant = 'page',
}: {
  children: ReactNode;
  variant?: 'page' | 'list';
}): JSX.Element {
  const ready = useDataReady();
  if (ready) return createElement(Fragment, null, children);
  return variant === 'list' ? createElement(ListSkeleton) : createElement(PageSkeleton);
}
