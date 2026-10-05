import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/terminal-entry-'));
const profile = path.join(root, 'profile'),
  project = path.join(root, 'project');
await mkdir(project);
await build({
  entryPoints: ['electron/store.ts'],
  outfile: path.join(root, 'store.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
const { Store } = createRequire(import.meta.url)(path.join(root, 'store.cjs'));
const store = new Store(path.join(profile, 'tongzhou.db'), {
  encrypt: (s) => s,
  decrypt: (s) => s,
});
store.put('project', { id: 'p', name: '终端项目', path: project, createdAt: 1 });
const projectSession = store.createSession('p'),
  ordinary = store.createSession(),
  second = store.createSession();
store.close();
const env = { ...process.env, TONGZHOU_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.app-shell');
  const open = async (sessionId) => {
    await page.locator(`[data-session-id="${sessionId}"]`).click();
    assert.equal(
      await page
        .locator('.composer-actions')
        .getByRole('button', { name: '知识', exact: true })
        .count(),
      0,
    );
    await page
      .locator('.conversation-header')
      .getByRole('button', { name: '终端', exact: true })
      .click();
    await page.getByRole('heading', { name: '会话终端', exact: true }).waitFor();
    await page.locator('.xterm').waitFor();
    return page.evaluate(
      async (id) =>
        (await window.tongzhou.taskState(id)).terminals.find((t) => t.status === 'running'),
      sessionId,
    );
  };
  const write = async (sessionId, terminal, expected) => {
    assert.equal(path.resolve(terminal.cwd), path.resolve(expected));
    const command =
      process.platform === 'win32'
        ? "Set-Content -Encoding UTF8 -LiteralPath terminal-location.txt -Value (Get-Location).Path; Write-Output ('cwd_' + 'verified')"
        : "pwd > terminal-location.txt; printf 'cwd_%s\\n' verified";
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(command);
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      async ({ s, t }) =>
        (await window.tongzhou.readTerminal(s, t)).output.includes('cwd_verified'),
      { s: sessionId, t: terminal.id },
      { timeout: 30000 },
    );
    // PSReadLine may echo a prediction before the command has finished executing.
    const outputFile = path.join(expected, 'terminal-location.txt');
    const deadline = Date.now() + 30000;
    let contents;
    while (contents === undefined) {
      try {
        contents = await readFile(outputFile, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const cwd = contents.trim().replace(/^\uFEFF/, '');
    assert.equal(path.resolve(cwd).toLowerCase(), path.resolve(expected).toLowerCase());
    await page.waitForFunction(() =>
      document.querySelector('.xterm-rows')?.textContent.includes('cwd_verified'),
    );
  };
  const first = await open(ordinary.id);
  assert.equal(first.projectId, undefined);
  await write(ordinary.id, first, path.join(profile, 'chat-workspaces', ordinary.id));
  await page.screenshot({ path: 'test-results/ordinary-terminal.png' });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const reopened = await open(ordinary.id);
  assert.equal(reopened.id, first.id);
  assert.equal(
    (await page.evaluate((id) => window.tongzhou.taskState(id), ordinary.id)).terminals.length,
    1,
  );
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const another = await open(second.id);
  assert.notEqual(another.cwd, first.cwd);
  await assert.rejects(
    page.evaluate(({ s, t }) => window.tongzhou.readTerminal(s, t), { s: second.id, t: first.id }),
    /终端不属于/,
  );
  await page.getByRole('button', { name: '停止终端', exact: true }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  const projectTerminal = await open(projectSession.id);
  await write(projectSession.id, projectTerminal, project);
  await page.getByRole('button', { name: '停止终端', exact: true }).click();
  await page.waitForFunction(
    async ({ s, t }) => (await window.tongzhou.readTerminal(s, t)).status !== 'running',
    { s: projectSession.id, t: projectTerminal.id },
  );
  assert.deepEqual(errors, []);
  console.log(
    'Terminal entry passed: one-click PTY, actual keyboard commands in project and ordinary directories, reuse after closing, session isolation and stop.',
  );
} finally {
  await app.close();
}
