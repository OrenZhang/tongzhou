import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/ui-'));
const projectPath = path.join(root, '示例项目');
await mkdir(projectPath);
await writeFile(path.join(projectPath, 'README.md'), '# 示例项目\n\n这是完全独立的 UI 测试项目。');
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
store.put('project', {
  id: 'ui-project',
  name: '同舟示例项目',
  path: projectPath,
  createdAt: Date.now(),
});
for (const [id, name, protocol, models] of [
  ['ui-deepseek', 'DeepSeek · 团队连接', 'openai-chat', ['deepseek-chat', 'deepseek-reasoner']],
  ['ui-openai', 'OpenAI · API', 'openai-responses', ['gpt-example']],
  ['ui-anthropic', 'Anthropic · 开发环境', 'anthropic', ['claude-example']],
])
  store.saveProvider({
    id,
    name,
    protocol,
    models,
    auth: 'none',
    baseUrl: 'https://example.invalid/v1',
    maxOutputTokens: 16384,
    contextChars: 0,
  });
for (const [id, name, description] of [
  ['ui-review', '代码审查', '检查改动、测试覆盖和可维护性'],
  ['ui-writing', '写作助手', '梳理结构，让表达清楚有条理'],
  ['ui-analysis', '问题分析', '从现象到证据，一起定位问题'],
])
  store.put('agent', {
    id,
    name,
    description,
    instructions:
      '先理解当前请求，结合事实提供清晰的建议。需要核验时说明依据。保留已有工作，并验证修改。',
    providerId: '',
    model: '',
    permission: 'read-only',
    maxSteps: 24,
  });
