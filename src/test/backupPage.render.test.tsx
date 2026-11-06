import { ThemeProvider } from '@mui/material';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import { ensureSeeded } from '../db/seed';
import { BackupPage } from '../ui/pages/Settings/Backup';
import { buildTheme } from '../ui/theme';

/**
 * 备份页渲染测试。
 *
 * 为什么需要它：`tsc` 只证明类型对，不证明 `ToggleButtonGroup` / `Dialog` 这些
 * MUI 组件在运行时不会炸。合并恢复改造把整页重写过一遍，而备份页是用户丢数据前
 * 唯一会打开的地方——它渲染不出来，用户连导出都做不到。
 */
async function render(): Promise<string> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ThemeProvider theme={buildTheme('light')}>
        <MemoryRouter>
          <BackupPage />
        </MemoryRouter>
      </ThemeProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  const text = container.textContent ?? '';
  await act(async () => {
    root.unmount();
  });
  container.remove();
  return text;
}

describe('备份页可渲染', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await ensureSeeded(db);
  });

  it('渲染出设备名、导出入口与「默认合并」的措辞', async () => {
    const text = await render();
    expect(text).toContain('本机设备名');
    expect(text).toContain('导出加密备份');
    expect(text).toContain('导出明文 CSV');
    // 恢复卡片的承诺必须写清楚「不会删你现有的账」，这是用户敢按下去的前提
    expect(text).toContain('默认合并');
    expect(text).toContain('不会删你现有的账');
    // 无服务器的事实必须一直在页面上，不能只写在文档里
    expect(text).toContain('口令一旦忘记');
  });

  it('未选文件时不渲染恢复对话框（避免空口令提交）', async () => {
    const text = await render();
    expect(text).not.toContain('开始合并');
    expect(text).not.toContain('确认覆盖');
  });
});
