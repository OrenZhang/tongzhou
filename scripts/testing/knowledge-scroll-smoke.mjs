import { seedKnowledge } from './knowledge-fixture.mjs';
import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/knowledge-scroll-'));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const ids = await seedKnowledge(path.join(root, 'profile'), async (api) => {
  const long = await api.knowledgeSave({
    title: '长内容滚动回归',
    kind: 'wiki',
    content:
      Array.from(
        { length: 70 },
        (_, i) =>
          `## 第 ${i + 1} 节\n\n这是需要完整阅读的知识正文，包含来源、使用条件与详细步骤。\n\n- 检查来源\n- 核对上下文\n`,
      ).join('\n') + '\n末尾验证标记：正文完整可读。',
  });
  const short = await api.knowledgeSave({
    title: '短页滚动回归',
    kind: 'wiki',
    content: '短页从顶部显示。',
  });
  return { long: long.id, short: short.id };
});
const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.app-shell');

  await page.getByRole('button', { name: '智库', exact: true }).click();
  await page.getByRole('button', { name: '智库', exact: true }).click();
  await page.getByRole('tab', { name: /^内容库/ }).click();
  for (const [width, height] of [
    [1440, 960],
    [1000, 700],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setMinimumSize(640, 540);
        win.setSize(...size);
      },
      [width, height],
    );
    await page.locator('.content-file-row').filter({ hasText: '长内容滚动回归' }).click();
    await page.getByLabel('文档内容', { exact: true }).waitFor();
    const reader = page.locator('.content-body-preview');
    await page.locator('.knowledge-page').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const before = await reader.evaluate((el) => ({
      height: el.clientHeight,
      total: el.scrollHeight,
      overflow: getComputedStyle(el).overflowY,
    }));
    assert.ok(
      before.total > before.height,
      `Reader must contain overflow at ${width}x${height}: ${JSON.stringify(before)}`,
    );
    assert.equal(before.overflow, 'auto');
    const railTop = await page.locator('.content-tree').evaluate((el) => el.scrollTop);
    await reader.hover();
    await page.mouse.wheel(0, 100000);
    await page.waitForFunction(() => {
      const reader = document.querySelector('.content-body-preview');
      return (
        reader.scrollTop > 100 && reader.scrollTop + reader.clientHeight >= reader.scrollHeight - 2
      );
    });
    const marker = reader.getByText('末尾验证标记：正文完整可读。', { exact: true });
    const box = await marker.boundingBox();
    const readerBox = await reader.boundingBox();
    assert.ok(
      box &&
        readerBox &&
        box.y >= readerBox.y &&
        box.y + box.height <= readerBox.y + readerBox.height + 1 &&
        box.y + box.height <= (await page.evaluate(() => innerHeight)),
      JSON.stringify({
        width,
        height,
        box,
        readerBox,
        viewport: await page.evaluate(() => innerHeight),
      }),
    );
    assert.equal(await page.locator('.content-tree').evaluate((el) => el.scrollTop), railTop);
    await reader.focus();
    await page.keyboard.press('Control+Home');
    await page.waitForFunction(
      () => document.querySelector('.content-body-preview').scrollTop === 0,
    );
    await page.keyboard.press('Control+End');
    await page.waitForFunction(() => {
      const el = document.querySelector('.content-body-preview');
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    });
    await page.locator('.content-file-row').filter({ hasText: '短页滚动回归' }).click();
    await page.getByLabel('文档内容', { exact: true }).waitFor();
    assert.equal(await reader.evaluate((el) => el.scrollTop), 0);
    await page.locator('.content-file-row').filter({ hasText: '长内容滚动回归' }).click();
    await page.getByLabel('文档内容', { exact: true }).waitFor();
    assert.equal(await reader.evaluate((el) => el.scrollTop), 0);
    if (width === 1000) {
      await page.locator('.knowledge-page').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await reader.focus();
      await page.keyboard.press('Control+End');
      await page.waitForFunction(() => {
        const el = document.querySelector('.content-body-preview');
        return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      });
      await page.screenshot({ path: 'test-results/knowledge-scroll-bottom.png' });
    }
  }
  assert.ok(ids.long && ids.short);
  assert.deepEqual(errors, []);
  console.log(
    'Knowledge scrolling passed: long document bottom reachable by wheel and keyboard, independent rail, reset on document switch, desktop/small windows.',
  );
} finally {
  await app.close();
}
