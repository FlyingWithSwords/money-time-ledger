import { ThemeProvider } from '@mui/material';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db';
import * as txRepo from '../db/repos/transactionRepo';
import { ensureSeeded } from '../db/seed';
import { makeTx } from './txFixture';
import { AiExportPage } from '../ui/pages/Settings/AiExport';
import { buildTheme } from '../ui/theme';

/**
 * AI 导出页渲染测试。
 *
 * 为什么需要它：`tsc` 只证明类型对，不证明 ToggleButtonGroup / useLiveQuery
 * 这些运行时行为不炸。这一页承载「数据不离开本机」的产品承诺——
 * 脱敏警告必须真的在选「保留原名」时出现，否则用户会在不知情下导出真名。
 */

interface RenderResult {
  container: HTMLDivElement;
  root: Root;
}

async function renderPage(): Promise<RenderResult> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ThemeProvider theme={buildTheme('light')}>
        <MemoryRouter>
          <AiExportPage />
        </MemoryRouter>
      </ThemeProvider>,
    );
  });
  // useLiveQuery 是异步解析，给一拍时间让预览数据渲染出来
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  return { container, root };
}

async function cleanup(result: RenderResult): Promise<void> {
  await act(async () => {
    result.root.unmount();
  });
  result.container.remove();
}

function findButton(container: HTMLDivElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(text));
}

describe('AI 导出页可渲染', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('渲染出「数据不离开本机」文案与两个操作按钮（有交易时可点）', async () => {
    await ensureSeeded(db);
    await txRepo.addMany([
      { ...makeTx({ id: 'a1', at: '2026-10-01T12:00:00+08:00', amount: 2500 }), counterparty: '某早餐店' },
      { ...makeTx({ id: 'a2', at: '2026-10-02T12:00:00+08:00', amount: 9000, l1: 'shopping' }), counterparty: '某商城' },
    ]);
    const { container, root } = await renderPage();
    const text = container.textContent ?? '';
    // 离线承诺必须写在页面上，不能只写在文档里
    expect(text).toContain('数据不离开本机');
    expect(text).toContain('下载 JSON 文件');
    expect(text).toContain('复制到剪贴板');
    expect(text).toContain('field_dictionary');
    // 预览展示已脱敏的代号（pseudonym 是默认值，必须真的生效在预览里）
    expect(text).toContain('商户A');
    expect(findButton(container, '下载 JSON 文件')?.disabled).toBe(false);
    await cleanup({ container, root });
  });

  it('选「保留原名」时出现警示文案，默认（代号）不出现', async () => {
    await ensureSeeded(db);
    const { container, root } = await renderPage();
    expect(container.textContent ?? '').not.toContain('真实商户名会进入数据包');

    const toggle = findButton(container, '保留原名');
    expect(toggle).toBeTruthy();
    await act(async () => {
      toggle?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(container.textContent ?? '').toContain('真实商户名会进入数据包');
    expect(container.textContent ?? '').toContain('值得信任');
    await cleanup({ container, root });
  });

  it('无交易时两个操作按钮 disabled', async () => {
    // ensureSeeded 只种分类/账户/规则，不种交易 → 交易数为 0
    await ensureSeeded(db);
    const { container, root } = await renderPage();
    expect(findButton(container, '下载 JSON 文件')?.disabled).toBe(true);
    expect(findButton(container, '复制到剪贴板')?.disabled).toBe(true);
    await cleanup({ container, root });
  });
});
