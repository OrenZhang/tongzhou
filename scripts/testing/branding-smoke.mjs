import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/cosail-brand-'));
const legacyProfile = path.join(root, 'Tongzhou');
const env = { ...process.env, TONGZHOU_DISABLE_UPDATES: '1' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
delete env.TONGZHOU_USER_DATA;
let app;
try {
  app = await electron.launch({ args: ['.'], env: { ...env, TONGZHOU_USER_DATA: legacyProfile } });
  let page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  const id = await page.evaluate(async () => {
    const session = await window.tongzhou.createSession();
    await window.tongzhou.updateSession(session.id, { title: '改名前的会话' });
    return session.id;
  });
  await app.close();
  app = undefined;
  const bootstrap = path.join(root, 'bootstrap.cjs');
  await writeFile(
    bootstrap,
    `const { app } = require('electron');
app.setPath('appData', ${JSON.stringify(root)});
require(${JSON.stringify(path.resolve('dist-electron/main.cjs'))});
`,
  );
  app = await electron.launch({ args: [bootstrap], env });
  page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  assert.deepEqual(
    await app.evaluate(({ app }) => ({ name: app.getName(), profile: app.getPath('userData') })),
    {
      name: 'CoSail',
      profile: legacyProfile,
    },
  );
  assert.equal(await page.title(), 'CoSail');
  assert.equal(await page.locator('.brand strong').innerText(), 'CoSail');
  assert.equal(
    await page.locator('.brand-mark svg polygon').first().getAttribute('fill'),
    'rgb(255,255,255)',
  );
  const sessions = await page.evaluate(async () => (await window.tongzhou.snapshot()).sessions);
  assert.equal(sessions.find((s) => s.id === id)?.title, '改名前的会话');
  await page.screenshot({ path: path.join(root, 'cosail-workspace.png') });
  console.log(
    'CoSail branding passed: window, sidebar, icon and legacy profile session preserved. ' + root,
  );
} finally {
  if (app) await app.close();
}
