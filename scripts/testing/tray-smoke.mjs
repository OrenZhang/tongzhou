import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

if (process.platform !== 'win32') {
  console.log('Windows tray smoke skipped on this platform.');
  process.exit(0);
}

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/tray-'));
const bootstrap = path.join(root, 'bootstrap.cjs');
// Capture the real native tray in the test harness, without exposing a production IPC hook.
await writeFile(
  bootstrap,
  `const { Tray } = require('electron');
const original = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function (menu) {
  global.__traySmoke = { tray: this, menu };
  return original.call(this, menu);
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
const app = await electron.launch({ args: [bootstrap], env, timeout: 45000 });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  await page.evaluate(() => (window.__traySmokeMarker = 'preserved'));
  const windowId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
  assert.deepEqual(
    await app.evaluate(() => ({
      destroyed: global.__traySmoke.tray.isDestroyed(),
      menu: global.__traySmoke.menu.items.map((item) => item.label),
    })),
    { destroyed: false, menu: ['打开CoSail', '', '退出CoSail'] },
  );

  for (const action of ['click', 'double-click', 'menu', 'second-instance']) {
    assert.deepEqual(
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.close();
        return { destroyed: window.isDestroyed(), visible: window.isVisible() };
      }),
      { destroyed: false, visible: false },
    );
    await app.evaluate(({ app }, action) => {
      const { tray, menu } = global.__traySmoke;
      if (action === 'menu') menu.items[0].click();
      else if (action === 'second-instance') app.emit('second-instance', {}, [], '');
      else tray.emit(action);
    }, action);
    assert.deepEqual(
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return { id: window.id, visible: window.isVisible(), minimized: window.isMinimized() };
      }),
      { id: windowId, visible: true, minimized: false },
    );
    assert.equal(await page.evaluate(() => window.__traySmokeMarker), 'preserved');
  }

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await app.evaluate(() => global.__traySmoke.tray.emit('click'));
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized()),
    false,
  );

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const closed = app.waitForEvent('close', { timeout: 15000 });
  await app.evaluate(() => {
    // Let evaluate return before the native process exits.
    setImmediate(() => global.__traySmoke.menu.items[2].click());
  });
  await closed;
  console.log('Windows tray smoke passed: hide, restore, preserve page state, minimize, and exit.');
} finally {
  await app.close();
}
