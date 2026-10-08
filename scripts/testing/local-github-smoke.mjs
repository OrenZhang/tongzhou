import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/local-github-'));
const bundle = path.join(root, 'fixture.cjs');
const profile = path.join(root, 'profile');
await build({
  stdin: {
    contents: `
    export { Store } from './electron/services/storage/store';
    export { LocalGithubAccounts, readLocalGithubCredential } from './electron/services/accounts/local-github';
    export { setServiceTransport } from './electron/services/network/service-network';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
});
let validIdentity = false,
  validMcp = false;
const requests = [];
const server = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer fixture-local-github-token');
  requests.push(req.url);
  if (req.url === '/user') {
    res.writeHead(validIdentity ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        validIdentity
          ? { id: 42, login: 'local-fixture-user' }
          : { error: 'private fixture-local-github-token' },
      ),
    );
    return;
  }
  if (!validMcp) {
    res.writeHead(403).end('private fixture-local-github-token');
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  if (body.id === undefined) {
    res.writeHead(202).end();
    return;
  }
  const result =
    body.method === 'initialize'
      ? {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'local-fixture', version: '1' },
        }
      : {
          tools: [
            {
              name: 'get_me',
              description: 'Read account',
              inputSchema: { type: 'object' },
              annotations: { readOnlyHint: true, destructiveHint: false },
            },
          ],
        };
  assert.ok(['initialize', 'tools/list'].includes(body.method));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, TONGZHOU_USER_DATA: profile, TONGZHOU_DISABLE_UPDATES: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
let app = await electron.launch({ args: ['.'], env });
try {
  let page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setIgnoreMouseEvents(true);
    window.setFocusable(false);
    window.blur();
  });
  await app.evaluate(
    ({ ipcMain, safeStorage }, config) => {
      const require = process.getBuiltinModule('module').createRequire(config.bundle);
      const {
        Store,
        LocalGithubAccounts,
        readLocalGithubCredential,
        setServiceTransport,
      } = require(config.bundle);
      const store = new Store(config.db, {
        encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
        decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
      });
      setServiceTransport((input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (!['api.github.com', 'api.githubcopilot.com'].includes(url.hostname))
          throw new Error('Unexpected fixture destination');
        return fetch(config.local + url.pathname, init);
      });
      const local = new LocalGithubAccounts(store, {
        read: (source) =>
          readLocalGithubCredential(source, async (command, args, input) => {
            if (source === 'gh') throw new Error('gh fixture unavailable');
            if (
              command !== 'git' ||
              args.at(-1) !== 'fill' ||
              input !== 'protocol=https\nhost=github.com\n\n'
            )
              throw new Error('Invalid fixture credential query');
            return 'protocol=https\nhost=github.com\nusername=123\npassword=fixture-local-github-token\n';
          }),
      });
      ipcMain.removeHandler('tongzhou:detectLocalGithubAccounts');
      ipcMain.removeHandler('tongzhou:enableLocalGithubAccount');
      ipcMain.handle('tongzhou:detectLocalGithubAccounts', () => local.detect());
      ipcMain.handle('tongzhou:enableLocalGithubAccount', (_event, id) => local.enable(id));
    },
    {
      bundle,
      db: path.join(profile, 'tongzhou.db'),
      local: `http://127.0.0.1:${server.address().port}`,
    },
  );
  await page.locator('.sidebar').getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('button', { name: /^内置插件/ }).click();
  await page.getByLabel('搜索插件', { exact: true }).fill('GitHub');
  let card = page
    .locator('.provider-card')
    .filter({ has: page.getByRole('heading', { name: 'GitHub 仓库工具', exact: true }) });
  await card.getByRole('button', { name: '检测本地账号', exact: true }).click();
  await card.getByText('GitHub CLI', { exact: true }).waitFor();
  await card.getByText('· 登录未验证，请检查网络或重新登录', { exact: false }).waitFor();
  assert.equal(await card.getByRole('button', { name: /并启用$/ }).count(), 0);
  validIdentity = true;
  await card.getByRole('button', { name: '重新检测本地账号', exact: true }).click();
  const use = card.getByRole('button', {
    name: '使用 local-fixture-user 的Git 凭据并启用',
    exact: true,
  });
  await use.waitFor();
  assert.equal((await page.evaluate(() => window.tongzhou.snapshot())).connectors.length, 0);
  assert.ok(!(await page.locator('body').innerText()).includes('fixture-local-github-token'));
  await page.screenshot({ path: 'test-results/local-github-detected.png' });
  await use.click();
  await card.getByRole('status').filter({ hasText: '插件连接未通过' }).waitFor();
  assert.equal((await page.evaluate(() => window.tongzhou.snapshot())).connectors.length, 0);
  assert.ok(!(await card.innerText()).includes('fixture-local-github-token'));
  validMcp = true;
  await use.click();
  await card.getByRole('status').filter({ hasText: '已使用 local-fixture-user 启用' }).waitFor();
  const snapshot = await page.evaluate(() => window.tongzhou.snapshot());
  const connector = snapshot.connectors.find((c) => c.localSource === 'git');
  const plugin = snapshot.plugins.find((p) => p.connectorId === connector.id);
  assert.equal(connector.account, 'local-fixture-user');
  assert.ok(connector.hasSecret && plugin.enabled && plugin.hasSecret);
  assert.equal(plugin.catalog[0].name, 'get_me');
  assert.ok(!JSON.stringify(snapshot).includes('fixture-local-github-token'));
  await card.getByRole('button', { name: '检测本地账号', exact: true }).click();
  await use.click();
  await card.getByRole('status').filter({ hasText: '已使用 local-fixture-user 启用' }).waitFor();
  const repeated = await page.evaluate(() => window.tongzhou.snapshot());
  assert.equal(repeated.plugins.filter((p) => p.connectorId === connector.id).length, 1);
  await page.reload();
  await page.locator('.sidebar').getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('button', { name: /^内置插件/ }).click();
  await page.getByLabel('搜索插件', { exact: true }).fill('GitHub');
  await card.getByText('凭据已保存 · 已启用', { exact: false }).waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(820, 700),
  );
  await card.getByRole('button', { name: '检测本地账号', exact: true }).click();
  await use.waitFor();
  assert.ok(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 2));
  await page.screenshot({ path: 'test-results/local-github-narrow.png' });
  await app.close();
  app = await electron.launch({ args: ['.'], env });
  page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setIgnoreMouseEvents(true);
    window.setFocusable(false);
    window.blur();
  });
  await page.locator('.sidebar').getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('button', { name: /^内置插件/ }).click();
  await page.getByLabel('搜索插件', { exact: true }).fill('GitHub');
  card = page
    .locator('.provider-card')
    .filter({ has: page.getByRole('heading', { name: 'GitHub 仓库工具', exact: true }) });
  await card.getByText('凭据已保存 · 已启用', { exact: false }).waitFor();
  const persisted = await page.evaluate(() => window.tongzhou.snapshot());
  assert.ok(persisted.plugins.find((p) => p.id === plugin.id).hasSecret);
  assert.ok(!JSON.stringify(persisted).includes('fixture-local-github-token'));
  assert.ok(requests.includes('/user') && requests.includes('/mcp/'));
  await writeFile(
    'test-results/local-github-report.json',
    JSON.stringify(
      {
        passed: true,
        checks: [
          'metadata-only detection',
          'missing and invalid login states',
          'MCP denial has no saved credentials',
          'verified explicit enable with catalog and account binding',
          'no token in UI or snapshots',
          'repeat enable deduplication',
          'reload and narrow layout',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    'Local GitHub smoke passed: detection, verification, enable, redaction, persistence and layout.',
  );
} catch (error) {
  await (await app.firstWindow()).screenshot({ path: 'test-results/local-github-failure.png' });
  throw error;
} finally {
  await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
