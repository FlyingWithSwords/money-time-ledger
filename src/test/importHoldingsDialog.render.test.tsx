import { ThemeProvider } from '@mui/material';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { describe, expect, it } from 'vitest';
import { ImportHoldingsDialog, emptyHoldingsHint, looksLikeGarbage } from '../ui/pages/funds/ImportHoldingsDialog';
import { buildTheme } from '../ui/theme';

/**
 * 持仓截图导入对话框的可渲染测试。
 *
 * 为什么只测可观察行为：四步流程的内部状态（识别会话号、校对行）刻意不设
 * 注入后门——识别要走真引擎（jsdom 里没有 canvas/wasm），校对行由识别产出。
 * 测试就锚定第 1 步必然渲染的东西：平台选择、隐私承诺文案、入库按钮的
 * disabled 语义。校对/入库逻辑由 holdingOcr 纯逻辑测试 + holdingRepo 覆盖。
 */
async function renderDialog(open: boolean): Promise<{ text: string; importButton: HTMLButtonElement | null }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ThemeProvider theme={buildTheme('light')}>
        <ImportHoldingsDialog open={open} onClose={() => undefined} />
      </ThemeProvider>,
    );
  });
  // MUI Dialog 走 portal 挂到 body，等一拍让进出场动画/焦点处理收尾
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  const text = document.body.textContent ?? '';
  const importButton =
    Array.from(document.querySelectorAll('button')).find((button) => (button.textContent ?? '').includes('导入')) ??
    null;
  await act(async () => {
    root.unmount();
  });
  container.remove();
  return { text, importButton: importButton as HTMLButtonElement | null };
}

describe('持仓截图导入对话框', () => {
  it('打开后显示平台选择（默认支付宝）与「不上传」承诺文案', async () => {
    const { text } = await renderDialog(true);
    expect(text).toContain('从截图导入持仓');
    // 平台必须选：五个截图来源都在，支付宝默认选中
    expect(text).toContain('支付宝');
    expect(text).toContain('天天基金');
    expect(text).toContain('银行');
    expect(text).toContain('券商');
    expect(text).toContain('其他');
    // 隐私承诺必须写明白，这是用户敢把截图交出来的前提
    expect(text).toContain('截图在本机识别，不上传');
    expect(text).toContain('逐行核对再入库');
  });

  it('没有可入库行时「导入」按钮 disabled 且计数为 0', async () => {
    const { text, importButton } = await renderDialog(true);
    expect(text).toContain('导入 0 笔');
    expect(importButton).not.toBeNull();
    expect(importButton?.disabled).toBe(true);
  });

  it('未打开时不渲染任何内容（不影响 Funds 页）', async () => {
    const { text } = await renderDialog(false);
    expect(text).not.toContain('从截图导入持仓');
    expect(text).not.toContain('导入 0 笔');
  });

  it('第 1 步文案说明平台身份决定幂等覆盖关系', async () => {
    const { text } = await renderDialog(true);
    // 平台是幂等键的一半，为什么要在选图前定必须在页面上说清
    expect(text).toContain('两笔独立持仓');
    expect(text).toContain('覆盖谁');
  });

  // 长截图的完整链路（tileCount、分段提示行）依赖真实识别结果，识别要走
  // canvas + wasm，jsdom 里没有——不为测试开后门，改为锁**纯文案函数**：
  // 它们决定空态与乱码提示显示什么，是渲染分支里唯一可独立验证的逻辑。
  it('长截图 0 笔时的空态文案给出可行动建议（分屏截图），而不是「换一张更清晰的」', () => {
    const longHint = emptyHoldingsHint(6);
    expect(longHint).toContain('分段识别');
    expect(longHint).toContain('分屏截图');
    expect(longHint).not.toContain('更清晰');
    // 普通截图保留旧文案
    expect(emptyHoldingsHint(1)).toContain('更清晰的截图');
  });

  it('未识别行英文碎片占比高时判定为乱码输出（提示分辨率问题）', () => {
    // 用户实测的长截图识别失败形态：整屏英文碎片
    expect(looksLikeGarbage(['won ore', 'ann id', 'om nmee'])).toBe(true);
    // 正常的持仓行（中文 + 数字代码）不是乱码
    expect(looksLikeGarbage(['华夏成长混合 000051', '110022 易方达沪深300', '总资产 36,389.00'])).toBe(false);
    expect(looksLikeGarbage([])).toBe(false);
  });
});
