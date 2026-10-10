import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/wecom-onboarding-'));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const app = await electron.launch({ args: ['.'], env });
const live = process.argv.includes('--live');
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(20_000);
  await page.waitForSelector('.app-shell');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setIgnoreMouseEvents(true);
    window.setFocusable(false);
    window.blur();
  });
  if (!live)
    await app.evaluate(() => {
      const original = globalThis.fetch;
      globalThis.wecomSmoke = { phase: 'init', requests: [] };
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (!url.startsWith('https://work.weixin.qq.com/ai/qc/')) return original(input, init);
        globalThis.wecomSmoke.requests.push({
          url,
          agent: new Headers(init.headers).get('User-Agent'),
        });
        const data = url.includes('/generate?')
          ? { scode: 'fixture-poll', auth_url: 'https://work.weixin.qq.com/ai/qc/auth?fixture=1' }
          : globalThis.wecomSmoke.phase === 'success'
            ? {
                status: 'success',
                bot_info: { botid: 'fixture-qr-bot', secret: 'fixture-qr-secret' },
              }
            : { status: globalThis.wecomSmoke.phase };
        return new Response(JSON.stringify({ data }));
      };
    });
  await page.locator('.sidebar').getByRole('button', { name: '渠道', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const openQr = async () => {
    await page.getByRole('button', { name: '添加企业微信渠道', exact: true }).click();
    await page.getByRole('button', { name: '连接企业微信', exact: true }).click();
    await dialog.getByRole('button', { name: /扫码接入/ }).click();
    await dialog.getByAltText('企业微信机器人授权二维码').waitFor();
  };
  await openQr();
  await page.screenshot({ path: `test-results/wecom-qr-${live ? 'live' : 'fixture'}.png` });
  if (!live) {
    await app.evaluate(() => {
      globalThis.wecomSmoke.phase = 'expired';
    });
    await dialog.getByRole('status').filter({ hasText: '二维码已过期' }).waitFor();
    assert.equal(await dialog.locator('img').count(), 0);
    await app.evaluate(() => {
      globalThis.wecomSmoke.phase = 'init';
    });
    await dialog.getByRole('button', { name: '重新获取二维码', exact: true }).click();
    await dialog.getByAltText('企业微信机器人授权二维码').waitFor();
    await app.evaluate(() => {
      globalThis.wecomSmoke.phase = 'success';
    });
    await dialog.getByRole('button', { name: '配置渠道', exact: true }).click();
    assert.equal(await dialog.getByLabel('Bot ID', { exact: true }).inputValue(), 'fixture-qr-bot');
    assert.equal(await dialog.getByLabel('应用密钥（留空保留）', { exact: true }).inputValue(), '');
    const snapshot = await page.evaluate(() => window.tongzhou.snapshot());
    const bot = snapshot.bots.find((b) => b.appId === 'fixture-qr-bot');
    assert.equal(bot.hasSecret, true);
    assert.equal('enabled' in bot, false);
    assert.equal('allowExecute' in bot, false);
    assert.deepEqual(bot.allowedSenders, []);
    assert.ok(!JSON.stringify(snapshot).includes('fixture-qr-secret'));
    const requests = await app.evaluate(() => globalThis.wecomSmoke.requests);
    assert.ok(requests.some((r) => r.url.endsWith('/generate?source=tongzhou')));
    assert.ok(requests.every((r) => r.agent.startsWith('Tongzhou/')));
    const database = new DatabaseSync(path.join(root, 'profile/tongzhou.db'), { readOnly: true });
    try {
      const saved = database.prepare('SELECT value FROM secrets WHERE id = ?').get('bot_' + bot.id);
      assert.ok(saved);
      assert.ok(!String(saved.value).includes('fixture-qr-secret'));
    } finally {
      database.close();
    }
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await app.evaluate(() => {
      globalThis.wecomSmoke.phase = 'init';
    });
    await openQr();
  }
  const pending = await page.evaluate(
    async () =>
      (await window.tongzhou.snapshot()).channelAuth.find((a) => a.phase === 'waiting')?.id,
  );
  assert.ok(pending);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.waitForFunction(
    async (id) =>
      (await window.tongzhou.snapshot()).channelAuth.find((a) => a.id === id)?.phase ===
      'cancelled',
    pending,
  );
  assert.deepEqual(errors, []);
  await writeFile(
    `test-results/wecom-onboarding-${live ? 'live' : 'fixture'}.json`,
    JSON.stringify(
      {
        passed: true,
        live,
        checks: live
          ? ['real QR retrieval', 'waiting state', 'cancellation']
          : [
              'platform IPC',
              'expiration',
              'retry',
              'authorization',
              'encrypted persistence',
              'secret-free snapshot',
              'Tongzhou identity',
              'cancellation',
            ],
      },
      null,
      2,
    ),
  );
  console.log(`WeCom onboarding ${live ? 'live QR' : 'fixture end-to-end'} passed.`);
} catch (error) {
  await app
    .windows()[0]
    ?.screenshot({ path: 'test-results/wecom-onboarding-failure.png' })
    .catch(() => {});
  throw error;
} finally {
  await app.close();
}
