import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openCanvas, openSidebar } from './navigation-helper.mjs';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/canvas-media-node-'));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const calls = path.join(root, 'calls.jsonl');
let app;
try {
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForSelector('.app-shell');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 640, 480);
    gradient.addColorStop(0, '#7694cb');
    gradient.addColorStop(1, '#d8c3a6');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = '#f9e5cc';
    ctx.beginPath();
    ctx.arc(320, 160, 72, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3d526e';
    ctx.fillRect(246, 245, 148, 235);
    return canvas.toDataURL().split(',')[1];
  });
  const tool = {
    name: 'generate_image',
    description: 'Fixture image generation',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        model: { enum: ['fixture-model'] },
        aspect_ratio: { enum: ['1:1', '4:3'] },
        resolution: { enum: ['1K', '2K'] },
        quality: { type: 'string', enum: ['standard', 'high'] },
      },
      required: ['prompt'],
    },
  };
  const video = {
    name: 'generate_video',
    description: 'Fixture video generation',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        first_frame_image_url: { type: 'string' },
        duration: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['prompt'],
    },
  };
  const script = path.join(root, 'media.cjs');
  await writeFile(
    script,
    `const fs = require('node:fs'); require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const r = JSON.parse(line); if(r.id === undefined) return; let result = {};
    if(r.method === 'initialize') result = {protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'media-fixture',version:'1'}};
    if(r.method === 'tools/list') result = {tools:${JSON.stringify([tool, { ...tool, name: 'generate_image_alternate' }, video])}};
    if(r.method === 'tools/call') { fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(r.params)+'\\n'); result = r.params.arguments.prompt.includes('FAIL') ? {isError:true,content:[{type:'text',text:'Fixture generation failed'}]} : {content:[{type:'image',mimeType:'image/png',data:${JSON.stringify(png)}}]}; }
    setTimeout(() => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n'), r.method === 'tools/call' ? 600 : 0);
  });`,
  );
  const seed = await page.evaluate(
    async ({ command, script }) => {
      const api = window.tongzhou;
      await api.savePlugin({
        id: 'media-fixture',
        name: '媒体测试',
        transport: 'stdio',
        command,
        args: [script],
        url: '',
        enabled: true,
        readOnlyTools: [],
      });
      await api.testPlugin('media-fixture');
      const session = await api.createSession();
      await api.setSessionPermission(session.id, 'full-access');
      const canvas = await api.canvasSave({
        title: '生成交互测试',
        nodes: [
          {
            id: 'image',
            kind: 'image',
            title: '角色设定图',
            x: 40,
            y: 20,
            width: 380,
            height: 270,
            media: { mode: 'text' },
          },
          {
            id: 'other',
            kind: 'image',
            title: '不要执行的节点',
            x: 560,
            y: 20,
            width: 300,
            height: 230,
            text: 'untouched',
          },
        ],
        edges: [],
        selection: ['image'],
        viewport: { x: 25, y: 55, zoom: 1 },
      });
      await api.canvasBind(session.id, canvas.id);
      return { canvasId: canvas.id, sessionId: session.id };
    },
    { command: process.execPath, script },
  );
  await openSidebar(page, '创作');
  await openCanvas(page, seed.canvasId);
  await page.getByRole('button', { name: '画布设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '画布设置', exact: true });
  await settings.getByLabel('画布会话', { exact: true }).selectOption(seed.sessionId);
  await settings.getByRole('button', { name: '关闭', exact: true }).click();
  const node = page.getByRole('article', { name: '角色设定图，图片生成', exact: true });
  const panel = page.getByRole('form', { name: '生成配置', exact: true });
  assert.equal(await page.locator('.canvas-chat-float').isVisible(), false);
  assert.equal(await node.getByRole('button', { name: '配置生成', exact: true }).count(), 0);
  await node.locator('header').click();
  await panel.waitFor();
  await panel.getByRole('button', { name: '收起生成配置' }).click();
  await panel.waitFor({ state: 'hidden' });
  await node.locator('.canvas-media-prompt-summary').click();
  await panel.waitFor();
  assert.equal(
    await page.getByRole('region', { name: '画布助手', exact: true }).isVisible(),
    false,
  );
  await page.locator('.canvas-chat-launcher').click();
  assert.equal(await panel.evaluate((el) => !!el.closest('.canvas-chat-float')), true);
  const compactBounds = await page.locator('.canvas-chat-float').boundingBox();
  assert(compactBounds.width <= 400 && compactBounds.height <= 900);
  assert.equal(await page.locator('.canvas-chat-float [role="tab"]').count(), 0);
  const configRegion = page.getByRole('region', { name: '节点配置', exact: true });
  const chatRegion = page.getByRole('region', { name: '画布助手', exact: true });
  const configBounds = await configRegion.boundingBox();
  const chatBounds = await chatRegion.boundingBox();
  assert(configBounds.y + configBounds.height + 12 <= chatBounds.y);
  assert(chatBounds.height >= 250, 'Configuration must leave usable space for the conversation');
  await page.getByLabel('向画布助手提问').fill('保留这条未发送的草稿');
  const modelBounds = await chatRegion.getByLabel('助手模型', { exact: true }).boundingBox();
  const inputBounds = await page.getByLabel('向画布助手提问').boundingBox();
  assert(
    modelBounds.y >= inputBounds.y + inputBounds.height,
    'Model selection belongs below the composer',
  );
  await node.locator('header').click();
  assert(await chatRegion.isVisible());
  await panel.waitFor();
  assert(await panel.getByRole('button', { name: '生成', exact: true }).isDisabled());
  await panel.getByLabel('生成提示词', { exact: true }).fill('Portrait, blue jacket, warm light');
  await panel.getByLabel('生成插件', { exact: true }).selectOption('media-fixture');
  await panel.getByLabel('画面比例', { exact: true }).selectOption('4:3');
  await panel.getByLabel('分辨率', { exact: true }).selectOption('2K');
  await panel.getByLabel('生成工具', { exact: true }).selectOption('generate_image_alternate');
  assert.equal(await panel.getByLabel('画面比例', { exact: true }).inputValue(), '4:3');
  assert.equal(await panel.getByLabel('分辨率', { exact: true }).inputValue(), '2K');
  await panel.getByRole('button', { name: '高级配置', exact: true }).click();
  const advanced = page.getByRole('dialog', { name: '节点配置', exact: true });
  assert.equal(await advanced.getByLabel('生成提示词', { exact: true }).count(), 0);
  assert.equal(await advanced.getByLabel('生成插件', { exact: true }).count(), 0);
  assert.equal(await advanced.getByLabel('画面比例', { exact: true }).count(), 0);
  assert.equal(await advanced.getByRole('region', { name: '生成结果' }).count(), 0);
  await advanced.getByLabel('quality').selectOption('high');
  await advanced.getByRole('button', { name: '返回生成配置' }).click();
  await page.getByText('草稿已暂存，尚未保存', { exact: true }).waitFor();
  const before = await node.boundingBox();
  await panel.getByLabel('生成数量', { exact: true }).selectOption('1');
  assert.deepEqual(await node.boundingBox(), before, 'Editing settings must not drag the node');
  // Wheel over a settings panel must not pan the canvas.
  const viewport = await page.evaluate(
    async (id) => (await window.tongzhou.canvasState(id)).canvas.viewport,
    seed.canvasId,
  );
  await panel.hover();
  await page.mouse.wheel(0, 100);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  assert.deepEqual(
    await page.evaluate(
      async (id) => (await window.tongzhou.canvasState(id)).canvas.viewport,
      seed.canvasId,
    ),
    viewport,
  );
  await page.screenshot({ path: path.join(root, 'empty-config.png') });
  await panel.getByRole('button', { name: '生成', exact: true }).click();
  await node.getByText('生成中', { exact: false }).first().waitFor();
  await node.locator('img').waitFor({ timeout: 30000 });
  await page.waitForFunction(
    async (id) => (await window.tongzhou.canvasState(id)).runs[0]?.status === 'completed',
    seed.canvasId,
  );
  const logged = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(logged.length, 1);
  assert(logged[0].arguments.prompt.includes('Portrait'));
  assert.equal(logged[0].arguments.aspect_ratio, '4:3');
  assert.equal(logged[0].arguments.quality, 'high');
  const state = await page.evaluate((id) => window.tongzhou.canvasState(id), seed.canvasId);
  assert.equal(state.canvas.nodes.find((n) => n.id === 'image').media.resolution, '2K');
  assert(!state.runs[0].nodes.other, 'Single-node generation must not run unrelated nodes');
  assert(await node.getByRole('button', { name: '预览', exact: true }).isVisible());
  await page.screenshot({ path: path.join(root, 'result.png') });
  // Regeneration failures keep a visible explanation and a retry without opening a modal.
  await panel.getByLabel('生成提示词', { exact: true }).fill('FAIL');
  await panel.getByRole('button', { name: '重新生成', exact: true }).click();
  await page.waitForFunction(
    async (id) => (await window.tongzhou.canvasState(id)).runs[0]?.status === 'failed',
    seed.canvasId,
  );
  await panel.getByRole('button', { name: '重生成', exact: true }).waitFor();
  assert.equal(
    await node.locator('img').count(),
    1,
    'A failed regeneration keeps the previous image visible',
  );
  await panel.getByLabel('生成提示词', { exact: true }).fill('Portrait retry');
  assert.equal(await panel.getByRole('button', { name: '重生成', exact: true }).count(), 0);
  await panel.getByRole('button', { name: '重新生成', exact: true }).click();
  await node.locator('img').waitFor({ timeout: 30000 });
  await page.waitForFunction(async (id) => {
    const r = (await window.tongzhou.canvasState(id)).runs[0];
    return (
      r?.definition.nodes.find((n) => n.id === 'image').text === 'Portrait retry' &&
      r.status === 'completed'
    );
  }, seed.canvasId);
  await node.getByRole('button', { name: '生成历史', exact: true }).click();
  const history = page.getByRole('dialog', { name: '生成历史', exact: true });
  assert((await history.getByLabel('历史版本').locator('option').count()) >= 3);
  assert.equal(await history.getByRole('button', { name: '重新生成整组' }).count(), 0);
  await history.getByRole('button', { name: '关闭', exact: true }).click();
  await node.getByRole('button', { name: '生成视频', exact: true }).click();
  await panel.getByText('视频生成', { exact: true }).waitFor();
  await panel.getByLabel('生成插件', { exact: true }).selectOption('media-fixture');
  assert.equal(await panel.getByLabel('生成模式', { exact: true }).inputValue(), 'first-frame');
  assert(await panel.getByLabel('生成模式', { exact: true }).isDisabled());
  await panel.getByLabel('视频时长', { exact: true }).fill('5');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const connected = await page.evaluate((id) => window.tongzhou.canvasState(id), seed.canvasId);
  const videoNode = connected.canvas.nodes.find((n) => n.kind === 'video');
  assert(
    connected.canvas.edges.some(
      (e) => e.from === 'image' && e.to === videoNode.id && e.toPort === 'firstFrame',
    ),
  );
  const bounds = await page.locator('.canvas-chat-float').boundingBox();
  assert(bounds.x >= 0 && bounds.y >= 0 && bounds.y + bounds.height <= 1000);
  await page.screenshot({ path: path.join(root, 'video-config.png') });
  const inputAssets = panel.getByRole('region', { name: '输入素材', exact: true });
  assert.equal(await inputAssets.locator('.canvas-input-item').count(), 1);
  await inputAssets.getByRole('button', { name: '断开输入：角色设定图', exact: true }).click();
  assert.equal(await inputAssets.locator('.canvas-input-item').count(), 0);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  assert.equal(
    (await page.evaluate((id) => window.tongzhou.canvasState(id), seed.canvasId)).canvas.edges
      .length,
    0,
  );
  await panel.getByRole('button', { name: '收起生成配置' }).click();
  assert.equal(await panel.isVisible(), false);
  assert(await chatRegion.isVisible());
  assert((await page.locator('.canvas-chat-float').boundingBox()).height <= 520);
  assert.equal(await page.getByLabel('向画布助手提问').inputValue(), '保留这条未发送的草稿');
  await page
    .getByRole('article', { name: '视频生成，视频生成', exact: true })
    .locator('header')
    .click();
  assert.equal(await panel.getByLabel('视频时长', { exact: true }).inputValue(), '5');
  await page.setViewportSize({ width: 1000, height: 650 });
  const smallBounds = await page.locator('.canvas-chat-float').boundingBox();
  assert(smallBounds.x >= 0 && smallBounds.y >= 0 && smallBounds.y + smallBounds.height <= 650);
  assert(await chatRegion.isVisible());
  const smallConfig = await configRegion.boundingBox();
  const smallChat = await chatRegion.boundingBox();
  assert(smallConfig.y + smallConfig.height <= smallChat.y + 1);
  assert(smallChat.height >= 200);
  const outlet = page.locator('.canvas-node-config-outlet');
  assert(await outlet.evaluate((el) => el.scrollHeight > el.clientHeight));
  await panel.getByRole('button', { name: '高级配置', exact: true }).scrollIntoViewIfNeeded();
  assert(await panel.getByRole('button', { name: '高级配置', exact: true }).isVisible());
  const sendBounds = await chatRegion
    .getByRole('button', { name: '发送', exact: true })
    .boundingBox();
  assert(sendBounds.y + sendBounds.height <= smallBounds.y + smallBounds.height);
  const closeConfig = await panel.getByRole('button', { name: '收起生成配置' }).boundingBox();
  assert(
    closeConfig.y >= smallConfig.y &&
      closeConfig.y + closeConfig.height <= smallConfig.y + smallConfig.height,
  );
  await page.screenshot({ path: path.join(root, 'compact-config.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '收起画布聊天', exact: true }).click();
  assert(await configRegion.isVisible(), 'Closing chat must keep the configuration card open');
  assert.equal(await chatRegion.isVisible(), false);
  const configOnly = await configRegion.boundingBox();
  const launcher = await page.locator('.canvas-chat-launcher').boundingBox();
  assert(configOnly.y + configOnly.height <= launcher.y);
  await page.locator('.canvas-chat-launcher').click();
  assert(await configRegion.isVisible());
  assert(await chatRegion.isVisible());
  await page.locator('.canvas-board').click({ position: { x: 10, y: 10 } });
  await configRegion.waitFor({ state: 'hidden' });
  assert(await chatRegion.isVisible());
  await page.getByRole('button', { name: '收起画布聊天', exact: true }).click();
  assert.equal(await page.locator('.canvas-chat-float').isVisible(), false);
  await page.locator('.canvas-chat-launcher').click();
  assert.equal(await configRegion.isVisible(), false);
  assert.equal(await page.getByLabel('向画布助手提问').inputValue(), '保留这条未发送的草稿');
  assert.deepEqual(errors, []);
  console.log(
    'Canvas media node smoke passed: inline setup, single-node generation, failure retry, references, viewport placement. ' +
      root,
  );
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    console.error((await page.locator('body').innerText()).slice(-6000));
  }
  throw error;
} finally {
  if (app) await app.close();
}
