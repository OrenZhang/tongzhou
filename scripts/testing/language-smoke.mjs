import { openCanvas } from './navigation-helper.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/language-'));
const english = JSON.parse(await readFile('src/shared/locales/en.json', 'utf8'));
const env = {
  ...process.env,
  TONGZHOU_USER_DATA: path.join(root, 'profile'),
  TONGZHOU_DISABLE_UPDATES: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
let app = await electron.launch({ args: ['.'], env });
try {
  let page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  await page.waitForSelector('.app-shell');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('tongzhou:computerStatus');
    ipcMain.handle('tongzhou:computerStatus', () => ({
      supported: true,
      platform: 'win32',
      diagnostic: { ok: true, time: Date.now(), detail: '本机窗口发现、截图与中文输入均通过' },
    }));
  });
  const metadata = await page.evaluate(async () => {
    const catalog = await window.tongzhou.clientMethods();
    return catalog.methods
      .flatMap((method) => [method.module, method.description, method.reason])
      .filter(Boolean);
  });
  const missingMetadata = [...new Set(metadata)].filter(
    (text) => /[\u3400-\u9fff]/.test(text) && !Object.hasOwn(english, text),
  );
  await writeFile(
    path.join(root, 'missing-metadata.json'),
    JSON.stringify(missingMetadata, null, 2),
  );
  assert.deepEqual(
    missingMetadata,
    [],
    'All registered feature descriptions must have English translations',
  );
  const fixture = await page.evaluate(async () => {
    const api = window.tongzhou;
    const session = await api.createSession();
    await api.updateSession(session.id, { title: '设置' });
    const canvas = await api.canvasSave({
      title: '用户画布',
      nodes: [{ id: 'source', kind: 'text', title: '设置', text: '原始正文 Settings', x: 0, y: 0 }],
      edges: [],
      selection: ['source'],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    return { sessionId: session.id, canvasId: canvas.id };
  });
  await page.locator(`[data-session-id="${fixture.sessionId}"]`).click();
  await page.getByLabel('消息', { exact: true }).fill('设置 / 用户未发送的草稿');
  await page.getByRole('button', { name: '设置', exact: true }).first().click();
  await page.getByLabel('界面语言 / Language', { exact: true }).selectOption('en');
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await page.locator('#sidebar-sessions').isVisible(), false);
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(
    await app.evaluate(
      ({ Menu }) => Menu.getApplicationMenu().items.find((item) => item.label === 'Edit')?.label,
    ),
    'Edit',
  );
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  assert.equal(await page.locator('#sidebar-sessions').isVisible(), true);
  await page.locator(`[data-session-id="${fixture.sessionId}"]`).click();
  assert.equal(
    await page.getByLabel('Message', { exact: true }).inputValue(),
    '设置 / 用户未发送的草稿',
  );
  assert.ok(
    (await page.locator(`[data-session-id="${fixture.sessionId}"]`).innerText()).includes('设置'),
  );
  const untranslated = {};
  for (const name of [
    'Settings',
    'Models',
    'Channels',
    'Plugins',
    'Knowledge',
    'Canvas',
    'Scheduled tasks',
    'Run history',
    'Agent',
  ]) {
    await page.getByRole('button', { name, exact: true }).first().click();
    await page.waitForTimeout(250);
    assert.equal(
      await page.locator('#sidebar-sessions').isVisible(),
      false,
      name + ' hides conversation sidebar',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Expand conversation list', exact: true }).count(),
      0,
    );
    if (name === 'Plugins')
      await page
        .getByText('Local window detection, screenshots and Chinese text input all passed.', {
          exact: true,
        })
        .waitFor();
    untranslated[name] = (
      await page.locator('.workspace-main, .main-content, main, .page').allInnerTexts()
    )
      .join('\n')
      .split('\n')
      .filter((s) => /[\u3400-\u9fff]/.test(s));
    await page.screenshot({ path: path.join(root, name.replaceAll(' ', '-') + '.png') });
  }
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse conversation list', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.keyboard.press('Control+b');
  await page.getByRole('button', { name: 'Conversations', exact: true }).click();
  assert.equal(
    await page.locator('#sidebar-sessions').isVisible(),
    false,
    'module navigation preserves collapsed preference',
  );
  await page.getByRole('button', { name: 'Expand conversation list', exact: true }).click();
  await page.getByRole('button', { name: 'Plugins', exact: true }).first().click();
  await page.getByRole('button', { name: /^Built-in plugins/ }).click();
  untranslated['Built-in plugins'] = (await page.locator('.plugin-library').innerText())
    .split('\n')
    .filter((s) => /[\u3400-\u9fff]/.test(s));
  await page.screenshot({ path: path.join(root, 'Built-in-plugins.png') });
  await page.getByRole('button', { name: 'View MiniMax Multimedia', exact: true }).click();
  untranslated['Plugin details'] = (await page.locator('.plugin-detail-page').innerText())
    .split('\n')
    .filter((s) => /[\u3400-\u9fff]/.test(s));
  await page.screenshot({ path: path.join(root, 'Plugin-details.png') });
  await page.getByRole('button', { name: 'Back to plugin list', exact: true }).click();
  await page.getByRole('button', { name: 'Studio', exact: true }).first().click();
  await openCanvas(page, fixture.canvasId);
  await page.getByRole('article', { name: /^设置，/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Configure node', exact: true }).click();
  const node = page.getByRole('dialog', { name: 'Node settings', exact: true });
  assert.equal(await node.getByLabel('Body', { exact: true }).inputValue(), '原始正文 Settings');
  await node.getByRole('button', { name: 'Close', exact: true }).click();
  const choices = await page.getByLabel('Node type', { exact: true }).innerText();
  untranslated['Node types'] = choices.split('\n').filter((s) => /[\u3400-\u9fff]/.test(s));
  await page.screenshot({ path: path.join(root, 'Canvas-nodes.png') });
  await writeFile(path.join(root, 'untranslated.json'), JSON.stringify(untranslated, null, 2));
  await app.close();
  app = await electron.launch({ args: ['.'], env });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.app-shell');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await page.getByLabel('界面语言 / Language', { exact: true }).inputValue(), 'en');
  await page.getByLabel('界面语言 / Language', { exact: true }).selectOption('zh-CN');
  await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.equal(
    await app.evaluate(
      ({ Menu }) => Menu.getApplicationMenu().items.find((item) => item.label === '编辑')?.label,
    ),
    '编辑',
  );
  for (const [module, lines] of Object.entries(untranslated)) {
    const unexpected = lines.filter(
      (line) => !['Language / 界面语言', '简体中文', '用户画布', '设置'].includes(line.trim()),
    );
    assert.deepEqual(unexpected, [], `Untranslated chrome in ${module}`);
  }
  assert.deepEqual(errors, []);
  console.log(
    'Language smoke passed: live switch, module navigation, persistence and switch back. ' + root,
  );
  console.log(JSON.stringify(untranslated, null, 2));
} finally {
  await app.close();
}
