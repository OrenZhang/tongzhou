import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openSidebar } from './navigation-helper.mjs';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/module-navigation-'));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const app = await electron.launch({ args: ['.'], env });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.app-shell');
  await openSidebar(page, '智库');
  assert.equal(await page.getByRole('tab', { name: /AI 工作流/ }).count(), 0);
  await page.getByRole('button', { name: '管理自动化', exact: true }).click();
  await page.getByRole('heading', { name: '定时任务', exact: true }).waitFor();
  await openSidebar(page, 'Agent');
  for (const card of await page.locator('.agent-card').all())
    assert.equal(await card.getByRole('button', { name: '配置', exact: true }).count(), 1);
  await openSidebar(page, '插件');
  await page.getByRole('button', { name: /^内置插件/ }).click();
  await page.getByRole('button', { name: '查看 MiniMax 多媒体', exact: true }).click();
  const detail = page.getByRole('region', { name: 'MiniMax 多媒体 详情', exact: true });
  await detail.getByLabel('认证方式', { exact: true }).selectOption('key');
  await detail.getByLabel('API Key', { exact: true }).fill('unsaved-test-value');
  await detail.getByLabel('认证方式', { exact: true }).selectOption('account');
  await detail.getByRole('button', { name: /套餐账号.*登录/ }).click();
  const dialog = page.getByRole('dialog', { name: 'MiniMax Code 账号授权', exact: true });
  await dialog.waitFor();
  // Opening the sign-in UI must not start a real authorization request.
  assert.equal(
    await dialog.getByRole('button', { name: '登录 MiniMax Code', exact: true }).count(),
    1,
  );
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await detail.waitFor();
  assert.ok(await detail.getByLabel('套餐账号', { exact: true }).inputValue());
  await detail.getByLabel('认证方式', { exact: true }).selectOption('key');
  assert.equal(
    await detail.getByLabel('API Key', { exact: true }).inputValue(),
    'unsaved-test-value',
  );
  await page.screenshot({ path: path.join(root, 'plugin-return.png') });
  assert.deepEqual(errors, []);
  console.log(
    'Module navigation passed: unified automation entry, single Agent configuration, account dialog return and unsaved draft preservation.',
    root,
  );
} finally {
  await app.close();
}
