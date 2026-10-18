import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openCanvas, openSidebar } from './navigation-helper.mjs';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/canvas-routing-'));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const app = await electron.launch({ args: ['.'], env });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  await openSidebar(page, '创作');
  await page.getByRole('heading', { name: '开始创作', exact: true }).waitFor();
  assert.equal(await page.locator('.canvas-node-palette,.canvas-toolbar').count(), 0);
  await page.getByRole('button', { name: '新建画布', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('select[aria-label="选择画布"]')?.value);
  const workflowId = await page.getByLabel('选择画布', { exact: true }).inputValue();
  const workflowOwner = await page.evaluate(
    async (id) => (await window.tongzhou.snapshot()).sessions.find((s) => s.activeCanvasId === id),
    workflowId,
  );
  assert.equal(workflowOwner.agentId, 'builtin-canvas-workflow');
  await page.getByRole('button', { name: '添加文本节点', exact: true }).click();
  await page.getByRole('button', { name: '返回创作', exact: true }).click();
  await page.locator('.studio-home').waitFor();
  assert.equal(
    (await page.evaluate((id) => window.tongzhou.canvasState(id), workflowId)).canvas.nodes.length,
    1,
  );
  assert.equal(await page.locator('.canvas-node-palette').count(), 0);
  await page.getByRole('button', { name: '新建白板', exact: true }).click();
  await page.locator('.whiteboard-editor .excalidraw').waitFor();
  const whiteboardId = await page.getByLabel('选择画布', { exact: true }).inputValue();
  const snapshot = await page.evaluate(() => window.tongzhou.snapshot());
  const whiteboardOwner = snapshot.sessions.find((s) => s.activeCanvasId === whiteboardId);
  assert.equal(whiteboardOwner.id, workflowOwner.id);
  assert.equal(whiteboardOwner.agentId, 'builtin-whiteboard-designer');
  for (const [agent, skill] of [
    ['builtin-canvas-workflow', 'tongzhou-canvas-workflow'],
    ['builtin-whiteboard-designer', 'tongzhou-whiteboard-design'],
  ]) {
    assert(snapshot.agents.find((a) => a.id === agent).skillIds.includes(skill));
    assert(snapshot.skills.find((s) => s.id === skill).enabled);
  }
  await openCanvas(page, workflowId);
  await page.waitForFunction(
    async ({ id, canvasId }) => {
      const s = (await window.tongzhou.snapshot()).sessions.find((s) => s.id === id);
      return s.activeCanvasId === canvasId && s.agentId === 'builtin-canvas-workflow';
    },
    { id: workflowOwner.id, canvasId: workflowId },
  );
  await openSidebar(page, 'Agent');
  await page.getByRole('heading', { name: '白板设计', exact: true }).waitFor();
  await page.getByRole('heading', { name: '工作流编排', exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'builtin-canvas-agents.png') });
  await openSidebar(page, '创作');
  await page.locator('.studio-home').waitFor();
  assert.equal(await page.locator('.canvas-toolbar,.canvas-node-palette').count(), 0);
  await page.evaluate(async (id) => {
    const { canvas } = await window.tongzhou.canvasState(id);
    const { updatedAt, ...input } = canvas;
    await window.tongzhou.canvasSave({ ...input, title: '后台更新的画布' });
  }, workflowId);
  await page.locator('.studio-home-list').getByText('后台更新的画布', { exact: true }).waitFor();
  assert.equal(await page.locator('.canvas-toolbar,.canvas-node-palette').count(), 0);
  await page.screenshot({ path: path.join(root, 'studio-home.png') });
  await page.setViewportSize({ width: 700, height: 760 });
  await page.screenshot({ path: path.join(root, 'studio-home-narrow.png') });
  assert(await page.locator('.studio-home').evaluate((e) => e.scrollWidth <= e.clientWidth));
  await page.locator('.canvas-workspace').evaluate((e) => {
    e.style.maxWidth = '300px';
  });
  await page.screenshot({ path: path.join(root, 'studio-home-panel.png') });
  assert(await page.locator('.studio-home').evaluate((e) => e.scrollWidth <= e.clientWidth));
  const cards = await page
    .locator('.studio-home-choice')
    .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().y));
  assert(cards[1] > cards[0], 'Narrow panels stack the two choices');
  await page.locator('.canvas-workspace').evaluate((e) => {
    e.style.maxWidth = '';
  });
  await openCanvas(page, whiteboardId);
  await page.locator('.whiteboard-editor .excalidraw').waitFor();
  assert.equal(await page.locator('.canvas-node-palette').count(), 0);
  await page.getByRole('button', { name: '返回创作', exact: true }).click();
  await page.locator('.studio-home').waitFor();
  await openCanvas(page, workflowId);
  await page.locator('.canvas-node-palette').waitFor();
  await page.getByRole('button', { name: '返回创作', exact: true }).click();
  await page.locator('.studio-home').waitFor();
  await page.evaluate(() =>
    window.tongzhou.setAppearance({
      language: 'en',
      theme: 'dark',
      style: 'graphite',
      font: 'system',
      textSize: 14,
    }),
  );
  await page.getByRole('heading', { name: 'Start creating', exact: true }).waitFor();
  await page.getByRole('button', { name: 'New whiteboard', exact: true }).waitFor();
  // Wait for the shared control color transition to settle after switching themes.
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(root, 'studio-home-english-dark.png') });
  console.log(
    'Studio passed: landing, draft save on return, background refresh, reopen, responsive layout, matching agents and skills.',
    root,
  );
} finally {
  await app.close();
}
