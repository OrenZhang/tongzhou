import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/turn-process-'));
const project = path.join(root, 'project');
await mkdir(project);
await writeFile(path.join(project, 'README.md'), 'Synthetic project instructions.');
execFileSync('git', ['init', '--quiet', project]);
execFileSync('git', ['add', 'README.md'], { cwd: project });
execFileSync(
  'git',
  [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  ],
  { cwd: project },
);
let release;
const gate = new Promise((resolve) => {
  release = resolve;
});
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const prompt = body.messages.filter((m) => m.role === 'user').at(-1).content;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = (delta, finish_reason) =>
    res.write('data: ' + JSON.stringify({ choices: [{ delta, finish_reason }] }) + '\n\n');
  if (prompt === '触发截断') {
    send({ content: '已收到正文，' });
    send(
      {
        content: '保留最后一段。',
        tool_calls: [
          {
            index: 0,
            id: 'partial',
            function: { name: 'write_file', arguments: '{"path":"never.txt"' },
          },
        ],
      },
      'length',
    );
  } else if (!body.messages.some((m) => m.role === 'tool')) {
    send({ reasoning_content: '先检查项目环境。' });
    send({ content: '环境已确认，继续检查项目。' });
    send({ reasoning_content: '接下来读取说明文件。' });
    send(
      {
        tool_calls: [
          {
            index: 0,
            id: 'read',
            function: { name: 'read_file', arguments: '{"path":"README.md"}' },
          },
        ],
      },
      'tool_calls',
    );
  } else {
    send({ content: '文件已检查，继续整理。' });
    await gate;
    send({ reasoning_content: '根据实际文件整理结果。' });
    send({ content: '已完成检查，说明文件内容正常。' }, 'stop');
  }
  res.end('data: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.welcome');
  await app.evaluate(({ BrowserWindow, dialog }, folder) => {
    BrowserWindow.getAllWindows().forEach((w) => w.setIgnoreMouseEvents(true));
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, project);
  const session = await page.evaluate(async (baseUrl) => {
    await window.tongzhou.saveProvider({
      id: 'fixture',
      name: '分段测试',
      protocol: 'openai-chat',
      auth: 'none',
      baseUrl,
      models: ['fixture'],
      maxOutputTokens: 16384,
      contextChars: 50000,
    });
    const project = await window.tongzhou.addProject();
    return window.tongzhou.createSession(project.id);
  }, `http://127.0.0.1:${server.address().port}/v1`);
  await page.locator(`[data-session-id="${session.id}"]`).click();
  await page.getByLabel('当前连接', { exact: true }).selectOption('fixture');
  await page.getByLabel('消息', { exact: true }).fill('检查项目');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('文件已检查，继续整理。', { exact: true }).waitFor();
  const turn = page.locator('.conversation-turn').last();
  assert.equal(await page.locator('.chat-message.assistant').count(), 1);
  assert.equal(
    await turn.getByText('环境已确认，继续检查项目。', { exact: true }).isVisible(),
    true,
  );
  assert.equal(await turn.locator('.process-current').innerText(), '正在回复');
  assert.equal(await turn.locator('.process-reasoning').count(), 2);
  assert.equal(await turn.locator('.process-toggle').getAttribute('aria-expanded'), 'true');
  await page.waitForFunction(
    () => !document.querySelector('.process-toggle').textContent.includes('0秒'),
  );
  const ordered = await turn
    .locator('[data-entry-kind]')
    .evaluateAll((elements) =>
      elements.map((e) => e.dataset.entryKind).filter((kind) => kind !== 'phase'),
    );
  assert.deepEqual(ordered, ['reasoning', 'response', 'reasoning', 'tool-result', 'response']);
  await page.screenshot({ path: 'test-results/process-segments-live.png' });
  release();
  await turn
    .locator('.turn-final')
    .getByText('已完成检查，说明文件内容正常。', { exact: true })
    .waitFor();
  assert.equal(await turn.locator('.process-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(await turn.locator('.process-current').count(), 0);
  await turn.locator('.process-toggle').click();
  await turn.getByText('文件已检查，继续整理。', { exact: true }).waitFor();
  const duration = await turn.locator('.process-toggle').innerText();
  assert.match(duration, /用时/);
  await page.screenshot({ path: 'test-results/process-segments-expanded.png' });
  await page.reload();
  await page.waitForSelector('.welcome');
  await page.locator(`[data-session-id="${session.id}"]`).click();
  await page.locator('.turn-final').waitFor();
  assert.equal(await page.locator('.process-toggle').innerText(), duration);
  assert.equal(await page.locator('.process-toggle').getAttribute('aria-expanded'), 'false');
  await page.locator('.process-toggle').click();
  assert.equal(await page.locator('.process-reasoning').count(), 3);
  assert.equal(await page.locator('.assistant-segment').count(), 3);
  await page.locator('.process-toggle').click();
  await page.getByLabel('消息', { exact: true }).fill('触发截断');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText(/本次请求上限：16,384 Tokens/).waitFor();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  assert.equal(
    await page.getByText('已收到正文，保留最后一段。', { exact: true }).isVisible(),
    true,
  );
  await page.screenshot({ path: 'test-results/process-output-limit.png' });
  await writeFile(
    'test-results/turn-process-report.json',
    JSON.stringify(
      {
        passed: true,
        packaged: Boolean(executablePath),
        checks: [
          'interleaved reasoning, interim responses and actual tool result',
          'visible interim response while work continues without new reasoning',
          'one assistant per turn',
          'elapsed process expands and collapses',
          'stable duration and segment history after reload',
          'truncation preserves text and identifies configured output limit',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    'Turn process UI passed: ordered stages, live response/status, elapsed disclosure, reload and output-limit recovery.',
  );
} finally {
  release();
  await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
