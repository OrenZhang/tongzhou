import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openSidebar } from './navigation-helper.mjs';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/comfyui-'));
const workflow = {
  1: { class_type: 'TextImage', inputs: { text: 'cat' } },
  2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'test' } },
};
const catalog = {
  TextImage: { input: { required: { text: ['STRING', { default: '' }] } }, output: ['IMAGE'] },
  SaveImage: {
    input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', { default: 'test' }] } },
    output: [],
    output_node: true,
  },
};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=',
  'base64',
);
let posts = 0,
  submitted;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/object_info') res.end(JSON.stringify(catalog));
  else if (req.url === '/prompt') {
    posts++;
    submitted = JSON.parse(Buffer.concat(chunks).toString());
    res.end(JSON.stringify({ prompt_id: 'ui-job', node_errors: {} }));
  } else if (req.url === '/history/ui-job')
    res.end(
      JSON.stringify({
        'ui-job': {
          status: { completed: true },
          outputs: { 2: { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } },
        },
      }),
    );
  else if (req.url?.startsWith('/view?')) {
    res.setHeader('Content-Type', 'image/png');
    res.end(png);
  } else {
    res.statusCode = 404;
    res.end('{}');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const file = path.join(root, 'workflow.json');
await writeFile(file, JSON.stringify(workflow));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
let app;
try {
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.app-shell').waitFor();
  await page.evaluate(async (url) => {
    await window.tongzhou.savePlugin({
      id: 'comfy-fixture',
      name: 'ComfyUI',
      protocol: 'comfyui',
      transport: 'http',
      command: '',
      args: [],
      url,
      enabled: true,
      readOnlyTools: [],
    });
    const catalog = await window.tongzhou.testPlugin('comfy-fixture');
    if (catalog.length !== 2) throw new Error('ComfyUI catalog not discovered');
  }, url);
  await openSidebar(page, '插件');
  await page.getByRole('button', { name: /^内置插件/ }).click();
  await page.getByLabel('搜索插件', { exact: true }).fill('ComfyUI');
  await page.getByRole('button', { name: '查看 ComfyUI', exact: true }).click();
  assert.equal(await page.getByLabel('ComfyUI 服务地址', { exact: true }).inputValue(), url);
  assert.equal(await page.getByLabel('认证方式', { exact: true }).count(), 0);
  await page.screenshot({ path: path.join(root, 'connection.png') });
  await page.getByRole('button', { name: '返回插件列表', exact: true }).click();
  await openSidebar(page, '创作');
  await page.getByRole('button', { name: '新建画布', exact: true }).click();
  await page.locator('.canvas-toolbar').waitFor();
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
  await page.getByRole('button', { name: '导入', exact: true }).click();
  const readImported = () =>
    page.evaluate(async () => {
      const state = await window.tongzhou.canvasState();
      const imported = state.canvases.find((c) => c.title === 'ComfyUI 工作流');
      return imported ? (await window.tongzhou.canvasState(imported.id)).canvas : null;
    });
  const wait = async (fn, predicate) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const value = await fn();
      if (predicate(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('ComfyUI UI state timed out');
  };
  await wait(readImported, (value) => value !== null);
  const imported = await readImported();
  assert.equal(imported.nodes.length, 2);
  await page.locator('.canvas-node[aria-label="TextImage，工具调用"]').click();
  await page.getByLabel('ComfyUI 服务', { exact: true }).selectOption('comfy-fixture');
  await page.getByRole('button', { name: '检查并应用服务', exact: true }).click();
  await page.getByText('ComfyUI 节点定义已更新', { exact: true }).waitFor();
  const text = page
    .locator('.canvas-config-form label')
    .filter({ hasText: /^text/ })
    .locator('input');
  await text.fill('UI edited prompt');
  await text.blur();
  await page.getByRole('button', { name: '运行整个流程', exact: true }).click();
  await wait(
    () =>
      page.evaluate(
        async (id) => (await window.tongzhou.canvasState(id)).runs[0]?.status,
        imported.id,
      ),
    (value) => value === 'completed',
  );
  assert.equal(posts, 1);
  assert.equal(submitted.prompt['1'].inputs.text, 'UI edited prompt');
  const state = await page.evaluate((id) => window.tongzhou.canvasState(id), imported.id);
  assert.equal(state.runs[0].nodes[imported.nodes[1].id].output.resources.length, 1);
  await page.getByRole('button', { name: '运行整个流程', exact: true }).waitFor();
  await page.locator('.canvas-node-status').filter({ hasText: '图已完成' }).first().waitFor();
  await page.screenshot({ path: path.join(root, 'completed.png') });
  // The same node library exposes the single-node API entry point.
  await page.locator('[data-node-plugin="comfyui.workflow"]').click();
  await page.locator('.canvas-node[aria-label="ComfyUI 工作流 API，工具调用"]').click();
  await page.getByLabel('API 工作流 JSON', { exact: true }).waitFor();
  await page.getByLabel('API 工作流 JSON', { exact: true }).fill(JSON.stringify(workflow));
  await page.getByLabel('ComfyUI 服务', { exact: true }).selectOption('comfy-fixture');
  await page.screenshot({ path: path.join(root, 'api-node.png') });
  await page.getByRole('button', { name: '添加参数绑定', exact: true }).click();
  await page.getByLabel('流程内节点 ID', { exact: true }).fill('1');
  assert.equal(await page.getByLabel('流程参数名', { exact: true }).inputValue(), 'text');
  await page.getByRole('button', { name: '删除绑定', exact: true }).click();
  await page.getByRole('button', { name: '运行选中节点', exact: true }).click();
  await wait(
    () =>
      page.evaluate(
        async (id) => (await window.tongzhou.canvasState(id)).runs[0]?.status,
        imported.id,
      ),
    (value) => posts === 2 && value === 'completed',
  );
  assert.equal(posts, 2);
  assert.deepEqual(errors, []);
  console.log(
    'ComfyUI desktop smoke passed: connection UI, expanded JSON import, catalog binding, parameter edit, single submission, original artifact and API node. ' +
      root,
  );
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    console.error((await page.locator('body').innerText()).slice(-10000));
  }
  throw error;
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
