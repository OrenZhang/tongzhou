import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openCanvas, openSidebar } from './navigation-helper.mjs';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/model-capabilities-'));
const env = {
  ...process.env,
  TONGZHOU_USER_DATA: path.join(root, 'profile'),
  TONGZHOU_DISABLE_UPDATES: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const script = path.join(root, 'media.cjs'),
  calls = path.join(root, 'calls.jsonl');
const tool = {
  name: 'generate_image',
  description: 'Synthetic image generator',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      model: { type: 'string', enum: ['synthetic-paint'] },
      aspect_ratio: { type: 'string', enum: ['1:1'] },
    },
    required: ['prompt', 'model'],
  },
};
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=';
await writeFile(
  script,
  `const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);if(r.id===undefined)return;let result={};
 if(r.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
 if(r.method==='tools/list')result={tools:[${JSON.stringify(tool)}]};
 if(r.method==='tools/call'){fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(r.params)+'\\n');result={content:[{type:'image',mimeType:'image/png',data:${JSON.stringify(png)}}]};}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`,
);
let app;
try {
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.waitForSelector('.app-shell');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const seed = await page.evaluate(
    async ({ command, script }) => {
      const a = window.tongzhou;
      await a.savePlugin({
        id: 'media-fixture',
        name: 'Synthetic media',
        transport: 'stdio',
        command,
        args: [script],
        url: '',
        enabled: true,
        readOnlyTools: [],
      });
      await a.testPlugin('media-fixture');
      await a.saveProvider({
        id: 'capability-fixture',
        name: '能力测试',
        protocol: 'openai-chat',
        baseUrl: 'http://127.0.0.1:1/v1',
        auth: 'none',
        models: ['chat-fixture', 'synthetic-paint'],
        maxOutputTokens: 1024,
        contextChars: 0,
      });
      const session = await a.createSession();
      await a.setSessionPermission(session.id, 'full-access');
      const canvas = await a.canvasSave({
        title: '能力验证',
        nodes: [
          {
            id: 'picture',
            kind: 'image',
            title: '合成图片',
            text: 'Synthetic fixture',
            x: 30,
            y: 30,
            media: { mode: 'text' },
          },
        ],
        edges: [],
        selection: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      });
      await a.canvasBind(session.id, canvas.id);
      const source = await a.contentWrite({
        libraryId: 'default',
        title: '合成研究来源',
        content: 'Synthetic source',
      });
      const doc = await a.contentWrite({
        libraryId: 'default',
        title: '合成研究笔记',
        content: 'Synthetic note',
        sourceIds: [source.id],
      });
      return { canvasId: canvas.id, sessionId: session.id, docId: doc.id, sourceId: source.id };
    },
    { command: process.execPath, script },
  );
  await openSidebar(page, '模型');
  await page.getByRole('button', { name: '编辑 能力测试', exact: true }).click();
  await page.getByText('模型能力与画布', { exact: true }).click();
  await page.getByLabel('配置模型能力', { exact: true }).selectOption('synthetic-paint');
  await page.getByRole('button', { name: '采用工具目录中的能力匹配', exact: true }).click();
  assert.equal(
    await page.getByRole('checkbox', { name: '文本生成', exact: true }).isChecked(),
    false,
  );
  assert.equal(
    await page.getByRole('checkbox', { name: '图片生成', exact: true }).isChecked(),
    true,
  );
  await page.getByRole('dialog').screenshot({ path: path.join(root, 'capabilities.png') });
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const saved = await page.evaluate(async () =>
    (await window.tongzhou.snapshot()).providers.find((p) => p.id === 'capability-fixture'),
  );
  assert.equal(saved.modelCapabilities['synthetic-paint'].bindings.image.pluginId, 'media-fixture');
  await openSidebar(page, '创作');
  await openCanvas(page, seed.canvasId);
  await page.getByRole('button', { name: '画布设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '画布设置', exact: true });
  await settings.getByLabel('画布会话', { exact: true }).selectOption(seed.sessionId);
  await settings.getByRole('button', { name: '关闭', exact: true }).click();
  const node = page.getByRole('article', { name: '合成图片，图片生成', exact: true });
  await node.locator('header').click();
  const panel = page.getByRole('form', { name: '生成配置', exact: true });
  await panel
    .getByLabel('已配置的生成模型', { exact: true })
    .selectOption(JSON.stringify(['capability-fixture', 'synthetic-paint']));
  await panel.getByRole('button', { name: '生成', exact: true }).click();
  await node.locator('img').waitFor({ timeout: 30000 });
  let completed = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await page.evaluate((id) => window.tongzhou.canvasState(id), seed.canvasId);
    if (state.runs[0]?.status === 'completed') {
      completed = true;
      break;
    }
    if (state.runs[0]?.status === 'failed') throw new Error(JSON.stringify(state.runs[0]));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(completed, 'Generation must complete before inspecting the tool result');
  const logged = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].arguments.model, 'synthetic-paint');
  await page.screenshot({ path: path.join(root, 'generation.png') });
  await openSidebar(page, '智库');
  await page.locator(`[data-document-id="${seed.docId}"]`).click();
  await page.getByLabel('更多文档操作', { exact: true }).click();
  await page.getByRole('button', { name: '内容属性与来源', exact: true }).click();
  const props = page.getByRole('dialog', { name: '内容属性与来源', exact: true });
  await props.getByLabel('内容类型', { exact: true }).fill('research/note');
  await props.getByLabel('标签（逗号分隔）', { exact: true }).fill('学习, 项目');
  await props.screenshot({ path: path.join(root, 'content-properties.png') });
  // Concurrent changes must not silently overwrite content.
  await page.evaluate(async (id) => {
    const a = window.tongzhou,
      d = (await a.knowledgeRead(id)).document;
    await a.contentWrite({
      id,
      version: d.version,
      libraryId: 'default',
      title: d.title,
      content: 'Concurrent edit',
    });
  }, seed.docId);
  await props.getByRole('button', { name: '保存', exact: true }).click();
  await props.getByRole('alert').waitFor();
  assert.equal(await props.getByLabel('内容类型', { exact: true }).inputValue(), 'research/note');
  await props.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByLabel('更多文档操作', { exact: true }).click();
  await page.getByRole('button', { name: '内容属性与来源', exact: true }).click();
  await props.getByLabel('内容类型', { exact: true }).fill('research/note');
  await props.getByLabel('标签（逗号分隔）', { exact: true }).fill('学习, 项目');
  await props.getByRole('button', { name: '保存', exact: true }).click();
  await props.waitFor({ state: 'hidden' });
  const doc = await page.evaluate(
    async (id) => (await window.tongzhou.knowledgeRead(id)).document,
    seed.docId,
  );
  assert.equal(doc.contentType, 'research/note');
  assert.equal(doc.content, 'Concurrent edit');
  assert.deepEqual(doc.tags, ['学习', '项目']);
  assert.equal(doc.sources.find((s) => s.id === seed.sourceId).version, 1);
  await page.getByLabel('筛选内容类型', { exact: true }).selectOption('research/note');
  await page.locator(`[data-document-id="${seed.docId}"]`).waitFor();
  assert.equal(await page.locator(`[data-document-id="${seed.sourceId}"]`).count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(root, 'report.json'),
    JSON.stringify(
      { passed: true, toolCalls: logged.length, properties: true, conflictPreserved: true },
      null,
      2,
    ),
  );
  console.log('Model capabilities and content properties passed: ' + root);
} catch (e) {
  if (app)
    await (await app.firstWindow())
      .screenshot({ path: path.join(root, 'failure.png') })
      .catch(() => {});
  throw e;
} finally {
  await app?.close();
}
