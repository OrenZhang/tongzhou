import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { openSidebar } from './navigation-helper.mjs';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/power-'));
const bootstrap = path.join(root, 'bootstrap.cjs');
// Replace only OS effects. Real service, IPC, persistence and settings UI remain in use.
await writeFile(
  bootstrap,
  `
const { powerMonitor, powerSaveBlocker } = require('electron');
const { EventEmitter } = require('node:events');
const processes = require('node:child_process');
const originalFork = processes.fork;
global.__powerSmoke = { battery: process.env.TEST_BATTERY === '1', starts: [], stops: [], lidStarts: 0, lidStops: 0 };
powerMonitor.isOnBatteryPower = () => global.__powerSmoke.battery;
powerSaveBlocker.start = (type) => { global.__powerSmoke.starts.push(type); return 1; };
powerSaveBlocker.stop = (id) => { global.__powerSmoke.stops.push(id); return true; };
processes.fork = (file, ...args) => {
  if (!/[/\\\\](windows|macos)-lid-host\\.cjs$/.test(file)) return originalFork(file, ...args);
  global.__powerSmoke.lidStarts++;
  const child = new EventEmitter();
  child.connected = true;
  child.send = () => { global.__powerSmoke.lidStops++; child.connected = false; setImmediate(() => child.emit('exit', 0)); };
  child.disconnect = child.send;
  setImmediate(() => child.emit('message', { type: 'ready' }));
  return child;
};
require(${JSON.stringify(path.resolve('dist-electron/main.cjs'))});
`,
);
const env = {
  ...process.env,
  TONGZHOU_USER_DATA: path.join(root, 'profile'),
  TONGZHOU_DISABLE_UPDATES: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
let app;
try {
  app = await electron.launch({ args: [bootstrap], env, timeout: 45000 });
  const page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  await openSidebar(page, '设置');
  const card = page.getByRole('region', { name: '电源与睡眠', exact: true });
  const awake = card.getByRole('checkbox', { name: '接通电源时保持唤醒', exact: true });
  const lid = card.getByRole('checkbox', { name: '接通电源时合盖不睡眠', exact: true });
  assert.equal(await awake.isChecked(), false);
  assert.equal(await lid.isEnabled(), false);
  await awake.click();
  await card.getByText('已接通电源 · 正在保持唤醒', { exact: true }).waitFor();
  await lid.click();
  await card.getByText('合盖保持唤醒已生效', { exact: true }).waitFor();
  assert.deepEqual(await app.evaluate(() => global.__powerSmoke.starts), [
    'prevent-app-suspension',
  ]);
  await page.screenshot({ path: 'test-results/power-settings.png' });
  await app.evaluate(({ powerMonitor }) => {
    global.__powerSmoke.battery = true;
    powerMonitor.emit('on-battery');
  });
  await card.getByText('当前使用电池 · 保持唤醒已暂停，遵循系统睡眠设置').waitFor();
  assert.equal((await page.evaluate(() => window.tongzhou.powerStatus())).active, false);
  assert.equal(await app.evaluate(() => global.__powerSmoke.lidStops), 1);
  await lid.click();
  await page.waitForFunction(
    async () => !(await window.tongzhou.powerStatus()).keepAwakeWhenLidClosed,
  );
  await awake.click();
  await page.waitForFunction(async () => !(await window.tongzhou.powerStatus()).keepAwakeOnAC);
  assert.equal(await awake.isEnabled(), false);
  assert.equal(await lid.isEnabled(), false);
  await assert.rejects(
    () =>
      page.evaluate(() =>
        window.tongzhou.savePowerSettings({
          keepAwakeOnAC: true,
          keepAwakeWhenLidClosed: false,
        }),
      ),
    /连接电源/,
  );
  await app.evaluate(({ powerMonitor }) => {
    global.__powerSmoke.battery = false;
    powerMonitor.emit('on-ac');
  });
  await awake.click();
  await card.getByText('已接通电源 · 正在保持唤醒', { exact: true }).waitFor();
  const catalog = await page.evaluate(() => window.tongzhou.clientMethods());
  assert.equal(catalog.methods.find((item) => item.name === 'savePowerSettings').access, 'manual');
  await app.close();
  app = await electron.launch({
    args: [bootstrap],
    env: { ...env, TEST_BATTERY: '1' },
    timeout: 45000,
  });
  const restored = await app.firstWindow();
  await restored.waitForSelector('.app-shell');
  assert.deepEqual(await app.evaluate(() => global.__powerSmoke.starts), []);
  assert.equal((await restored.evaluate(() => window.tongzhou.powerStatus())).keepAwakeOnAC, true);
  console.log(
    'Power settings smoke passed: UI, IPC policy, AC/battery transitions and persistence. No OS power settings changed.',
  );
} finally {
  await app?.close();
}
