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
  ['services/storage/store', 'store'],
  ['modules/projects/run-changes', 'changes'],
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
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + server.address().port;
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
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      // Hosted Windows desktops can occlude packaged apps. Keep the real xterm
      // renderer painting during UI verification, even when the runner loses focus.
      w.webContents.setBackgroundThrottling(false);
      w.show();
      w.focus();
      w.setIgnoreMouseEvents(true);
    }
  });
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
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1008, 650),
  );
  await page.getByRole('button', { name: '终端', exact: true }).click();
  await page.locator('.xterm').waitFor();
  const terminal = await page.evaluate(
    async (id) => (await window.tongzhou.taskState(id)).terminals[0],
    session.id,
  );
  assert.equal(terminal.status, 'running');
  // Wait for the interactive shell's first prompt before injecting a command;
  // on clean Windows runners PowerShell/PSReadLine initializes after PTY ready.
  if (process.platform === 'win32')
    await page.waitForFunction(
      () => /PS [^\r\n]*>/.test(document.querySelector('.xterm-rows')?.textContent ?? ''),
      undefined,
      { timeout: 30000 },
    );
  const command =
    process.platform === 'win32'
      ? "Write-Output ('终端' + '交互通过')\r"
      : "printf '终端%s\\n' '交互通过'\r";
  const terminalInput = page.locator('.xterm-helper-textarea');
  await terminalInput.pressSequentially(command.trimEnd(), { delay: 10 });
  await terminalInput.press('Enter');
  // waitForFunction considers the Promise itself truthy in this Playwright
  // version. Poll resolved IPC values outside the renderer instead.
  const terminalStarted = Date.now();
  const waitForTerminal = async (predicate, timeout = 90000) => {
    const deadline = Date.now() + timeout;
    let record;
    do {
      record = await page.evaluate(({ s, t }) => window.tongzhou.readTerminal(s, t), {
        s: session.id,
        t: terminal.id,
      });
      if (predicate(record)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    throw new Error('Terminal condition timed out: ' + JSON.stringify(record));
  };
  await waitForTerminal((record) => record.output.includes('终端交互通过'));
  console.log('Interactive command output ms:', Date.now() - terminalStarted);
  await page.waitForFunction(() =>
    document.querySelector('.xterm-rows')?.textContent.includes('终端交互通过'),
  );
  await page.screenshot({ path: 'test-results/task-terminal.png' });
  await page.getByRole('button', { name: '停止终端', exact: true }).click();
  await waitForTerminal((record) => record.status !== 'running', 15000);
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
  await writeFile(
    'test-results/task-workbench-report.json',
    JSON.stringify({ passed: true, packaged: !!executablePath, checks }, null, 2),
  );
  console.log(checks);
} catch (e) {
  await writeFile(
    'test-results/task-terminal-report.json',
    JSON.stringify(
      await app
        .windows()[0]
        ?.evaluate(
          async (sessionId) => ({
            rendered: document.querySelector('.xterm-rows')?.textContent,
            visibility: document.visibilityState,
            terminals: await Promise.all(
              (await window.tongzhou.taskState(sessionId)).terminals.map((t) =>
                window.tongzhou.readTerminal(sessionId, t.id),
              ),
            ),
          }),
          session.id,
        )
        .catch(() => null),
      null,
      2,
    ),
  );
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
