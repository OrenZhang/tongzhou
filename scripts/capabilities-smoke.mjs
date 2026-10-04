import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/capabilities-'));
const env = { ...process.env, TONGZHOU_USER_DATA: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
const errors = [],
  checks = [];
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.app-shell');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1200, 950);
    w.setIgnoreMouseEvents(true);
  });
  const navigate = () =>
    page.locator('.sidebar').getByRole('button', { name: '插件', exact: true }).click();
  await navigate();
  const computer = page.getByRole('region', { name: '电脑控制能力', exact: true });
  const management = page.getByRole('region', { name: '客户端管理能力', exact: true });
  await computer.getByText('尚未检测电脑控制', { exact: true }).waitFor();
  assert.equal(await computer.getByRole('button', { name: /停止全部任务/ }).count(), 0);
  const computerSwitch = computer.getByRole('switch', { name: '启用电脑控制', exact: true });
  await computerSwitch.check();
  await computer.getByText('已启用。Agent 从下一轮对话起可使用此能力。', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.tongzhou.snapshot())).capabilities.computer, true);
  const managementSwitch = management.getByRole('switch', { name: '启用客户端管理', exact: true });
  await managementSwitch.uncheck();
  await management.getByText('已停用，后续工具调用将不再使用此能力。', { exact: true }).waitFor();
  await page.reload();
  await page.waitForSelector('.app-shell');
  await navigate();
  assert.equal(await computerSwitch.isChecked(), true);
  assert.equal(await managementSwitch.isChecked(), false);
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('tongzhou:setCapability');
    ipcMain.handle('tongzhou:setCapability', () => {
      throw new Error('合成保存失败，请重试');
    });
  });
  await computerSwitch.click();
  await computer.getByRole('alert').filter({ hasText: '合成保存失败' }).waitFor();
  assert.equal(
    await computerSwitch.isChecked(),
    true,
    'failed writes must restore the saved switch value',
  );
  await management.getByRole('button', { name: '复制客户端管理示例' }).click();
  await management.getByText('已复制示例。前往会话粘贴并发送即可。', { exact: true }).waitFor();
  assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /同舟有哪些会话/);
  if (process.platform === 'darwin' && process.env.TONGZHOU_COMPUTER_SMOKE !== '1') {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('tongzhou:computerPermission');
      ipcMain.handle('tongzhou:computerPermission', () => ({
        supported: true,
        platform: 'darwin',
        screen: 'granted',
        accessibility: true,
        emergencyShortcut: false,
      }));
    });
  }
  await computer.getByRole('button', { name: /刷新系统状态|检查系统权限/ }).click();
  await computer
    .getByText('系统状态已刷新。是否可以截图和输入，请以电脑控制检测结果为准。', { exact: true })
    .waitFor();
  checks.push(
    'switches persist, separate per-card feedback, actionable example clipboard and permissions refresh, no inert stop button',
  );
  if (process.env.TONGZHOU_COMPUTER_SMOKE === '1') {
    await computer.getByRole('button', { name: '检测电脑控制', exact: true }).click();
    await computer.getByText('正在检测电脑控制', { exact: true }).waitFor();
    await computer
      .getByText('检测通过，可以返回会话使用电脑控制。', { exact: true })
      .waitFor({ timeout: 60000 });
    const status = await page.evaluate(() => window.tongzhou.computerStatus());
    assert.equal(status.diagnostic.ok, true, status.diagnostic.detail);
    checks.push(
      'real owned-window detection: native discovery, screenshot, Unicode input, result shown in the same card',
    );
  }
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('tongzhou:computerSelfTest');
    ipcMain.handle(
      'tongzhou:computerSelfTest',
      () =>
        new Promise((resolve) => {
          globalThis.finishCapabilityTest = resolve;
        }),
    );
  });
  await computer.getByRole('button', { name: '检测电脑控制', exact: true }).click();
  await computer.getByText('正在检测电脑控制', { exact: true }).waitFor();
  assert.equal(
    await computer.getByRole('button', { name: '检测中…', exact: true }).isDisabled(),
    true,
  );
  await app.evaluate(() =>
    globalThis.finishCapabilityTest({
      supported: true,
      platform: process.platform,
      screen: 'available',
      accessibility: true,
      emergencyShortcut: false,
      diagnostic: {
        ok: false,
        time: Date.now(),
        detail: '截取测试窗口未完成：请保持窗口可见后重试。',
      },
    }),
  );
  await computer.getByRole('alert').filter({ hasText: '请保持窗口可见后重试' }).waitFor();
  assert.equal(
    await computer.getByRole('button', { name: '重新检测', exact: true }).isEnabled(),
    true,
  );
  await page.screenshot({ animations: 'disabled', path: 'test-results/capabilities-retry.png' });
  await computer.getByRole('button', { name: '重新检测', exact: true }).click();
  await computer.getByText('正在检测电脑控制', { exact: true }).waitFor();
  await app.evaluate(() =>
    globalThis.finishCapabilityTest({
      supported: true,
      platform: process.platform,
      screen: 'available',
      accessibility: true,
      emergencyShortcut: true,
      diagnostic: { ok: true, time: Date.now(), detail: '本机窗口发现、截图与中文输入均通过' },
    }),
  );
  await computer.getByText('检测通过，可以返回会话使用电脑控制。', { exact: true }).waitFor();
  await page.screenshot({ animations: 'disabled', path: 'test-results/capabilities-light.png' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ animations: 'disabled', path: 'test-results/capabilities-dark.png' });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 700),
  );
  await page.screenshot({ animations: 'disabled', path: 'test-results/capabilities-narrow.png' });
  assert.equal(
    await page.locator('.extensions-page').evaluate((el) => el.scrollWidth > el.clientWidth + 2),
    false,
  );
  await management.getByRole('button', { name: '前往会话', exact: true }).click();
  await page.locator('.welcome').waitFor();
  checks.push(
    'pending state and disabled explanation, failure details, retry success, light/dark/narrow layout and working conversation navigation',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    'test-results/capabilities-report.json',
    JSON.stringify({ passed: true, packaged: !!executablePath, checks }, null, 2),
  );
  console.log('Core capabilities smoke passed: ' + checks.join('; '));
} catch (error) {
  await app
    .windows()[0]
    ?.screenshot({ animations: 'disabled', path: 'test-results/capabilities-failure.png' })
    .catch(() => {});
  throw error;
} finally {
  await app.close();
}
