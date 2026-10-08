import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Explicit opt-in: talks to OpenAI to start/cancel login, never signs in or opens a browser.
if (process.env.TONGZHOU_LIVE_AUTH_SMOKE !== '1')
  throw new Error('Set TONGZHOU_LIVE_AUTH_SMOKE=1 to run the online authorization smoke test');
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/auth-'));
const env = { ...process.env, TONGZHOU_USER_DATA: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_CODEX_PATH;
const app = await electron.launch({ args: ['.'], env, timeout: 45000 });
try {
  await app.evaluate(({ shell }) => {
    shell.openExternal = async () => {};
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => w.setIgnoreMouseEvents(true)),
  );
  await page.getByRole('button', { name: /^模型/ }).click();
  await page.getByRole('button', { name: '编辑 OpenAI · ChatGPT', exact: true }).click();
  await page.getByRole('button', { name: '前往登录', exact: true }).click();
  await page.getByText('Codex 可用，尚未登录', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'ChatGPT 浏览器登录', exact: true }).click();
  await page.getByText('等待浏览器授权完成', { exact: true }).waitFor({ timeout: 65000 });
  assert.equal(
    await page.getByRole('button', { name: '设备码登录', exact: true }).isDisabled(),
    true,
  );
  await page.getByRole('button', { name: '改用设备码登录', exact: true }).click();
  await page.getByLabel('设备授权码', { exact: true }).waitFor({ timeout: 65000 });
  assert.ok((await page.getByLabel('设备授权码', { exact: true }).innerText()).length > 0);
  await page.getByRole('button', { name: '打开授权页面', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  await page.getByRole('button', { name: /^模型/ }).click();
  await page.getByRole('button', { name: '编辑 OpenAI · ChatGPT', exact: true }).click();
  await page.getByRole('button', { name: '前往登录', exact: true }).click();
  await page.getByLabel('设备授权码', { exact: true }).waitFor();
  await page.getByRole('button', { name: '取消授权', exact: true }).click();
  await page.getByText('已取消本次授权，可以重新选择登录方式。', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('设备授权码', { exact: true }).count(), 0);
  assert.equal((await page.evaluate(() => window.tongzhou.codexStatus())).account, '');
  await page.screenshot({ path: 'test-results/09-auth-settings.png' });
  await writeFile(
    'test-results/auth-report.json',
    JSON.stringify(
      {
        passed: true,
        checks: [
          'real browser login request',
          'pending state',
          'cancel browser flow before switching to device login',
          'real device code request',
          'device UI',
          'reopen link',
          'state survives page navigation',
          'cancel device flow',
        ],
        accountLoginCompleted: false,
      },
      null,
      2,
    ),
  );
  console.log(
    'Live authorization smoke passed: browser/device request, UI state and cancellation. No user sign-in performed.',
  );
} finally {
  await app.close();
}
