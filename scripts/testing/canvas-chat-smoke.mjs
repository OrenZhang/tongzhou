import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openSidebar } from './navigation-helper.mjs';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/canvas-chat-'));
const requests = [];
let release,
  waiting = false,
  recoveryAttempts = 0;
const server = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const last = body.messages.findLastIndex((m) => m.role === 'user');
    const userMessage = String(body.messages[last].content);
    const prompt = userMessage.slice(
      userMessage.lastIndexOf('\n\n用户问题：') + '\n\n用户问题：'.length,
    );
    const tools = body.messages.slice(last + 1).filter((m) => m.role === 'tool');
    let delta;
    if (prompt.includes('仅讨论测试')) delta = { content: '只读讨论，不修改画布。' };
    else if (!tools.length)
      delta = {
        tool_calls: [{ index: 0, id: 'read', function: { name: 'canvas_read', arguments: '{}' } }],
      };
    else if (tools.length === 1) {
      const result = JSON.parse(tools[0].content);
      const canvas = result.canvas;
      assert(canvas, tools[0].content);
      if (prompt.includes('继续调整') || prompt.includes('制造冲突')) {
        waiting = true;
        await new Promise((resolve) => {
          release = resolve;
        });
        waiting = false;
      }
      const ops = prompt.includes('搭建流程')
        ? [
            {
              type: 'put_node',
              node: { id: 'source', kind: 'text', title: '故事原文', text: '初始故事', x: 0, y: 0 },
            },
            {
              type: 'put_node',
              node: {
                id: 'worker',
                kind: 'agent',
                title: '提取人物',
                text: '提取角色描述',
                x: 320,
                y: 0,
              },
            },
            {
              type: 'put_edge',
              edge: {
                id: 'link',
                from: 'source',
                fromPort: 'result',
                to: 'worker',
                toPort: 'context',
                kind: 'dependency',
              },
            },
          ]
        : [
            {
              type: 'put_node',
              node: {
                ...canvas.nodes.find((n) => n.id === 'worker'),
                text: prompt.includes('制造冲突') ? 'AI 冲突版本' : '同时提取人物和场景',
              },
            },
          ];
      delta = {
        tool_calls: [
          {
            index: 0,
            id: 'apply',
            function: {
              name: 'canvas_apply',
              arguments: JSON.stringify({ canvasId: canvas.id, version: canvas.version, ops }),
            },
          },
        ],
      };
    } else {
      const applied = JSON.parse(tools[tools.length - 1].content);
      assert(applied.nodes?.length, tools[tools.length - 1].content);
      delta = { content: '已按需求更新画布，可以继续调整。' };
    }
    if (
      tools.length === 1 &&
      delta.tool_calls &&
      ((prompt.includes('格式恢复测试') && recoveryAttempts++ === 0) ||
        (prompt.includes('失败恢复测试') && !prompt.startsWith('继续完成：')))
    )
      delta.tool_calls[0].function.arguments = '{"ops":[';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
