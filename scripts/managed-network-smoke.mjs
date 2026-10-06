import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/managed-network-'));
const upstreams = [],
  hosts = [[], []];
for (let i = 0; i < 2; i++) {
  const s = createServer((req, res) => {
    hosts[i].push(req.url);
    res.end('node-' + i);
  });
  s.on('connect', (req, socket) => {
    socket.on('error', () => {});
    hosts[i].push(req.url);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  upstreams.push(s);
}
const config = {
  proxies: upstreams.map((s, i) => ({
    name: '测试节点' + i,
    type: 'http',
    server: '127.0.0.1',
    port: s.address().port,
    username: 'fixture',
    password: 'private-fixture-password',
  })),
  tun: { enable: true },
  'allow-lan': true,
};
const configFile = path.join(root, 'nodes.json');
await writeFile(configFile, JSON.stringify(config));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
let app;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const launch = () => electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
const errors = [],
  checks = [];
try {
  app = await launch();
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.app-shell');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 930),
  );
  const systemBefore = await app.evaluate(({ session }) =>
    session.defaultSession.resolveProxy('https://auth.openai.com'),
  );
  const initial = await page.evaluate(() => window.tongzhou.networkProfiles());
  const archive =
    process.env.TONGZHOU_NETWORK_ARCHIVE || path.resolve('.test-data', initial.core.asset);
  let local = false;
  try {
    await access(archive);
    local = true;
  } catch {}
  if (local) {
    await app.evaluate(({ dialog }, archive) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archive] });
    }, archive);
    await page.evaluate(() => window.tongzhou.installNetworkCore(true));
  } else await page.evaluate(() => window.tongzhou.installNetworkCore(false));
  await page.getByRole('button', { name: /设置与优化/ }).click();
  await page.getByRole('button', { name: /打开连接中心/ }).click();
  await page.getByRole('button', { name: '网络配置', exact: true }).click();
  await page.getByRole('button', { name: '添加配置', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('测试内置网络');
  await page.getByLabel('导入网络配置文件').setInputFiles(configFile);
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByRole('heading', { name: '测试内置网络' }).waitFor();
  const overview = await page.evaluate(() => window.tongzhou.networkProfiles());
  const id = overview.profiles[0].id;
  assert.ok(!JSON.stringify(overview).includes('private-fixture-password'));
  await page.getByRole('button', { name: '启动', exact: true }).click();
  await page.getByText('运行中', { exact: true }).waitFor();
  await page.getByRole('button', { name: '检测全部节点', exact: true }).click();
  await page.getByText(/已检测 2 个节点/).waitFor();
  const tested = (await page.evaluate(() => window.tongzhou.networkProfiles())).profiles[0];
  assert.equal(tested.health.results.length, 2);
  assert.equal(tested.selected, '测试节点0', 'scan must not change the active exit');
  assert.equal(tested.health.recommended, undefined, 'failing fixtures must never be recommended');
  assert.ok(hosts.every((h) => h.includes('auth.openai.com:443') && h.includes('chatgpt.com:443')));
  await page.getByLabel('测试内置网络的出口策略').selectOption('auto');
  await page.getByText(/没有通过 OpenAI 与 ChatGPT 检测的节点/).waitFor();
  assert.equal(
    (await page.evaluate(() => window.tongzhou.networkProfiles())).profiles[0].routing,
    'manual',
  );
  checks.push(
    'per-node real-core probes, latency table, failed auto routing preserves current selection',
  );
  const profile = path.join(root, 'profile');
  const generated = await readdir(path.join(profile, 'network-runtime'));
  for (const directory of generated)
    assert.ok(
      !(await readdir(path.join(profile, 'network-runtime', directory))).includes('config.yaml'),
      'plaintext config must be removed once loaded',
    );
  await page.getByRole('button', { name: '绑定 ChatGPT 账号…', exact: true }).click();
  const accountName = await page.evaluate(
    async () =>
      (await window.tongzhou.snapshot()).providers.find((p) => p.id === 'openai-codex').name,
  );
  await page.getByRole('dialog').getByRole('button', { name: accountName, exact: true }).click();
  await page.getByText('账号已绑定此网络配置', { exact: true }).waitFor();
  await page.evaluate(async () => {
    try {
      await window.tongzhou.testProviderNetwork('openai-codex');
    } catch {}
  });
  assert.ok(
    hosts[0].some((h) => h === 'auth.openai.com:443'),
    'managed account test reaches first upstream',
  );
  checks.push(
    'UI file import, verified offline install, actual Mihomo start, encrypted metadata, removed plaintext configuration',
  );
  await page.getByLabel('测试内置网络的出口节点').selectOption('测试节点1');
  await page.getByText('出口节点已切换', { exact: true }).waitFor();
  await page.evaluate(async () => {
    try {
      await window.tongzhou.testProviderNetwork('openai-codex');
    } catch {}
  });
  assert.ok(
    hosts[1].some((h) => h === 'auth.openai.com:443'),
    'node switching reaches second upstream',
  );
  const count = hosts[1].length;
  const after = await app.evaluate(({ session }) =>
    session.defaultSession.resolveProxy('https://auth.openai.com'),
  );
  assert.equal(after, systemBefore);
  await page.evaluate(async () => {
    try {
      await window.tongzhou.codexLogin('device', 'openai-codex');
    } catch {}
  });
  const deadline = Date.now() + 20000;
  while (hosts[1].length === count && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 100));
  assert.ok(hosts[1].length > count, 'bundled Codex device login must traverse managed core');
  await page.evaluate(() => window.tongzhou.codexLoginCancel('openai-codex'));
  checks.push(
    'account browser traffic follows selected node, system routing unchanged, no external VPN used by fixture traffic',
  );
  await page.screenshot({ path: 'test-results/managed-network-light.png' });
  await page.evaluate(() =>
    window.tongzhou.setAppearance({
      theme: 'dark',
      style: 'graphite',
      font: 'system',
      textSize: 14,
    }),
  );
  await page.screenshot({ path: 'test-results/managed-network-dark.png' });
  await page.evaluate((id) => window.tongzhou.stopNetworkProfile(id), id);
  assert.equal(
    (await page.evaluate(() => window.tongzhou.networkProfiles())).profiles[0].status,
    'stopped',
  );
  await page.evaluate(async () => {
    try {
      await window.tongzhou.testProviderNetwork('openai-codex');
    } catch {}
  });
  assert.equal(
    (await page.evaluate(() => window.tongzhou.networkProfiles())).profiles[0].status,
    'running',
  );
  await assert.rejects(
    () => page.evaluate((id) => window.tongzhou.deleteNetworkProfile(id), id),
    /取消使用/,
  );
  await page.getByRole('button', { name: /^模型与订阅/ }).click();
  await page.getByRole('button', { name: '编辑 OpenAI · ChatGPT', exact: true }).click();
  assert.equal(await page.getByLabel('ChatGPT 网络方式', { exact: true }).inputValue(), 'managed');
  // Profile options arrive through IPC after the editor opens. Wait for that list
  // before reading the select value, especially on a cold macOS CI runner.
  await page.waitForFunction(
    (id) =>
      document
        .querySelector('[aria-label="ChatGPT 内置网络配置"]')
        ?.querySelector(`option[value="${id}"]`),
    id,
  );
  assert.equal(await page.getByLabel('ChatGPT 内置网络配置').inputValue(), id);
  checks.push(
    'selected profile persists in account editor, stopping permits automatic restart, bound deletion rejected',
  );
  assert.deepEqual(errors, []);
  await app.close();
  app = undefined;
  assert.deepEqual(
    await readdir(path.join(profile, 'network-runtime')),
    [],
    'app exit must stop core and remove runtime directory',
  );
  checks.push('desktop shutdown removes owned runtime and process');
  app = await launch();
  const reopened = await app.firstWindow();
  await reopened.waitForSelector('.app-shell');
  await reopened.evaluate(async () => {
    try {
      await window.tongzhou.testProviderNetwork('openai-codex');
    } catch {}
  });
  assert.equal(
    (await reopened.evaluate(() => window.tongzhou.networkProfiles())).profiles[0].selected,
    '测试节点1',
  );
  assert.ok((await readdir(path.join(profile, 'network-runtime'))).length > 0);
  const runtimeDirectory = (await readdir(path.join(profile, 'network-runtime')))[0];
  const { proxyPort } = JSON.parse(
    await readFile(path.join(profile, 'network-runtime', runtimeDirectory, 'status.json'), 'utf8'),
  );
  const processHandle = app.process();
  const mainPid = await app.evaluate(() => process.pid);
  const closed = new Promise((resolve) => processHandle.once('exit', resolve));
  // On Windows app.process() may be a launcher wrapper, not the desktop main process.
  process.kill(mainPid, 'SIGKILL');
  await closed;
  app = undefined;
  const listening = () =>
    new Promise((resolve) => {
      const socket = connect(proxyPort, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });
  const cleanupDeadline = Date.now() + 10000;
  while ((await listening()) && Date.now() < cleanupDeadline)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(await listening(), false, 'desktop crash must stop the owned proxy listener');
  app = await launch();
  await (await app.firstWindow()).waitForSelector('.app-shell');
  assert.deepEqual(
    await readdir(path.join(profile, 'network-runtime')),
    [],
    'relaunch removes leftover temp directories',
  );
  await app.close();
  app = undefined;
  checks.push(
    'relaunch restores encrypted configuration; abrupt desktop termination also stops the owned core',
  );
  await writeFile(
    'test-results/managed-network-report.json',
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  if (app) await app.close();
  for (const s of upstreams) {
    s.closeAllConnections();
    s.close();
  }
}
