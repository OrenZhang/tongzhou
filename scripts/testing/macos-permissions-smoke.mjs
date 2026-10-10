import { openSidebar } from './navigation-helper.mjs';
import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import electronPath from 'electron';
import { prepareMacDevelopmentApp } from '../macos-dev-app.mjs';
if (process.platform !== 'darwin') throw new Error('This permission guide test requires macOS.');
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/macos-permissions-'));
const env = {
  ...process.env,
  TONGZHOU_USER_DATA: path.join(root, 'profile'),
  TONGZHOU_DISABLE_UPDATES: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = await prepareMacDevelopmentApp(electronPath);
const app = await electron.launch({ executablePath, args: ['.'], env });
const checks = [],
  errors = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.app-shell');
  const actualStatus = await page.evaluate(() => window.tongzhou.computerStatus());
  const application = await page.evaluate(() => window.tongzhou.computerPermissionGuide());
  assert.ok(application.path.endsWith('.app'));
  assert.ok((await stat(application.path)).isDirectory());
  assert.ok(application.icon.startsWith('data:image/png;base64,'));
  assert.equal(application.name, '同舟.app');
  const systemName = await app.evaluate(({ app }) => ({
    name: app.getName(),
    executable: app.getPath('exe'),
  }));
  assert.equal(systemName.name, '同舟');
  assert.equal(systemName.executable, executablePath);
  checks.push('Development runtime is 同舟.app with the branded bundle identity and icon');
  await app.evaluate(({ app, BrowserWindow, ipcMain, shell }) => {
    globalThis.permissionStatus = {
      supported: true,
      platform: 'darwin',
      screen: 'denied',
      accessibility: false,
      emergencyShortcut: true,
    };
    globalThis.permissionCalls = { settings: [], reveal: [], drag: [] };
    ipcMain.removeHandler('tongzhou:computerStatus');
    ipcMain.handle('tongzhou:computerStatus', () => globalThis.permissionStatus);
    shell.openExternal = async (url) => {
      globalThis.permissionCalls.settings.push(url);
    };
    shell.showItemInFolder = (file) => {
      globalThis.permissionCalls.reveal.push(file);
    };
    app.on('browser-window-created', (_, window) => {
      window.webContents.startDrag = ({ file, icon }) => {
        globalThis.permissionCalls.drag.push({
          file,
          hasIcon: !icon.isEmpty(),
          size: icon.getSize(),
        });
      };
    });
    BrowserWindow.getAllWindows()[0].setContentSize(1200, 1000);
  });
  await openSidebar(page, '插件');
  const guide = page.getByRole('region', { name: 'macOS 授权引导', exact: true });
  assert.equal(await guide.locator('[draggable=true]').count(), 0);
  await guide.getByRole('button', { name: '打开辅助功能设置', exact: true }).click();
  await guide.getByRole('status').filter({ hasText: '已打开辅助功能设置' }).waitFor();
  const firstPanel = app.windows().find((candidate) => candidate !== page);
  await firstPanel.locator('#application').waitFor();
  assert.equal(await firstPanel.evaluate(() => typeof window.tongzhou), 'undefined');
  const options = await app.evaluate(({ BrowserWindow }) => {
    const panel = BrowserWindow.getAllWindows().find((w) => w.getTitle() === '同舟授权助手');
    return {
      focusable: panel.isFocusable(),
      focused: panel.isFocused(),
      floating: panel.isAlwaysOnTop(),
    };
  });
  assert.deepEqual(options, { focusable: false, focused: false, floating: true });
  await firstPanel.screenshot({ path: path.join(root, 'authorization-panel.png') });
  await guide.getByRole('button', { name: '打开屏幕录制设置', exact: true }).click();
  await guide.getByRole('status').filter({ hasText: '已打开屏幕录制设置' }).waitFor();
  const panel = app.windows().find((candidate) => candidate !== page);
  await panel.locator('#application').waitFor();
  assert.equal(await panel.locator('#application').getAttribute('draggable'), 'true');
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((w) => w.getTitle() === '同舟授权助手').length,
    ),
    1,
  );
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const main = BrowserWindow.getAllWindows().find((w) => w.getTitle() !== '同舟授权助手');
    ipcMain.emit('tongzhou:permission-panel-drag', {
      sender: main.webContents,
      senderFrame: main.webContents.mainFrame,
    });
    ipcMain.emit('tongzhou:permission-panel-close', {
      sender: main.webContents,
      senderFrame: main.webContents.mainFrame,
    });
  });
  assert.equal(await panel.isClosed(), false);
  assert.equal((await app.evaluate(() => globalThis.permissionCalls.drag)).length, 0);
  await panel.getByRole('button', { name: '在 Finder 中显示', exact: true }).click();
  await panel.locator('#application').dispatchEvent('dragstart');
  await panel.waitForTimeout(100);
  const calls = await app.evaluate(() => globalThis.permissionCalls);
  assert.deepEqual(calls.settings, [
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  ]);
  assert.deepEqual(calls.reveal, [application.path]);
  assert.deepEqual(calls.drag, [
    { file: application.path, hasIcon: true, size: { width: 64, height: 64 } },
  ]);
  checks.push(
    'Only the nonactivating floating panel routes the verified .app to native drag; singleton, isolated preload, trusted sender gate, fixed settings links and Finder fallback',
  );
  const closed = panel.waitForEvent('close');
  await panel.getByRole('button', { name: '关闭授权助手', exact: true }).click();
  await closed;
  assert.equal(
    await app.evaluate(({ ipcMain }) => ipcMain.listenerCount('tongzhou:permission-panel-drag')),
    0,
  );
  await app.evaluate(async ({ BrowserWindow }) => {
    const target = new BrowserWindow({
      title: '权限焦点测试',
      width: 500,
      height: 400,
      show: false,
    });
    await target.loadURL(
      'data:text/html,<title>权限焦点测试</title><p>仅用于验证授权浮窗不抢焦点</p>',
    );
    globalThis.permissionFocusTarget = target;
    target.show();
    target.focus();
  });
  await page.evaluate(() => window.tongzhou.computerOpenPermissionSettings('accessibility'));
  const focused = await app.evaluate(({ BrowserWindow }) => ({
    target: globalThis.permissionFocusTarget.id,
    current: BrowserWindow.getFocusedWindow()?.id,
  }));
  assert.equal(
    focused.current,
    focused.target,
    'Opening the panel must preserve the target window focus',
  );
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((w) => w.getTitle() === '同舟 Tongzhou');
    main.focus();
  });
  await page.waitForTimeout(100);
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((w) => w.getTitle() === '同舟授权助手').length,
    ),
    0,
  );
  await app.evaluate(() => globalThis.permissionFocusTarget.close());
  checks.push(
    'Native target-window focus survives panel creation; returning to the main window dismisses the panel',
  );
  await page.screenshot({ path: path.join(root, 'permissions-pending.png') });
  await app.evaluate(() => {
    globalThis.permissionStatus = {
      ...globalThis.permissionStatus,
      screen: 'granted',
      accessibility: true,
    };
  });
  await guide.getByRole('button', { name: '我已授权，重新检查', exact: true }).click();
  await guide.getByText('两项权限已授权，可以运行电脑控制检测。', { exact: true }).waitFor();
  await app.evaluate(() => {
    globalThis.permissionStatus = { ...globalThis.permissionStatus, accessibility: false };
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await guide.getByText('截图和输入需要下面两项系统权限。', { exact: true }).waitFor();
  checks.push(
    'Explicit refresh and returning-window focus refresh reflect permission grants and revocation',
  );
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.screenshot({ path: path.join(root, 'permissions-dark.png') });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 700),
  );
  assert.equal(
    await page.locator('.extensions-page').evaluate((el) => el.scrollWidth > el.clientWidth + 2),
    false,
  );
  await page.screenshot({ path: path.join(root, 'permissions-narrow.png') });
  await guide.screenshot({ path: path.join(root, 'permission-guide.png') });
  checks.push('Dark and narrow layouts');
  const computer = page.getByRole('region', { name: '电脑控制能力', exact: true });
  for (const platform of ['win32', 'linux']) {
    await app.evaluate((_, platform) => {
      globalThis.permissionStatus = {
        supported: platform === 'win32',
        platform,
        screen: 'available',
        accessibility: true,
        emergencyShortcut: platform === 'win32',
        // Unsupported systems must not display an old successful diagnostic.
        diagnostic: { ok: true, detail: '旧系统检测通过', time: Date.now() },
      };
    }, platform);
    await page.reload();
    await openSidebar(page, '插件');
    await computer
      .getByText(platform === 'win32' ? 'Windows 使用条件' : 'Linux 支持状态', { exact: true })
      .waitFor();
    assert.equal(await guide.count(), 0);
    assert.equal(
      await computer.getByRole('button', { name: /Finder|系统设置|检查系统权限/ }).count(),
      0,
    );
    assert.equal(await computer.getByText(/拖动此图标|屏幕录制：|辅助功能：/).count(), 0);
    if (platform === 'win32') {
      await computer
        .getByText(
          '无需单独授权屏幕录制或辅助功能。请运行本机检测，确认窗口识别、截图和输入可用。',
          { exact: true },
        )
        .waitFor();
      await computer.locator('summary').click();
      await computer.getByText('紧急停止快捷键：Ctrl + Alt + Esc。', { exact: true }).waitFor();
      assert.equal(
        await computer.getByRole('button', { name: '检测电脑控制', exact: true }).isEnabled(),
        true,
      );
    } else {
      assert.equal(
        await computer.getByRole('switch', { name: '启用电脑控制', exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await computer.getByRole('button', { name: /检测电脑控制|重新检测/ }).count(),
        0,
      );
      assert.equal(await computer.getByText('上次检测通过', { exact: true }).count(), 0);
      assert.equal(
        await computer.getByRole('button', { name: '复制电脑控制示例', exact: true }).count(),
        0,
      );
    }
    await computer.getByRole('button', { name: '刷新系统状态', exact: true }).click();
    await computer.getByRole('status').filter({ hasText: '系统状态已刷新' }).waitFor();
    await page.screenshot({ path: path.join(root, `permissions-${platform}.png`) });
  }
  checks.push(
    'Simulated Windows and Linux show only their own conditions, actions and support state',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(root, 'report.json'),
    JSON.stringify(
      {
        passed: true,
        actualStatus,
        application: { name: application.name, development: application.development },
        checks,
      },
      null,
      2,
    ),
  );
  console.log('macOS permission guide smoke passed:', root, JSON.stringify(checks));
} catch (error) {
  await app
    .windows()[0]
    ?.screenshot({ path: path.join(root, 'failure.png') })
    .catch(() => {});
  throw error;
} finally {
  await app.close();
}
