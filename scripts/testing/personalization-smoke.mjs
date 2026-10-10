import { openSidebar } from './navigation-helper.mjs';
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/personalization-'));
await build({
  entryPoints: ['electron/services/storage/store.ts'],
  outfile: path.join(root, 'store.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
});
const { Store } = createRequire(import.meta.url)(path.join(root, 'store.cjs'));
const store = new Store(path.join(root, 'profile/tongzhou.db'), {
  encrypt: (s) => s,
  decrypt: (s) => s,
});
const session = store.createSession();
const docId = randomUUID(),
  entryId = randomUUID();
store.put('automation', {
  id: 'fe89d222-6dfb-4caa-9363-9f194710303e',
  version: 1,
  name: '记忆整理',
  kind: 'memory',
  enabled: false,
  trigger: 'idle',
  permission: 'read-only',
  missed: 'once',
  createdAt: Date.now(),
});
const memory = {
  id: docId,
  kind: 'memory',
  title: '每日偏好来源',
  memoryDate: '2026-10-07',
  status: 'draft',
  tags: [],
  content: '以后回答先给结论',
  version: 1,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  origin: 'automatic',
  sources: [],
  memoryEntries: [
    {
      id: entryId,
      category: 'preference',
      subject: '沟通方式',
      relation: '表达偏好',
      content: '以后回答先给结论',
      quotes: ['以后回答先给结论'],
      sources: [],
      sessionId: session.id,
      occurredAt: Date.now(),
    },
  ],
};
const directory = path.join(root, 'profile', '.tzhou', 'knowledge', 'documents');
await mkdir(directory, { recursive: true });
const { content, ...metadata } = memory;
await writeFile(
  path.join(directory, docId + '.md'),
  '---\n' + JSON.stringify(metadata, null, 2) + '\n---\n' + content,
);
store.close();
const requests = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  requests.push(JSON.parse(raw));
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    'data: ' +
      JSON.stringify({
        choices: [{ delta: { content: '已按当前偏好回答。' }, finish_reason: 'stop' }],
      }) +
      '\n\ndata: [DONE]\n\n',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
let app;
const launch = async () => {
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.waitForSelector('.app-shell');
  return page;
};
try {
  let page = await launch();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluate(async (baseUrl) => {
    await window.tongzhou.saveProvider({
      id: 'fixture',
      name: 'Fixture',
      protocol: 'openai-chat',
      baseUrl,
      auth: 'none',
      models: ['mock'],
      maxOutputTokens: 1000,
      contextChars: 50000,
    });
  }, `http://127.0.0.1:${server.address().port}/v1`);
  const open = async () => {
    await openSidebar(page, '智库');
    await page.getByRole('tab', { name: '个性与偏好' }).click();
    await page.getByLabel('补充要求', { exact: true }).waitFor();
  };
  await open();
  await page.getByRole('button', { name: '简洁直接', exact: true }).click();
  await page.getByLabel('怎么称呼你', { exact: true }).fill('小林');
  await page.getByLabel('回复语言', { exact: true }).selectOption('zh');
  assert.equal(await page.getByLabel('回答长度', { exact: true }).inputValue(), 'concise');
  await page.getByText('调整助手性格（高级）', { exact: true }).click();
  await page.getByLabel('同舟的通用性格', { exact: true }).fill('温暖但直截了当，像可靠的同事');
  await page.getByLabel('补充要求', { exact: true }).fill('称呼我小林，使用中文');
  await page.getByLabel('沟通方式', { exact: true }).check();
  await page.getByRole('button', { name: '保存偏好', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  const run = async () => {
    const id = await page.evaluate(
      async (sessionId) =>
        window.tongzhou.run({
          sessionId,
          providerId: 'fixture',
          model: 'mock',
          agentId: '',
          prompt: '解释版本控制的用途',
        }),
      session.id,
    );
    const deadline = Date.now() + 30000;
    let completed = false;
    while (Date.now() < deadline) {
      const run = (await page.evaluate(() => window.tongzhou.snapshot())).runs.find(
        (r) => r.id === id,
      );
      if (run?.status === 'failed') throw new Error(run.error);
      if (run?.status === 'completed') {
        completed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(completed, true);
    return requests.at(-1).messages.find((m) => m.role === 'system').content;
  };
  let system = await run();
  assert.match(system, /温暖但直截了当/);
  assert.match(system, /称呼我小林/);
  assert.match(system, /以后回答先给结论/);
  assert.match(system, /回答简短，先给结论/);
  assert.match(system, /默认使用中文/);
  assert.match(system, /语气直接、专业/);
  for (const theme of ['light', 'dark']) {
    await page.locator('.knowledge-page').evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.screenshot({
      path: path.join(root, `preferences-${theme}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 900, height: 700 });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await page.getByText('调整助手性格（高级）', { exact: true }).click();
  await page.locator('.knowledge-page').evaluate((el) => {
    el.scrollTop = 0;
  });
  assert.equal(
    await page
      .locator('.personalization-panel')
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    true,
  );
  const saveBounds = await page
    .getByRole('button', { name: '保存偏好', exact: true })
    .boundingBox();
  assert.ok(saveBounds && saveBounds.y >= 0 && saveBounds.y + saveBounds.height <= 700);
  await page.screenshot({ path: path.join(root, 'preferences-small.png'), fullPage: true });
  await app.close();
  app = undefined;
  page = await launch();
  await open();
  assert.equal(
    await page.getByLabel('补充要求', { exact: true }).inputValue(),
    '称呼我小林，使用中文',
  );
  assert.equal(await page.getByLabel('沟通方式', { exact: true }).isChecked(), true);
  await page.getByLabel('沟通方式', { exact: true }).uncheck();
  await page.getByLabel('补充要求', { exact: true }).fill('称呼我小周');
  await page.getByLabel('怎么称呼你', { exact: true }).fill('小周');
  await page.getByRole('button', { name: '保存偏好', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  system = await run();
  assert.match(system, /称呼我小周/);
  assert.doesNotMatch(system, /称呼我小林|以后回答先给结论/);
  await page.getByRole('switch', { name: '使用我的个性与偏好', exact: true }).uncheck();
  await page.getByRole('button', { name: '保存偏好', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  system = await run();
  assert.doesNotMatch(system, /称呼我小周|温暖但直截了当/);
  const methods = await page.evaluate(() => window.tongzhou.clientMethods());
  for (const name of ['personalizationState', 'savePersonalization'])
    assert.equal(
      methods.methods.find((m) => m.name === name).access,
      name === 'personalizationState' ? 'query' : 'change',
    );
  await page.getByLabel('怎么称呼你', { exact: true }).fill('未保存的称呼');
  await page.getByRole('button', { name: '撤销修改', exact: true }).click();
  assert.equal(await page.getByLabel('怎么称呼你', { exact: true }).inputValue(), '小周');
  await page.getByRole('button', { name: '查看每日记忆', exact: true }).click();
  await page.getByRole('tab', { name: /知识与记忆/ }).waitFor();
  await open();
  const before = (await page.evaluate(() => window.tongzhou.snapshot())).sessions.length;
  await page.getByRole('button', { name: '保存并去试聊', exact: true }).click();
  await page.locator('.composer').waitFor();
  assert.equal((await page.evaluate(() => window.tongzhou.snapshot())).sessions.length, before + 1);
  assert.deepEqual(errors, []);
  console.log(
    `Personalization desktop passed: save, confirm recall, prompt refresh, unselect, disable, restart persistence, manual-only APIs, light/dark screenshots. ${root}`,
  );
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
