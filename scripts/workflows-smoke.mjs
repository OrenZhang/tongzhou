import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/workflows-'));
const requests = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const b of req) raw += b;
  const body = JSON.parse(raw);
  requests.push(body);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(
    'data: ' +
      JSON.stringify({
        choices: [{ delta: { reasoning_content: '公开思考摘要：正在处理合成测试任务。' } }],
      }) +
      '\n\n',
  );
  setTimeout(
    () =>
      res.end(
        'data: ' +
          JSON.stringify({
            choices: [
              {
                delta: {
                  content:
                    '已回复：' + body.messages.filter((m) => m.role === 'user').at(-1).content,
                },
                finish_reason: 'stop',
              },
            ],
          }) +
          '\n\ndata: [DONE]\n\n',
      ),
    1800,
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const app = await electron.launch({ args: ['.'], env, timeout: 45000 });
const checks = [];
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.welcome');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => w.setIgnoreMouseEvents(true)),
  );
  await page.evaluate(
    (baseUrl) =>
      window.tongzhou.saveProvider({
        id: 'fixture',
        name: '合成测试',
        protocol: 'openai-chat',
        baseUrl,
        auth: 'none',
        models: ['mock'],
        maxOutputTokens: 1000,
        contextChars: 50000,
      }),
    `http://127.0.0.1:${server.address().port}/v1`,
  );
  await page.getByLabel('当前连接', { exact: true }).selectOption('fixture');
  await page.getByLabel('消息', { exact: true }).fill('第一条');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText(/公开思考摘要：/).waitFor();
  assert.equal(await page.getByText('处理过程', { exact: true }).count(), 0);
  const firstThinking = page
    .locator('.conversation-turn')
    .first()
    .getByRole('button', { name: '本轮用时与处理过程', exact: true });
  assert.equal(await firstThinking.getAttribute('aria-expanded'), 'true');
  await page.screenshot({ path: 'test-results/turn-thinking-live.png' });
  await firstThinking.click();
  assert.equal(await firstThinking.getAttribute('aria-expanded'), 'false');
  await firstThinking.click();
  const mode = page.getByRole('button', { name: '补充方式', exact: true });
  assert.equal(await mode.innerText(), '');
  assert.ok((await mode.boundingBox()).width <= 34);
  await mode.click();
  await page.getByRole('menuitemradio', { name: '补充当前任务', exact: true }).press('ArrowDown');
  await page.getByRole('menuitemradio', { name: '排队下一轮', exact: true }).press('Enter');
  assert.equal(await mode.getAttribute('title'), '补充方式：排队下一轮');
  await page.getByLabel('消息', { exact: true }).fill('第二条');
  await page.getByRole('button', { name: '补充', exact: true }).click();
  await page.getByText('已回复：第二条', { exact: true }).waitFor();
  assert.equal(requests.length, 2);
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  assert.equal(await page.locator('.conversation-turn').count(), 2);
  assert.equal(await page.locator('.conversation-turn .turn-process').count(), 2);
  assert.equal(await page.locator('.process-timeline:visible').count(), 0);
  assert.equal(await page.locator('.run-activity, .composer-wrap .turn-process').count(), 0);
  await firstThinking.click();
  await page.locator('.conversation-turn').first().locator('.process-reasoning > summary').click();
  await page
    .locator('.conversation-turn')
    .first()
    .getByText(/公开思考摘要：/)
    .waitFor();
  assert.ok(
    await page
      .locator('.conversation-turn')
      .first()
      .evaluate((turn) =>
        Boolean(
          turn
            .querySelector('.turn-process')
            .compareDocumentPosition(turn.querySelector('.assistant-segment')) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      ),
  );
  await firstThinking.click();
  checks.push(
    'public reasoning',
    'queued input exactly once',
    'reasoning precedes the answer and collapses after completion',
    'elapsed time expands ordered work and collapses after completion',
    'compact keyboard-accessible mode selection',
  );

  await page.getByLabel('消息', { exact: true }).fill('第三轮任务');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await mode.click();
  await page.getByRole('menuitemradio', { name: '补充当前任务', exact: true }).click();
  await page.getByLabel('消息', { exact: true }).fill('本轮补充内容');
  await mode.click();
  await page.screenshot({ path: 'test-results/turn-input-menu.png' });
  await page.getByRole('menuitemradio', { name: '补充当前任务', exact: true }).press('Escape');
  assert.equal(await mode.getAttribute('aria-expanded'), 'false');
  await page.getByRole('button', { name: '补充', exact: true }).click();
  await page.getByText('已回复：本轮补充内容', { exact: true }).waitFor();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  assert.equal(requests.length, 4);
  assert.equal(await page.locator('.conversation-turn').count(), 3);
  assert.equal(await page.locator('.chat-message.assistant').count(), 3);
  const supplemented = page.locator('.conversation-turn').last();
  assert.equal(await supplemented.locator('.assistant-segment').count(), 2);
  assert.equal(await supplemented.locator('.turn-supplement:visible').count(), 1);
  assert.ok((await supplemented.innerText()).includes('本轮补充内容'));
  assert.equal(
    await page.getByRole('button', { name: '引用补充', exact: true }).first().innerText(),
    '',
  );
  await page.screenshot({ path: 'test-results/turn-supplement.png' });
  await page.reload();
  await page.waitForSelector('.welcome');
  await page.locator('.session-list > button').first().click();
  await page.getByText('已回复：本轮补充内容', { exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll('.conversation-turn .process-toggle').length === 3,
  );
  assert.equal(await page.locator('.chat-message.assistant').count(), 3);
  checks.push(
    'supplement stays in the same assistant turn',
    'reasoning and turn grouping survive reload',
  );
  assert.equal(await page.locator('.process-timeline:visible').count(), 0);
  await page
    .locator('.conversation-turn')
    .last()
    .getByRole('button', { name: '本轮用时与处理过程', exact: true })
    .click();
  await page
    .locator('.conversation-turn')
    .last()
    .locator('.process-reasoning > summary')
    .first()
    .click();
  await page
    .locator('.conversation-turn')
    .last()
    .getByText(/公开思考摘要：/)
    .first()
    .waitFor();
  await page.screenshot({ path: 'test-results/turn-thinking-history.png' });
  await page.getByRole('button', { name: '引用补充', exact: true }).first().click();
  assert.ok((await page.getByLabel('消息', { exact: true }).inputValue()).includes('第一条'));
  await page.getByLabel('消息', { exact: true }).fill('');
  await page.getByRole('button', { name: '从此处新建分支', exact: true }).first().click();
  await page.getByRole('heading', { name: /分支/ }).waitFor();
  assert.equal(
    await page.locator('.turn-process').count(),
    0,
    'source activity must not leak into the new branch',
  );
  const branch = (await page.evaluate(() => window.tongzhou.snapshot())).sessions.find((s) =>
    s.title.includes('分支'),
  );
  await page.getByRole('button', { name: '归档会话', exact: true }).click();
  await page.getByRole('button', { name: '删除会话', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.waitForFunction(
    async (id) => !(await window.tongzhou.snapshot()).sessions.some((s) => s.id === id),
    branch.id,
  );
  assert.equal((await page.evaluate(() => window.tongzhou.snapshot())).sessions.length, 1);
  checks.push('history quote and independent branch', 'archive deletion');
  await page.getByRole('button', { name: /^连接中心/ }).click();
  await page.getByRole('button', { name: '服务与浏览器', exact: true }).click();
  await page.getByRole('button', { name: '添加 github', exact: true }).click();
  const form = page.locator('.connection-form');
  await form.getByLabel('名称', { exact: true }).fill('测试 GitHub');
  await form.getByLabel('访问令牌', { exact: false }).fill('fixture-token');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('heading', { name: '测试 GitHub', exact: true }).waitFor();
  await page.getByRole('button', { name: '渠道通知', exact: true }).click();
  await page.getByRole('button', { name: '添加 飞书', exact: true }).click();
  await form.getByLabel('名称', { exact: true }).fill('合成飞书');
  await form
    .getByLabel('Webhook', { exact: false })
    .fill('https://open.feishu.cn/open-apis/bot/v2/hook/fixture');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  const card = page
    .locator('.provider-card')
    .filter({ has: page.getByRole('heading', { name: /合成飞书/ }) });
  await card.getByRole('button', { name: '添加通知规则', exact: true }).click();
  await form
    .getByLabel('会话范围', { exact: true })
    .selectOption((await page.evaluate(() => window.tongzhou.snapshot())).sessions[0].id);
  await form.getByLabel('只发送一次', { exact: true }).check();
  await form.getByRole('button', { name: '保存规则', exact: true }).click();
  await card.getByRole('button', { name: '停用', exact: true }).click();
  await page.waitForFunction(
    async () => (await window.tongzhou.snapshot()).channels[0].enabled === false,
  );
  checks.push('connector and notification configuration UI', 'channel disable persists');
  const snapshot = await page.evaluate(() => window.tongzhou.snapshot());
  assert.ok(!JSON.stringify(snapshot).includes('fixture-token'));
  assert.ok(!JSON.stringify(snapshot).includes('/hook/fixture'));
  await page.reload();
  await page.waitForSelector('.welcome');
  const again = await page.evaluate(() => window.tongzhou.snapshot());
  assert.equal(again.channels[0].enabled, false);
  assert.equal(again.notificationRules[0].once, true);
  const connector = again.connectors[0];
  await app.evaluate(async ({ session }, id) => {
    await session.fromPartition('persist:tongzhou-connector-' + id).cookies.set({
      url: 'https://fixture.test',
      name: 'session',
      value: 'synthetic-only',
      secure: true,
      expirationDate: Date.now() / 1000 + 3600,
    });
  }, connector.id);
  await page.evaluate((id) => window.tongzhou.clearBrowserProfile(id), connector.id);
  assert.equal(
    await app.evaluate(
      async ({ session }, id) =>
        (await session.fromPartition('persist:tongzhou-connector-' + id).cookies.get({})).length,
      connector.id,
    ),
    0,
  );
  checks.push('credentials absent from snapshots', 'owned browser cookies clear');
  const project = path.join(root, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
  }, project);
  const p = await page.evaluate(() => window.tongzhou.addProject());
  await page.evaluate((id) => window.tongzhou.initializeAgent(id), p.id);
  assert.ok((await readFile(path.join(project, 'agent.md'), 'utf8')).includes('npm run test'));
  checks.push('project instructions initialization');
  await writeFile(
    'test-results/workflows-report.json',
    JSON.stringify({ passed: true, checks, externalMessagesSent: false }, null, 2),
  );
  console.log('Workflow UI smoke passed: ' + checks.join(', '));
} catch (e) {
  await app
    .windows()[0]
    ?.screenshot({ path: 'test-results/workflows-failure.png' })
    .catch(() => {});
  throw e;
} finally {
  await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
