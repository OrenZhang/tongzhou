import { openSidebar } from './navigation-helper.mjs';
import { seedKnowledge } from './knowledge-fixture.mjs';
import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('test-results', { recursive: true });
const profile = await mkdtemp(path.resolve('test-results/ontology-profile-'));
const env = { ...process.env, TONGZHOU_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const ids = await seedKnowledge(profile, async (api) => {
  const source = await api.knowledgeSave({
    title: '后台部署指南',
    kind: 'source',
    content: '# 部署说明\n\n后台依赖 PostgreSQL。\n启动命令 npm start。\n备选命令 npm run dev。',
  });
  const a = {
    subject: '小程序后台',
    subjectType: 'system',
    relation: 'command',
    object: 'npm start',
    quote: '启动命令 npm start。',
    sourceId: source.id,
  };
  const doc = await api.knowledgeSave({
    title: '后台运行知识',
    kind: 'wiki',
    status: 'draft',
    content: `# 运行与依赖\n\n参考 [[${source.id}|后台部署指南]]。\n\n后台依赖 PostgreSQL，使用 npm start 启动。`,
    sourceIds: [source.id],
    assertions: [
      a,
      {
        ...a,
        relation: 'depends_on',
        object: 'PostgreSQL',
        objectType: 'system',
        quote: '后台依赖 PostgreSQL。',
      },
    ],
  });
  await api.knowledgeSave({
    title: '启动方式待核对',
    kind: 'wiki',
    status: 'draft',
    content: '另一种启动方式',
    sourceIds: [source.id],
    assertions: [{ ...a, object: 'npm run dev', quote: '备选命令 npm run dev。' }],
  });
  return { source: source.id, doc: doc.id };
});
const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await openSidebar(page, '智库');
  await openSidebar(page, '智库');
  await page.getByRole('tab', { name: /^内容库/ }).click();
  assert.equal(await page.getByRole('button', { name: '查看来源记录', exact: true }).count(), 0);
  await page.locator('.content-file-row').filter({ hasText: '后台运行知识' }).click();
  await page.getByLabel('文档内容', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '知识与记忆', exact: false }).click();
  await page.locator('.ontology-fact').first().waitFor();
  assert.equal(await page.locator('.ontology-fact').count(), 3);
  assert.equal(await page.locator('.ontology-status.conflict').count(), 2);
  await page.locator('.ontology-fact').filter({ hasText: 'PostgreSQL' }).locator('summary').click();
  await page.getByText('后台依赖 PostgreSQL。', { exact: true }).waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.screenshot({ path: `test-results/ontology-${theme}.png` });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await page
    .locator('.ontology-fact')
    .filter({ hasText: 'PostgreSQL' })
    .getByRole('button', { name: /后台运行知识.*查看/ })
    .click();
  await page.getByLabel('文档内容', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('文档标题', { exact: true }).inputValue(), '后台运行知识');
  await page.evaluate(async (id) => {
    const doc = (await window.tongzhou.knowledgeRead(id)).document;
    await window.tongzhou.knowledgeSave({
      ...doc,
      assertions: doc.assertions.map((a, i) =>
        i === 0 ? { ...a, object: 'npm start --safe' } : a,
      ),
    });
  }, ids.doc);
  // Human correction is versioned; content need not be verbatim but its evidence must be.
  const saved = await page.evaluate((id) => window.tongzhou.knowledgeRead(id), ids.doc);
  assert.equal(saved.document.assertions[0].object, 'npm start --safe');
  assert.ok(saved.revisions.length >= 1);
  await openSidebar(page, '智库');
  await page.getByRole('tab', { name: '知识与记忆', exact: false }).click();
  await page.getByLabel('搜索知识关系', { exact: true }).fill('safe');
  await page.waitForFunction(() => document.querySelectorAll('.ontology-fact').length === 1);
  await page.evaluate(async (id) => {
    const r = await window.tongzhou.knowledgeRead(id);
    await window.tongzhou.knowledgeSave({
      ...r.document,
      content: r.document.content + '\n配置已变更。',
    });
  }, ids.source);
  await openSidebar(page, '智库');
  await page.getByRole('tab', { name: /^内容库/ }).click();
  await openSidebar(page, '智库');
  await page.getByRole('tab', { name: '知识与记忆', exact: false }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.ontology-status.stale').length === 3,
  );
  await page.reload();
  await openSidebar(page, '智库');
  await openSidebar(page, '智库');
  await page.getByRole('tab', { name: /^内容库/ }).click();
  await openSidebar(page, '智库');
  await page.getByRole('tab', { name: '知识与记忆', exact: false }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.ontology-status.stale').length === 3,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Ontology desktop passed: unified document source navigation, typed facts, conflicts, evidence, correction, versioning, query, source invalidation, persistence and light/dark.',
  );
} finally {
  await app.close();
}