store.put('plugin', {
  id: 'ui-plugin',
  name: '文档检索',
  transport: 'http',
  command: '',
  args: [],
  url: 'https://example.invalid/mcp',
  enabled: false,
  readOnlyTools: [],
  catalog: [{ name: 'search_docs', description: '搜索项目文档', inputSchema: {} }],
});
store.put('skill', {
  id: 'ui-skill',
  name: '项目规范',
  description: '让代码审查和测试遵循统一标准。',
  instructions: '先读项目说明，再开始修改。',
  enabled: false,
  files: {},
});
store.put('connector', {
  id: 'ui-git',
  name: 'GitHub · 示例账号',
  kind: 'github',
  enabled: false,
  baseUrl: 'https://github.com',
  status: 'unknown',
});
store.put('connector', {
  id: 'ui-browser',
  name: '独立浏览器',
  kind: 'browser',
  enabled: false,
  baseUrl: 'https://example.invalid',
});
store.put('channel', {
  id: 'ui-channel',
  name: '飞书 · 项目通知',
  kind: 'feishu',
  enabled: false,
  status: 'unknown',
});
store.put('notificationRule', {
  id: 'ui-rule',
  channelId: 'ui-channel',
  sessionId: null,
  enabled: false,
  once: false,
  events: ['completed', 'failed'],
  template: '{title} · {status}',
});
const sessions = [];
for (const [title, projectId, status] of [
  ['整理产品设计思路', null, 'completed'],
  ['检查项目结构与改进建议', 'ui-project', 'completed'],
  ['网络中断后的任务', 'ui-project', 'failed'],
]) {
  const session = {
    ...store.createSession(projectId),
    title,
    providerId: 'ui-deepseek',
    model: 'deepseek-chat',
  };
  store.put('session', session);
  sessions.push(session);
  const runId = 'run-' + session.id;
  store.put('run', {
    id: runId,
    sessionId: session.id,
    providerId: session.providerId,
    model: session.model,
    agentName: '同舟',
    status,
    startedAt: Date.now() - 30000,
    endedAt: Date.now() - 12000,
    inputTokens: 2140,
    outputTokens: 460,
    usageReported: true,
  });
  store.message({
    id: 'ask-' + session.id,
    sessionId: session.id,
    runId,
    role: 'user',
    content: title,
    createdAt: Date.now() - 30000,
    sequence: 1,
  });
  store.message({
    id: 'reply-' + session.id,
    sessionId: session.id,
    runId,
    role: 'assistant',
    model: session.model,
    content:
      '可以。先把目标和现状放在一起看。\n\n**建议从最常用的操作开始：**\n\n- 会话内容是中心，设置和工具按需展开。\n- 重要状态用清晰的文字表达，保持阅读连续。\n- 每次调整都保留原有记录，并验证结果。\n\n下一步可以先验证一个完整的使用场景。',
    createdAt: Date.now() - 12000,
    sequence: 3,
    status: 'complete',
  });
  store.put('runEvent', {
    id: 'event-' + session.id,
    sessionId: session.id,
    runId,
    type: 'reasoning',
    seq: 2,
    time: Date.now() - 28000,
    text: '先核对当前目标，再整理与任务相关的建议。',
  });
}
store.close();
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
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(12000);
  await page.waitForSelector('.welcome');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => w.setIgnoreMouseEvents(true)),
  );
  const nav = (name) => page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
  const capture = async (name) => {
    const file = `test-results/ui-${name}.png`;
    await page.screenshot({ path: file, animations: 'disabled' });
    screens.push(file);
    const overflow = await page.evaluate(() => ({
      root: document.documentElement.scrollWidth > innerWidth + 1,
      pages: [...document.querySelectorAll('.page, .conversation, .modal')]
        .filter((e) => e.getClientRects().length)
        .filter((e) => e.scrollWidth > e.clientWidth + 2)
        .map((e) => e.className),
    }));
    assert.deepEqual(overflow, { root: false, pages: [] }, `horizontal overflow on ${name}`);
  };
  const shortcut = process.platform === 'darwin' ? 'Meta+k' : 'Control+k';
  await page.keyboard.press(shortcut);
  await page.getByRole('combobox', { name: '搜索操作或会话' }).focus();
  await page.keyboard.press('Tab');
  assert.equal(
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '关闭', exact: true })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  await page.keyboard.press('Tab');
  await page.getByRole('combobox', { name: '搜索操作或会话' }).fill('连接中心');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: '连接中心', exact: true }).waitFor();
  checks.push('keyboard command search opens the selected real module');
  await page.getByLabel('搜索模型连接', { exact: true }).fill('does-not-exist');
  await page.getByText('没有匹配的连接，试试其他关键词。', { exact: true }).waitFor();
  assert.equal(await page.locator('.model-connections .provider-card').count(), 0);
  await page.getByLabel('搜索模型连接', { exact: true }).fill('DeepSeek');
  assert.equal(await page.locator('.model-connections .provider-card').count(), 1);
  await page.getByLabel('搜索模型连接', { exact: true }).fill('');
  await page.getByRole('button', { name: '编辑 DeepSeek · 团队连接', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).waitFor();
  const controls = page
    .getByRole('dialog')
    .locator(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
    );
  await controls.last().focus();
  await page.keyboard.press('Tab');
  assert.equal(
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '关闭', exact: true })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(
    await page
      .getByRole('button', { name: '编辑 DeepSeek · 团队连接', exact: true })
      .evaluate((e) => e === document.activeElement),
    true,
  );
  checks.push('provider search, modal tab containment, escape and focus restoration');
  await nav('工作空间');
  assert.equal(await page.locator('.context-panel').count(), 0);
  await page.locator(`[data-session-id="${sessions[1].id}"]`).click();
  await page.getByRole('button', { name: '关闭项目面板', exact: true }).click();
  assert.equal(await page.locator('.context-panel').count(), 0);
  await page.getByRole('button', { name: '收起导航', exact: true }).click();
  assert.equal(await page.locator('.sidebar').getAttribute('inert'), '');
  await page.reload();
  await page.waitForSelector('.welcome');
  assert.equal(await page.locator('.sidebar').getAttribute('inert'), '');
  await page.getByRole('button', { name: '展开导航', exact: true }).click();
  await page.locator(`[data-session-id="${sessions[1].id}"]`).click();
  assert.equal(await page.locator('.context-panel').count(), 0);
  await page.getByRole('button', { name: '展开项目面板', exact: true }).click();
  await page.locator('.context-panel').waitFor();
  checks.push('ordinary chat has no empty inspector; both panels toggle and persist');
  await nav('运行记录');
  await page.getByLabel('筛选运行状态', { exact: true }).selectOption('failed');
  assert.equal(await page.locator('.table-row').count(), 1);
  await page.getByLabel('搜索运行记录', { exact: true }).fill('no-such-task');
  await page.getByText('没有符合条件的运行记录', { exact: true }).waitFor();
  await page.getByLabel('搜索运行记录', { exact: true }).fill('');
  await page.getByLabel('筛选运行状态', { exact: true }).selectOption('all');
  checks.push('activity status and title filters, including empty results');
  for (const [width, height] of [
    [1440, 900],
    [1000, 700],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size),
      [width, height],
    );
    await nav('工作空间');
    await page.locator(`[data-session-id="${sessions[0].id}"]`).click();
    await page.locator('.turn-final').waitFor();
    assert.equal(await page.locator('.context-panel').count(), 0);
    const textSize = await page
      .locator('.turn-final .markdown')
      .evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    assert.ok(textSize >= 15);
    await capture(`${width}-chat`);
    await page.locator(`[data-session-id="${sessions[1].id}"]`).click();
    await page.locator('.context-panel').waitFor();
    await page.locator('.turn-final').waitFor();
    await capture(`${width}-project`);
    await nav('连接中心');
    await capture(`${width}-connections`);
    await page.getByRole('button', { name: '添加连接', exact: true }).click();
    await capture(`${width}-connection-editor`);
    await page.keyboard.press('Escape');
    for (const [label, name] of [
      ['服务与浏览器', 'accounts'],
      ['渠道通知', 'channels'],
      ['认证与发送记录', 'records'],
    ]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await capture(`${width}-${name}`);
    }
    await nav('Agent 团队');
    await capture(`${width}-agents`);
    await nav('插件与工具');
    await capture(`${width}-core`);
    await page.getByRole('button', { name: /^MCP 插件/ }).click();
    await capture(`${width}-mcp`);
    await page.getByRole('button', { name: /^Skills/ }).click();
    await capture(`${width}-skills`);
    await nav('运行记录');
    await capture(`${width}-activity`);
    await nav('设置与关于');
    await capture(`${width}-settings`);
    await page.keyboard.press(shortcut);
    await page.getByRole('combobox', { name: '搜索操作或会话' }).fill('项目');
    await capture(`${width}-commands`);
    await page.keyboard.press('Escape');
  }
  await nav('插件与工具');
  await page.getByRole('button', { name: /^MCP 插件/ }).click();
  await page.getByRole('checkbox', { name: '启用 文档检索', exact: true }).click();
  await page.waitForFunction(
    async () =>
      (await window.tongzhou.snapshot()).plugins.find((p) => p.id === 'ui-plugin')?.enabled ===
      true,
  );
  await page.locator('input[aria-label="启用 文档检索"]:checked:not(:disabled)').waitFor();
  await page.getByRole('checkbox', { name: '启用 文档检索', exact: true }).click();
  await page.waitForFunction(
    async () =>
      (await window.tongzhou.snapshot()).plugins.find((p) => p.id === 'ui-plugin')?.enabled ===
      false,
  );
  await page.locator('input[aria-label="启用 文档检索"]:not(:checked):not(:disabled)').waitFor();
  checks.push('MCP list switch saves enabled and disabled states');
  const colors = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      ['--muted', '--secondary-text', '--teal', '--canvas'].map((key) => [
        key,
        styles.getPropertyValue(key).trim(),
      ]),
    );
  });
  const luminance = (hex) =>
    hex
      .replace('#', '')
      .match(/../g)
      .map((c) => parseInt(c, 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((total, c, i) => total + c * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a, b) =>
    (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  assert.ok(contrast(colors['--muted'], colors['--canvas']) >= 4.5);
  assert.ok(contrast(colors['--teal'], '#ffffff') >= 4.5);
  assert.deepEqual(errors, []);
  checks.push(
    'all major screens at 1440×900 and 1000×700 without horizontal overflow',
    '15px chat text and 4.5:1 normal-text contrast tokens',
    'no renderer errors',
  );
  await writeFile(
    'test-results/ui-report.json',
    JSON.stringify(
      { passed: true, packaged: Boolean(executablePath), checks, screenshots: screens },
      null,
      2,
    ),
  );
  console.log(
    'UI smoke passed: navigation, search, focus, panels, filters, all module layouts and contrast.',
  );
} catch (error) {
  await app
    .windows()[0]
    ?.screenshot({ path: 'test-results/ui-failure.png' })
    .catch(() => {});
  throw error;
} finally {
  await app.close();
}
