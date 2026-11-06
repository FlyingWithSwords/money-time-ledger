/**
 * PWA 注册（vite-plugin-pwa 用 injectRegister:'auto' 自动注入 SW 注册）。
 * 这里只做两件事：申请持久化存储、给出更新提示的钩子。
 */

export function requestPersistentStorage(): void {
  if (typeof navigator === 'undefined') return;
  const storage = navigator.storage;
  if (storage?.persist) {
    storage.persist().catch(() => {
      // 用户拒绝或浏览器不支持：不阻塞使用
    });
  }
}

export async function estimateStorageMb(): Promise<number> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return 0;
  const estimate = await navigator.storage.estimate();
  return Math.round(((estimate.usage ?? 0) / (1024 * 1024)) * 10) / 10;
}
