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
  assert.equal(await page.getByRole('button', { name: '工作空间', exact: true }).count(), 0);
  await page.getByRole('button', { name: '管理模型与订阅', exact: true }).waitFor();
  await page.getByRole('button', { name: /开启新会话/ }).click();
  await page.getByRole('heading', { name: '新会话', exact: true }).waitFor();
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
  const options = await page
    .getByLabel('当前连接', { exact: true })
    .locator('option')
    .evaluateAll((nodes) => nodes.map((n) => n.value).filter(Boolean));
  assert.deepEqual(options.sort(), ['key-ready', 'ready']);
  await page.getByLabel('消息', { exact: true }).fill('保留这份草稿');
  await page.getByRole('button', { name: '模型与订阅', exact: true }).click();
  await page.getByRole('switch', { name: '启用连接 可用服务', exact: true }).uncheck();
  await page.waitForFunction(
    async () =>
      (await window.tongzhou.snapshot()).providers.find((p) => p.id === 'ready').enabled === false,
  );
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  await page.getByText('可用服务：已停用', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('当前连接', { exact: true }).inputValue(), '');
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
  await page.getByRole('button', { name: '模型与订阅', exact: true }).click();
  await page.getByRole('switch', { name: '启用连接 可用服务', exact: true }).check();
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="当前连接"]').value === 'ready',
  );
  await page.screenshot({ path: 'test-results/session-entry.png' });
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
          'credential and enable filtering',
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
