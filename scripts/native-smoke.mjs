import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Explicit opt-in. Real device requests; Kimi's official CLI may open the browser.
// No user sign-in is completed, no model inference or billable test call is made.
const live = process.env.TONGZHOU_LIVE_NATIVE_SMOKE === '1';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/native-'));
const env = { ...process.env, TONGZHOU_USER_DATA: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const app = await electron.launch({
  executablePath,
  args: executablePath ? [] : ['.'],
  cwd: executablePath ? root : process.cwd(),
  env,
  timeout: 45000,
});
try {
  await app.evaluate(({ shell }) => {
    shell.openExternal = async () => {};
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.welcome');
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => w.setIgnoreMouseEvents(true)),
  );
  await page.getByRole('button', { name: /^连接中心/ }).click();
  const checks = [];
  for (const [engine, label] of [
    ['kimi', 'Kimi Code'],
    ['minimax', 'MiniMax Code'],
  ]) {
    const providerName = engine === 'kimi' ? 'Kimi · 账号授权' : 'MiniMax · 账号授权';
    await page.getByRole('button', { name: `编辑 ${providerName}`, exact: true }).click();
    await page.getByRole('button', { name: '前往登录', exact: true }).click();
    const card = page.getByRole('region', { name: `${label} 账号`, exact: true });
    await card
      .locator('.account-status')
      .filter({ hasText: '尚未登录' })
      .waitFor({ timeout: 65000 });
    const state = await page.evaluate((engine) => window.tongzhou.nativeStatus(engine), engine);
    assert.equal(state.authenticated, false);
    assert.equal(state.error, undefined);
    checks.push(`${engine} real ACP initialization and anonymous status`);
    if (!live) {
      await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
      continue;
    }
    await card.getByRole('button', { name: `登录 ${label}`, exact: true }).click();
    await card.getByLabel(`${label} 设备码`, { exact: true }).waitFor({ timeout: 65000 });
    assert.ok(await card.getByLabel(`${label} 设备码`, { exact: true }).innerText());
    await card.getByRole('button', { name: '打开授权页面', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '工作空间', exact: true }).click();
    await page.getByRole('button', { name: /^连接中心/ }).click();
    await page.getByRole('button', { name: `编辑 ${providerName}`, exact: true }).click();
    await page.getByRole('button', { name: '前往登录', exact: true }).click();
    await card.getByLabel(`${label} 设备码`, { exact: true }).waitFor();
    await card.getByRole('button', { name: '取消授权', exact: true }).click();
    await card.getByText('本次授权已取消。', { exact: true }).waitFor();
    assert.equal(await card.getByLabel(`${label} 设备码`, { exact: true }).count(), 0);
    checks.push(`${engine} real device request, UI, navigation persistence and cancellation`);
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  }
  const snapshot = await page.evaluate(() => window.tongzhou.snapshot());
  for (const engine of ['kimi', 'minimax'])
    assert.equal(snapshot.providers.find((p) => p.id === `${engine}-account`).auth, 'native');
  await page.getByRole('button', { name: '编辑 Kimi · 账号授权', exact: true }).click();
  await page.getByRole('button', { name: '前往登录', exact: true }).click();
  await page.getByRole('region', { name: 'Kimi Code 账号', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/10-native-auth.png' });
  await writeFile(
    'test-results/native-report.json',
    JSON.stringify(
      { passed: true, live, checks, accountLoginCompleted: false, inferenceTested: false },
      null,
      2,
    ),
  );
  console.log('Native engine smoke passed; no user sign-in or model inference performed.');
} catch (error) {
  const page = app.windows()[0];
  await page?.screenshot({ path: 'test-results/native-failure.png' }).catch(() => {});
  throw error;
} finally {
  await app.close();
}
