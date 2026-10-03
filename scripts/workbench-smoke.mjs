import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/workbench-')),
  repo = path.join(root, '示例仓库');
await mkdir(repo);
await writeFile(path.join(repo, 'README.md'), '# 同舟测试项目\n');
const git = (args) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' });
git(['init', '-b', 'main']);
git(['config', 'user.name', 'Fixture']);
git(['config', 'user.email', 'fixture@example.com']);
git(['add', '.']);
git(['commit', '-m', 'initial']);
await build({
  entryPoints: ['electron/store.ts'],
  outfile: path.join(root, 'store.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
const { Store } = createRequire(import.meta.url)(path.join(root, 'store.cjs'));
const s = new Store(path.join(root, 'profile/tongzhou.db'), {
  encrypt: (v) => v,
  decrypt: (v) => v,
});
s.put('project', { id: 'project', name: '示例仓库', path: repo, createdAt: Date.now() });
const sessions = [s.createSession(), s.createSession('project')];
sessions[0].title = '普通会话';
sessions[1].title = '项目任务';
for (const session of sessions) s.put('session', session);
s.close();
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
const checks = [],
  screens = [];
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(12000);
  await page.waitForSelector('.welcome');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setIgnoreMouseEvents(true),
  );
  const nav = (label) =>
    page.locator('.sidebar').getByRole('button', { name: label, exact: true }).click();
  const capture = async (name) => {
    const file = `test-results/workbench-${name}.png`;
    await page.screenshot({ path: file });
    screens.push(file);
    assert.equal(
      await page.evaluate(() =>
        [...document.querySelectorAll('.page,.modal,.conversation')]
          .filter((e) => e.getClientRects().length)
          .some((e) => e.scrollWidth > e.clientWidth + 2),
      ),
      false,
      `overflow ${name}`,
    );
  };
  await page.locator(`[data-session-id="${sessions[0].id}"]`).click();
  await page.locator('.composer textarea').fill('普通会话草稿');
  await page.locator(`[data-session-id="${sessions[1].id}"]`).click();
  assert.equal(await page.locator('.composer textarea').inputValue(), '');
  await page.locator('.composer textarea').fill('项目会话草稿');
  await page.locator(`[data-session-id="${sessions[0].id}"]`).click();
  assert.equal(await page.locator('.composer textarea').inputValue(), '普通会话草稿');
  await page.reload();
  await page.waitForSelector('.welcome');
  await page.locator(`[data-session-id="${sessions[1].id}"]`).click();
  assert.equal(await page.locator('.composer textarea').inputValue(), '项目会话草稿');
  checks.push('drafts are isolated per session and survive renderer reload');
  await nav('连接中心');
  await page.getByRole('button', { name: '渠道通知', exact: true }).click();
  await page.getByRole('button', { name: '添加 邮件', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称', { exact: true }).fill('开发测试邮件');
  await dialog.getByLabel('SMTP 服务器', { exact: true }).fill('smtp.example.invalid');
  await dialog.getByLabel('登录账号', { exact: true }).fill('fixture@example.com');
  await dialog
    .getByLabel('邮箱授权码 / 密码（留空保留）', { exact: true })
    .fill('fixture-only-secret');
  await dialog.getByLabel('发件邮箱', { exact: true }).fill('fixture@example.com');
  await dialog.getByLabel('收件人邮箱', { exact: true }).fill('one@example.com');
  await page.keyboard.press('Enter');
  await dialog.getByLabel('收件人邮箱', { exact: true }).fill('two@example.com');
  await page.keyboard.press('Enter');
  assert.equal(await dialog.locator('.input-chip').count(), 2);
  await dialog.getByRole('button', { name: '移除 one@example.com', exact: true }).click();
  await capture('email-editor');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const channel = await page.evaluate(async () => {
    const s = await window.tongzhou.snapshot();
    return s.channels.find((c) => c.kind === 'email');
  });
  assert.deepEqual(channel.smtp.to, ['two@example.com']);
  assert.ok(!JSON.stringify(channel).includes('fixture-only-secret'));
  await page.getByRole('button', { name: '添加通知规则', exact: true }).click();
  await dialog.getByLabel('轮次结束', { exact: true }).check();
  await dialog.getByLabel('只发送一次', { exact: true }).check();
  await dialog.getByText('条件筛选', { exact: true }).click();
  await dialog.getByLabel('所属项目', { exact: true }).selectOption('project');
  await dialog.getByLabel('仅执行超过这些秒数时通知', { exact: true }).fill('20');
  await dialog.getByRole('button', { name: '保存规则', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  checks.push(
    'SMTP recipient chips, encrypted credential snapshot, condition and end-of-turn rule persistence; no message sent',
  );
  await page.getByRole('button', { name: '机器人', exact: true }).click();
  await page.getByRole('button', { name: '企业微信机器人', exact: true }).click();
  await dialog.getByLabel('名称', { exact: true }).fill('企微测试机器人');
  await dialog.getByLabel('Bot ID', { exact: true }).fill('fixture-bot');
  await dialog.getByLabel('应用密钥（留空保留）', { exact: true }).fill('fixture-bot-secret');
  await dialog.getByLabel('允许用户 ID', { exact: true }).fill('fixture-user');
  await page.keyboard.press('Enter');
  await capture('bot-editor');
  await dialog.getByRole('button', { name: '保存机器人', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const bot = await page.evaluate(async () => (await window.tongzhou.snapshot()).bots[0]);
  assert.equal(bot.enabled, false);
  assert.equal(bot.allowExecute, false);
  assert.ok(!JSON.stringify(bot).includes('fixture-bot-secret'));
  checks.push(
    'bot credentials and read-only disabled defaults remain separate from notification targets',
  );
  await page.getByRole('button', { name: '服务与浏览器', exact: true }).click();
  await page.getByLabel('搜索工作插件', { exact: true }).fill('Figma');
  assert.equal(await page.locator('.work-plugins .provider-card').count(), 1);
  await page
    .locator('.work-plugins')
    .getByRole('button', { name: '配置插件', exact: true })
    .click();
  assert.equal(await dialog.getByLabel('认证方式', { exact: true }).inputValue(), 'oauth');
  await capture('plugin-editor');
  await dialog.getByRole('button', { name: '保存连接', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const plugin = await page.evaluate(async () =>
    (await window.tongzhou.snapshot()).plugins.find((p) => p.name === 'Figma'),
  );
  assert.equal(plugin.url, 'https://mcp.figma.com/mcp');
  assert.equal(plugin.enabled, false);
  await page.getByLabel('搜索工作插件', { exact: true }).fill('');
  checks.push(
    'official work plugin search and OAuth configuration without attempting external login',
  );
  await nav('项目与工作树');
  await page.getByRole('button', { name: '新建工作树', exact: true }).click();
  await dialog.getByLabel('新分支名称', { exact: true }).fill('feature/ui-test');
  await dialog.getByRole('button', { name: '创建工作树', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('feature/ui-test', { exact: true }).waitFor();
  await capture('worktrees');
  const managed = await page.evaluate(async () =>
    (await window.tongzhou.snapshot()).projects.find((p) => p.sourceProjectId),
  );
  assert.ok(managed);
  await page
    .locator('.worktree-row')
    .filter({ hasText: 'feature/ui-test' })
    .getByRole('button', { name: '进入会话', exact: true })
    .click();
  await page.locator('.project-binding').filter({ hasText: 'feature/ui-test' }).waitFor();
  checks.push('worktree creation and session binding through the UI');
  await nav('设置与关于');
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.reload();
  await page.waitForSelector('.welcome');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  for (const [width, height] of [
    [1440, 900],
    [1000, 700],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size),
      [width, height],
    );
    for (const theme of ['dark', 'light']) {
      await nav('设置与关于');
      await page
        .getByRole('button', { name: theme === 'dark' ? '深色' : '浅色', exact: true })
        .click();
      await capture(`${width}-${theme}-settings`);
      await nav('工作空间');
      await page.locator(`[data-session-id="${sessions[0].id}"]`).click();
      await capture(`${width}-${theme}-chat`);
      await nav('连接中心');
      for (const label of ['服务与浏览器', '渠道通知', '机器人']) {
        await page.getByRole('button', { name: label, exact: true }).click();
        await capture(`${width}-${theme}-${label}`);
        if (theme === 'dark') {
          const button =
            label === '服务与浏览器'
              ? page.locator('.work-plugins').getByRole('button', { name: '管理连接', exact: true })
              : label === '渠道通知'
                ? page
                    .locator('.channel-connections')
                    .getByRole('button', { name: '管理', exact: true })
                : page.getByRole('button', { name: '管理机器人', exact: true });
          await button.click();
          const background = await page
            .getByRole('dialog')
            .locator('.connection-form')
            .first()
            .evaluate((e) => getComputedStyle(e).backgroundColor);
          assert.notEqual(
            background,
            'rgb(255, 255, 255)',
            'dark forms must not have a white surface',
          );
          await capture(`${width}-dark-${label}-editor`);
          await page.keyboard.press('Escape');
        }
      }
      await nav('项目与工作树');
      await page.getByRole('button', { name: '查看工作树', exact: true }).click();
      await page.getByText('feature/ui-test', { exact: true }).waitFor();
      await capture(`${width}-${theme}-projects`);
    }
  }
  await nav('设置与关于');
  await page.getByRole('button', { name: '跟随系统', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  checks.push(
    'light/dark persistence, system change response, all new screens at two viewport sizes',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    'test-results/workbench-report.json',
    JSON.stringify({ passed: true, packaged: !!executablePath, checks, screens }, null, 2),
  );
  console.log(
    'Workbench UI smoke passed: themes, drafts, SMTP, rules, bots, work plugins, Git worktrees.',
  );
} catch (error) {
  await app
    .windows()[0]
    ?.screenshot({ path: 'test-results/workbench-failure.png' })
    .catch(() => {});
  throw error;
} finally {
  await app.close();
}
