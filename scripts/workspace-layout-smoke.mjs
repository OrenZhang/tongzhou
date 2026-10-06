import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/workspace-layout-'));
const project = path.join(root, 'project');
await mkdir(project);
await writeFile(
  path.join(project, 'hello.ts'),
  'export const welcome = "同舟";\nexport const version = "0.1.0";\n',
);
const git = (...args) =>
  execFileSync('git', args, { cwd: project, windowsHide: true, stdio: 'pipe' });
git('init', '-b', 'main');
git('config', 'user.name', 'Fixture');
git('config', 'user.email', 'fixture@example.invalid');
git('add', '.');
git('commit', '-m', 'initial');
await build({
  entryPoints: ['electron/store.ts'],
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
store.put('project', { id: 'project', name: '同舟客户端', path: project, createdAt: Date.now() });
const session = store.createSession('project'),
  ordinary = store.createSession();
store.put('session', { ...session, title: '优化客户端工作区' });
store.put('session', { ...ordinary, title: '独立会话' });
store.put('run', {
  id: 'layout-run',
  sessionId: session.id,
  providerId: 'fixture',
  model: 'fixture',
  agentName: '同舟',
  status: 'completed',
  startedAt: Date.now() - 10000,
  endedAt: Date.now(),
  inputTokens: 0,
  outputTokens: 0,
});
store.message({
  id: 'user',
  sessionId: session.id,
  runId: 'layout-run',
  role: 'user',
  content: '把客户端调整成以任务为中心的布局。',
  createdAt: Date.now() - 10000,
});
store.message({
  id: 'evidence',
  sessionId: session.id,
  runId: 'layout-run',
  role: 'tool',
  toolName: 'run_command',
  status: 'error',
  content: '合成验证失败，不能标成测试通过。',
  createdAt: Date.now(),
});
store.message({
  id: 'reply',
  sessionId: session.id,
  runId: 'layout-run',
  role: 'assistant',
  status: 'complete',
  content:
    '已整理工作区。可查看 [hello.ts](hello.ts#L2) 中的版本定义。\n\n文件、审阅与终端都可以在当前会话中打开。',
  createdAt: Date.now(),
});
const before = 'export const version = \"0.0.0\";';
const after = 'export const version = \"0.1.0\";';
const hash = (text) => createHash('sha256').update(text).digest('hex');
await mkdir(path.join(root, 'profile/checkpoints'), { recursive: true });
for (const text of [before, after])
  await writeFile(path.join(root, 'profile/checkpoints', hash(text)), text);
store.put('runChanges', {
  id: 'layout-run',
  sessionId: session.id,
  projectId: 'project',
  createdAt: Date.now() - 10000,
  finishedAt: Date.now(),
  skipped: 0,
  files: [
    {
      path: 'hello.ts',
      before: hash(before),
      after: hash(after),
    },
  ],
});
store.close();
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const app = await electron.launch({ args: ['.'], env });
const checks = [],
  errors = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1440, 900);
    w.webContents.setBackgroundThrottling(false);
  });
  // macOS may constrain native window bounds to the CI display. Use an explicit
  // renderer viewport so every runner exercises the same desktop breakpoint.
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await page.evaluate(() => innerWidth), 1440);
  await page.locator(`[data-session-id="${session.id}"]`).click();
  await page.getByRole('button', { name: '优化客户端工作区', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByLabel('会话名称', { exact: true }).fill('新的工作区标题');
  await page.getByLabel('会话名称', { exact: true }).press('Enter');
  await page.getByRole('button', { name: '新的工作区标题', exact: true }).waitFor();
  await page.getByRole('button', { name: '新的工作区标题', exact: true }).click();
  await page.getByLabel('会话名称', { exact: true }).fill('不保存的标题');
  await page.getByLabel('会话名称', { exact: true }).press('Escape');
  await page.getByRole('button', { name: '新的工作区标题', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: '新的工作区标题', exact: true }).waitFor();
  checks.push(
    'inline title saves on Enter, cancels on Escape, persists after reload without a dialog',
  );
  await page.getByLabel('执行上下文').getByText('main', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('会话工作区').count(), 0);
  assert.ok((await page.getByLabel('执行上下文').innerText()).includes('同舟客户端'));
  await page.getByLabel('消息', { exact: true }).fill('请保留我的草稿');
  await page.getByRole('button', { name: 'hello.ts', exact: true }).click();
  await page.locator('.source-line.selected').filter({ hasText: '0.1.0' }).waitFor();
  await page.screenshot({ path: 'test-results/workspace-layout-files.png' });
  await page.getByLabel('调整工作区宽度').press('ArrowLeft');
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="调整工作区宽度"]')?.getAttribute('aria-valuenow') ===
      '454',
  );
  assert.equal(await page.getByLabel('调整工作区宽度').getAttribute('aria-valuenow'), '454');
  await page.getByLabel('关闭工作区').click();
  await page.getByRole('button', { name: '验证记录', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#review-run')?.value === 'layout-run');
  assert.equal(await page.getByLabel('运行范围').inputValue(), 'layout-run');
  await page.locator('.task-panel details').first().click();
  await page
    .locator('.task-panel')
    .getByText('合成验证失败，不能标成测试通过。', { exact: true })
    .waitFor();
  assert.ok(!(await page.getByLabel('任务交付').innerText()).includes('验证通过'));
  await page.getByRole('button', { name: '工作目录全部改动', exact: true }).click();
  await page.getByText('当前范围没有变更。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '本次任务改动', exact: true }).click();
  await page.getByRole('tab', { name: '改动审阅', exact: true }).click();
  await page.locator('.task-panel').getByRole('button', { name: 'hello.ts', exact: true }).click();
  await page.locator('.task-patch').filter({ hasText: '0.0.0' }).waitFor();
  await page.screenshot({ path: 'test-results/workspace-layout-review.png' });
  checks.push(
    'real project context; file link opens source at line; task review retains run scope; directory changes remain separate; failed evidence is not promoted to passed',
  );
  await page.getByLabel('关闭工作区').click();
  await page.getByRole('button', { name: '终端', exact: true }).click();
  await page.locator('.xterm').waitFor();
  const terminalId = await page.evaluate(
    async (id) => (await window.tongzhou.taskState(id)).terminals[0].id,
    session.id,
  );
  await page.getByLabel('停靠底部', { exact: true }).click();
  await page.locator('.conversation > .terminal-dock .xterm').waitFor();
  const terminalBox = await page.locator('.conversation > .terminal-dock .xterm').evaluate((el) => {
    const style = getComputedStyle(el),
      screen = el.querySelector('.xterm-screen');
    return {
      bottom: parseFloat(style.paddingBottom),
      available: el.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      screen: screen.getBoundingClientRect().height,
    };
  });
  assert.equal(terminalBox.bottom, 8);
  assert.ok(
    terminalBox.screen <= terminalBox.available + 1,
    'terminal rows fit inside compact padding',
  );
  assert.equal(await page.getByLabel('会话工作区').count(), 0);
  await page.getByLabel('停靠右侧', { exact: true }).click();
  await page.locator('.task-workspace .xterm').waitFor();
  assert.equal(
    await page.evaluate(
      async (id) => (await window.tongzhou.taskState(id)).terminals.length,
      session.id,
    ),
    1,
  );
  await page.getByLabel('关闭工作区').click();
  await page.locator(`[data-session-id="${ordinary.id}"]`).click();
  await page.getByLabel('执行上下文').getByText('本地', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('会话工作区').count(), 0);
  assert.ok(!(await page.getByLabel('执行上下文').innerText()).includes('main'));
  await page.locator(`[data-session-id="${session.id}"]`).click();
  await page.getByLabel('展开工作区', { exact: true }).click();
  await page.locator('.task-workspace .xterm').waitFor();
  assert.equal(await page.getByLabel('消息', { exact: true }).inputValue(), '请保留我的草稿');
  await page.reload();
  await page.locator('.task-workspace .xterm').waitFor();
  assert.equal(
    await page.evaluate(
      async (id) => (await window.tongzhou.taskState(id)).terminals[0].id,
      session.id,
    ),
    terminalId,
  );
  checks.push(
    'terminal moves without duplicating PTY; per-session layout and draft survive switching and reload',
  );
  for (const [width, height, theme] of [
    [1440, 900, 'light'],
    [1000, 760, 'dark'],
    [800, 700, 'light'],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size),
      [width, height],
    );
    await page.setViewportSize({ width, height });
    await page.evaluate(
      (theme) =>
        window.tongzhou.setAppearance({ theme, style: 'graphite', font: 'system', textSize: 14 }),
      theme,
    );
    await page.waitForTimeout(250);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    assert.equal(
      await page.getByLabel('会话工作区').evaluate((e) => e.scrollWidth > e.clientWidth + 2),
      false,
    );
    assert.equal(
      await page.locator('.task-terminal').evaluate((e) => getComputedStyle(e).backgroundColor),
      'rgb(23, 25, 30)',
    );
    await page.screenshot({ path: `test-results/workspace-layout-${width}-${theme}.png` });
  }
  await page.getByLabel('关闭工作区').click();
  await page.getByLabel('选择模型与连接').click();
  await page.getByLabel('当前连接', { exact: true }).waitFor({ state: 'visible' });
  await page.screenshot({ path: 'test-results/workspace-layout-model-menu.png' });
  await page.evaluate(({ s, t }) => window.tongzhou.stopTerminal(s, t), {
    s: session.id,
    t: terminalId,
  });
  assert.deepEqual(errors, []);
  checks.push('wide and narrow layouts, light/dark themes, dark terminal, combined model menu');
  console.log(JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  await (await app.firstWindow())
    .screenshot({ path: 'test-results/workspace-layout-failure.png' })
    .catch(() => {});
  throw error;
} finally {
  await app.close();
}
