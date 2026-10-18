import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openCanvas, openSidebar } from './navigation-helper.mjs';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/canvas-node-config-'));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const app = await electron.launch({ args: ['.'], env });
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForSelector('.app-shell');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fixtures = await page.evaluate(async () => {
    const api = window.tongzhou;
    const definitions = (await api.canvasState()).plugins;
    const fixtures = [];
    for (const definition of definitions) {
      if (definition.adapter === 'mcp') continue;
      const canvas = await api.canvasSave({
        title: `手动配置 ${definition.name}`,
        nodes: [
          {
            id: 'node',
            kind: definition.kind,
            pluginId: definition.id,
            title: definition.name,
            x: 40,
            y: 40,
            width: 300,
            height: 260,
            ...definition.defaults,
          },
        ],
        edges: [],
        selection: [],
        viewport: { x: 25, y: 25, zoom: 1 },
      });
      fixtures.push({ canvasId: canvas.id, definition });
    }
    return fixtures;
  });
  assert(fixtures.length >= 15);
  await openSidebar(page, '创作');
  for (const { canvasId, definition } of fixtures) {
    console.log(`Check manual editor: ${definition.id} (${canvasId})`);
    await openCanvas(page, canvasId);
    await page.waitForFunction(
      (name) => document.querySelector('.canvas-node-label')?.textContent === name,
      definition.name,
    );
    const node = page.locator('.canvas-node');
    await node.locator('header').click();
    const config = page.getByRole('region', { name: '节点配置', exact: true });
    await config.waitFor();
    assert.equal(
      await page.getByRole('region', { name: '画布助手', exact: true }).isVisible(),
      false,
    );
    if (['image', 'video'].includes(definition.kind)) {
      await config.getByLabel('生成提示词', { exact: true }).fill('手动生成提示词');
      await config.getByRole('button', { name: '收起生成配置' }).click();
    } else {
      await config.getByLabel('节点名称', { exact: true }).fill(`手动 ${definition.name}`);
      const label =
        definition.view?.textLabel ??
        (definition.kind === 'text'
          ? '正文'
          : definition.kind === 'audio'
            ? '生成提示词'
            : definition.kind === 'resource'
              ? '自定义提示词'
              : '处理要求');
      if (definition.kind !== 'save') {
        await config.getByLabel(label, { exact: true }).fill('手动编辑内容');
      }
      if (definition.id === 'visual.sticky-note') {
        await config.getByLabel('便签颜色').selectOption('pink');
        await page.screenshot({ path: path.join(root, 'sticky-settings.png') });
      }
      await config.getByRole('button', { name: '收起节点配置', exact: true }).click();
    }
    await config.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const saved = await page.evaluate((id) => window.tongzhou.canvasState(id), canvasId);
    const savedNode = saved.canvas.nodes[0];
    if (!['image', 'video'].includes(definition.kind)) {
      assert.equal(savedNode.title, `手动 ${definition.name}`);
      if (definition.kind !== 'save') assert.equal(savedNode.text, '手动编辑内容');
    }
    await node.locator('header').click();
    await config.waitFor();
    await page.locator('.canvas-board').click({ position: { x: 10, y: 10 } });
    await config.waitFor({ state: 'hidden' });
  }
  assert.deepEqual(errors, []);
  console.log(
    `Manual node configuration passed for ${fixtures.length} built-in node types. ${root}`,
  );
} catch (error) {
  const page = await app.firstWindow();
  await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app.close();
}
