import { openModels } from './navigation-helper.mjs';
import { openModelMenu } from './choice-helper.mjs';
import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/session-entry-'));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const app = await electron.launch({ args: ['.'], env });
const errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.app-shell');
  const builtins = await page.evaluate(async () =>
    (await window.tongzhou.snapshot()).providers.map((p) => ({ id: p.id, enabled: p.enabled })),
  );
  assert.deepEqual(
    builtins,
    ['openai-codex', 'local', 'kimi-account', 'minimax-account'].map((id) => ({
      id,
      enabled: false,
    })),
  );
  assert.equal(await page.getByRole('button', { name: '工作空间', exact: true }).count(), 0);
  await page.getByRole('button', { name: '管理模型', exact: true }).waitFor();
  await page.getByRole('button', { name: '新建普通会话', exact: true }).click();
  await page.getByRole('heading', { name: '新会话', exact: true }).waitFor();
  const emptySession = (await page.evaluate(() => window.tongzhou.snapshot())).sessions[0];
  assert.ok(emptySession?.id, 'ordinary sidebar + creates a session without a model');
  assert.equal(emptySession.projectId, null);
  await page.getByLabel('消息', { exact: true }).fill('无模型时保留草稿');
  assert.equal(
    await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(),
    true,
  );
  const id = await page.evaluate(async () => {
    const base = {
      protocol: 'openai-chat',
      baseUrl: 'http://127.0.0.1:9/v1',
      auth: 'none',
      models: ['fixture'],
      maxOutputTokens: 8192,
      contextChars: 0,
    };
    for (const p of [
      { ...base, id: 'ready', name: '可用服务' },
      { ...base, id: 'key-ready', name: '密钥服务', auth: 'api-key', secret: 'synthetic' },
      { ...base, id: 'key-missing', name: '缺少密钥', auth: 'api-key' },
      { ...base, id: 'disabled', name: '已停用服务', enabled: false },
    ])
      await window.tongzhou.saveProvider(p);
    const session = await window.tongzhou.createSession();
    await window.tongzhou.updateSession(session.id, {
      title: '恢复会话测试',
      providerId: 'ready',
      model: 'fixture',
    });
    return session.id;
  });
  await page.locator(`[data-session-id="${id}"]`).click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="当前连接"]').value === 'ready',
  );
  await page.getByRole('button', { name: '新建普通会话', exact: true }).click();
  await page.getByRole('heading', { name: '新会话', exact: true }).waitFor();
  const selected = await page
    .locator('.ordinary-sessions .session-row.selected .session-title')
    .getAttribute('data-session-id');
  assert.ok(selected && selected !== id && selected !== emptySession.id);
  // Reload checks that the new session and inherited model were persisted.
  await page.reload();
  await page.getByRole('heading', { name: '新会话', exact: true }).waitFor();
  const created = (await page.evaluate(() => window.tongzhou.snapshot())).sessions.find(
    (s) => s.id === selected,
  );
  assert.equal(created.projectId, null);
  assert.equal(created.providerId, 'ready');
  assert.equal(created.model, 'fixture');
  await page.getByLabel('消息', { exact: true }).fill('有模型时可发送');
  assert.equal(
    await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(),
    false,
  );
  await page.locator(`[data-session-id="${id}"]`).click();
  await openModelMenu(page);
  await page.getByLabel('当前连接', { exact: true }).click();
  const options = await page
    .locator('.choice-panel [role="menuitemradio"]')
    .evaluateAll((nodes) => nodes.map((n) => n.dataset.value));
  await page.keyboard.press('Escape');
  assert.deepEqual(options.sort(), ['key-ready', 'ready']);
  await page.getByLabel('消息', { exact: true }).fill('保留这份草稿');
  await openModels(page);
  await page.getByRole('button', { name: '编辑 可用服务', exact: true }).click();
  await page.locator('.thinking-settings > summary').click();
  assert.equal(await page.getByLabel('模型思考', { exact: true }).inputValue(), 'on');
  await page.getByLabel('模型思考', { exact: true }).selectOption('off');
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  assert.equal(
    (await page.evaluate(() => window.tongzhou.snapshot())).providers.find((p) => p.id === 'ready')
      .thinkingEnabled,
    false,
  );
  await page.getByRole('button', { name: '编辑 可用服务', exact: true }).click();
  await page.locator('.thinking-settings > summary').click();
  assert.equal(await page.getByLabel('模型思考', { exact: true }).inputValue(), 'off');
  await page.getByLabel('模型思考', { exact: true }).selectOption('on');
  await page.locator('.thinking-settings').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/model-thinking-settings.png' });
  await page.getByRole('button', { name: '保存连接', exact: true }).click();
  // Status text and controls must stay in the two-row layout, including when
  // the endpoint column is hidden. Horizontal-overflow checks alone miss this.
  const originalTheme = await page.locator('html').getAttribute('data-theme');
  for (const width of [1440, 1000, 900]) {
    await app.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(800, 600);
      window.setContentSize(width, 900);
    }, width);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await page.screenshot({
        path: `test-results/connections-${width}-${theme}.png`,
        animations: 'disabled',
      });
      const failures = await page
        .locator('.model-connections > .provider-card')
        .evaluateAll((cards) =>
          cards.flatMap((card) => {
            const row = card.getBoundingClientRect();
            const status = card.querySelector('.provider-availability > .muted');
            const text = status.getBoundingClientRect();
            const toggle = card.querySelector('.switch-control').getBoundingClientRect();
            const edit = card.querySelector('.card-top > .icon-button').getBoundingClientRect();
            return row.height > 90 ||
              text.height > 22 ||
              status.scrollWidth > status.clientWidth + 1 ||
              text.right > toggle.left ||
              toggle.right > edit.left ||
              edit.right > row.right ||
              toggle.top < row.top ||
              toggle.bottom > row.bottom
              ? [card.querySelector('h3').textContent]
              : [];
          }),
        );
      assert.deepEqual(failures, [], `connection row layout at ${width}px (${theme})`);
    }
  }
  await page.evaluate((theme) => {
    document.documentElement.dataset.theme = theme;
  }, originalTheme);
  await page.getByRole('switch', { name: '启用连接 可用服务', exact: true }).uncheck();
  await page.waitForFunction(
    async () =>
      (await window.tongzhou.snapshot()).providers.find((p) => p.id === 'ready').enabled === false,
  );
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  await page.getByText('可用服务：已停用', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('当前连接', { exact: true }).getAttribute('data-value'), '');
  assert.equal(
    await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    (await page.evaluate(() => window.tongzhou.snapshot())).sessions.find((s) => s.id === id)
      .providerId,
    'ready',
  );
  await page.reload();
  await page.getByRole('heading', { name: '恢复会话测试', exact: true }).waitFor();
  assert.equal(await page.getByLabel('消息', { exact: true }).inputValue(), '保留这份草稿');
  await page.getByText('可用服务：已停用', { exact: true }).waitFor();
  await openModels(page);
  await page.getByRole('switch', { name: '启用连接 可用服务', exact: true }).check();
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="当前连接"]').value === 'ready',
  );
  await page.screenshot({ path: 'test-results/session-entry.png' });
  for (const section of ['项目空间', '普通会话']) {
    const toggle = page.getByRole('button', { name: new RegExp(`^${section}`) });
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  }
  await page.reload();
  await page.waitForSelector('.app-shell');
  assert.equal(
    await page.getByRole('button', { name: /^普通会话/ }).getAttribute('aria-expanded'),
    'false',
  );
  await page.getByLabel('搜索会话', { exact: true }).fill('恢复');
  await page.locator(`[data-session-id="${id}"]`).waitFor();
  await page.getByLabel('搜索会话', { exact: true }).fill('');
  assert.equal(
    await page.getByRole('button', { name: /^普通会话/ }).getAttribute('aria-expanded'),
    'false',
  );
  await page.getByRole('button', { name: /^普通会话/ }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await openModelMenu(page);
    await page.getByRole('button', { name: '当前连接', exact: true }).click();
    await page.getByLabel('搜索当前连接', { exact: true }).fill('可用');
    assert.equal(await page.locator('.choice-panel [role="menuitemradio"]').count(), 1);
    await page.keyboard.press('ArrowDown');
    assert.equal(
      await page.evaluate(() => document.activeElement.getAttribute('role')),
      'menuitemradio',
    );
    const box = await page.locator('.choice-panel').boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    assert.ok(
      box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width &&
        box.y + box.height <= viewport.height,
    );
    await page
      .locator('.choice-panel')
      .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await page.screenshot({ path: `test-results/choice-menu-${theme}.png` });
    await page.keyboard.press('Escape');
    assert.equal(
      await page
        .getByRole('button', { name: '当前连接', exact: true })
        .getAttribute('aria-expanded'),
      'false',
    );
  }
  await page.evaluate((id) => window.tongzhou.updateSession(id, { archived: true }), id);
  await page.reload();
  await page.waitForSelector('.welcome');
  await page.waitForFunction(() => !localStorage.getItem('tongzhou-last-session'));
  assert.equal(await page.getByRole('heading', { name: '恢复会话测试', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  await writeFile(
    'test-results/session-entry-report.json',
    JSON.stringify(
      {
        passed: true,
        checks: [
          'conversation-first navigation',
          'ordinary sidebar + creates sessions with and without an available model',
          'credential and enable filtering',
          'compact provider rows and controls at 1440/1000/900px in light/dark themes',
          'disabled selection preserved without silent fallback',
          'restore session and draft after reload',
          'archived session skipped',
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    'Session entry smoke passed: readiness filtering, enable controls, session/draft restoration, archived fallback.',
  );
} finally {
  await app.close();
}
