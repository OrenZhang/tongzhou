import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/project-deletion-'));
const profile = path.join(root, 'profile');
await writeFile(path.join(root, 'user-file.txt'), 'must survive project removal');
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
store.put('project', {
  id: 'empty',
  name: '空项目',
  path: path.join(root, 'missing'),
  createdAt: 1,
});
store.put('project', { id: 'p', name: '待删除项目', path: root, createdAt: 2 });
const session = store.createSession('p');
const other = store.createSession();
store.close();
const env = { ...process.env, TONGZHOU_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('button', { name: '删除项目 空项目', exact: true }).click();
  await page.getByRole('heading', { name: '删除项目', exact: true }).waitFor();
  assert.match(await page.locator('.modal').innerText(), /磁盘上的项目文件/);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '项目 空项目', exact: true }).count(), 1);
  await page.getByRole('button', { name: '删除项目 空项目', exact: true }).click();
  await page.getByRole('button', { name: '确认删除项目' }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="项目 空项目"]'));
  await page.locator(`[data-session-id="${session.id}"]`).click();
  const terminal = await page.evaluate((id) => window.tongzhou.startTerminal(id), session.id);
  await page.getByRole('button', { name: '删除项目 待删除项目', exact: true }).click();
  await page.getByRole('button', { name: '确认删除项目' }).click();
  await page.getByRole('alert').filter({ hasText: '运行中的终端' }).waitFor();
  await page.evaluate(({ s, t }) => window.tongzhou.stopTerminal(s, t), {
    s: session.id,
    t: terminal.id,
  });
  await page.waitForFunction(
    async ({ s, t }) => (await window.tongzhou.readTerminal(s, t)).status !== 'running',
    { s: session.id, t: terminal.id },
  );
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (theme) =>
        window.tongzhou.setAppearance({ style: 'graphite', font: 'system', textSize: 14, theme }),
      theme,
    );
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
    await page.screenshot({ path: `test-results/project-delete-${theme}.png` });
  }
  await page.getByRole('button', { name: '确认删除项目' }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="项目 待删除项目"]'));
  const snapshot = await page.evaluate(() => window.tongzhou.snapshot());
  assert.equal(snapshot.projects.length, 0);
  assert.deepEqual(
    snapshot.sessions.map((s) => s.id),
    [other.id],
  );
  assert.equal(await page.locator('.conversation-header').count(), 0);
  assert.equal(
    await readFile(path.join(root, 'user-file.txt'), 'utf8'),
    'must survive project removal',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Project deletion passed: empty/missing directory, cancel, live-terminal guard, current session cleanup, theme layouts, disk-file preservation.',
  );
} catch (e) {
  await app.windows()[0]?.screenshot({ path: 'test-results/project-delete-failure.png' });
  throw e;
} finally {
  await app.close();
}
