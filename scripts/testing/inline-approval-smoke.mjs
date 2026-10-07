import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/inline-approval-'));
const project = path.join(root, 'project');
await mkdir(project);
await build({
  entryPoints: ['electron/services/storage/store.ts'],
  outfile: path.join(root, 'store.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
const { Store } = createRequire(import.meta.url)(path.join(root, 'store.cjs'));
const store = new Store(path.join(root, 'profile/tongzhou.db'), {
  encrypt: (s) => s,
  decrypt: (s) => s,
});
store.put('project', { id: 'project', name: '审批测试', path: project, createdAt: Date.now() });
store.put('knowledgeSettings', { id: 'default', autoCollect: false });
const sessions = ['allow', 'deny', 'cancel'].map((name) => {
  const session = store.createSession('project');
  store.put('session', { ...session, title: name });
  return { id: session.id, name };
});
store.close();
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const done = body.messages.some((m) => m.role === 'tool');
  const name = body.messages.filter((m) => m.role === 'user').at(-1).content;
  const delta = done
    ? { content: '本轮结束' }
    : {
        tool_calls: [
          {
            index: 0,
            id: `write-${name}`,
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: `${name}.txt`, content: '审批测试' }),
            },
          },
        ],
      };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    'data: ' +
      JSON.stringify({ choices: [{ delta, finish_reason: done ? 'stop' : 'tool_calls' }] }) +
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
  page.setDefaultTimeout(15000);
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.waitForSelector('.app-shell');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluate(async (baseUrl) => {
    await window.tongzhou.saveProvider({
      id: 'fixture',
      name: 'Fixture',
      protocol: 'openai-chat',
      baseUrl,
      auth: 'none',
      models: ['mock'],
      maxOutputTokens: 1000,
      contextChars: 50000,
    });
  }, `http://127.0.0.1:${server.address().port}/v1`);
  const open = async (session) => page.locator(`[data-session-id="${session.id}"]`).click();
  const start = async (session) =>
    page.evaluate(
      async (s) =>
        window.tongzhou.run({
          sessionId: s.id,
          providerId: 'fixture',
          model: 'mock',
          agentId: '',
          prompt: s.name,
        }),
      session,
    );
  const count = async (n) =>
    page.waitForFunction(async (n) => (await window.tongzhou.snapshot()).approvals.length === n, n);
  const card = (name) => page.getByRole('region', { name: `写入 ${name}.txt`, exact: true });
  await open(sessions[0]);
  await page.getByLabel('消息', { exact: true }).fill('保留当前草稿');
  await start(sessions[0]);
  await start(sessions[1]);
  await count(2);
  await card('allow').waitFor();
  assert.equal(await card('deny').count(), 0);
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByLabel('消息', { exact: true }).press('Escape');
  await count(2);
  assert.equal(await page.getByLabel('消息', { exact: true }).inputValue(), '保留当前草稿');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (theme) =>
        window.tongzhou.setAppearance({ theme, style: 'graphite', font: 'system', textSize: 14 }),
      theme,
    );
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
    await page.screenshot({
      path: path.join(root, `approval-${theme}.png`),
      animations: 'disabled',
    });
  }
  await page.getByRole('button', { name: '待批准 · 1', exact: true }).click();
  await card('deny').waitFor();
  assert.equal(await card('allow').count(), 0);
  await card('deny').getByRole('button', { name: '拒绝', exact: true }).click();
  await count(1);
  await assert.rejects(readFile(path.join(project, 'deny.txt')), { code: 'ENOENT' });
  await page.getByRole('button', { name: '智库', exact: true }).click();
  await page.getByRole('button', { name: '待批准 · 1', exact: true }).click();
  await card('allow').waitFor();
  await card('allow').getByRole('button', { name: '批准本次', exact: true }).click();
  await count(0);
  await page.waitForFunction(
    async (id) =>
      !(await window.tongzhou.snapshot()).runs.some(
        (r) => r.sessionId === id && r.status === 'running',
      ),
    sessions[0].id,
  );
  assert.equal(await readFile(path.join(project, 'allow.txt'), 'utf8'), '审批测试');
  await start(sessions[2]);
  await count(1);
  await open(sessions[2]);
  await card('cancel').waitFor();
  await page.evaluate((id) => window.tongzhou.cancel(id), sessions[2].id);
  await count(0);
  await card('cancel').waitFor({ state: 'hidden' });
  await assert.rejects(readFile(path.join(project, 'cancel.txt')), { code: 'ENOENT' });
  assert.deepEqual(errors, []);
  console.log(
    `Inline approval passed: no dialogs, explicit approve/reject, session isolation, background navigation, Escape and draft preserved, cancellation clears, light/dark screenshots. ${root}`,
  );
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
