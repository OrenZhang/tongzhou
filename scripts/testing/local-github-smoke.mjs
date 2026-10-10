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
    export { LocalGitlabAccounts, readLocalGitlabCredential } from './electron/services/accounts/local-gitlab';
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
  validMcp = false,
  validGitlab = true;
let deviceTokensReady = false;
const requests = [];
const server = createServer(async (req, res) => {
  if (req.url?.startsWith('/login/')) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const params = new URLSearchParams(raw);
    assert.equal(params.get('client_id'), 'tongzhou-fixture-client');
    assert.equal(params.has('client_secret'), false);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        req.url === '/login/device/code'
          ? {
              device_code: 'fixture-device-secret',
              user_code: 'ABCD-EFGH',
              verification_uri: 'https://github.com/login/device',
              expires_in: 900,
              interval: 5,
            }
          : deviceTokensReady
            ? {
                access_token: 'fixture-local-github-token',
                token_type: 'Bearer',
                refresh_token: 'fixture-refresh-secret',
                expires_in: 28800,
              }
            : { error: 'authorization_pending' },
      ),
    );
    return;
  }
  if (req.url === '/api/v4/user') {
    assert.equal(req.headers.authorization, 'Bearer fixture-local-gitlab-token');
    requests.push(req.url);
    res.writeHead(validGitlab ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        validGitlab
          ? { id: 42, username: 'local-gitlab-user' }
          : { message: 'fixture-local-gitlab-token' },
      ),
    );
    return;
  }
  if (req.url?.startsWith('/api/v4/projects')) {
    assert.equal(req.headers.authorization, 'Bearer fixture-local-gitlab-token');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ id: 1, name: 'Fixture' }]));
    return;
  }
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
env.TONGZHOU_GITHUB_CLIENT_ID = 'tongzhou-fixture-client';
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
    ({ ipcMain, safeStorage, session, shell }, config) => {
      shell.openExternal = async (url) => {
        if (url !== 'https://github.com/login/device')
          throw new Error('Unexpected browser destination');
      };
      const require = process.getBuiltinModule('module').createRequire(config.bundle);
      const {
        Store,
        LocalGithubAccounts,
        readLocalGithubCredential,
        LocalGitlabAccounts,
        readLocalGitlabCredential,
        setServiceTransport,
      } = require(config.bundle);
      const store = new Store(config.db, {
        encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
        decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
      });
      const route = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (
          ![
            'api.github.com',
            'github.com',
            'api.githubcopilot.com',
            'gitlab.com',
            'gitlab.fixture.example',
          ].includes(url.hostname)
        )
          throw new Error('Unexpected fixture destination');
        return fetch(config.local + url.pathname + url.search, init);
      };
      setServiceTransport(route);
      // Exercise the real plugin save/check handlers without sending fixture secrets externally.
      session.fromPartition('tongzhou-service-network').fetch = route;
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
      const gitlab = new LocalGitlabAccounts(store, {
        read: (source, baseUrl) =>
          readLocalGitlabCredential(
            source,
            baseUrl,
            async (command, args, input, includeStderr) => {
              const host = new URL(baseUrl).host;
              if (source === 'git') {
                if (command !== 'git' || input !== `protocol=https\nhost=${host}\n\n`)
                  throw new Error('Invalid GitLab fixture query');
                return `protocol=https\nhost=${host}\npassword=fixture-local-gitlab-token\n`;
              }
              if (command !== 'glab' || args[3] !== host || !includeStderr)
                throw new Error('Invalid CLI fixture query');
              return `${host}\n  ✓ Token found in keyring: fixture-local-gitlab-token\n`;
            },
          ),
      });
      ipcMain.removeHandler('tongzhou:detectLocalGitlabAccounts');
      ipcMain.removeHandler('tongzhou:useLocalGitlabAccount');
      ipcMain.handle('tongzhou:detectLocalGitlabAccounts', (_event, url) => gitlab.detect(url));
      ipcMain.handle('tongzhou:useLocalGitlabAccount', (_event, id) => gitlab.use(id));
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
  await card.getByText('连接已验证 · 已启用', { exact: false }).waitFor();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(820, 700),
  );
  await card.getByRole('button', { name: '管理连接', exact: true }).click();
  const githubDialog = page.getByRole('dialog');
  assert.equal(
    await githubDialog.getByLabel('认证方式', { exact: true }).locator('option').count(),
    2,
  );
  await githubDialog.getByLabel('认证方式', { exact: true }).selectOption('oauth');
  assert.equal(await githubDialog.getByText('GitHub OAuth2 应用配置', { exact: true }).count(), 0);
  assert.equal(await githubDialog.locator('input[type="password"]').count(), 0);
  await githubDialog.getByRole('button', { name: '使用 GitHub 登录', exact: true }).waitFor();
  await githubDialog.getByRole('button', { name: '使用 GitHub 登录', exact: true }).click();
  await githubDialog.getByText('ABCD-EFGH', { exact: true }).waitFor();
  assert.ok(!(await githubDialog.innerText()).includes('fixture-device-secret'));
  deviceTokensReady = true;
  await githubDialog.getByText('✓ 已授权', { exact: true }).waitFor();
  await githubDialog.getByText('GitHub · local-fixture-user', { exact: true }).waitFor();
  await githubDialog.getByRole('button', { name: '保存并检查', exact: true }).click();
  await githubDialog.getByText('✓ 插件连接检查通过', { exact: true }).waitFor();
  await githubDialog.getByText('GitHub · local-fixture-user', { exact: true }).waitFor();
  const oauthSnapshot = await page.evaluate(() => window.tongzhou.snapshot());
  assert.ok(!JSON.stringify(oauthSnapshot).includes('fixture-refresh-secret'));
  await githubDialog.getByRole('button', { name: '退出授权', exact: true }).click();
  assert.equal(await githubDialog.getByLabel('访问令牌（留空保留）', { exact: true }).count(), 0);
  await githubDialog.getByLabel('认证方式', { exact: true }).selectOption('headers');
  await githubDialog.getByLabel('Token 来源', { exact: true }).selectOption(plugin.connectorId);
  await githubDialog.getByRole('button', { name: '保存并检查', exact: true }).click();
  await githubDialog.getByText('✓ 插件连接检查通过', { exact: true }).waitFor();
  await githubDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await card.getByRole('button', { name: '检测本地账号', exact: true }).click();
  await use.waitFor();
  assert.ok(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 2));
  await page.screenshot({ path: 'test-results/local-github-narrow.png' });
  await page.getByLabel('搜索插件', { exact: true }).fill('GitLab');
  const gitlabCard = page
    .locator('.provider-card')
    .filter({ has: page.getByRole('heading', { name: 'GitLab 仓库工具', exact: true }) });
  await gitlabCard.getByRole('button', { name: '检测本地账号', exact: true }).click();
  await gitlabCard
    .getByRole('button', { name: '使用 local-gitlab-user 的GitLab CLI并配置', exact: true })
    .waitFor();
  const instance = gitlabCard.getByLabel('检测 GitLab 实例', { exact: true });
  await instance.fill('https://gitlab.fixture.example:8443');
  assert.equal(
    await gitlabCard.getByRole('button', { name: /并配置$/ }).count(),
    0,
    'changing instances clears old candidates',
  );
  await gitlabCard.getByRole('button', { name: '检测本地账号', exact: true }).click();
  await gitlabCard
    .getByRole('button', { name: '使用 local-gitlab-user 的GitLab CLI并配置', exact: true })
    .waitFor();
  assert.ok(!(await gitlabCard.innerText()).includes('fixture-local-gitlab-token'));
  assert.ok(await gitlabCard.evaluate((el) => el.scrollWidth <= el.clientWidth + 2));
  await page.screenshot({ path: 'test-results/local-gitlab-detected.png' });
  await gitlabCard
    .getByRole('button', { name: '使用 local-gitlab-user 的Git 凭据并配置', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('heading', { name: '连接 GitLab · local-gitlab-user（本地）', exact: true })
    .waitFor();
  assert.equal(
    await dialog.getByLabel('GitLab 实例地址', { exact: true }).inputValue(),
    'https://gitlab.fixture.example:8443',
  );
  assert.equal(await dialog.getByLabel('认证方式', { exact: true }).inputValue(), 'headers');
  assert.equal(await dialog.getByRole('button', { name: '浏览器授权', exact: true }).count(), 0);
  assert.equal(
    await dialog.getByRole('checkbox', { name: '在会话中启用此插件', exact: true }).isChecked(),
    false,
  );
  assert.equal(await dialog.getByLabel('检测 GitLab 实例', { exact: true }).count(), 0);
  await dialog.getByRole('button', { name: '检测本地账号', exact: true }).click();
  await dialog
    .getByRole('button', { name: '使用 local-gitlab-user 的GitLab CLI并配置', exact: true })
    .waitFor();
  await dialog.getByLabel('GitLab 实例地址', { exact: true }).fill('https://gitlab.com');
  assert.equal(await dialog.getByRole('button', { name: /并配置$/ }).count(), 0);
  await dialog
    .getByLabel('GitLab 实例地址', { exact: true })
    .fill('https://gitlab.fixture.example:8443');
  await dialog.getByRole('button', { name: '检测本地账号', exact: true }).click();
  await dialog
    .getByRole('button', { name: '使用 local-gitlab-user 的Git 凭据并配置', exact: true })
    .click();
  await dialog
    .getByText('本地账号已保存。可点击「保存并检查」验证 Token 工具连接，再启用插件。')
    .waitFor();
  assert.equal(
    await dialog.getByLabel('GitLab 实例地址', { exact: true }).inputValue(),
    'https://gitlab.fixture.example:8443',
  );
  assert.ok(!(await dialog.innerText()).includes('fixture-local-gitlab-token'));
  assert.equal(await dialog.getByLabel('认证方式', { exact: true }).locator('option').count(), 2);
  await dialog.getByRole('button', { name: '保存并检查', exact: true }).click();
  await dialog.getByText('✓ 插件连接检查通过', { exact: true }).waitFor();
  let checkedGitlab = (await page.evaluate(() => window.tongzhou.snapshot())).plugins.find(
    (p) => p.name === 'GitLab · local-gitlab-user（本地）',
  );
  assert.deepEqual(
    checkedGitlab.catalog.map((t) => t.name),
    ['gitlab_api_read', 'gitlab_api_write'],
  );
  validGitlab = false;
  await dialog.getByRole('button', { name: '保存并检查', exact: true }).click();
  await dialog.getByText('GitLab Token 已失效或无效，请更新认证', { exact: false }).waitFor();
  checkedGitlab = (await page.evaluate(() => window.tongzhou.snapshot())).plugins.find(
    (p) => p.id === checkedGitlab.id,
  );
  assert.equal(checkedGitlab.catalog, undefined, 'failed recheck invalidates stale verified tools');
  validGitlab = true;
  await dialog.getByLabel('认证方式', { exact: true }).selectOption('oauth');
  assert.equal(
    await dialog.getByRole('button', { name: '使用 GitLab 登录', exact: true }).count(),
    1,
  );
  assert.equal(await dialog.getByText('高级：使用已注册的 OAuth 应用', { exact: true }).count(), 0);
  assert.equal(await dialog.getByLabel('预注册 Client ID（可选）', { exact: true }).count(), 0);
  assert.equal(await dialog.getByLabel('访问令牌（留空保留）', { exact: true }).count(), 0);
  await dialog.getByLabel('认证方式', { exact: true }).selectOption('headers');
  await dialog.getByLabel('Token 来源', { exact: true }).selectOption(checkedGitlab.connectorId);
  await dialog.getByRole('button', { name: '保存并检查', exact: true }).click();
  await dialog.getByText('✓ 插件连接检查通过', { exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/local-gitlab-dialog.png' });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  const gitlabState = await page.evaluate(() => window.tongzhou.snapshot());
  const gitlabAccount = gitlabState.connectors.find((c) => c.kind === 'gitlab');
  const gitlabPlugin = gitlabState.plugins.find(
    (p) => p.name === 'GitLab · local-gitlab-user（本地）',
  );
  assert.ok(gitlabAccount.hasSecret);
  assert.equal(gitlabAccount.baseUrl, 'https://gitlab.fixture.example:8443');
  assert.equal(gitlabPlugin.url, 'https://gitlab.fixture.example:8443/api/v4/mcp');
  assert.equal(gitlabPlugin.authMode, 'headers');
  assert.equal(gitlabPlugin.enabled, false);
  assert.equal(gitlabPlugin.connectorId, gitlabAccount.id);
  assert.ok(gitlabPlugin.hasSecret, 'Token mode resolves the verified bound account');
  assert.ok(!JSON.stringify(gitlabState).includes('fixture-local-gitlab-token'));
  await gitlabCard.getByRole('button', { name: '检测本地账号', exact: true }).click();
  await gitlabCard
    .getByRole('button', { name: '使用 local-gitlab-user 的Git 凭据并配置', exact: true })
    .click();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(
    (await page.evaluate(() => window.tongzhou.snapshot())).connectors.filter(
      (c) => c.kind === 'gitlab',
    ).length,
    1,
  );
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
  await card.getByText('连接已验证 · 已启用', { exact: false }).waitFor();
  const persisted = await page.evaluate(() => window.tongzhou.snapshot());
  assert.ok(persisted.plugins.find((p) => p.id === plugin.id).hasSecret);
  assert.ok(!JSON.stringify(persisted).includes('fixture-local-github-token'));
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '打开渠道', exact: true }).click();
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '管理浏览器账号', exact: true }).count(), 0);
  assert.ok(
    (await page.evaluate(() => window.tongzhou.snapshot())).connectors.some(
      (c) => c.kind === 'github',
    ),
  );
  assert.ok(
    (await page.evaluate(() => window.tongzhou.snapshot())).connectors.some(
      (c) => c.kind === 'gitlab',
    ),
  );
  assert.ok(persisted.connectors.find((c) => c.id === gitlabAccount.id).hasSecret);
  assert.equal(persisted.plugins.find((p) => p.id === gitlabPlugin.id).url, gitlabPlugin.url);
  assert.ok(!JSON.stringify(persisted).includes('fixture-local-gitlab-token'));
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
          'GitLab Git and CLI detection for official and self-managed sites',
          'changing instances invalidates displayed results',
          'GitLab account import prepares isolated MCP browser authorization',
          'GitLab repeat import, encrypted credentials and main-process restart',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    'Local code hosting smoke passed: GitHub enable, GitLab token detection and configuration, redaction, restart and layout.',
  );
} catch (error) {
  await (await app.firstWindow()).screenshot({ path: 'test-results/local-github-failure.png' });
  throw error;
} finally {
  await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
