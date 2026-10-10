import { openSidebar } from './navigation-helper.mjs';
import { seedKnowledge } from './knowledge-fixture.mjs';
import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('test-results', { recursive: true });
const profile = await mkdtemp(path.resolve('test-results/knowledge-density-'));
const env = { ...process.env, TONGZHOU_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const ids = await seedKnowledge(profile, async (api) => {
  await api.knowledgeSave(
    {
      title: '每日记忆待核对',
      kind: 'memory',
      status: 'draft',
      content: '这是记忆，不应计入文档的待整理数量。',
    },
    { memoryDate: '2026-10-09' },
  );
  const folder = await api.knowledgeFolderSave({ name: '已整理' });
  await api.knowledgeSave({
    title: '阅读笔记',
    kind: 'source',
    folderId: folder.id,
    content: '原始想法已记录。',
  });
  const doc = await api.knowledgeSave({
    title: '待补充来源的结论',
    kind: 'wiki',
    status: 'draft',
    content: '待补充来源的结论',
  });
  await api.knowledgeSave({
    title: '实体资料',
    kind: 'source',
    content: '长期使用中文。',
    assertions: [
      {
        subject: '本地知识库是否为空的检索与核对方法',
        subjectType: 'concept',
        relation: 'preference',
        object: '长期使用中文',
        quote: '长期使用中文。',
      },
    ],
  });
  return { doc: doc.id };
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
  await page.locator('.content-file-row').filter({ hasText: '待补充来源的结论' }).click();
  await page.getByLabel('文档内容', { exact: true }).waitFor();
  assert.equal(await page.locator('.knowledge-library').count(), 0);
  assert.equal(await page.locator('.content-file-row').filter({ hasText: '每日记忆' }).count(), 0);
  await page.getByLabel('搜索内容库', { exact: true }).fill('不存在的标题');
  await page.waitForFunction(() => document.querySelectorAll('.content-file-row').length === 0);
  await page.getByLabel('搜索内容库', { exact: true }).fill('');
  await openSidebar(page, '智库');
  await page.getByRole('tab', { name: /知识与记忆/ }).click();
  await page.locator('.ontology-entity').nth(1).waitFor();
  const layout = await page
    .locator('.ontology-entity')
    .nth(1)
    .evaluate((el) => ({
      justify: getComputedStyle(el).justifyContent,
      height: el.getBoundingClientRect().height,
    }));
  assert.equal(layout.justify, 'flex-start');
  assert.ok(layout.height <= 65, JSON.stringify(layout));
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.screenshot({ path: `test-results/knowledge-density-${theme}.png` });
  }
  assert.deepEqual(errors, []);
  console.log(
    'Knowledge density passed: compact entities, unified content tree/search, no legacy source page, memories excluded from content, light/dark.',
  );
} finally {
  await app.close();
}
