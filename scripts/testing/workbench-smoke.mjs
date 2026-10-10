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
git(['remote', 'add', 'origin', 'https://github.com/fixture/repository.git']);
await build({
  entryPoints: ['electron/services/storage/store.ts'],
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
env.TONGZHOU_GITHUB_CLIENT_ID = '';
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
  await page.waitForSelector('.app-shell');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setIgnoreMouseEvents(true);
    window.setFocusable(false);
    window.blur();
  });
  const nav = async (label) => {
    if (label === '渠道') {
      await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '打开渠道', exact: true }).click();
    } else await page.locator('.sidebar').getByRole('button', { name: label, exact: true }).click();
  };
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
  await page.waitForSelector('.app-shell');
  await page.locator(`[data-session-id="${sessions[1].id}"]`).click();
  assert.equal(await page.locator('.composer textarea').inputValue(), '项目会话草稿');
  checks.push('drafts are isolated per session and survive renderer reload');
  const ordinaryRow = page
    .locator('.session-row')
    .filter({ has: page.locator(`[data-session-id="${sessions[0].id}"]`) });
  const projectRow = page
    .locator('.session-row')
    .filter({ has: page.locator(`[data-session-id="${sessions[1].id}"]`) });
  for (const row of [ordinaryRow, projectRow])
    assert.equal(await row.getByRole('button', { name: '删除会话', exact: true }).count(), 0);
  const rejectedDelete = await page.evaluate(async (id) => {
    try {
      await window.tongzhou.deleteSession(id);
      return '';
    } catch (error) {
      return error.message;
    }
  }, sessions[0].id);
  assert.ok(rejectedDelete.includes('请先归档'), rejectedDelete);
  assert.equal(await ordinaryRow.count(), 1);
  await page.locator('.composer textarea').focus();
  await page.locator('.conversation-header').hover();
  assert.equal(
    await ordinaryRow.locator('.session-actions').evaluate((el) => getComputedStyle(el).opacity),
    '0',
  );
  assert.equal(
    await projectRow.locator('.session-actions').evaluate((el) => getComputedStyle(el).opacity),
    '0',
  );
  assert.equal(
    await page
      .locator('.conversation-header')
      .getByRole('button', { name: /归档会话|删除会话|恢复会话/ })
      .count(),
    0,
  );
  await ordinaryRow.hover();
  assert.equal(
    await ordinaryRow.locator('.session-actions').evaluate((el) => getComputedStyle(el).opacity),
    '1',
  );
  await capture('session-hover');
  await page.locator('.conversation-header').hover();
  assert.equal(
    await ordinaryRow.locator('.session-actions').evaluate((el) => getComputedStyle(el).opacity),
    '0',
  );
  await ordinaryRow.locator('.session-title').focus();
  await page.keyboard.press('Tab');
  assert.equal(
    await ordinaryRow
      .getByRole('button', { name: '归档会话', exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  assert.equal(
    await ordinaryRow.locator('.session-actions').evaluate((el) => getComputedStyle(el).opacity),
    '1',
  );
  await page.keyboard.press('Enter');
  await ordinaryRow.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.conversation-header h2').innerText(), '项目任务');
  assert.equal(await page.locator('.composer textarea').inputValue(), '项目会话草稿');
  await page.getByRole('button', { name: '切换归档会话', exact: true }).click();
  await ordinaryRow.hover();
  await ordinaryRow.getByRole('button', { name: '恢复会话', exact: true }).click();
  await ordinaryRow.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '切换归档会话', exact: true }).click();
  await ordinaryRow.hover();
  assert.equal(await ordinaryRow.getByRole('button', { name: '删除会话', exact: true }).count(), 0);
  await ordinaryRow.getByRole('button', { name: '归档会话', exact: true }).click();
  await ordinaryRow.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '切换归档会话', exact: true }).click();
  await ordinaryRow.hover();
  await ordinaryRow.getByRole('button', { name: '删除会话', exact: true }).click();
  assert.ok((await page.getByRole('dialog').innerText()).includes('确认删除“普通会话”'));
  await capture('delete-confirmation');
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await ordinaryRow.count(), 1);
  await ordinaryRow.getByRole('button', { name: '恢复会话', exact: true }).click();
  await ordinaryRow.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '切换归档会话', exact: true }).click();
  const disposable = await page.evaluate(() => window.tongzhou.createSession('project'));
  const disposableRow = page
    .locator('.session-row')
    .filter({ has: page.locator(`[data-session-id="${disposable.id}"]`) });
  await disposableRow.hover();
  assert.equal(
    await disposableRow.getByRole('button', { name: '删除会话', exact: true }).count(),
    0,
  );
  await disposableRow.getByRole('button', { name: '归档会话', exact: true }).click();
  await disposableRow.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '切换归档会话', exact: true }).click();
  await disposableRow.hover();
  await disposableRow.getByRole('button', { name: '删除会话', exact: true }).click();
  // A restored session must no longer be deletable even if its confirmation is open.
  await page.evaluate(
    (id) => window.tongzhou.updateSession(id, { archived: false }),
    disposable.id,
  );
  await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelector('.destructive-button')?.disabled === true,
  );
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate((id) => window.tongzhou.updateSession(id, { archived: true }), disposable.id);
  await disposableRow.hover();
  await disposableRow.getByRole('button', { name: '删除会话', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
  await disposableRow.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '切换归档会话', exact: true }).click();
  assert.equal(await page.locator('.conversation-header h2').innerText(), '项目任务');
  assert.equal(await page.locator('.composer textarea').inputValue(), '项目会话草稿');
  checks.push(
    'session actions reveal on hover or keyboard focus',
    'archive and restore from the sidebar preserve the current conversation',
    'unarchived sessions have no delete entry and reject direct deletion',
    'archived deletion names the target, supports cancellation and refuses restored sessions',
  );
  await nav('渠道');
  await page.getByRole('button', { name: '添加邮件渠道', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '飞书扫码接入', exact: true }).count(), 0);
  await page.getByRole('button', { name: '连接邮件', exact: true }).click();
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
  await page.getByRole('button', { name: /^邮件通知/ }).click();
  await page.getByRole('button', { name: '通知规则', exact: true }).click();
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
  assert.equal(
    await page
      .locator('.connection-tabs')
      .getByRole('button', { name: '渠道', exact: true })
      .count(),
    0,
  );
  await nav('渠道');
  await page.getByRole('heading', { name: '渠道', exact: true }).waitFor();
  const botMethods = (await page.evaluate(() => window.tongzhou.clientMethods())).methods;
  assert.equal(botMethods.find((m) => m.name === 'onboardBot').view, 'connections');
  const removedBrowserMethods = [
    'browserProfileStatus',
    'openBrowserProfile',
    'clearBrowserProfile',
    'browserDownloads',
    'browserSnapshot',
    'browserAction',
    'browserNavigate',
    'browserPress',
  ];
  assert.ok(!botMethods.some((method) => removedBrowserMethods.includes(method.name)));
  assert.ok(botMethods.some((method) => method.name === 'saveConnector'));
  assert.ok(botMethods.some((method) => method.name === 'sendChannel'));
  await page.getByRole('button', { name: '添加飞书渠道', exact: true }).click();
  assert.ok(botMethods.some((m) => m.name === 'cancelBotLogin'));
  assert.equal(await page.getByRole('button', { name: '飞书扫码接入', exact: true }).count(), 0);
  await page.getByRole('button', { name: '连接飞书', exact: true }).click();
  await dialog.getByRole('button', { name: /扫码接入/ }).waitFor();
  await capture('feishu-methods');
  await dialog.getByRole('button', { name: /手动配置/ }).click();
  await dialog.getByLabel('App / Client ID', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  // Stub only onboarding IPC in this isolated test process. Never contact Feishu.
  await app.evaluate(({ ipcMain }) => {
    globalThis.feishuSmoke = { calls: 0, cancelled: '' };
    ipcMain.removeHandler('tongzhou:onboardBot');
    ipcMain.handle('tongzhou:onboardBot', (_event, id, _name, kind) => {
      globalThis.feishuSmoke.calls++;
      globalThis.feishuSmoke.kind = kind;
      if (globalThis.feishuSmoke.calls === 1) throw new Error('合成网络异常，请重试');
      return {
        id,
        image:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
        expiresAt: Date.now() + 60000,
      };
    });
    ipcMain.removeHandler('tongzhou:cancelBotLogin');
    ipcMain.handle('tongzhou:cancelBotLogin', (_event, id) => {
      globalThis.feishuSmoke.cancelled = id;
    });
  });
  await page.getByRole('button', { name: '连接飞书', exact: true }).click();
  await dialog.getByRole('button', { name: /扫码接入/ }).click();
  await dialog.getByRole('alert').filter({ hasText: '合成网络异常' }).waitFor();
  await dialog.getByRole('button', { name: /扫码接入/ }).click();
  await dialog.getByAltText('飞书机器人授权二维码').waitFor();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  assert.ok(await app.evaluate(() => globalThis.feishuSmoke.cancelled));
  checks.push(
    'Feishu QR and manual setup are inside Add Feishu Bot; inline error/retry and QR cancellation work without contacting Feishu',
  );
  await page.getByRole('button', { name: '添加企业微信渠道', exact: true }).click();
  await page.getByRole('button', { name: '连接企业微信', exact: true }).click();
  await dialog.getByRole('button', { name: /扫码接入/ }).click();
  await dialog.getByAltText('企业微信机器人授权二维码').waitFor();
  assert.equal(await app.evaluate(() => globalThis.feishuSmoke.kind), 'wecom');
  await capture('wecom-qr');
  await dialog.getByRole('button', { name: '重新获取二维码', exact: true }).click();
  await dialog.getByAltText('企业微信机器人授权二维码').waitFor();
  await dialog.getByRole('button', { name: '手动配置', exact: true }).click();
  checks.push(
    'WeCom QR uses its own platform, supports refreshing and falls back to manual configuration',
  );
  await dialog.getByLabel('名称', { exact: true }).fill('企微测试机器人');
  await dialog.getByLabel('Bot ID', { exact: true }).fill('fixture-bot');
  await dialog.getByLabel('应用密钥（留空保留）', { exact: true }).fill('fixture-bot-secret');
  await dialog.getByLabel('允许用户 ID', { exact: true }).fill('');
  await capture('bot-editor');
  await dialog.getByRole('button', { name: '保存渠道', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const bot = await page.evaluate(async () => (await window.tongzhou.snapshot()).bots[0]);
  assert.equal('enabled' in bot, false);
  assert.equal('allowExecute' in bot, false);
  assert.ok(!JSON.stringify(bot).includes('fixture-bot-secret'));
  checks.push('bot credentials stay separate from shared settings and notification targets');
  await nav('插件');
  await page.getByRole('button', { name: /^内置插件/ }).click();
  await page.getByLabel('类型', { exact: true }).selectOption('app');
  await page.getByLabel('搜索插件', { exact: true }).fill('机器人');
  await page.getByRole('button', { name: '打开渠道', exact: true }).click();
  await page.getByRole('heading', { name: '渠道', exact: true }).waitFor();
  await page.getByRole('heading', { name: '企微测试机器人', exact: true }).waitFor();
  assert.equal(await page.locator('.connection-tabs').count(), 0);
  await capture('bots-standalone');
  checks.push('standalone bots navigation, built-in application entry and persisted configuration');
  await nav('渠道');
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '管理浏览器账号', exact: true }).count(), 0);
  // Legacy account fixtures remain usable from plugin Token mode after the old UI is removed.
  await page.evaluate(() =>
    window.tongzhou.saveConnector({
      id: 'fixture-github',
      name: '仓库测试账号',
      kind: 'github',
      baseUrl: 'https://github.com',
      enabled: true,
      secret: 'fixture-github-token',
    }),
  );
  const connector = await page.evaluate(async () =>
    (await window.tongzhou.snapshot()).connectors.find((c) => c.kind === 'github'),
  );
  assert.ok(connector.hasSecret);
  assert.ok(!JSON.stringify(connector).includes('fixture-github-token'));
  assert.equal(await page.locator('.work-plugins').count(), 0);
  await nav('插件');
  await page.getByRole('button', { name: /^内置插件/ }).click();
  assert.equal(await page.getByRole('button', { name: /^工作插件|^内置与自定义/ }).count(), 0);
  assert.equal(await page.locator('.plugin-library .provider-card').count(), 9);
  await capture('builtin-plugin-library-all');
  assert.equal(await page.getByRole('button', { name: '添加插件', exact: true }).count(), 0);
  await page.getByLabel('类型', { exact: true }).selectOption('mcp');
  assert.equal(await page.locator('.plugin-library .provider-card').count(), 2);
  await page.getByLabel('搜索插件', { exact: true }).fill('系统环境');
  assert.equal(await page.locator('.plugin-library .provider-card').count(), 1);
  await page.getByLabel('搜索插件', { exact: true }).fill('');
  await page.getByLabel('类型', { exact: true }).selectOption('skill');
  await page.getByRole('heading', { name: '技能创建', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '移除', exact: true }).count(), 0);
  await page.getByLabel('类型', { exact: true }).selectOption('app');
  assert.equal(await page.locator('.plugin-library .provider-card').count(), 6);
  await capture('builtin-plugin-library');
  await page.getByLabel('搜索插件', { exact: true }).fill('Figma');
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
  await page.getByRole('button', { name: /^个人插件/ }).click();
  assert.equal(await page.getByRole('heading', { name: 'Figma', exact: true }).count(), 0);
  assert.equal(
    await page.getByRole('heading', { name: '系统环境 · 内置', exact: true }).count(),
    0,
  );
  await page.getByRole('button', { name: '添加插件', exact: true }).waitFor();
  await page.getByLabel('类型', { exact: true }).selectOption('app');
  await page
    .getByText('暂无个人应用插件，可在“内置插件”中配置现有应用。', { exact: true })
    .waitFor();
  await capture('personal-plugin-library-empty');
  await page.getByRole('button', { name: /^内置插件/ }).click();
  await page.getByLabel('搜索插件', { exact: true }).fill('Figma');
  await page
    .locator('.work-plugins')
    .getByRole('button', { name: '管理连接', exact: true })
    .click();
  await dialog.getByRole('button', { name: '高级 MCP 设置', exact: true }).click();
  await dialog.getByRole('heading', { name: '管理 MCP 插件', exact: true }).waitFor();
  assert.equal(await dialog.getByLabel('插件名称', { exact: true }).inputValue(), 'Figma');
  await dialog.getByRole('button', { name: '保存插件', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  // Multiple accounts of the same application remain reachable in its one card.
  await page.evaluate(
    (p) => window.tongzhou.savePlugin({ ...p, id: 'figma-extra', name: 'Figma 备用' }),
    plugin,
  );
  await page.getByLabel('Figma 连接', { exact: true }).selectOption('figma-extra');
  await page
    .locator('.work-plugins')
    .getByRole('button', { name: '管理连接', exact: true })
    .click();
  await dialog.getByRole('heading', { name: '连接 Figma 备用', exact: true }).waitFor();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.evaluate(() => window.tongzhou.deletePlugin('figma-extra'));
  await page.getByLabel('Figma 连接', { exact: true }).waitFor({ state: 'detached' });
  await capture('plugin-single-entry');
  assert.equal(await page.locator('.work-plugins .service-card-actions button').count(), 1);
  await page
    .locator('.work-plugins')
    .getByRole('button', { name: '管理连接', exact: true })
    .click();
  await dialog
    .getByLabel('Figma 连接方式', { exact: true })
    .selectOption('http://127.0.0.1:3845/mcp');
  assert.equal(await dialog.getByRole('button', { name: '浏览器授权', exact: true }).count(), 0);
  await dialog.getByText(/在 Figma 桌面应用打开文件/).waitFor();
  await dialog
    .getByLabel('Figma 连接方式', { exact: true })
    .selectOption('https://mcp.figma.com/mcp');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByLabel('搜索插件', { exact: true }).fill('GitHub');
  await page
    .locator('.work-plugins')
    .getByRole('button', { name: '配置插件', exact: true })
    .click();
  assert.equal(await dialog.getByLabel('认证方式', { exact: true }).inputValue(), 'headers');
  await dialog.getByLabel('Token 来源', { exact: true }).selectOption(connector.id);
  assert.equal(await dialog.getByLabel('Token 来源', { exact: true }).inputValue(), connector.id);
  assert.equal(await dialog.getByText('高级：自定义 GitHub OAuth 应用').count(), 0);
  await capture('github-saved-auth');
  await dialog.getByRole('button', { name: '保存连接', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const githubPlugin = await page.evaluate(async () =>
    (await window.tongzhou.snapshot()).plugins.find((p) => p.name === 'GitHub 仓库工具'),
  );
  assert.ok(githubPlugin.hasSecret);
  assert.ok(!JSON.stringify(githubPlugin).includes('fixture-github-token'));
  await page
    .locator('.work-plugins')
    .getByRole('button', { name: '管理连接', exact: true })
    .click();
  assert.equal(await dialog.getByLabel('认证方式', { exact: true }).inputValue(), 'headers');
  assert.equal(githubPlugin.connectorId, connector.id);
  assert.equal(await dialog.getByLabel('Token 来源', { exact: true }).inputValue(), connector.id);
  await dialog.getByLabel('认证方式', { exact: true }).selectOption('oauth');
  await dialog.getByLabel('认证方式', { exact: true }).selectOption('headers');
  await dialog
    .getByLabel('访问令牌（留空保留）', { exact: true })
    .fill('fixture-github-independent-token');
  await dialog.getByRole('button', { name: '保存连接', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.ok(
    await page.evaluate(
      async (id) => (await window.tongzhou.snapshot()).plugins.find((p) => p.id === id).hasSecret,
      githubPlugin.id,
    ),
    'switching away from advanced settings must preserve a saved token',
  );
  await page
    .locator('.work-plugins')
    .getByRole('button', { name: '管理连接', exact: true })
    .click();
  await dialog.getByLabel('认证方式', { exact: true }).selectOption('oauth');
  await dialog.getByRole('button', { name: '使用 GitHub 登录', exact: true }).click();
  await dialog
    .getByRole('alert')
    .filter({ hasText: /尚未配置同舟的 GitHub 登录应用/ })
    .waitFor();
  assert.ok(!(await dialog.innerText()).includes('Error invoking remote method'));
  await capture('github-oauth-requirements');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByLabel('搜索插件', { exact: true }).fill('GitLab');
  await page
    .locator('.work-plugins')
    .getByRole('button', { name: '配置插件', exact: true })
    .click();
  assert.equal(
    await dialog.getByLabel('GitLab 实例地址', { exact: true }).inputValue(),
    'https://gitlab.com',
  );
  await dialog
    .getByLabel('GitLab 实例地址', { exact: true })
    .fill('https://gitlab.fixture.example');
  assert.equal(await dialog.getByLabel('认证方式', { exact: true }).inputValue(), 'headers');
  await dialog.getByLabel('认证方式', { exact: true }).selectOption('oauth');
  assert.equal(
    await dialog.getByRole('button', { name: '使用 GitLab 登录', exact: true }).count(),
    1,
  );
  assert.equal(await dialog.getByText('高级：使用已注册的 OAuth 应用', { exact: true }).count(), 0);
  assert.equal(await dialog.getByLabel('预注册 Client ID（可选）', { exact: true }).count(), 0);
  assert.equal(await dialog.getByLabel('访问令牌（留空保留）', { exact: true }).count(), 0);
  await capture('gitlab-self-managed');
  await dialog.getByRole('button', { name: '保存连接', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const gitlabPlugin = await page.evaluate(async () =>
    (await window.tongzhou.snapshot()).plugins.find((p) => p.name === 'GitLab 仓库工具'),
  );
  assert.equal(gitlabPlugin.url, 'https://gitlab.fixture.example/api/v4/mcp');
  assert.equal(gitlabPlugin.authMode, 'oauth');
  assert.equal(gitlabPlugin.enabled, false);
  assert.equal(
    await page
      .locator('.work-plugins .service-card-actions')
      .getByRole('button', { name: '添加连接', exact: true })
      .count(),
    0,
  );
  await page
    .locator('.work-plugins')
    .getByRole('button', { name: '管理连接', exact: true })
    .click();
  await dialog.getByText('其他账号与站点', { exact: true }).click();
  await dialog.getByRole('button', { name: '添加其他账号或站点', exact: true }).click();
  assert.equal(
    await dialog.getByLabel('GitLab 实例地址', { exact: true }).inputValue(),
    'https://gitlab.com',
  );
  assert.equal(await dialog.getByLabel('认证方式', { exact: true }).inputValue(), 'headers');
  await dialog
    .getByLabel('访问令牌（留空保留）', { exact: true })
    .fill('fixture-other-gitlab-token');
  await dialog.getByRole('button', { name: '保存连接', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByLabel('GitLab 仓库工具 连接', { exact: true }).selectOption(gitlabPlugin.id);
  await page
    .locator('.work-plugins')
    .getByRole('button', { name: '管理连接', exact: true })
    .click();
  assert.equal(
    await dialog.getByLabel('GitLab 实例地址', { exact: true }).inputValue(),
    'https://gitlab.fixture.example',
  );
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByLabel('搜索插件', { exact: true }).fill('');
  checks.push(
    'plugin library separates built-in and personal sources, filters applications/MCP/skills, searches built-ins, and preserves app connections without duplicates',
    'Figma desktop alternative and inline GitHub registration requirements without external login',
  );
  assert.equal(await page.getByRole('button', { name: '项目与工作树', exact: true }).count(), 0);
  await page.evaluate((id) => window.tongzhou.bindGitAccount('project', id), connector.id);
  const managed = await page.evaluate(() =>
    window.tongzhou.createWorktree('project', 'feature/ui-test', 'HEAD'),
  );
  const isolated = await page.evaluate((id) => window.tongzhou.createSession(id), managed.id);
  const grouped = page.locator('.project-group[data-project-id="project"]');
  await grouped.locator('[data-session-id="' + isolated.id + '"]').click();
  assert.equal(
    await page.locator('.project-group').count(),
    1,
    'execution worktrees must not create separate project groups',
  );
  await page
    .getByLabel('执行上下文')
    .locator('.context-chip')
    .first()
    .filter({ hasText: 'feature/ui-test' })
    .waitFor();
  assert.equal(
    (await page.evaluate(() => window.tongzhou.snapshot())).sessions.find(
      (s) => s.id === isolated.id,
    ).projectId,
    managed.id,
  );
  await page.getByLabel('搜索会话', { exact: true }).fill('feature/ui-test');
  await grouped.locator('[data-session-id="' + isolated.id + '"]').waitFor();
  await page.getByLabel('搜索会话', { exact: true }).fill('');
  await capture('agent-worktree-session');
  await page.evaluate(() => window.tongzhou.openModule('projects'));
  await page.locator('.conversation-header').waitFor();
  checks.push(
    'Git worktree capabilities remain available to agents without a configuration page',
    'isolated sessions group under their source and keep their actual directory binding',
  );
  await nav('设置');
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.reload();
  await page.waitForSelector('.app-shell');
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
      await nav('设置');
      await page
        .getByRole('button', { name: theme === 'dark' ? '深色' : '浅色', exact: true })
        .click();
      await capture(`${width}-${theme}-settings`);
      await page.getByRole('button', { name: '返回会话', exact: true }).click();
      await page.locator(`[data-session-id="${sessions[0].id}"]`).click();
      await capture(`${width}-${theme}-chat`);
      await nav('渠道');
      for (const label of ['开发测试邮件', '企微测试机器人']) {
        await nav('渠道');
        await page.locator('.channel-list-item').filter({ hasText: label }).click();
        await capture(`${width}-${theme}-${label}`);
        if (theme === 'dark') {
          await page.getByRole('button', { name: '管理授权', exact: true }).click();
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
    }
  }
  await nav('设置');
  await page.getByRole('button', { name: '跟随系统', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  checks.push(
    'light/dark persistence, system change response, all new screens at two viewport sizes',
  );
  await page.evaluate((id) => window.tongzhou.removeWorktree(id), managed.id);
  await page.getByRole('button', { name: '切换归档会话', exact: true }).click();
  await grouped.locator('[data-session-id="' + isolated.id + '"]').click();
  assert.equal(await page.locator('.project-group').count(), 1);
  assert.equal(
    (await page.evaluate(() => window.tongzhou.snapshot())).sessions.find(
      (s) => s.id === isolated.id,
    ).archived,
    true,
  );
  checks.push('removed execution workspaces keep archived history under the original project');
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
