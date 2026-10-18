import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openCanvas, openSidebar } from './navigation-helper.mjs';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/canvas-text-source-'));
const local = path.join(root, '上传页面.html');
await writeFile(local, '<h1>上传的页面</h1>');
let remoteText = '<h1>外部页面</h1><script>window.alert("should not run")</script>';
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(remoteText);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/page.html`;
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const app = await electron.launch({ args: ['.'], env });
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForSelector('.app-shell');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', () => {
    errors.push('Source script executed');
  });
  const { id, docId } = await page.evaluate(async () => {
    const api = window.tongzhou;
    const doc = await api.contentWrite({
      libraryId: 'default',
      title: '内容库页面',
      content: '<h1>库中的页面</h1>',
    });
    const canvas = await api.canvasSave({
      title: '内容来源测试',
      nodes: [
        {
          id: 'html',
          kind: 'plugin',
          pluginId: 'visual.html',
          title: 'HTML',
          x: 40,
          y: 40,
          width: 360,
          height: 280,
          text: '<p>原始正文</p>',
        },
      ],
      edges: [],
      selection: [],
      viewport: { x: 20, y: 20, zoom: 1 },
    });
    return { id: canvas.id, docId: doc.id };
  });
  await openSidebar(page, '创作');
  await openCanvas(page, id);
  await page.locator('.canvas-node header').click();
  const config = page.getByRole('region', { name: '节点配置', exact: true });
  const text = config.getByLabel('HTML 源码', { exact: true });
  const picker = page.getByRole('dialog', { name: '选择画布资源', exact: true });
  await config.getByRole('button', { name: '关联资源 / 上传', exact: true }).click();
  await picker.getByRole('button', { name: /内容库页面/ }).click();
  await picker.waitFor({ state: 'hidden' });
  assert.equal(await text.inputValue(), '<h1>库中的页面</h1>');
  await text.fill('<h1>手动修改</h1>');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal(
    await page.evaluate(
      async (id) =>
        (await window.tongzhou.canvasReadTextSource({ kind: 'content', id, version: 1 })).text,
      docId,
    ),
    '<h1>库中的页面</h1>',
  );
  await config.getByRole('button', { name: '重新载入来源（覆盖当前正文）', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-label="HTML 源码"]')?.value === '<h1>库中的页面</h1>',
  );
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, local);
  await config.getByRole('button', { name: '关联资源 / 上传', exact: true }).click();
  await picker.getByRole('button', { name: '导入本地文件', exact: true }).click();
  await picker.waitFor({ state: 'hidden' });
  assert.equal(await text.inputValue(), '<h1>上传的页面</h1>');
  await config.getByRole('button', { name: '外部地址', exact: true }).click();
  await config.getByLabel('外部内容地址').fill(url);
  await config.getByRole('button', { name: '载入', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('textarea[aria-label="HTML 源码"]')?.value.includes('外部页面'),
  );
  assert.equal(await page.locator('iframe[title="HTML 预览"]').getAttribute('sandbox'), '');
  await page
    .frameLocator('iframe[title="HTML 预览"]')
    .getByRole('heading', { name: '外部页面', exact: true })
    .waitFor();
  await page.screenshot({ path: path.join(root, 'html-source.png') });
  remoteText = '<h1>更新后的外部页面</h1>';
  await config.getByRole('button', { name: '重新载入来源（覆盖当前正文）', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-label="HTML 源码"]')?.value ===
      '<h1>更新后的外部页面</h1>',
  );
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const saved = await page.evaluate(
    async (id) => (await window.tongzhou.canvasState(id)).canvas.nodes[0],
    id,
  );
  assert.equal(saved.textSource.url, url);
  assert.equal(saved.resource.kind, 'content');
  await config.getByRole('button', { name: '解除关联，保留正文', exact: true }).click();
  assert.equal(await text.inputValue(), remoteText);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.reload();
  await page.waitForSelector('.app-shell');
  const reloaded = await page.evaluate(
    async (id) => (await window.tongzhou.canvasState(id)).canvas.nodes[0],
    id,
  );
  assert.equal(reloaded.text, remoteText);
  assert.equal(reloaded.textSource, undefined);
  assert.equal(reloaded.resource, undefined);
  assert.deepEqual(errors, []);
  console.log(
    'Canvas text sources passed: library, native upload, URL, refresh, manual edits, sandboxed preview, unlink and persistence.',
    root,
  );
} finally {
  await app.close();
  await new Promise((resolve) => server.close(resolve));
}
