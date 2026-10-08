import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chooseOption } from './choice-helper.mjs';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/message-resend-'));
const requests = [];
let mode = 'error';
const server = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  if (mode === 'error') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '合成模型连接失败' } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    'data: ' +
      JSON.stringify({
        choices: [
          {
            delta: { content: mode === 'partial' ? '已经收到的部分回复' : '重新发送成功' },
            finish_reason: mode === 'partial' ? 'length' : 'stop',
          },
        ],
      }) +
      '\n\ndata: [DONE]\n\n',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = {
  ...process.env,
  TONGZHOU_USER_DATA: path.join(root, 'profile'),
  TONGZHOU_DISABLE_UPDATES: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const app = await electron.launch({ args: ['.'], env, timeout: 45000 });
let page;
try {
  page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().forEach((w) => w.setIgnoreMouseEvents(true));
  });
  const session = await page.evaluate(async (baseUrl) => {
    await window.tongzhou.saveProvider({
      id: 'fixture',
      name: '重发测试',
      protocol: 'openai-chat',
      auth: 'none',
      baseUrl,
      models: ['fixture-model'],
      maxOutputTokens: 1024,
      contextChars: 0,
    });
    return window.tongzhou.createSession();
  }, `http://127.0.0.1:${server.address().port}/v1`);
  await page.locator(`[data-session-id="${session.id}"]`).click();
  await chooseOption(page, '当前连接', 'fixture');
  await page.getByLabel('消息', { exact: true }).fill('原始失败请求');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('button', { name: '编辑并重发', exact: true }).waitFor();
  const checkFooter = async (width, name) => {
    await app.evaluate(({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(720, 600);
      window.setSize(size, 800);
    }, width);
    await page.waitForFunction((size) => window.innerWidth === size, width);
    const prompt = page.getByRole('article', { name: '你的消息', exact: true });
    await prompt.hover();
    await page.waitForFunction(() => {
      const row = document.querySelector('.user-message-footer');
      if (!row) return false;
      if (getComputedStyle(row.querySelector('.message-actions')).opacity !== '1') return false;
      const time = row.querySelector('time').getBoundingClientRect();
      const buttons = [...row.querySelectorAll('button')];
      return (
        buttons.length === 4 &&
        buttons.every((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left >= time.right || rect.top >= time.bottom || rect.bottom <= time.top;
        })
      );
    });
    await page.screenshot({ path: path.join(root, `footer-${name}.png`) });
  };
  await checkFooter(1280, 'wide');
  await checkFooter(820, 'narrow');
  const original = await page.evaluate(
    async (id) => (await window.tongzhou.messages(id)).find((m) => m.role === 'user'),
    session.id,
  );
  await page.getByLabel('消息', { exact: true }).fill('保留当前未发送的草稿');
  await page.getByRole('button', { name: '编辑并重发', exact: true }).click();
  assert.equal(await page.getByLabel('编辑未完成的消息').inputValue(), original.content);
  const editor = page.getByRole('form', { name: '编辑未完成消息' });
  const field = page.getByLabel('编辑未完成的消息');
  const shortBox = await field.boundingBox();
  const editorBox = await editor.boundingBox();
  assert.ok(shortBox.height <= 52, 'short message uses a compact field');
  assert.ok(editorBox.width <= 480 && editorBox.height <= 120, 'compact editor card');
  await field.fill(Array.from({ length: 30 }, (_, i) => `较长内容第 ${i + 1} 行`).join('\n'));
  const longBox = await field.boundingBox();
  assert.ok(
    longBox.height > shortBox.height && longBox.height <= 180,
    'long content grows with a height limit',
  );
  await page.getByLabel('编辑未完成的消息').fill('放弃的修改');
  await page
    .getByRole('form', { name: '编辑未完成消息' })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  assert.equal(await page.getByLabel('消息', { exact: true }).inputValue(), '保留当前未发送的草稿');
  assert.equal(
    (await page.evaluate((id) => window.tongzhou.messages(id), session.id)).find(
      (m) => m.id === original.id,
    ).content,
    original.content,
  );
  await page.getByRole('button', { name: '编辑并重发', exact: true }).click();
  await page.getByLabel('编辑未完成的消息').fill('修改后的请求');
  await page.screenshot({ path: path.join(root, 'editing.png') });
  mode = 'success';
  const before = requests.length;
  await page.getByRole('button', { name: '重新发送', exact: true }).click();
  await page.getByText('重新发送成功', { exact: true }).waitFor();
  await page.waitForFunction(
    async (id) =>
      !(await window.tongzhou.snapshot()).runs.some(
        (r) => r.sessionId === id && r.status === 'running',
      ),
    session.id,
  );
  const messages = await page.evaluate((id) => window.tongzhou.messages(id), session.id);
  assert.equal(messages.filter((m) => m.role === 'user').length, 1);
  assert.equal(messages.find((m) => m.id === original.id).content, '修改后的请求');
  assert.equal(
    messages.some((m) => m.role === 'system' && m.status === 'error'),
    false,
  );
  assert.equal(await page.getByRole('button', { name: '编辑并重发', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('消息', { exact: true }).inputValue(), '保留当前未发送的草稿');
  assert.equal(requests.length - before, 1);
  assert.equal(JSON.stringify(requests.at(-1)).includes('原始失败请求'), false);
  assert.equal(JSON.stringify(requests.at(-1)).includes('修改后的请求'), true);
  const rejected = await page.evaluate(
    async ({ id, messageId }) => {
      try {
        await window.tongzhou.resendMessage(messageId, {
          sessionId: id,
          providerId: 'fixture',
          model: 'fixture-model',
          agentId: '',
          prompt: '非法改写',
        });
        return false;
      } catch {
        return true;
      }
    },
    { id: session.id, messageId: original.id },
  );
  assert.equal(rejected, true);
  mode = 'partial';
  await page.getByLabel('消息', { exact: true }).fill('产生部分回复后失败');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForFunction(
    async (id) =>
      (await window.tongzhou.snapshot()).runs
        .filter((r) => r.sessionId === id)
        .sort((a, b) => b.startedAt - a.startedAt)[0]?.status === 'failed',
    session.id,
  );
  await page.getByText('已经收到的部分回复', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '编辑并重发', exact: true }).count(), 0);
  await page.screenshot({ path: path.join(root, 'partial-reply.png') });
  await writeFile(
    path.join(root, 'report.json'),
    JSON.stringify(
      {
        ok: true,
        checks: [
          'cancel retains history and draft',
          'single replacement',
          'old error removed',
          'completed and partial replies cannot be edited',
          'backend rejects forged retry',
          'timestamp and four actions do not overlap at wide and narrow window sizes',
          'compact editor grows with content and limits long message height',
        ],
      },
      null,
      2,
    ),
  );
  console.log('Message resend smoke passed:', root);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