let app;
try {
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.app-shell');
  const seed = await page.evaluate(async (baseUrl) => {
    const api = window.tongzhou;
    await api.saveProvider({
      id: 'fixture',
      name: '测试模型',
      protocol: 'openai-chat',
      baseUrl,
      auth: 'none',
      models: ['mock'],
      maxOutputTokens: 1000,
      contextChars: 50000,
    });
    const session = await api.createSession();
    await api.updateSession(session.id, {
      title: '画布协作测试',
      providerId: 'fixture',
      model: 'mock',
    });
    const canvas = await api.canvasSave({
      title: '协作流程',
      nodes: [],
      edges: [],
      selection: [],
      viewport: { x: 40, y: 40, zoom: 1 },
    });
    await api.canvasBind(session.id, canvas.id);
    return { canvasId: canvas.id, sessionId: session.id };
  }, `http://127.0.0.1:${server.address().port}/v1`);
  const poll = async (fn) => {
    const until = Date.now() + 20000;
    while (Date.now() < until) {
      if (await fn()) return;
      await page.waitForTimeout(100);
    }
    throw Error('Timed out');
  };
  await openSidebar(page, '画布');
  await page.getByLabel('选择画布', { exact: true }).selectOption(seed.canvasId);
  await page.getByRole('button', { name: '展开画布聊天', exact: true }).click();
  await page.getByRole('button', { name: '会话设置', exact: true }).click();
  await page.getByLabel('画布聊天会话').selectOption(seed.sessionId);
  await poll(
    async () =>
      (await page.getByLabel('画布聊天会话').inputValue()) === seed.sessionId &&
      !(await page.getByRole('button', { name: '新建会话', exact: true }).isDisabled()),
  );
  await page.getByRole('button', { name: '会话设置', exact: true }).click();
  const chat = page.getByRole('region', { name: '画布助手', exact: true });
  const closeConfig = async () => {
    await page
      .getByRole('dialog', { name: '节点配置', exact: true })
      .getByRole('button', { name: '关闭', exact: true })
      .click();
  };
  const configure = async (name) => {
    // Collapse the floating chat when it covers the node; the reply keeps running.
    if (await chat.isVisible()) await chat.getByRole('button', { name: '收起画布聊天' }).click();
    await page
      .getByRole('article', { name, exact: true })
      .locator('header')
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: '配置节点', exact: true }).click();
  };
  const reopenChat = async () => {
    await page.getByRole('button', { name: '展开画布聊天', exact: true }).click();
  };
  const send = async (text) => {
    await chat.getByLabel('向画布助手提问').fill(text);
    await chat.getByRole('button', { name: '发送', exact: true }).click();
  };
  await send('搭建流程：故事原文连接到人物提取节点');
  await poll(
    async () =>
      (await page.evaluate((id) => window.tongzhou.canvasState(id), seed.canvasId)).canvas.nodes
        .length === 2,
  );
  await page.getByRole('article', { name: '提取人物，Agent 处理', exact: true }).waitFor();
  await chat.getByText('已按需求更新画布，可以继续调整。', { exact: true }).waitFor();
  assert.equal(await chat.locator('.canvas-chat-message.user').count(), 1);
  assert(!(await chat.locator('.canvas-chat-message.user').innerText()).includes('canvas_apply'));
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal(await page.locator('.canvas-node').count(), 0);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  assert.equal(await page.locator('.canvas-node').count(), 2);
  await page.getByRole('button', { name: '适应', exact: true }).click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await send('继续调整：同时提取人物和场景');
  await poll(() => waiting);
  await configure('故事原文，文本');
  await page.getByLabel('正文', { exact: true }).fill('我在 AI 回复期间修改的故事');
  await closeConfig();
  release();
  await poll(
    async () =>
      (
        await page.evaluate((id) => window.tongzhou.canvasState(id), seed.canvasId)
      ).canvas.nodes.find((n) => n.id === 'worker').text === '同时提取人物和场景',
  );
  await reopenChat();
  await poll(async () => (await chat.locator('.canvas-chat-message.assistant').count()) === 2);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await poll(
    async () =>
      (
        await page.evaluate((id) => window.tongzhou.canvasState(id), seed.canvasId)
      ).canvas.nodes.find((n) => n.id === 'source').text === '我在 AI 回复期间修改的故事',
  );
  const current = await page.evaluate((id) => window.tongzhou.canvasState(id), seed.canvasId);
  assert.equal(current.canvas.edges.length, 1);
  assert.equal(current.canvas.nodes.find((n) => n.id === 'worker').text, '同时提取人物和场景');
  await send('制造冲突：修改提取要求');
  await poll(() => waiting);
  await configure('提取人物，Agent 处理');
  await page.getByLabel('处理要求', { exact: true }).fill('用户冲突版本');
  release();
  await page
    .getByText('你和 AI／其他窗口修改了同一处内容，已暂停同步。', { exact: false })
    .waitFor();
  assert.equal(await page.getByLabel('处理要求', { exact: true }).inputValue(), '用户冲突版本');
  await page.screenshot({ path: path.join(root, 'node-config.png') });
  await closeConfig();
  await reopenChat();
  await chat.getByLabel('向画布助手提问').fill('继续');
  await chat.getByRole('button', { name: '发送', exact: true }).waitFor();
  assert.equal(await chat.getByRole('button', { name: '发送', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '使用最新版本', exact: true }).click();
  await configure('提取人物，Agent 处理');
  await poll(
    async () => (await page.getByLabel('处理要求', { exact: true }).inputValue()) === 'AI 冲突版本',
  );
  await page.screenshot({ path: path.join(root, 'canvas-chat.png') });
  await closeConfig();
  await reopenChat();
  assert.equal(await chat.isVisible(), true);
  await page.screenshot({ path: path.join(root, 'chat-expanded.png') });
  await page.reload();
  await page.waitForSelector('.app-shell');
  await openSidebar(page, '画布');
  await page.getByLabel('选择画布', { exact: true }).selectOption(seed.canvasId);
  await page.getByRole('button', { name: '展开画布聊天', exact: true }).click();
  await page.getByRole('button', { name: '会话设置', exact: true }).click();
  await page.getByLabel('画布聊天会话').selectOption(seed.sessionId);
  await poll(
    async () =>
      (await page.getByLabel('画布聊天会话').inputValue()) === seed.sessionId &&
      !(await page.getByRole('button', { name: '新建会话', exact: true }).isDisabled()),
  );
  await page.getByRole('button', { name: '会话设置', exact: true }).click();
  await poll(async () => (await chat.locator('.canvas-chat-message.user').count()) === 3);
  assert.equal(await chat.getByLabel('向画布助手提问').inputValue(), '继续');
  assert.equal(
    await page.evaluate(
      async (id) => (await window.tongzhou.snapshot()).sessions.find((s) => s.id === id).permission,
      seed.sessionId,
    ),
    'full-access',
  );
  await page.evaluate((id) => window.tongzhou.setSessionPermission(id, 'ask'), seed.sessionId);
  await send('审批测试：调整提取要求');
  await chat.getByRole('button', { name: '批准本次', exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'chat-approval.png') });
  await chat.getByRole('button', { name: '批准本次', exact: true }).click();
  await poll(
    async () => !(await chat.getByRole('button', { name: '停止回复', exact: true }).count()),
  );
  await page.evaluate(
    (id) => window.tongzhou.setSessionPermission(id, 'full-access'),
    seed.sessionId,
  );
  await send('继续调整：这次停止');
  await poll(() => waiting);
  await chat.getByRole('button', { name: '停止回复', exact: true }).click();
  release();
  await poll(
    async () => !(await chat.getByRole('button', { name: '停止回复', exact: true }).count()),
  );
  await page.evaluate(
    (id) => window.tongzhou.setSessionPermission(id, 'read-only'),
    seed.sessionId,
  );
  await send('仅讨论测试');
  await chat.getByText('只读讨论，不修改画布。', { exact: true }).waitFor();
  const readOnlyRequest = requests.findLast((r) =>
    String(r.messages.findLast((m) => m.role === 'user')?.content).includes('仅讨论测试'),
  );
  assert(!readOnlyRequest.tools.some((t) => t.function.name === 'canvas_apply'));
  await page.evaluate(
    (id) => window.tongzhou.setSessionPermission(id, 'full-access'),
    seed.sessionId,
  );
  await send('格式恢复测试');
  await poll(async () => (await chat.locator('.canvas-chat-message.user').count()) === 7);
  await poll(
    async () => !(await chat.getByRole('button', { name: '停止回复', exact: true }).count()),
  );
  assert.equal(recoveryAttempts, 2);
  assert.equal(await chat.locator('.canvas-chat-error').count(), 0);
  assert.equal(
    await chat
      .getByRole('button', { name: '插入画布', exact: true })
      .isVisible()
      .catch(() => false),
    false,
  );
  await send('失败恢复测试');
  await chat.getByText('这次没有完成', { exact: true }).waitFor();
  assert.equal(
    await chat.locator('.canvas-chat-turn').last().getByText('更多操作', { exact: true }).count(),
    0,
  );
  await page.screenshot({ path: path.join(root, 'chat-recoverable-error.png') });
  await chat.getByRole('button', { name: '继续完成', exact: true }).click();
  await poll(async () => (await chat.locator('.canvas-chat-message.user').count()) === 9);
  await poll(
    async () => !(await chat.getByRole('button', { name: '停止回复', exact: true }).count()),
  );
  assert.equal(await chat.locator('.canvas-chat-error').count(), 0);
  await page.setViewportSize({ width: 1000, height: 700 });
  await poll(async () =>
    page
      .locator('.canvas-chat-messages')
      .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60),
  );
  await page.screenshot({ path: path.join(root, 'canvas-chat-compact.png') });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert((await page.locator('.canvas-board').boundingBox()).width > 200);
  assert.equal(await chat.getByLabel('向画布助手提问').isVisible(), true);
  const sendBounds = await chat.getByRole('button', { name: '发送', exact: true }).boundingBox();
  const dockBounds = await page.locator('.canvas-chat-float').boundingBox();
  assert(
    sendBounds.y + sendBounds.height <= dockBounds.y + dockBounds.height,
    'Chat send stays in view',
  );
  assert(
    await page.evaluate(
      () =>
        Math.abs(
          document.querySelector('.canvas-board').getBoundingClientRect().width -
            document.querySelector('.canvas-body').getBoundingClientRect().width,
        ) < 1,
    ),
  );
  await chat.getByLabel('向画布助手提问').fill('收起保留的草稿');
  await chat.getByRole('button', { name: '收起画布聊天' }).click();
  assert.equal(await chat.isVisible(), false);
  assert(
    await page.evaluate(
      () =>
        Math.abs(
          document.querySelector('.canvas-board').getBoundingClientRect().width -
            document.querySelector('.canvas-body').getBoundingClientRect().width,
        ) < 1,
    ),
  );
  await page.screenshot({ path: path.join(root, 'chat-collapsed.png') });
  await reopenChat();
  assert.equal(await chat.getByLabel('向画布助手提问').inputValue(), '收起保留的草稿');
  await chat.getByRole('button', { name: '会话设置', exact: true }).click();
  await chat.getByRole('button', { name: '新建会话', exact: true }).click();
  await poll(async () => (await chat.getByLabel('画布聊天会话').inputValue()) !== seed.sessionId);
  assert.equal(await chat.locator('.canvas-chat-message.user').count(), 0);
  assert.equal(await chat.getByLabel('向画布助手提问').inputValue(), '收起保留的草稿');
  assert.equal(await chat.getByLabel('画布聊天权限').inputValue(), 'full-access');
  const newSessionId = await chat.getByLabel('画布聊天会话').inputValue();
  assert.equal(
    await page.evaluate(
      async (id) => (await window.tongzhou.snapshot()).sessions.find((s) => s.id === id).permission,
      newSessionId,
    ),
    'full-access',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Canvas chat passed: multi-turn canvas_apply, undo, two-way sync, conflicts, history, drafts, approval, cancellation, read-only tools, new session and narrow layout. ' +
      root,
  );
} catch (error) {
  console.error(error);
  console.error(
    'Mock waiting:',
    waiting,
    'Last user:',
    String(requests.at(-1)?.messages.findLast((m) => m.role === 'user')?.content).slice(-1500),
  );
  if (app) {
    const page = await app.firstWindow();
    console.error(
      'Approvals:',
      await page.evaluate(async () => (await window.tongzhou.snapshot()).approvals),
    );
    await page.screenshot({ path: path.join(root, 'failure.png'), timeout: 5000 }).catch(() => {});
    console.error((await page.locator('body').innerText()).slice(-8000));
  }
  throw error;
} finally {
  release?.();
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
