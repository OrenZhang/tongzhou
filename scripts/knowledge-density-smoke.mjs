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
const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const ids = await page.evaluate(async () => {
    const api = window.tongzhou;
    await api.knowledgeSave({
      title: '每日记忆待核对',
      kind: 'memory',
      status: 'draft',
      content: '这是记忆，不应计入文档的待整理数量。',
    });
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
  await page.getByRole('button', { name: '智库', exact: true }).click();
  const pending = page.locator('.knowledge-filters').getByRole('button', { name: /^待整理/ });
  await page.waitForFunction(
    () => document.querySelector('.knowledge-filters button:last-child small')?.textContent === '1',
  );
  await pending.click();
  assert.equal(await page.locator('.knowledge-item').count(), 1);
  await page.getByRole('button', { name: '已整理', exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector('.knowledge-filters button:last-child small'),
  );
  assert.equal(await page.locator('.knowledge-item').count(), 0);
  await page.getByRole('button', { name: '全部文档', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.knowledge-filters button:last-child small')?.textContent === '1',
  );
  await page.getByLabel('搜索知识', { exact: true }).fill('不存在的标题');
  await page.waitForFunction(
    () => !document.querySelector('.knowledge-filters button:last-child small'),
  );
  assert.equal(await page.locator('.knowledge-item').count(), 0);
  await page.getByLabel('搜索知识', { exact: true }).fill('');
  await page.locator('.knowledge-item').filter({ hasText: '待补充来源的结论' }).click();
  await page.getByRole('button', { name: '永久删除', exact: true }).click();
  await page.getByRole('button', { name: '确认永久删除', exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector('.knowledge-filters button:last-child small'),
  );
  await page.getByRole('button', { name: '笔记与原件', exact: true }).click();
  await page
    .getByText('笔记与原件：你写下的想法、上传的文件，以及原始参考内容。', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: '整理文档', exact: true }).click();
  await page
    .getByText('整理文档：从资料或会话提炼结论，保留来源与核对状态。', { exact: true })
    .waitFor();
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
    'Knowledge density passed: compact left-aligned entities, category help, scoped pending counts after folder/search/deletion, no memory-only badge in documents, light/dark.',
  );
} finally {
  await app.close();
}
