import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/state-boundaries-'));
const env = { ...process.env, TONGZHOU_USER_DATA: root, TONGZHOU_DISABLE_UPDATES: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const app = await electron.launch({ args: ['.'], env });
const errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.app-shell');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((window) => window.setIgnoreMouseEvents(true)),
  );

  const waitRequests = async (key, count) => {
    const deadline = Date.now() + 10000;
    while ((await app.evaluate((_, key) => globalThis[key].length, key)) < count) {
      assert.ok(Date.now() < deadline, `Timed out waiting for ${key}: ${count}`);
      await page.waitForTimeout(30);
    }
  };
  // The page owns its editor; save/reopen still uses the shared business operation.
  await page.locator('.sidebar').getByRole('button', { name: 'Agent', exact: true }).click();
  await page.getByRole('button', { name: '创建 Agent', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '配置 Agent', exact: true });
  await editor.getByLabel('名称', { exact: true }).fill('状态边界角色');
  await editor.getByLabel('职责描述', { exact: true }).fill('独立页面状态');
  await editor.getByLabel('角色指令', { exact: true }).fill('保留用户原始请求。');
  await editor.getByRole('button', { name: '保存 Agent', exact: true }).click();
  await page.getByRole('heading', { name: '状态边界角色', exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑 状态边界角色', exact: true }).click();
  assert.equal(
    await editor.getByLabel('角色指令', { exact: true }).inputValue(),
    '保留用户原始请求。',
  );
  await editor.getByLabel('名称', { exact: true }).fill('编辑后角色');
  await editor.getByRole('button', { name: '保存 Agent', exact: true }).click();
  await page.getByRole('heading', { name: '编辑后角色', exact: true }).waitFor();

  const ids = await page.evaluate(async () => {
    const first = await window.tongzhou.createSession();
    const second = await window.tongzhou.createSession();
    await window.tongzhou.updateSession(first.id, { title: '旧会话' });
    await window.tongzhou.updateSession(second.id, { title: '新会话' });
    return [first.id, second.id];
  });
  await page.locator(`[data-session-id="${ids[0]}"]`).waitFor();
  await app.evaluate(({ ipcMain }) => {
    globalThis.stateMessages = [];
    ipcMain.removeHandler('tongzhou:messages');
    ipcMain.handle(
      'tongzhou:messages',
      (_, id) => new Promise((resolve) => globalThis.stateMessages.push({ id, resolve })),
    );
  });
  await page.locator(`[data-session-id="${ids[0]}"]`).click();
  await page.waitForFunction(() =>
    document.querySelector('.session-row.selected .session-title')?.textContent.includes('旧会话'),
  );
  await waitRequests('stateMessages', 1);
  await page.locator(`[data-session-id="${ids[1]}"]`).click();
  await waitRequests('stateMessages', 2);
  await app.evaluate(() => {
    const [first, second] = globalThis.stateMessages;
    const message = (request, content) => [
      {
        id: 'message-' + request.id,
        sessionId: request.id,
        role: 'user',
        content,
        createdAt: 1,
        status: 'complete',
      },
    ];
    second.resolve(message(second, '当前会话正文'));
    first.resolve(message(first, '迟到的旧会话正文'));
  });
  await page.getByText('当前会话正文', { exact: true }).waitFor();
  assert.equal(await page.getByText('迟到的旧会话正文', { exact: true }).count(), 0);

  // A second invalidation waits for the in-flight snapshot, then refreshes again.
  await page.locator('.sidebar').getByRole('button', { name: 'Agent', exact: true }).click();
  const baseline = await page.evaluate(() => window.tongzhou.snapshot());
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    globalThis.stateSnapshots = [];
    ipcMain.removeHandler('tongzhou:snapshot');
    ipcMain.handle(
      'tongzhou:snapshot',
      () => new Promise((resolve) => globalThis.stateSnapshots.push(resolve)),
    );
    BrowserWindow.getAllWindows()[0].webContents.send('tongzhou:event', { type: 'changed' });
  });
  await waitRequests('stateSnapshots', 1);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('tongzhou:event', { type: 'changed' }),
  );
  await page.waitForTimeout(120);
  assert.equal(await app.evaluate(() => globalThis.stateSnapshots.length), 1);
  await app.evaluate((_, baseline) => globalThis.stateSnapshots[0](baseline), baseline);
  await waitRequests('stateSnapshots', 2);
  await app.evaluate((_, baseline) => {
    globalThis.stateSnapshots[1]({
      ...baseline,
      agents: baseline.agents.map((agent) =>
        agent.name === '编辑后角色' ? { ...agent, name: '较新的快照角色' } : agent,
      ),
    });
  }, baseline);
  await page.getByRole('heading', { name: '较新的快照角色', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('heading', { name: '迟到的旧快照角色', exact: true }).count(),
    0,
  );
  await app.evaluate(({ ipcMain, BrowserWindow }, baseline) => {
    globalThis.stateTaskReads = 0;
    ipcMain.removeHandler('tongzhou:taskSnapshot');
    ipcMain.handle('tongzhou:taskSnapshot', () => {
      globalThis.stateTaskReads++;
      return { sessions: baseline.sessions, runs: baseline.runs, approvals: baseline.approvals };
    });
    BrowserWindow.getAllWindows()[0].webContents.send('tongzhou:event', {
      type: 'changed',
      scope: 'tasks',
    });
  }, baseline);
  await page.waitForTimeout(200);
  assert.equal(await app.evaluate(() => globalThis.stateTaskReads), 1);
  assert.equal(await app.evaluate(() => globalThis.stateSnapshots.length), 2);
  assert.deepEqual(errors, []);
  console.log(
    'State boundaries passed: Agent create/edit, stale chat history and serialized snapshots and task-only refreshes.',
  );
} finally {
  await app.close();
}
