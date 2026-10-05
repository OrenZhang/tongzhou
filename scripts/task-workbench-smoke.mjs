import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/task-workbench-')),
  profile = path.join(root, 'profile'),
  project = path.join(root, 'project');
await mkdir(project);
await writeFile(path.join(project, 'file.txt'), 'user content before task');
for (const [entry, name] of [
  ['store', 'store'],
  ['run-changes', 'changes'],
])
  await build({
    entryPoints: [`electron/${entry}.ts`],
    outfile: path.join(root, name + '.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
const require = createRequire(import.meta.url),
  { Store } = require(path.join(root, 'store.cjs')),
  { ChangeCheckpoints } = require(path.join(root, 'changes.cjs'));
const store = new Store(path.join(profile, 'tongzhou.db'), {
  encrypt: (s) => s,
  decrypt: (s) => s,
});
store.put('project', { id: 'p', name: '验证项目', path: project, createdAt: 1 });
const session = store.createSession('p');
store.message({
  id: 'm1',
  sessionId: session.id,
  role: 'user',
  content: '中途约束：保留既有 API 和客户资料',
  createdAt: 1,
});
store.put('session', { ...session, title: '可靠性验证' });
store.put('run', {
  id: 'r1',
  sessionId: session.id,
  providerId: 'local',
  model: 'fixture',
  agentName: '同舟',
  status: 'failed',
  startedAt: 1,
  endedAt: 2,
  inputTokens: 0,
  outputTokens: 0,
  error: '合成中断，待继续',
});
store.put('taskMemory', {
  id: session.id,
  sessionId: session.id,
  goal: '可靠性验证',
  constraints: ['保留既有 API'],
  decisions: [],
  completed: [],
  nextSteps: ['检查工具结果后继续'],
  sources: ['m1'],
  updatedAt: 1,
});
store.message({
  id: 'e1',
  sessionId: session.id,
  role: 'tool',
  content: '本轮验证结果',
  toolName: 'run_command',
  runId: 'r1',
  createdAt: 3,
});
store.message({
  id: 'e2',
  sessionId: session.id,
  role: 'tool',
  content: '其他轮次验证',
  toolName: 'read_file',
  runId: 'other-run',
  createdAt: 4,
});
const checkpoints = new ChangeCheckpoints(store, profile);
await checkpoints.begin('r1', session.id, store.get('project', 'p'));
await writeFile(path.join(project, 'file.txt'), 'agent changed content');
await checkpoints.finish('r1');
const server = createServer(async (req, res) => {
  if (req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'fixture' }] }));
    return;
  }
  if (req.url === '/v1/chat/completions') {
    let raw = '';
    for await (const part of req) raw += part;
    const b = JSON.parse(raw),
      value = b.messages.at(-1).content.split(' ').at(-1);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'test',
                    function: { name: 'diagnostic_echo', arguments: JSON.stringify({ value }) },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
    return;
  }
  if (req.url === '/download') {
    res.setHeader('Content-Disposition', 'attachment; filename=report.txt');
    res.end('download verified');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(
    '<html><body><h1>浏览器验证</h1><a href="/download">下载报告</a><label>名称 <input aria-label="名称" id="name"></label><input type="password" name="password" value="NEVER_RETURN_PASSWORD"><button onclick="document.getElementById(\'result\').textContent=document.getElementById(\'name\').value">保存</button><p id="result">尚未保存</p><select aria-label="选择类型"><option value="a">类型A</option><option value="b">类型B</option></select></body></html>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + server.address().port;
store.put('connector', {
  id: 'browser-fixture',
  kind: 'browser',
  enabled: true,
  name: '页面验证',
  baseUrl: url,
});
store.saveProvider({
  id: 'probe',
  name: '诊断夹具',
  enabled: true,
  protocol: 'openai-chat',
  auth: 'none',
  baseUrl: url + '/v1',
  models: ['fixture'],
  contextChars: 0,
  maxOutputTokens: 512,
});
store.close();
const env = { ...process.env, TONGZHOU_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
let executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
if (process.env.TONGZHOU_PACKAGE_AUTO === '1' && !executablePath) {
  const candidates =
    process.platform === 'win32'
      ? ['release/win-unpacked/Tongzhou.exe']
      : [
          'release/mac-arm64/Tongzhou.app/Contents/MacOS/Tongzhou',
          'release/mac/Tongzhou.app/Contents/MacOS/Tongzhou',
        ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      executablePath = path.resolve(candidate);
      break;
    } catch {}
  }
  if (!executablePath) throw new Error('Packaged executable not found');
}
const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
const checks = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.waitForSelector('.app-shell');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => w.setIgnoreMouseEvents(true)),
  );
  await page.locator(`[data-session-id="${session.id}"]`).click();
  await page.getByRole('button', { name: '运行记录', exact: true }).click();
  await page.locator('.table-row').first().click();
  assert.equal(await page.locator('.modal').count(), 0);
  await page.getByRole('heading', { name: '任务记忆', exact: true }).waitFor();
  assert.equal(await page.getByLabel('运行范围').inputValue(), 'r1');
  assert.match(await page.locator('.task-panel').innerText(), /保留既有 API/);
  await page.getByRole('tab', { name: '验证记录', exact: true }).click();
  assert.equal(await page.locator('.task-panel details').count(), 1);
  await page.getByLabel('运行范围').selectOption('');
  assert.equal(await page.locator('.task-panel details').count(), 2);
  await page.getByLabel('运行范围').selectOption('r1');
  checks.push('run row opens inline review; evidence follows selected run scope');
  await page.screenshot({ path: 'test-results/activity-review.png' });
  await page.getByRole('tab', { name: '搜索历史', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索消息内容' }).fill('中途约束');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.locator('.history-hit').first().click();
  assert.match(await page.locator('.history-search pre').innerText(), /客户资料/);
  checks.push('history search and original source');
  await page.getByRole('tab', { name: '改动审阅', exact: true }).click();
  await page.locator('.task-panel').getByRole('button', { name: 'file.txt', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.task-patch')?.textContent.includes('-user content before task'),
  );
  await page.getByRole('button', { name: '恢复…', exact: true }).click();
  await page.getByRole('button', { name: '确认恢复本轮前内容', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('.task-panel')?.textContent.includes('已恢复到本轮开始前'),
  );
  assert.equal(await readFile(path.join(project, 'file.txt'), 'utf8'), 'user content before task');
  checks.push('review and protected restore through UI');
  const git = (...args) =>
    execFileSync('git', args, { cwd: project, windowsHide: true, encoding: 'utf8' });
  git('init');
  git('config', 'user.name', 'Tongzhou Test');
  git('config', 'user.email', 'test@example.invalid');
  git('add', 'file.txt');
  const reviewed = await page.evaluate(() => window.tongzhou.reviewStaged('p'));
  await writeFile(path.join(project, 'file.txt'), 'edited after review');
  git('add', 'file.txt');
  await assert.rejects(
    page.evaluate(
      (hash) => window.tongzhou.commitStaged('p', 'fixture commit', hash),
      reviewed.hash,
    ),
    /发生变化/,
  );
  const verified = await page.evaluate(() => window.tongzhou.reviewStaged('p'));
  await page.evaluate(
    (hash) => window.tongzhou.commitStaged('p', 'fixture commit', hash),
    verified.hash,
  );
  assert.match(git('log', '-1', '--format=%s'), /fixture commit/);
  checks.push('staged review fingerprint rejects changed index and commits verified content');

  await page.getByRole('button', { name: '打开会话', exact: true }).click();
  await page.getByRole('button', { name: '终端', exact: true }).click();
  await page.locator('.xterm').waitFor();
  const terminal = await page.evaluate(
    async (id) => (await window.tongzhou.taskState(id)).terminals[0],
    session.id,
  );
  assert.equal(terminal.status, 'running');
  const command =
    process.platform === 'win32'
      ? "Write-Output ('终端' + '交互通过')\r"
      : "printf '终端%s\\n' '交互通过'\r";
  await page.evaluate(async ({ id, t, command }) => window.tongzhou.writeTerminal(id, t, command), {
    id: session.id,
    t: terminal.id,
    command,
  });
  await page.waitForFunction(
    async ({ id, t }) =>
      (await window.tongzhou.readTerminal(id, t)).output.includes('终端交互通过'),
    { id: session.id, t: terminal.id },
    { timeout: 30000 },
  );
  await page.waitForFunction(() =>
    document.querySelector('.xterm-rows')?.textContent.includes('终端交互通过'),
  );
  await page.screenshot({ path: 'test-results/task-terminal.png' });
  await page.getByRole('button', { name: '停止终端', exact: true }).click();
  await page.waitForFunction(
    async ({ id, t }) => (await window.tongzhou.readTerminal(id, t)).status !== 'running',
    { id: session.id, t: terminal.id },
  );
  checks.push('real PTY Unicode input, persistent log and stop');
  const background = await page.evaluate((id) => window.tongzhou.startTerminal(id), session.id);
  await page.evaluate(() => window.tongzhou.emergencyStop());
  let stopped = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await page.evaluate(({ s, t }) => window.tongzhou.readTerminal(s, t), {
      s: session.id,
      t: background.id,
    });
    if (state.status !== 'running') {
      stopped = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(stopped, 'Emergency stop must stop persistent terminals');
  checks.push('emergency stop includes persistent background terminals');

  for (const dark of [false, true]) {
    await page.evaluate(async (dark) => {
      const a = await window.tongzhou.getAppearance();
      await window.tongzhou.setAppearance({
        style: 'graphite',
        font: 'system',
        textSize: 14,
        ...a,
        theme: dark ? 'dark' : 'light',
      });
    }, dark);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 800));
    await page.screenshot({ path: `test-results/task-panel-${dark ? 'dark' : 'light'}.png` });
    assert.equal(
      await page.evaluate(
        () =>
          document.querySelector('.terminal-dock').scrollWidth >
          document.querySelector('.terminal-dock').clientWidth + 2,
      ),
      false,
    );
    await page.getByRole('button', { name: '运行记录', exact: true }).click();
    await page.getByRole('tab', { name: '任务与交付', exact: true }).click();
    await page.getByRole('tab', { name: '任务记忆', exact: true }).click();
    await page.getByRole('heading', { name: '任务记忆', exact: true }).waitFor();
    await page.screenshot({ path: `test-results/activity-review-${dark ? 'dark' : 'light'}.png` });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await page.getByRole('button', { name: '打开会话', exact: true }).click();
  }
  const health = await page.evaluate(() =>
    window.tongzhou.diagnoseProvider('probe', 'fixture', true),
  );
  assert.equal(health.find((c) => c.name === '推理与工具协议').status, 'passed');
  checks.push('real loopback SSE and tool-protocol diagnostic');
  await page.evaluate(() => window.tongzhou.openBrowserProfile('browser-fixture'));
  const snapshot = () => page.evaluate(() => window.tongzhou.browserSnapshot('browser-fixture'));
  let view = await snapshot();
  assert.ok(!JSON.stringify(view).includes('NEVER_RETURN_PASSWORD'));
  const input = view.elements.find((e) => e.name === '名称');
  await page.evaluate(
    ({ frame, ref }) =>
      window.tongzhou.browserAction('browser-fixture', {
        frame,
        ref,
        action: 'fill',
        text: '页面操作已验证',
      }),
    { frame: view.frame, ref: input.ref },
  );
  await assert.rejects(
    page.evaluate(
      ({ frame, ref }) =>
        window.tongzhou.browserAction('browser-fixture', {
          frame,
          ref,
          action: 'fill',
          text: 'stale',
        }),
      { frame: view.frame, ref: input.ref },
    ),
    /页面已变化/,
  );
  view = await snapshot();
  await page.evaluate(
    ({ frame, ref }) =>
      window.tongzhou.browserAction('browser-fixture', { frame, ref, action: 'click' }),
    { frame: view.frame, ref: view.elements.find((e) => e.name === '保存').ref },
  );
  view = await snapshot();
  assert.match(view.text, /页面操作已验证/);
  const secret = view.elements.find((e) => e.protected);
  await assert.rejects(
    page.evaluate(
      ({ frame, ref }) =>
        window.tongzhou.browserAction('browser-fixture', {
          frame,
          ref,
          action: 'fill',
          text: 'do not enter',
        }),
      { frame: view.frame, ref: secret.ref },
    ),
    /凭据字段/,
  );
  view = await snapshot();
  await page.evaluate(
    ({ frame, ref }) =>
      window.tongzhou.browserAction('browser-fixture', { frame, ref, action: 'click' }),
    { frame: view.frame, ref: view.elements.find((e) => e.name === '下载报告').ref },
  );
  let download;
  for (let attempt = 0; attempt < 100; attempt++) {
    download = await page.evaluate(async () =>
      (await window.tongzhou.browserDownloads('browser-fixture')).find(
        (d) => d.status === 'completed',
      ),
    );
    if (download) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(download, 'browser download did not complete');
  assert.equal(await readFile(download.path, 'utf8'), 'download verified');
  checks.push('browser DOM actions, stale references and credential isolation');
  checks.push('managed browser download persisted to a real file');
  await writeFile(
    'test-results/task-workbench-report.json',
    JSON.stringify({ passed: true, packaged: !!executablePath, checks }, null, 2),
  );
  console.log(checks);
} catch (e) {
  await app
    .windows()[0]
    ?.screenshot({ path: 'test-results/task-workbench-failure.png' })
    .catch(() => {});
  throw e;
} finally {
  await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
