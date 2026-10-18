import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openSidebar } from './navigation-helper.mjs';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/canvas-'));
const requests = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const last = body.messages.findLastIndex((m) => m.role === 'user');
  const done = body.messages.slice(last + 1).some((m) => m.role === 'tool');
  const isSplit = JSON.stringify(body.messages[last]).includes('输出分类与要求');
  const delta = isSplit
    ? {
        content: JSON.stringify({
          characters: [
            { name: '林舟', description: '穿蓝色长衫的少年' },
            { name: '阿月', description: '身穿白衣的少女' },
          ],
          scenes: [{ name: '竹林', description: '薄雾笼罩的竹林' }],
          props: [{ name: '纸伞', description: '一把黄色油纸伞' }],
        }),
      }
    : done
      ? { content: '已读取最新选区，建议增加一段旁白。' }
      : {
          tool_calls: [
            { index: 0, id: 'canvas-read', function: { name: 'canvas_read', arguments: '{}' } },
          ],
        };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    'data: ' +
      JSON.stringify({
        choices: [{ delta, finish_reason: done || isSplit ? 'stop' : 'tool_calls' }],
      }) +
      '\n\ndata: [DONE]\n\n',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
let app;
try {
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  const waitForApi = async (predicate, arg) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const result = await page.evaluate(predicate, arg);
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for API state');
  };
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.app-shell');
  const seed = await page.evaluate(async (baseUrl) => {
    const api = window.tongzhou;
    await api.saveProvider({
      id: 'fixture',
      name: '画布测试',
      protocol: 'openai-chat',
      baseUrl,
      auth: 'none',
      models: ['mock'],
      maxOutputTokens: 1000,
      contextChars: 50000,
    });
    const session = await api.createSession();
    await api.updateSession(session.id, {
      title: '画布功能测试',
      providerId: 'fixture',
      model: 'mock',
    });
    await api.setSessionPermission(session.id, 'full-access');
    const canvas = await api.canvasSave({
      title: '故事工作流',
      nodes: [
        { id: 'a', kind: 'text', title: '故事', text: '初始正文', x: 0, y: 0 },
        {
          id: 'b',
          kind: 'audio',
          title: '旁白',
          text: '你好',
          x: 300,
          y: 0,
          media: { count: 1, mode: 'text' },
        },
      ],
      edges: [{ id: 'ab', from: 'a', to: 'b', kind: 'dependency' }],
      viewport: { x: 40, y: 40, zoom: 1 },
      selection: ['a'],
    });
    await api.canvasBind(session.id, canvas.id);
    return { sessionId: session.id, canvasId: canvas.id };
  }, `http://127.0.0.1:${server.address().port}/v1`);
  const closeConfig = async () => {
    const dialog = page.getByRole('dialog', { name: '节点配置', exact: true });
    if (await dialog.count())
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  };
  const configure = async (name) => {
    await closeConfig();
    const chat = page.getByRole('region', { name: '画布助手' });
    if (await chat.isVisible()) await chat.getByRole('button', { name: '收起画布聊天' }).click();
    const node = name
      ? page.getByRole('article', { name, exact: true })
      : page.locator('.canvas-node.selected').first();
    await node.locator('header').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '配置节点', exact: true }).click();
  };
  const bindSession = async () => {
    await closeConfig();
    await page.getByRole('button', { name: '画布设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '画布设置', exact: true });
    await dialog.getByLabel('执行会话', { exact: true }).selectOption(seed.sessionId);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  };
  await openSidebar(page, '画布');
  await page.getByLabel('选择画布', { exact: true }).selectOption(seed.canvasId);
  await bindSession();
  await configure('故事，文本');
  await page.getByLabel('正文', { exact: true }).fill('未手动保存的新正文');
  await closeConfig();
  await page.getByRole('button', { name: '展开画布聊天' }).click();
  await page.getByLabel('向画布助手提问').fill('请检查这个节点');
  await page
    .getByRole('region', { name: '画布助手' })
    .getByRole('button', { name: '发送', exact: true })
    .click();
  await page
    .getByRole('region', { name: '画布助手' })
    .getByText('已读取最新选区，建议增加一段旁白。', { exact: true })
    .waitFor({ timeout: 30000 });
  assert(requests.some((r) => JSON.stringify(r.messages).includes('未手动保存的新正文')));
  await page.locator('.canvas-chat-actions summary').last().click();
  await page.getByRole('button', { name: '插入画布', exact: true }).click();
  assert.equal(await page.locator('.canvas-node').count(), 3);
  await page.getByRole('button', { name: '收起画布聊天' }).click();
  await page.getByRole('button', { name: '提示词库', exact: true }).click();
  await page.getByRole('button', { name: '分镜拆解' }).click();
  await page.getByLabel('变量 镜头数量').fill('3');
  await page.getByLabel('变量 故事').fill('小猫回家');
  await page.getByRole('button', { name: '插入为文本节点', exact: true }).click();
  assert.equal(await page.locator('.canvas-node').count(), 4);
  await page.getByRole('button', { name: '提示词库', exact: true }).click();
  await page.getByRole('button', { name: '新建提示词', exact: true }).click();
  const library = page.getByRole('dialog', { name: '提示词库', exact: true });
  await library.getByLabel('名称', { exact: true }).fill('自定义配音');
  await library.getByLabel('标签（逗号分隔）').fill('配音, 测试');
  await library.getByLabel('提示词', { exact: true }).fill('请朗读 {{内容}}');
  await library.getByRole('button', { name: '保存到内容库', exact: true }).click();
  await library.getByRole('button', { name: '自定义配音' }).waitFor();
  const prompts = await page.evaluate(() => window.tongzhou.canvasLibrary('prompt'));
  assert.deepEqual(prompts[0].tags, ['配音', '测试']);
  await page.screenshot({ path: path.join(root, 'prompt-library.png') });
  await library.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.canvas-board').focus();
  await page.keyboard.press('Control+a');
  await page.getByLabel('批量操作').selectOption('group');
  assert.equal(await page.locator('.canvas-group').count(), 1);
  await page.getByRole('button', { name: '复制选中', exact: true }).click();
  assert.equal(await page.locator('.canvas-node').count(), 8);
  assert.equal(await page.locator('.canvas-group').count(), 2);
  await closeConfig();
  await page.getByRole('button', { name: '适应', exact: true }).click();
  await page.locator('.canvas-minimap').click({ position: { x: 60, y: 40 } });
  await page.getByRole('button', { name: '保存为模板', exact: true }).click();
  await page.getByText('已保存到内容库的“画布模板”目录。', { exact: false }).waitFor();
  const templates = await page.evaluate(() => window.tongzhou.canvasLibrary('template'));
  assert.equal(templates.length, 1);
  await page.getByRole('button', { name: '模板库', exact: true }).click();
  await page
    .getByRole('dialog', { name: '工作流模板', exact: true })
    .getByRole('button', { name: '故事工作流' })
    .click();
  await page.getByRole('button', { name: '使用模板创建画布', exact: true }).click();
  await page
    .getByText('模板已创建。请重新选择素材、插件连接和执行会话。', { exact: false })
    .waitFor();
  assert.equal(await page.locator('.canvas-node').count(), 8);
  const exportPath = path.join(root, 'workflow.canvas.json');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, exportPath);
  await page.getByLabel('导出画布', { exact: true }).selectOption('project');
  await page.getByText('已导出到：' + exportPath, { exact: false }).waitFor();
  const exported = JSON.parse(await readFile(exportPath, 'utf8'));
  assert.equal(exported.format, 'tongzhou-canvas');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, exportPath);
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await page
    .getByText('已导入。请重新选择模型／插件连接，并检查素材和输出位置。', { exact: false })
    .waitFor();
  await page.screenshot({ path: path.join(root, 'canvas.png') });
  const wav = Buffer.alloc(32044);
  wav.write('RIFF');
  wav.writeUInt32LE(32036, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(32000, 40);
  const audioPath = path.join(root, 'audio.wav');
  await writeFile(audioPath, wav);
  // Use the existing import boundary, with the native file chooser selecting only this fixture.
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, audioPath);
  const importedAudio = await page.evaluate(() => window.tongzhou.contentImport('default'));
  assert.equal(importedAudio.imported.length, 1);
  // Single-node configuration is also reachable without changing group membership.
  await page.getByRole('button', { name: '旁白保存位置', exact: true }).first().click();
  await page.getByLabel('生成模式', { exact: true }).selectOption('existing');
  await page.getByRole('button', { name: '选择已有素材', exact: true }).click();
  await page.getByRole('button', { name: 'audio.wav', exact: false }).click();
  await page.locator('.canvas-inspector audio').waitFor();
  assert(
    (await page.locator('.canvas-inspector audio').getAttribute('src')).startsWith(
      'data:audio/wav;base64,',
    ),
  );
  await page.waitForFunction(() => document.querySelector('.canvas-inspector audio')?.duration > 0);
  await page.locator('.canvas-inspector audio').evaluate(async (audio) => {
    await audio.play();
    audio.pause();
  });
  await page.screenshot({ path: path.join(root, 'audio-node.png') });
  // New visual plugins use the same creation, editing and persistence path as native nodes.
  await closeConfig();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByTitle('新建画布', { exact: true }).click();
  for (const id of ['markdown', 'svg', 'html', 'sticky-note', 'panorama']) {
    await page.getByLabel('节点类型', { exact: true }).selectOption('visual.' + id);
    await page.getByRole('button', { name: '添加节点', exact: true }).click();
  }
  await closeConfig();
  await page.getByRole('button', { name: '适应', exact: true }).click();
  await page.locator('.canvas-markdown h1').waitFor();
  assert.equal(
    await page.frameLocator('iframe[title="SVG 预览"]').locator('svg circle').count(),
    1,
  );
  await page
    .frameLocator('iframe[title="HTML 预览"]')
    .getByText('你好，CoSail', { exact: true })
    .waitFor();
  assert.equal(
    await page
      .frameLocator('iframe[title="HTML 预览"]')
      .locator('body')
      .evaluate((body) => getComputedStyle(body).paddingTop),
    '20px',
  );
  const pngData = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 256;
    const ctx = c.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 512, 0);
    gradient.addColorStop(0, '#0a5');
    gradient.addColorStop(0.5, '#f80');
    gradient.addColorStop(1, '#09f');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 512, 256);
    return c.toDataURL().split(',')[1];
  });
  const panoramaPath = path.join(root, 'panorama.png');
  await writeFile(panoramaPath, Buffer.from(pngData, 'base64'));
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, panoramaPath);
  await page.evaluate(() => window.tongzhou.contentImport('default'));
  await configure('3D 全景，3D 全景');
  await page.getByRole('button', { name: '选择全景图片', exact: true }).click();
  await page.getByRole('button', { name: 'panorama.png', exact: false }).click();
  await page.waitForFunction(() => {
    const c = document.querySelector('.canvas-panorama canvas'),
      gl = c?.getContext('webgl');
    if (!gl) return false;
    const pixel = new Uint8Array(4);
    gl.readPixels(c.width / 2, c.height / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return pixel[3] === 255 && pixel[0] > 0;
  });
  await closeConfig();
  const pano = page.getByLabel('全景预览，拖动环视');
  await pano.focus();
  await page.keyboard.press('ArrowRight');
  await configure('3D 全景，3D 全景');
  assert.equal(await page.getByLabel('水平角度', { exact: false }).inputValue(), '5');
  await closeConfig();
  // Preview frames must route right-clicks to their node, including multi-selection.
  for (const kind of ['HTML', 'SVG']) {
    const frame = await page.locator(`iframe[title="${kind} 预览"]`).boundingBox();
    assert(frame);
    await page.mouse.click(frame.x + frame.width / 2, frame.y + frame.height / 2, {
      button: 'right',
    });
    await page.getByRole('menuitem', { name: '删除节点', exact: true }).click();
    assert.equal(await page.locator('.canvas-node').count(), 4);
    await page.locator('.canvas-board').focus();
    await page.keyboard.press('Control+z');
    assert.equal(await page.locator('.canvas-node').count(), 5);
  }
  await page.locator('.canvas-board').focus();
  await page.keyboard.press('Control+a');
  const htmlFrame = await page.locator('iframe[title="HTML 预览"]').boundingBox();
  await page.mouse.click(htmlFrame.x + htmlFrame.width / 2, htmlFrame.y + htmlFrame.height / 2, {
    button: 'right',
  });
  await page.getByRole('menuitem', { name: '删除选中节点（5）', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  const htmlOutput = page.getByLabel('HTML 输出 结果', { exact: true });
  const nextNode = page.getByRole('dialog', { name: '选择后续节点', exact: true });
  await htmlOutput.hover();
  await nextNode.waitFor();
  await page.keyboard.press('Escape');
  await htmlOutput.click();
  await nextNode.waitFor();
  await nextNode.getByRole('button', { name: 'Agent 处理 输入：输入内容', exact: true }).click();
  assert.equal(await page.locator('.canvas-node').count(), 6);
  await page.locator('.canvas-board').focus();
  await page.keyboard.press('Control+z');
  assert.equal(await page.locator('.canvas-node').count(), 5);
  await page.locator('.canvas-board').click({ position: { x: 10, y: 10 } });
  await configure('HTML，HTML');
  await page
    .getByLabel('HTML 源码', { exact: true })
    .fill(
      '<h1>隔离测试</h1><script>parent.__canvasEscape = true</script><meta http-equiv="refresh" content="0;url=https://example.invalid/"><iframe src="https://example.invalid/"></iframe>',
    );
  await page
    .frameLocator('iframe[title="HTML 预览"]')
    .getByText('隔离测试', { exact: true })
    .waitFor();
  assert.equal(await page.locator('iframe[title="HTML 预览"]').getAttribute('sandbox'), '');
  assert.equal(
    await page
      .frameLocator('iframe[title="HTML 预览"]')
      .locator('script, iframe, meta[http-equiv="refresh"]')
      .count(),
    0,
  );
  assert.equal(await page.evaluate(() => window.__canvasEscape), undefined);
  await configure('便利贴，便利贴');
  await page.getByLabel('便签内容', { exact: true }).fill('验证保存后的便签');
  await page.getByLabel('便签颜色', { exact: false }).selectOption('pink');
  await closeConfig();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const visualId = await page.getByLabel('选择画布', { exact: true }).inputValue();
  const visualState = await page.evaluate((id) => window.tongzhou.canvasState(id), visualId);
  assert.equal(
    visualState.canvas.nodes.find((n) => n.pluginId === 'visual.panorama').config.yaw,
    5,
  );
  await page.getByLabel('选择画布', { exact: true }).selectOption(seed.canvasId);
  await page.getByLabel('选择画布', { exact: true }).selectOption(visualId);
  await page.getByText('验证保存后的便签', { exact: true }).first().waitFor();
  assert.equal(await page.locator('.canvas-sticky-note.note-pink').count(), 1);
  assert.equal(await page.locator('.canvas-plugin-view').count(), 5);
  await page.screenshot({ path: path.join(root, 'visual-plugins.png') });
  await page.getByTitle('新建画布', { exact: true }).click();
  await bindSession();
  for (const kind of ['text', 'content.split', 'image']) {
    await page.getByLabel('节点类型', { exact: true }).selectOption(kind);
    await page.getByRole('button', { name: '添加节点', exact: true }).click();
    if (kind === 'text') {
      await configure();
      await page
        .getByLabel('正文', { exact: true })
        .fill('林舟穿蓝色长衫，阿月穿白衣，两人在竹林里撑着黄色油纸伞。');
      await closeConfig();
    }
  }
  await closeConfig();
  await page.getByRole('button', { name: '适应', exact: true }).click();
  // Drag actual port buttons; each edge carries its source and destination port identity.
  const dragPort = async (from, to) => {
    const a = await page.getByRole('button', { name: from, exact: true }).boundingBox();
    const b = await page.getByRole('button', { name: to, exact: true }).boundingBox();
    assert(a && b);
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
    await page.mouse.up();
  };
  await dragPort('文本 输出 文本', '内容拆分 输入 原文内容');
  await dragPort('内容拆分 输出 人物', '图片生成 输入 提示词');
  await configure('内容拆分，Agent 处理');
  await page.getByLabel('输出名称 1', { exact: true }).fill('角色');
  await page.getByLabel('提取要求 1', { exact: true }).fill('提取角色姓名与服装，不要混入场景');
  await closeConfig();
  await page.getByRole('button', { name: '运行选中', exact: true }).click();
  await configure('内容拆分，Agent 处理');
  await page
    .getByRole('button', { name: '展开角色为文本节点', exact: true })
    .waitFor({ timeout: 30000 });
  assert.equal(
    await page.locator('.canvas-split-results').getByText('角色 · 2 项', { exact: true }).count(),
    1,
  );
  const splitId = await page.getByLabel('选择画布', { exact: true }).inputValue();
  const splitState = await page.evaluate((id) => window.tongzhou.canvasState(id), splitId);
  assert.equal(splitState.canvas.edges.length, 2);
  assert(splitState.canvas.edges.some((e) => e.fromPort === 'characters' && e.toPort === 'prompt'));
  assert.equal(splitState.runs[0].status, 'completed');
  const splitNode = splitState.canvas.nodes.find((n) => n.pluginId === 'content.split');
  assert.equal(splitState.runs[0].nodes[splitNode.id].output.ports.characters.items.length, 2);
  await page.screenshot({ path: path.join(root, 'split-ports.png') });
  await page.getByRole('button', { name: '展开角色为文本节点', exact: true }).click();
  assert.equal(await page.locator('.canvas-node').count(), 5);
  await closeConfig();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const expanded = await page.evaluate((id) => window.tongzhou.canvasState(id), splitId);
  assert(
    expanded.canvas.nodes.some(
      (n) => n.kind === 'text' && n.title === '林舟' && n.text.includes('蓝色长衫'),
    ),
  );
  await configure('内容拆分，Agent 处理');
  await page.getByRole('button', { name: '添加输出类别', exact: true }).click();
  await page.getByLabel('输出名称 4', { exact: true }).fill('对白');
  await page.getByLabel('提取要求 4', { exact: true }).fill('提取人物对白');
  await closeConfig();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByLabel('选择画布', { exact: true }).selectOption(seed.canvasId);
  await page.getByLabel('选择画布', { exact: true }).selectOption(splitId);
  await configure('内容拆分，Agent 处理');
  assert.equal(await page.getByLabel('输出名称 4', { exact: true }).inputValue(), '对白');
  await page.getByRole('button', { name: '删除输出 1', exact: true }).click();
  await closeConfig();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  const removed = await page.evaluate((id) => window.tongzhou.canvasState(id), splitId);
  assert.equal(removed.canvas.edges.length, 1);
  // Publish a deterministic workflow using the real scheduler, without external services.
  await page.getByTitle('新建画布', { exact: true }).click();
  await bindSession();
  for (const kind of ['workflow.schedule', 'workflow.template']) {
    await page.getByLabel('节点类型', { exact: true }).selectOption(kind);
    await page.getByRole('button', { name: '添加节点', exact: true }).click();
  }
  await closeConfig();
  await page.getByRole('button', { name: '适应', exact: true }).click();
  await dragPort('定时触发 输出 触发信息', '文本模板 / 合并 输入 输入正文');
  await configure('定时触发，工具调用');
  await page.getByRole('button', { name: '保存并启用定时流程', exact: true }).click();
  await page.getByRole('button', { name: '暂停定时流程', exact: true }).waitFor();
  const scheduledCanvasId = await page.getByLabel('选择画布', { exact: true }).inputValue();
  const scheduledRule = await page.evaluate(
    async (id) => (await window.tongzhou.automationState()).rules.find((r) => r.canvas?.id === id),
    scheduledCanvasId,
  );
  assert.equal(scheduledRule.kind, 'canvas');
  assert.equal(scheduledRule.permission, 'ask');
  await page.evaluate((id) => window.tongzhou.automationRun(id), scheduledRule.id);
  await waitForApi(
    async (id) =>
      (await window.tongzhou.automationState()).jobs.some(
        (j) => j.rule.id === id && j.status === 'completed',
      ),
    scheduledRule.id,
  );
  await closeConfig();
  await page.getByRole('button', { name: '画布设置', exact: true }).click();
  assert(await page.getByLabel('执行记录', { exact: true }).inputValue());
  await page
    .getByRole('dialog', { name: '画布设置', exact: true })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await configure('定时触发，工具调用');
  await page.screenshot({ path: path.join(root, 'scheduled-workflow.png') });
  await page.getByRole('button', { name: '暂停定时流程', exact: true }).click();
  await waitForApi(
    async (id) => !(await window.tongzhou.automationState()).rules.find((r) => r.id === id).enabled,
    scheduledRule.id,
  );
  await closeConfig();
  await page.getByLabel('节点类型', { exact: true }).selectOption('workflow.notify');
  await page.getByRole('button', { name: '添加节点', exact: true }).click();
  await configure();
  await page.getByLabel('通知渠道', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('通知渠道', { exact: true }).inputValue(), '');
  await page.screenshot({ path: path.join(root, 'notification-node.png') });
  await page.evaluate(async () => {
    await window.tongzhou.saveChannel({
      id: 'canvas-test-mail',
      name: '测试邮件（拒绝发送）',
      kind: 'email',
      enabled: true,
      smtp: {
        host: '127.0.0.1',
        port: 9,
        secure: false,
        user: 'test@example.invalid',
        from: 'test@example.invalid',
        to: ['receiver@example.invalid'],
        subject: 'fixture',
      },
      password: 'fixture-only',
    });
  });
  await page.getByLabel('通知渠道', { exact: true }).selectOption('canvas-test-mail');
  await closeConfig();
  await page.getByRole('button', { name: '适应', exact: true }).click();
  await dragPort('文本模板 / 合并 输出 模板正文', '渠道通知 输入 消息正文');
  await configure('定时触发，工具调用');
  await page.getByRole('button', { name: '保存并重新发布定时流程', exact: true }).click();
  await page.getByRole('button', { name: '暂停定时流程', exact: true }).waitFor();
  await page.evaluate((id) => window.tongzhou.automationRun(id), scheduledRule.id);
  const approval = await waitForApi(async () =>
    (await window.tongzhou.snapshot()).approvals.find((a) => a.title.includes('发送通知')),
  );
  await page.evaluate((id) => window.tongzhou.approve(id, false), approval.id);
  await waitForApi(
    async (id) =>
      (await window.tongzhou.automationState()).jobs.some(
        (j) => j.rule.id === id && j.status === 'failed' && j.error.includes('未批准'),
      ),
    scheduledRule.id,
  );
  assert.equal(
    await page.evaluate(async () => (await window.tongzhou.snapshot()).deliveries.length),
    0,
  );
  await page.getByRole('button', { name: '暂停定时流程', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(
    'Canvas smoke passed: draft sync, prompts, transfer, typed ports, extraction, scheduling, notification approval rejection and persistence. ' +
      root,
  );
} catch (error) {
  console.error(error);
  if (app) {
    const page = await app.firstWindow();
    await page.screenshot({ path: path.join(root, 'failure.png'), timeout: 5000 }).catch(() => {});
    console.error((await page.locator('body').innerText()).slice(-12000));
  }
  throw error;
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
