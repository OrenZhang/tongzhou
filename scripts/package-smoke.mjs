import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('test-results', { recursive: true });
if (process.env.TONGZHOU_PACKAGE_AUTO === '1' && !process.env.TONGZHOU_SMOKE_EXECUTABLE) {
  const candidates =
    process.platform === 'win32'
      ? ['release/win-unpacked/Tongzhou.exe']
      : [
          'release/mac-arm64/Tongzhou.app/Contents/MacOS/Tongzhou',
          'release/mac/Tongzhou.app/Contents/MacOS/Tongzhou',
        ];
  for (const file of candidates) {
    try {
      await access(file);
      process.env.TONGZHOU_SMOKE_EXECUTABLE = path.resolve(file);
      break;
    } catch {}
  }
  if (!process.env.TONGZHOU_SMOKE_EXECUTABLE) throw new Error('Packaged executable not found');
}
const root = await mkdtemp(path.resolve('test-results/package-'));
const project = path.join(root, '项目 with spaces');
await mkdir(project);
await writeFile(path.join(project, 'source.js'), '// SEARCH_MARKER\n');
let toolResult = '';
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const b of req) raw += b;
  const body = JSON.parse(raw),
    result = body.messages.find((m) => m.role === 'tool');
  if (result) toolResult = result.content;
  const reply = result
    ? { choices: [{ delta: { content: '检查结束' }, finish_reason: 'stop' }] }
    : {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'search',
                  function: {
                    name: 'search_files',
                    arguments: JSON.stringify({ query: 'SEARCH_MARKER' }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end('data: ' + JSON.stringify(reply) + '\n\ndata: [DONE]\n\n');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const options = process.env.TONGZHOU_SMOKE_EXECUTABLE
  ? {
      executablePath: path.resolve(process.env.TONGZHOU_SMOKE_EXECUTABLE),
      args: [],
      cwd: root,
      env,
    }
  : { args: ['.'], env };
let app;
const checks = [];
try {
  app = await electron.launch(options);
  let page = await app.firstWindow();
  await page.waitForSelector('.welcome');
  await app.evaluate(({ BrowserWindow, shell }) => {
    BrowserWindow.getAllWindows().forEach((w) => w.setIgnoreMouseEvents(true));
    shell.openExternal = async () => {};
  });
  await page.evaluate(() => window.tongzhou.installBuiltinPlugin());
  const snapshot = await page.evaluate(() => window.tongzhou.snapshot());
  const tools = await page.evaluate((id) => window.tongzhou.testPlugin(id), snapshot.plugins[0].id);
  assert.ok(tools.some((t) => t.name === 'current_time'));
  checks.push('bundled MCP starts outside repository cwd');
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, project);
  const p = await page.evaluate(() => window.tongzhou.addProject());
  const s = await page.evaluate((id) => window.tongzhou.createSession(id), p.id);
  await page.evaluate(
    (base) =>
      window.tongzhou.saveProvider({
        id: 'fixture',
        name: '合成测试',
        protocol: 'openai-chat',
        baseUrl: base,
        auth: 'none',
        models: ['mock'],
        contextChars: 50000,
        maxOutputTokens: 1000,
      }),
    `http://127.0.0.1:${server.address().port}/v1`,
  );
  const runId = await page.evaluate(
    (id) =>
      window.tongzhou.run({
        sessionId: id,
        providerId: 'fixture',
        model: 'mock',
        agentId: '',
        prompt: '搜索 SEARCH_MARKER',
      }),
    s.id,
  );
  let run;
  for (let i = 0; i < 200; i++) {
    run = (await page.evaluate(() => window.tongzhou.snapshot())).runs.find((r) => r.id === runId);
    if (run?.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(run.status, 'completed', run.error);
  assert.ok(toolResult.includes('SEARCH_MARKER'));
  assert.ok(toolResult.includes('source.js'));
  checks.push('packaged ripgrep in Chinese project path');
  await page.evaluate(() =>
    window.tongzhou.saveConnector({
      id: 'browser-fixture',
      name: '浏览器',
      kind: 'browser',
      enabled: true,
      baseUrl: 'https://example.com',
    }),
  );
  await app.evaluate(async ({ session }) => {
    const s = session.fromPartition('persist:tongzhou-connector-browser-fixture');
    await s.cookies.set({
      url: 'https://example.com',
      name: 'fixture',
      value: 'synthetic',
      secure: true,
      expirationDate: Date.now() / 1000 + 3600,
    });
    await s.cookies.flushStore();
  });
  if (process.env.TONGZHOU_COMPUTER_SMOKE === '1') {
    const status = await page.evaluate(() => window.tongzhou.computerSelfTest());
    assert.equal(status.diagnostic?.ok, true, status.diagnostic?.detail);
    checks.push('owned window diagnostic: real screenshot and Unicode input');
  }
  await app.close();
  app = await electron.launch(options);
  page = await app.firstWindow();
  await page.waitForSelector('.welcome');
  const cookies = await app.evaluate(async ({ session }) =>
    session
      .fromPartition('persist:tongzhou-connector-browser-fixture')
      .cookies.get({ name: 'fixture' }),
  );
  assert.equal(cookies[0]?.value, 'synthetic');
  await page.evaluate(() => window.tongzhou.clearBrowserProfile('browser-fixture'));
  assert.equal(
    (
      await app.evaluate(async ({ session }) =>
        session.fromPartition('persist:tongzhou-connector-browser-fixture').cookies.get({}),
      )
    ).length,
    0,
  );
  checks.push('browser cookie persistence across restart and explicit clear');
  await page.screenshot({ path: 'test-results/package-preview.png' });
  await writeFile(
    'test-results/package-report.json',
    JSON.stringify(
      { passed: true, packaged: Boolean(process.env.TONGZHOU_SMOKE_EXECUTABLE), checks },
      null,
      2,
    ),
  );
  console.log('Package smoke passed: ' + checks.join(', '));
} finally {
  await app?.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
