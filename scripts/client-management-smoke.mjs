import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/client-management-'));
let step = 0;
let createdId;
const failures = [],
  errors = [];
const server = createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const b of req) raw += b;
    const body = JSON.parse(raw);
    const previous = body.messages.filter((m) => m.role === 'tool').at(-1);
    const value = previous ? JSON.parse(previous.content) : undefined;
    const tools = body.tools.map((t) => t.function.name);
    assert.ok(tools.includes('client_catalog'));
    const calls = [
      () => ['client_catalog', { method: 'setAppearance' }],
      () => {
        assert.equal(value.methods[0].arguments.prefixItems[0].properties.style.type, 'string');
        return [
          'client_change',
          {
            method: 'setAppearance',
            args: [{ theme: 'dark', style: 'blue', font: 'system', textSize: 18 }],
          },
        ];
      },
      () => {
        assert.equal(value.success, true);
        return ['client_change', { method: 'createSession', args: [] }];
      },
      () => {
        assert.ok(value.id);
        createdId = value.id;
        return [
          'client_change',
          { method: 'updateSession', args: [createdId, { title: '会话工具创建的任务' }] },
        ];
      },
      () => {
        assert.equal(value.success, true);
        return ['client_query', { method: 'snapshot', args: [] }];
      },
    ];
    let delta, finish_reason;
    if (step < calls.length) {
      const [name, args] = calls[step]();
      delta = {
        tool_calls: [
          {
            index: 0,
            id: 'management-' + step,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      };
      finish_reason = 'tool_calls';
    } else {
      assert.ok(value.sessions.some((s) => s.id === createdId && s.title === '会话工具创建的任务'));
      delta = { content: '已通过会话工具切换外观并创建会话。' };
      finish_reason = 'stop';
    }
    step++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: ' + JSON.stringify({ choices: [{ delta, finish_reason }] }) + '\n\ndata: [DONE]\n\n',
    );
  } catch (error) {
    failures.push(String(error));
    res.writeHead(500);
    res.end('合成服务断言失败');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, TONGZHOU_USER_DATA: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.app-shell');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setIgnoreMouseEvents(true);
    w.setContentSize(1150, 950);
  });
  assert.equal(
    await page.locator('.sidebar').getByRole('button', { name: '连接中心', exact: true }).count(),
    0,
  );
  await page.locator('.sidebar').getByRole('button', { name: '模型与订阅', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '服务与浏览器', exact: true }).count(), 0);
  await page.locator('.sidebar').getByRole('button', { name: '设置与优化', exact: true }).click();
  await page.getByRole('button', { name: '打开连接中心', exact: true }).click();
  await page.getByRole('heading', { name: '连接中心', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '添加连接', exact: true }).count(), 0);
  assert.equal(await page.locator('.sidebar-bottom .active').innerText(), '设置与优化');
  await page.getByRole('button', { name: '返回设置与优化', exact: true }).click();
  const catalog = await page.evaluate(() => window.tongzhou.clientMethods());
  const source = (
    await Promise.all(
      [
        'electron/main.ts',
        ...(await readdir('electron'))
          .filter((file) => file.endsWith('-services.ts'))
          .map((file) => 'electron/' + file),
      ].map((file) => readFile(file, 'utf8')),
    )
  ).join('\n');
  const names = [...source.matchAll(/^\s*register\(\s*'([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(
    catalog.methods.map((m) => m.name).sort(),
    names.sort(),
    'every business registration must appear in the live catalog',
  );
  assert.equal(new Set(names).size, names.length);
  assert.ok(catalog.modules.length >= 10);
  for (const name of [
    'saveBot',
    'saveNotificationRule',
    'enqueue',
    'setAppearance',
    'savePlugin',
    'saveSkill',
    'syncRepository',
  ])
    assert.ok(catalog.change.includes(name));
  assert.equal(catalog.methods.find((m) => m.name === 'approve').access, 'manual');
  assert.ok(!catalog.change.includes('setDefaultPermission'));
  await page.locator('.sidebar').getByRole('button', { name: '插件', exact: true }).click();
  const card = page.getByRole('region', { name: '客户端管理能力' });
  await card.getByRole('button', { name: '复制客户端管理示例' }).click();
  const copyFeedback = card.locator('.capability-feedback');
  await copyFeedback.filter({ hasText: /已复制示例|系统剪贴板暂不可用/ }).waitFor();
  const clipboardUnavailable = (await copyFeedback.innerText()).includes('剪贴板暂不可用');
  if (clipboardUnavailable) assert.equal(await copyFeedback.getAttribute('role'), 'alert');
  else assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /同舟有哪些会话/);
  await card.locator('.client-capability-catalog > summary').click();
  await card.getByLabel('搜索客户端功能').fill('机器人');
  await card.getByText('重新连接已有机器人', { exact: true }).waitFor();
  await card.getByLabel('搜索客户端功能').fill('没有这个功能');
  await card.getByText('没有匹配的功能。').waitFor();
  await card.getByLabel('搜索客户端功能').fill('批准');
  await card.getByRole('button', { name: '打开：批准或拒绝待审批操作' }).click();
  await page.waitForSelector('.app-shell');
  await page.evaluate(
    async (baseUrl) => {
      const api = window.tongzhou;
      await api.saveProvider({
        id: 'fixture',
        name: '本地合成模型',
        protocol: 'openai-chat',
        baseUrl,
        auth: 'none',
        models: ['mock'],
        maxOutputTokens: 2000,
        contextChars: 0,
      });
      // Only the test renderer grants full access; no model-callable privilege operation.
      const session = await api.createSession();
      await api.setSessionPermission(session.id, 'full-access');
      await api.run({
        sessionId: session.id,
        providerId: 'fixture',
        model: 'mock',
        agentId: '',
        prompt: '切换深色雾蓝外观并创建一个会话，最后查询确认。',
      });
    },
    'http://127.0.0.1:' + server.address().port + '/v1',
  );
  const deadline = Date.now() + 30000;
  while (step < 6 && !failures.length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  const finished = await page.evaluate(() => window.tongzhou.snapshot());
  assert.ok(finished.runs.some((run) => run.status === 'completed'));
  assert.deepEqual(failures, []);
  assert.equal(step, 6);
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.theme === 'dark' &&
      document.documentElement.dataset.style === 'blue',
  );
  assert.equal(await page.locator('html').getAttribute('data-font'), 'system');
  assert.equal((await page.evaluate(() => window.tongzhou.getAppearance())).textSize, 18);
  await page.reload();
  await page.waitForSelector('.app-shell');
  await page.waitForFunction(() => document.documentElement.dataset.style === 'blue');
  await page.locator('.sidebar').getByRole('button', { name: '插件', exact: true }).click();
  await card.locator('.client-capability-catalog > summary').click();
  await card.getByLabel('搜索客户端功能').fill('外观');
  await card.getByText('设置主题、界面风格、字体和字号；立即生效并保存').waitFor();
  await card.locator('.client-capability-catalog').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/client-catalog-dark.png', animations: 'disabled' });
  await page.evaluate(() => window.tongzhou.setTheme('light'));
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.screenshot({ path: 'test-results/client-catalog-light.png', animations: 'disabled' });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 700),
  );
  await page.screenshot({ path: 'test-results/client-catalog-narrow.png', animations: 'disabled' });
  assert.deepEqual(errors, []);
  await writeFile(
    'test-results/client-management-report.json',
    JSON.stringify(
      {
        passed: true,
        packaged: !!executablePath,
        modules: catalog.modules,
        methods: names.length,
        requests: step,
        clipboard: clipboardUnavailable
          ? 'system denied access; correct failure shown'
          : 'copy confirmed',
        checks: [
          'complete IPC catalog',
          'search and manual entry',
          'real chat tool dispatch',
          'appearance updates and reload',
          'session creation and mutation',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    'Client management passed: ' +
      names.length +
      ' registrations, real chat dispatch, UI changes and persistence.',
  );
} catch (error) {
  console.error({ failures, errors, step });
  await (await app.firstWindow())
    .screenshot({ path: 'test-results/client-management-failure.png' })
    .catch(() => {});
  throw error;
} finally {
  await app.close();
  await new Promise((resolve) => server.close(resolve));
}
