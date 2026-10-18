import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openSidebar } from './navigation-helper.mjs';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/studio-library-'));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const app = await electron.launch({ args: ['.'], env });
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForSelector('.app-shell');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await page.evaluate(async () => {
    const api = window.tongzhou;
    const base = { nodes: [], edges: [], selection: [], viewport: { x: 40, y: 40, zoom: 1 } };
    const workflow = await api.canvasSave({
      ...base,
      title: '测试流程',
      nodes: [{ id: 'text', kind: 'text', title: '文案', text: '已保存内容', x: 0, y: 0 }],
    });
    localStorage.setItem(
      'tongzhou.canvas.draft.' + workflow.id,
      JSON.stringify({
        ...workflow,
        nodes: workflow.nodes.map((n) => ({ ...n, text: '尚未保存的本地草稿' })),
      }),
    );
    const whiteboard = await api.canvasSave({
      ...base,
      title: '测试白板',
      mode: 'whiteboard',
      whiteboard: { elements: [], appState: {}, files: {} },
    });
    const removable = await api.canvasSave({
      ...base,
      title: '待删除白板',
      mode: 'whiteboard',
      whiteboard: { elements: [], appState: {}, files: {} },
    });
    const session = await api.createSession(null);
    await api.canvasBind(session.id, removable.id);
    return { workflow, whiteboard, removable, session };
  });
  const openLibrary = async () => {
    await openSidebar(page, '智库');
    await page.getByRole('tab', { name: /^创作/ }).click();
    await page.locator('.studio-library-list').waitFor();
  };
  const row = (id) => page.locator(`.studio-library-item[data-canvas-id="${id}"]`);
  await openLibrary();
  assert.equal(await page.locator('.studio-library-item').count(), 3);
  await page.getByLabel('创作类型', { exact: true }).selectOption('whiteboard');
  assert.equal(await page.locator('.studio-library-item').count(), 2);
  await page.getByLabel('搜索创作', { exact: true }).fill('待删除');
  assert.equal(await page.locator('.studio-library-item').count(), 1);
  await page.getByLabel('搜索创作', { exact: true }).fill('不存在');
  await page.getByRole('heading', { name: '没有匹配的创作', exact: true }).waitFor();
  await page.getByLabel('搜索创作', { exact: true }).fill('');
  await page.getByLabel('创作类型', { exact: true }).selectOption('');
  await row(fixture.workflow.id)
    .getByRole('button', { name: /^重命名 / })
    .click();
  const rename = page.getByRole('dialog', { name: '重命名创作', exact: true });
  await rename.getByLabel('名称', { exact: true }).fill('人物制作流程');
  await rename.getByRole('button', { name: '保存', exact: true }).click();
  await rename.waitFor({ state: 'hidden' });
  await row(fixture.workflow.id)
    .getByRole('button', { name: '打开 人物制作流程', exact: true })
    .click();
  await page.getByLabel('选择画布', { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel('选择画布', { exact: true }).inputValue(),
    fixture.workflow.id,
  );
  await page.locator('.canvas-node').getByText('尚未保存的本地草稿', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回创作', exact: true }).click();
  await page.locator('.studio-home').waitFor();
  const saved = await page.evaluate((id) => window.tongzhou.canvasState(id), fixture.workflow.id);
  assert.equal(saved.canvas.nodes[0].text, '尚未保存的本地草稿');
  assert.equal(saved.canvas.title, '人物制作流程');
  await openLibrary();
  await row(fixture.whiteboard.id)
    .getByRole('button', { name: '打开 测试白板', exact: true })
    .click();
  await page.locator('.whiteboard-editor .excalidraw').waitFor();
  assert.equal(
    await page.getByLabel('选择画布', { exact: true }).inputValue(),
    fixture.whiteboard.id,
  );
  await openLibrary();
  await row(fixture.removable.id)
    .getByRole('button', { name: /^删除 / })
    .click();
  const deletion = page.getByRole('dialog', { name: '删除创作', exact: true });
  await deletion.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await row(fixture.removable.id).count(), 1);
  await page.evaluate(
    async ({ session, removable }) => window.tongzhou.canvasBind(session.id, removable.id),
    fixture,
  );
  await row(fixture.removable.id)
    .getByRole('button', { name: /^删除 / })
    .click();
  await deletion.getByRole('button', { name: '删除', exact: true }).click();
  await deletion.waitFor({ state: 'hidden' });
  await row(fixture.removable.id).waitFor({ state: 'detached' });
  const session = await page.evaluate(
    async (id) => (await window.tongzhou.snapshot()).sessions.find((s) => s.id === id),
    fixture.session.id,
  );
  assert.equal(session.activeCanvasId, undefined);
  assert.equal(session.agentId, '');
  await row(fixture.workflow.id)
    .getByRole('button', { name: /^重命名 / })
    .click();
  await page.evaluate(async (id) => {
    const { canvas } = await window.tongzhou.canvasState(id);
    const { updatedAt, ...input } = canvas;
    await window.tongzhou.canvasSave({ ...input, title: '外部更新的流程' });
  }, fixture.workflow.id);
  await rename.getByLabel('名称', { exact: true }).fill('不应覆盖');
  await rename.getByRole('button', { name: '保存', exact: true }).click();
  await rename.getByRole('alert').waitFor();
  assert.equal(
    (await page.evaluate((id) => window.tongzhou.canvasState(id), fixture.workflow.id)).canvas
      .title,
    '外部更新的流程',
  );
  await rename.getByRole('button', { name: '取消', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'studio-library.png') });
  await openSidebar(page, '创作');
  await page.locator('.studio-home').waitFor();
  await openLibrary();
  await page.evaluate(() =>
    window.tongzhou.setAppearance({
      language: 'en',
      theme: 'dark',
      style: 'graphite',
      font: 'system',
      textSize: 14,
    }),
  );
  await page.getByLabel('Search creations', { exact: true }).waitFor();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(root, 'studio-library-en.png') });
  assert.deepEqual(errors, []);
  console.log(
    'Studio library passed: auto index, search/filter, direct open, rename preserves drafts, concurrent version protection, delete confirmation and cleanup, bilingual UI.',
    root,
  );
} finally {
  await app.close();
}
