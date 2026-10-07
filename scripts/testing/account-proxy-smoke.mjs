import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/account-proxy-'));
const hosts = [];
const proxy = createServer((_req, res) => res.writeHead(502).end());
proxy.on('connect', (req, socket) => {
  // Clients may reset the deliberately rejected CONNECT tunnel.
  socket.on('error', (error) => {
    if (error.code !== 'ECONNRESET') throw error;
  });
  hosts.push(req.url);
  socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
const callback = createServer((_req, res) => res.end('callback-direct'));
await new Promise((r) => callback.listen(0, '127.0.0.1', r));
await build({
  entryPoints: ['electron/core/codex/codex.ts'],
  outfile: path.join(root, 'codex.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
await build({
  entryPoints: ['electron/services/accounts/account-browser.ts'],
  outfile: path.join(root, 'browser.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});
const { CodexClient } = createRequire(import.meta.url)(path.join(root, 'codex.cjs'));
const client = new CodexClient(path.join(root, 'codex-home'), { mode: 'proxy', proxyUrl });
const checks = [];
let app;
try {
  await client.start();
  await assert.rejects(() => client.request('account/login/start', { type: 'chatgptDeviceCode' }));
  assert.ok(
    hosts.some((h) => h === 'auth.openai.com:443'),
    'bundled Codex login must reach the configured proxy',
  );
  checks.push('real bundled Codex device authorization traverses only the chosen local proxy');
  client.stop();
  const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TONGZHOU_DEV_URL;
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.app-shell');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1250, 900),
  );
  await page.getByRole('button', { name: /^模型与订阅/ }).click();
  await page.getByRole('button', { name: '编辑 OpenAI · ChatGPT', exact: true }).click();
  await page.getByLabel('ChatGPT 网络方式', { exact: true }).selectOption('proxy');
  await page.getByLabel('ChatGPT 独立代理地址', { exact: true }).fill(proxyUrl);
  const browserStart = hosts.length;
  await page.getByRole('button', { name: '保存并测试账号网络', exact: true }).click();
  await page
    .locator('.provider-network-fields [role=status]')
    .filter({ hasText: '账号网络测试失败' })
    .waitFor();
  assert.ok(hosts.slice(browserStart).some((h) => h === 'auth.openai.com:443'));
  const saved = await page.evaluate(() => window.tongzhou.snapshot());
  assert.deepEqual(saved.providers.find((p) => p.id === 'openai-codex').network, {
    mode: 'proxy',
    proxyUrl,
  });
  assert.ok(saved.providers.filter((p) => p.id !== 'openai-codex').every((p) => !p.network));
  await page.screenshot({ path: 'test-results/account-proxy-settings.png' });
  await page.getByRole('button', { name: '前往登录', exact: true }).click();
  await page.getByText('账号网络：独立代理', { exact: true }).waitFor();
  await page.getByRole('button', { name: '配置账号网络', exact: true }).click();
  assert.equal(
    await page.getByLabel('ChatGPT 独立代理地址', { exact: true }).inputValue(),
    proxyUrl,
  );
  checks.push(
    'UI saves per-account settings, verifies routing, displays errors and restores saved values',
  );
  const routing = await app.evaluate(
    async ({ session }, args) => {
      const { createRequire } = process.getBuiltinModule('module');
      const require = createRequire(args.bundle);
      const { AccountBrowser } = require(args.bundle);
      const before = await session.defaultSession.resolveProxy('https://auth.openai.com');
      const accounts = new AccountBrowser({
        get: (_kind, id) => ({
          id,
          name: id,
          protocol: 'codex',
          network: id === 'a' ? { mode: 'proxy', proxyUrl: args.proxyUrl } : { mode: 'direct' },
        }),
      });
      const a = await accounts.networkSession('a'),
        b = await accounts.networkSession('b');
      const selected = await a.resolveProxy('https://auth.openai.com');
      const other = await b.resolveProxy('https://auth.openai.com');
      const local = await (await a.fetch(args.callback)).text();
      const after = await session.defaultSession.resolveProxy('https://auth.openai.com');
      let browserError = '';
      try {
        await accounts.open('https://auth.openai.com/authorize', 'a');
      } catch (e) {
        browserError = String(e);
      }
      accounts.dispose();
      return { before, after, selected, other, local, browserError };
    },
    {
      bundle: path.join(root, 'browser.cjs'),
      proxyUrl,
      callback: `http://127.0.0.1:${callback.address().port}/auth/callback`,
    },
  );
  assert.equal(routing.before, routing.after);
  assert.equal(routing.other, 'DIRECT');
  assert.ok(routing.selected.includes('127.0.0.1:' + proxy.address().port));
  assert.equal(routing.local, 'callback-direct');
  assert.match(routing.browserError, /独立授权页面未能打开/);
  assert.deepEqual(errors, []);
  checks.push(
    'isolated login window, direct peer account, unchanged global session and direct loopback callback',
  );
  await writeFile(
    'test-results/account-proxy-report.json',
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  client.stop();
  if (app) await app.close();
  proxy.closeAllConnections();
  proxy.close();
  callback.closeAllConnections();
  callback.close();
}
