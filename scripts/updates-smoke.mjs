import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('test-results', { recursive: true });
const profile = await mkdtemp(path.resolve('test-results/updates-'));
const env = { ...process.env, TONGZHOU_USER_DATA: profile, TONGZHOU_DISABLE_UPDATES: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const app = await electron.launch({ args: ['.'], env });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  await page.getByRole('button', { name: '设置与优化', exact: true }).click();
  await page.getByRole('heading', { name: '版本更新' }).waitFor();
  assert.equal(await page.locator('.sidebar-update').count(), 0);
  const emit = (phase, extra = {}) =>
    app.evaluate(
      ({ BrowserWindow }, state) => {
        BrowserWindow.getAllWindows()[0].webContents.send('tongzhou:event', {
          type: 'update',
          state,
        });
      },
      { phase, currentVersion: '0.1.0', automaticInstall: true, ...extra },
    );
  await emit('available', { version: '0.2.0' });
  await page.locator('.sidebar-update button').waitFor();
  assert.match(await page.locator('.sidebar-update button').getAttribute('aria-label'), /0.2.0/);
  await emit('downloading', { version: '0.2.0', progress: 42 });
  await page.getByRole('button', { name: '正在下载 42%', exact: true }).first().waitFor();
  assert.equal(await page.locator('.sidebar-update button').isDisabled(), true);
  await emit('current');
  await page.waitForFunction(() => !document.querySelector('.sidebar-update'));
  await page.screenshot({ path: 'test-results/updates-settings.png' });
  console.log(
    'Update UI passed: no empty help icon, hidden when current, available version and disabled progress state. No installer was executed.',
  );
} finally {
  await app.close();
}
