import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openSidebar } from './navigation-helper.mjs';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/canvas-import-'));
const file = path.join(root, '外部人物.png');
await writeFile(
  file,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=',
    'base64',
  ),
);
const note = path.join(root, '小说.txt');
await writeFile(note, '人物：小舟；场景：码头。');
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const app = await electron.launch({ args: ['.'], env });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, file);
  await openSidebar(page, '创作');
  await page.getByRole('button', { name: '新建画布', exact: true }).click();
  await page.getByRole('button', { name: '添加资源节点', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选择画布资源', exact: true });
  await picker.getByText('也可将文件拖到这里', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'import-picker.png') });
  await picker.getByRole('button', { name: '导入本地文件', exact: true }).click();
  await picker.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const canvasId = await page.getByLabel('选择画布', { exact: true }).inputValue();
  const ref = await page.evaluate(async (id) => {
    const state = await window.tongzhou.canvasState(id);
    return state.canvas.nodes.find((node) => node.title === '外部人物.png').resource;
  }, canvasId);
  assert.equal(ref.kind, 'content');
  await rm(file);
  assert.equal(
    await page.evaluate(async (r) => (await window.tongzhou.canvasResourcePreview(r)).type, ref),
    'image',
  );

  // The same API handles native drops, applies image restrictions, and preserves cancellation.
  const rejected = await page.evaluate(
    (note) => window.tongzhou.canvasImportResources({ paths: [note], media: 'image' }),
    note,
  );
  assert.equal(rejected.choices.length, 0);
  assert.equal(rejected.errors.length, 1);
  const text = await page.evaluate(
    (note) => window.tongzhou.canvasImportResources({ paths: [note] }),
    note,
  );
  assert.equal(text.choices.length, 1);
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole('button', { name: '添加资源节点', exact: true }).click();
  await picker.getByRole('button', { name: '导入本地文件', exact: true }).click();
  await picker
    .getByRole('button', { name: '导入本地文件', exact: true })
    .waitFor({ state: 'visible' });
  assert.equal(await picker.isVisible(), true);
  assert.equal(await picker.getByRole('alert').count(), 0);
  await picker.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await page.waitForSelector('.app-shell');
  assert.equal(
    await page.evaluate(async (r) => (await window.tongzhou.canvasResourcePreview(r)).type, ref),
    'image',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Canvas external import passed: picker, native import, node reference, media filtering, cancellation, original removal and reload.',
    root,
  );
} finally {
  await app.close();
}
