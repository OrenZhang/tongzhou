import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/desktop-'));
const project = path.join(root, 'project');
await mkdir(project);
await writeFile(path.join(project, 'README.md'), '# Fixture project\n');
const server = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'fixture-model' }, { id: 'fixture-reviewer' }] }));
    return;
  }
  let raw = '';
  for await (const b of req) raw += b;
  const body = JSON.parse(raw);
  const done = body.messages.some((m) => m.role === 'tool');
  const data = !body.tools?.some((t) => t.function.name === 'write_file')
    ? {
        choices: [
          {
            delta: {
              content:
                '普通聊天回复：' + body.messages.filter((m) => m.role === 'user').at(-1).content,
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 4 },
      }
    : done
      ? {
          choices: [
            {
              delta: { content: '已创建 hello.txt，内容为同舟。验证完成。' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }
      : {
          choices: [
            {
              delta: {
                content: '我将创建一个项目文件。',
                tool_calls: [
                  {
                    index: 0,
                    id: 'test_call',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({ path: 'hello.txt', content: '同舟' }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end('data: ' + JSON.stringify(data) + '\n\ndata: [DONE]\n\n');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_CODEX_PATH;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const launchOptions = executablePath
  ? { executablePath: path.resolve(executablePath), args: [], cwd: root, env, timeout: 45000 }
  : { args: ['.'], env, timeout: 45000 };
let app;
try {
  app = await electron.launch(launchOptions);
  const page = await app.firstWindow();
  await page.waitForSelector('.welcome');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => w.setIgnoreMouseEvents(true)),
  );
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.screenshot({ path: 'test-results/01-workspace.png' });
  await page.getByRole('button', { name: /^连接中心/ }).click();
  await page.getByRole('button', { name: '添加连接', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('本地测试服务');
  await page.getByLabel('API Base URL').fill(`http://127.0.0.1:${server.address().port}/v1`);
  await page.getByLabel('认证方式', { exact: true }).selectOption('none');
  await page.getByRole('button', { name: '保存连接并获取模型', exact: true }).click();
  await page.getByText('2 个模型已配置，可在会话和 Agent 中搜索选择。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  await page.getByRole('heading', { name: '本地测试服务' }).waitFor();
  const provider = await page.evaluate(async () =>
    (await window.tongzhou.snapshot()).providers.find((p) => p.name === '本地测试服务'),
  );
  await page.screenshot({ path: 'test-results/02-connections.png' });
  await page.getByRole('button', { name: 'Agent 团队', exact: true }).click();
  assert.equal((await page.evaluate(() => window.tongzhou.snapshot())).agents.length, 0);
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('代码审查');
  await page.getByLabel('执行权限', { exact: true }).selectOption('read-only');
  await page.getByLabel('角色指令', { exact: true }).fill('只读检查代码，给出证据。');
  await page.getByLabel('连接中心', { exact: true }).selectOption(provider.id);
  await page.getByRole('button', { name: 'Agent 模型', exact: true }).click();
  await page.getByLabel('搜索模型', { exact: true }).fill('reviewer');
  await page.getByLabel('搜索模型', { exact: true }).press('Enter');
  await page.getByRole('button', { name: '保存 Agent', exact: true }).click();
  await page.locator('.modal').waitFor({ state: 'hidden' });
  assert.equal(
    await page.evaluate(
      async () =>
        (await window.tongzhou.snapshot()).agents.find((a) => a.name === '代码审查').model,
    ),
    'fixture-reviewer',
  );
  await page.screenshot({ path: 'test-results/03-agents.png' });
  await page.getByRole('button', { name: '使用 代码审查', exact: true }).click();
  await page.getByRole('button', { name: '移除专属 Agent', exact: true }).click();
  assert.equal(await page.getByLabel('当前 Agent', { exact: true }).count(), 0);
  assert.equal(await page.locator('.selected-agent-note').count(), 0);
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => {
      throw new Error('普通聊天不应打开文件夹选择器');
    };
  });
  await page.getByRole('button', { name: '工作空间', exact: true }).click();
  await page.getByLabel('当前连接', { exact: true }).selectOption(provider.id);
  await page.getByRole('button', { name: '当前模型', exact: true }).click();
  await page.getByRole('button', { name: 'fixture-model', exact: true }).click();
  await page.getByLabel('消息', { exact: true }).fill('你好，不打开项目聊天');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('普通聊天回复：你好，不打开项目聊天', { exact: true }).waitFor();
  const ordinary = await page.evaluate(() => window.tongzhou.snapshot());
  assert.equal(ordinary.projects.length, 0);
  assert.equal(ordinary.sessions[0].projectId, null);
  assert.equal(ordinary.runs[0].status, 'completed');
  await page.getByRole('button', { name: '当前模型', exact: true }).click();
  await page.getByRole('button', { name: 'fixture-reviewer', exact: true }).click();
  await page.getByLabel('消息', { exact: true }).fill('换一个模型继续');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('普通聊天回复：换一个模型继续', { exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/08-ordinary-chat.png' });
  await page.getByRole('button', { name: /开启新会话/ }).click();
  await page.getByRole('heading', { name: '新会话', exact: true }).waitFor();
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] });
  }, project);
  await page.getByRole('button', { name: '工作空间', exact: true }).click();
  await page.getByRole('button', { name: '打开项目，开始创作', exact: true }).click();
  await page.getByLabel('消息', { exact: true }).waitFor();
  await page.evaluate(async (p) => window.tongzhou.saveProvider({ ...p, models: [] }), provider);
  await page.getByLabel('当前连接', { exact: true }).selectOption(provider.id);
  await page.getByLabel('当前模型', { exact: true }).click();
  await page.getByRole('button', { name: '刷新模型列表', exact: true }).click();
  await page.waitForFunction(
    async (id) =>
      (await window.tongzhou.snapshot()).providers.find((p) => p.id === id).models.length === 2,
    provider.id,
  );
  await page.getByLabel('搜索模型', { exact: true }).fill('fixture');
  await page.getByRole('button', { name: 'fixture-model', exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/07-model-picker.png' });
  await page.getByRole('button', { name: 'fixture-model', exact: true }).click();
  await page
    .getByRole('button', { name: '当前模型', exact: true })
    .filter({ hasText: 'fixture-model' })
    .waitFor();
  await page.getByLabel('消息', { exact: true }).fill('创建 hello.txt，写入“同舟”。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page
    .getByRole('dialog', { name: '写入 hello.txt', exact: true })
    .waitFor({ timeout: 15000 });
  await page.screenshot({ path: 'test-results/04-approval.png' });
  await page.getByRole('button', { name: '批准本次', exact: true }).click();
  await page.getByText('已创建 hello.txt，内容为同舟。验证完成。', { exact: true }).waitFor();
  assert.equal(await readFile(path.join(project, 'hello.txt'), 'utf8'), '同舟');
  let state;
  for (let attempt = 0; attempt < 200; attempt++) {
    state = await page.evaluate(() => window.tongzhou.snapshot());
    if (state.runs[0]?.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(state.runs[0].status, 'completed');
  assert.equal(state.runs[0].inputTokens, 30);
  assert.equal(await page.locator('.conversation-turn').count(), 1);
  assert.equal(
    await page.locator('.chat-message.assistant').count(),
    1,
    'tool iteration must not create another assistant bubble',
  );
  assert.equal(await page.locator('.assistant-segment').count(), 2);
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  assert.equal(await page.getByText('处理过程', { exact: true }).count(), 0);
  assert.equal(
    await page.locator('.turn-thinking, .tool-message').count(),
    0,
    'do not invent reasoning when the provider sends none',
  );
  const storedMessages = await page.evaluate(
    (id) => window.tongzhou.messages(id),
    state.runs[0].sessionId,
  );
  assert.ok(
    storedMessages.some((m) => m.role === 'tool' && m.content.includes('hello.txt')),
    'hiding logs must preserve tool evidence in history',
  );
  await page.screenshot({ path: 'test-results/05-conversation.png' });
  await page.getByRole('button', { name: '运行记录', exact: true }).click();
  await page.locator('.table-row').first().waitFor();
  await page.screenshot({ path: 'test-results/06-activity.png' });
  const codex = await page.evaluate(() => window.tongzhou.codexStatus());
  assert.equal(codex.available, true, JSON.stringify(codex));
  assert.equal(codex.account, '', 'Smoke profile must not reuse existing user credentials');
  assert.deepEqual(errors, []);
  await app.close();
  app = undefined;
  app = await electron.launch(launchOptions);
  const again = await app.firstWindow();
  await again.waitForSelector('.welcome');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => w.setIgnoreMouseEvents(true)),
  );
  const recovered = await again.evaluate(() => window.tongzhou.snapshot());
  assert.equal(recovered.runs[0].status, 'completed');
  assert.equal(recovered.sessions.length, 3);
  assert.equal(recovered.sessions.filter((s) => s.projectId === null).length, 2);
  assert.deepEqual(recovered.providers.find((p) => p.id === provider.id).models, [
    'fixture-model',
    'fixture-reviewer',
  ]);
  await writeFile(
    'test-results/desktop-report.json',
    JSON.stringify(
      {
        passed: true,
        packaged: Boolean(executablePath),
        checks: [
          'window startup',
          'provider UI save',
          'model discovery and searchable selection',
          'ordinary chat without opening a project',
          'ordinary chat model switching and restart recovery',
          'agent UI edit',
          'project selection',
          'streaming',
          'write approval',
          'tool execution',
          'one assistant turn across tool iterations; hidden logs retain stored evidence',
          'usage',
          'Codex handshake',
          'isolated auth',
          'persistence across restart',
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    'Desktop smoke passed: provider + agent UI, real file approval, streaming, usage, Codex handshake, restart recovery.',
  );
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    await page.screenshot({ path: 'test-results/failure.png' });
    console.error(await page.locator('body').innerText());
    console.error(await page.evaluate(() => window.tongzhou.snapshot()));
  }
  throw error;
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
