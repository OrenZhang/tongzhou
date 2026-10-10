import { openModels, openSidebar } from './navigation-helper.mjs';
import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/account-ui-'));
const env = { ...process.env, TONGZHOU_USER_DATA: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const app = await electron.launch(
  executablePath
    ? { executablePath: path.resolve(executablePath), args: [], cwd: root, env, timeout: 45000 }
    : { args: ['.'], env, timeout: 45000 },
);
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    BrowserWindow.getAllWindows().forEach((w) => w.setIgnoreMouseEvents(true));
    // Fixture states deliberately omit a transient login-success phase. Success badges
    // must derive from the verified account returned after opening/reopening a page.
    ipcMain.removeHandler('tongzhou:codexStatus');
    ipcMain.handle('tongzhou:codexStatus', () => ({
      available: true,
      account: 'fixture@example.test',
      plan: 'plus',
    }));
    ipcMain.removeHandler('tongzhou:nativeStatus');
    ipcMain.handle('tongzhou:nativeStatus', (_, engine) => ({
      engine,
      phase: 'idle',
      authenticated: engine === 'kimi',
    }));
  });
  // Built-in connections default to disabled; this fixture explicitly opts in.
  await page.evaluate(async () => {
    const { providers } = await window.tongzhou.snapshot();
    for (const provider of providers)
      if (['codex', 'kimi', 'minimax'].includes(provider.protocol))
        await window.tongzhou.saveProvider({ ...provider, enabled: true });
  });
  await openModels(page);
  await page
    .locator('.provider-card')
    .filter({ has: page.getByRole('heading', { name: 'OpenAI · ChatGPT', exact: true }) })
    .getByText('已授权', { exact: true })
    .waitFor();
  for (const [provider, heading] of [
    ['Kimi · 账号授权', 'Kimi Code 账号授权'],
    ['MiniMax · 账号授权', 'MiniMax Code 账号授权'],
    ['OpenAI · ChatGPT', 'OpenAI / ChatGPT 账号授权'],
  ]) {
    await page.getByRole('button', { name: `编辑 ${provider}`, exact: true }).click();
    await page.getByRole('button', { name: '前往登录', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('heading', { name: heading, exact: true }).first().waitFor();
    assert.equal(await dialog.locator('.settings-card').count(), 1);
    const text = await dialog.innerText();
    if (provider.startsWith('Kimi')) {
      assert.ok(!text.includes('MiniMax'));
      assert.ok(!text.includes('ChatGPT'));
      await dialog.getByText('已授权', { exact: true }).waitFor();
    }
    if (provider.startsWith('MiniMax')) {
      assert.ok(!text.includes('Kimi'));
      assert.ok(!text.includes('ChatGPT'));
      await dialog.getByText('未授权', { exact: true }).waitFor();
    }
    if (provider.startsWith('OpenAI')) {
      assert.ok(!text.includes('Kimi'));
      assert.ok(!text.includes('MiniMax'));
      await dialog.getByText('已授权', { exact: true }).waitFor();
    }
    if (provider.startsWith('Kimi'))
      await page.screenshot({ path: 'test-results/11-single-account-dialog.png' });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('heading', { name: provider, exact: true }).waitFor();
  }
  await page.getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await page.locator('.auth-badge.connected').count(), 0);
  await openSidebar(page, '渠道');
  assert.equal(await page.locator('.auth-badge.connected').count(), 0);
  await page.getByRole('heading', { name: '渠道', exact: true }).waitFor();
  await openModels(page);
  assert.equal(await page.locator('.auth-badge.connected').count(), 2);
  console.log(
    'Account UI smoke passed: single-provider dialogs, verified badges, return navigation. States are fixtures.',
  );
} finally {
  await app.close();
}
