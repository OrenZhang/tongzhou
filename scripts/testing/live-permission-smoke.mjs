import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chooseOption } from './choice-helper.mjs';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/live-permission-'));
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
const sessions = ['live-full', 'live-readonly', 'restore-writes', 'revoke-writes'].map((name) => {
  const session = store.createSession('project');
  store.put('session', { ...session, title: name });
  return { id: session.id, name };
});
store.setSessionPermission(sessions[2].id, 'read-only');
store.setSessionPermission(sessions[3].id, 'full-access');
store.close();
const requests = [];
const held = new Map();
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const user = body.messages.filter((m) => m.role === 'user').at(-1).content;
  const name = [...user.matchAll(/TARGET=([a-z-]+)/g)].at(-1)?.[1];
  const writable = body.tools.some((t) => t.function.name === 'write_file');
  const done = body.messages.some((m) => m.role === 'tool');
  requests.push({ name, writable, done });
  if (
    (name === 'restore-writes' && !writable) ||
    (name === 'revoke-writes' && writable && !held.has(name))
  ) {
    held.set(name, res);
    return;
  }
  const delta =
    done || !writable
      ? { content: writable ? '写入完成' : '只读模式，未执行写入' }
      : {
          tool_calls: [
            {
              index: 0,
              id: `write-${name}`,
              function: {
                name: 'write_file',
                arguments: JSON.stringify({ path: `${name}.txt`, content: '权限已生效' }),
              },
            },
          ],
        };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    'data: ' +
      JSON.stringify({
        choices: [{ delta, finish_reason: done || !writable ? 'stop' : 'tool_calls' }],
      }) +
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
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => w.setIgnoreMouseEvents(true)),
  );
  page.setDefaultTimeout(15000);
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.waitForSelector('.app-shell');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluate(
    (baseUrl) =>
      window.tongzhou.saveProvider({
        id: 'fixture',
        name: 'Fixture',
        protocol: 'openai-chat',
        baseUrl,
        auth: 'none',
        models: ['mock'],
        maxOutputTokens: 1000,
        contextChars: 50000,
      }),
    `http://127.0.0.1:${server.address().port}/v1`,
  );
  const begin = async (session) => {
    await page.locator(`[data-session-id="${session.id}"]`).click();
    return page.evaluate(
      (s) =>
        window.tongzhou.run({
          sessionId: s.id,
          providerId: 'fixture',
          model: 'mock',
          agentId: '',
          prompt: 'TARGET=' + s.name,
        }),
      session,
    );
  };
  const waitSnapshot = async (predicate) => {
    const deadline = Date.now() + 20000;
    while (true) {
      const state = await page.evaluate(() => window.tongzhou.snapshot());
      if (predicate(state)) return state;
      if (Date.now() > deadline) throw new Error('Timed out waiting for runtime state');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const pending = (id) => waitSnapshot((state) => state.approvals.some((a) => a.sessionId === id));
  const finished = async (id, permission) => {
    await waitSnapshot((state) =>
      ['completed', 'failed', 'interrupted'].includes(state.runs.find((r) => r.id === id)?.status),
    );
    const run = await page.evaluate(
      async (id) => (await window.tongzhou.snapshot()).runs.find((r) => r.id === id),
      id,
    );
    assert.equal(run.status, 'completed', run.error);
    assert.equal(run.config.permission, permission);
    assert.equal(
      await page.getByRole('button', { name: '会话权限', exact: true }).getAttribute('data-value'),
      permission,
    );
    const promptCount = await page.evaluate(
      async (id) => (await window.tongzhou.messages(id)).filter((m) => m.role === 'user').length,
      run.sessionId,
    );
    assert.equal(promptCount, 1, 'switching must not duplicate the user message');
    const active = await page.evaluate(async (sessionId) => {
      const s = await window.tongzhou.snapshot();
      return {
        approvals: s.approvals.filter((a) => a.sessionId === sessionId).length,
        runs: s.runs.filter((r) => r.sessionId === sessionId).length,
      };
    }, run.sessionId);
    assert.deepEqual(active, { approvals: 0, runs: 1 });
  };
  const waitHeld = async (name) => {
    const deadline = Date.now() + 15000;
    while (!held.has(name)) {
      if (Date.now() > deadline) throw new Error('Model request not received: ' + name);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const first = await begin(sessions[0]);
  await pending(sessions[0].id);
  await page.getByLabel('消息', { exact: true }).fill('保留草稿');
  await chooseOption(page, '会话权限', 'full-access');
  await finished(first, 'full-access');
  assert.equal(await readFile(path.join(project, 'live-full.txt'), 'utf8'), '权限已生效');
  assert.equal(await page.getByLabel('消息', { exact: true }).inputValue(), '保留草稿');
  assert.match(
    await page.getByRole('button', { name: '会话权限', exact: true }).innerText(),
    /完全开放/,
  );
  await page.getByRole('button', { name: '会话权限', exact: true }).click();
  assert.equal(
    await page
      .locator('[role="menuitemradio"][data-value="full-access"]')
      .getAttribute('aria-checked'),
    'true',
  );
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(root, 'permission-full.png'), animations: 'disabled' });

  const second = await begin(sessions[1]);
  await pending(sessions[1].id);
  await chooseOption(page, '会话权限', 'read-only');
  await finished(second, 'read-only');
  await assert.rejects(readFile(path.join(project, 'live-readonly.txt')), { code: 'ENOENT' });

  const third = await begin(sessions[2]);
  await waitHeld('restore-writes');
  await chooseOption(page, '会话权限', 'full-access');
  await finished(third, 'full-access');
  assert.equal(await readFile(path.join(project, 'restore-writes.txt'), 'utf8'), '权限已生效');

  const fourth = await begin(sessions[3]);
  await waitHeld('revoke-writes');
  await chooseOption(page, '会话权限', 'ask');
  await pending(sessions[3].id);
  const state = await page.evaluate(
    async (id) => (await window.tongzhou.snapshot()).runs.find((r) => r.id === id),
    fourth,
  );
  assert.equal(state.config.permission, 'ask');
  assert.match(
    await page.getByRole('button', { name: '会话权限', exact: true }).innerText(),
    /按需审批/,
  );
  assert.equal(await page.getByText('当前任务生效', { exact: true }).count(), 1);
  await assert.rejects(readFile(path.join(project, 'revoke-writes.txt')), { code: 'ENOENT' });
  await page.getByRole('button', { name: '批准本次', exact: true }).click();
  await finished(fourth, 'ask');
  assert.equal(await readFile(path.join(project, 'revoke-writes.txt'), 'utf8'), '权限已生效');
  await page.reload();
  await page.waitForSelector('.app-shell');
  const saved = await page.evaluate(() => window.tongzhou.snapshot());
  assert.deepEqual(
    sessions.map((s) => saved.sessions.find((p) => p.id === s.id).permission),
    ['full-access', 'read-only', 'full-access', 'ask'],
  );
  assert.deepEqual(errors, []);
  console.log(
    `Live permissions passed: actual Codex engine, waiting approval to full access, read-only revocation and restoration, full access to ask, same task/prompt, persisted selection, aligned labels and preserved draft. ${root}`,
  );
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
