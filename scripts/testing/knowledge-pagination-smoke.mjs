import { openSidebar } from './navigation-helper.mjs';
import { seedKnowledge } from './knowledge-fixture.mjs';
import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const profile = await mkdtemp(path.resolve('test-results/knowledge-pagination-'));
await seedKnowledge(profile, async (api) => {
  for (let i = 0; i < 105; i++)
    await api.knowledgeSave({
      title: i === 0 ? 'sentinel 待核对记忆' : `每日记忆 ${String(i).padStart(3, '0')}`,
      kind: 'memory',
      status: i === 0 ? 'draft' : 'ready',
      content: '保留旧的每日记忆，新增普通资料不能把它们从列表挤走。',
    });
  for (let i = 0; i < 110; i++)
    await api.knowledgeSave({
      title: `较新普通资料 ${i}`,
      kind: 'source',
      content: '普通资料正文',
    });
});
const env = { ...process.env, TONGZHOU_USER_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
try {
  const page = await app.firstWindow();
  const waitForMemoryPage = (visible, total) =>
    page.waitForFunction(
      ({ visible, total }) => {
        const list = document.querySelector('.knowledge-list');
        const count = document.querySelector('.knowledge-count')?.textContent;
        // Switching "pending" filters the old page immediately; the new server total
        // and pagination arrive after the debounced request. Wait for the full result.
        return (
          list?.getAttribute('aria-busy') === 'false' &&
          list.querySelectorAll('.knowledge-item').length === visible &&
          count?.replace(/\s+/g, ' ').trim() === `${visible} 项结果 · 共 ${total} 份记忆` &&
          (total > 100 || !document.querySelector('.knowledge-pagination'))
        );
      },
      { visible, total },
    );
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.app-shell');
  await openSidebar(page, '智库');
  await page.getByRole('tab', { name: /知识与记忆/ }).click();
  await page.getByRole('button', { name: '每日记忆', exact: true }).first().click();
  await waitForMemoryPage(100, 105);
  assert.match(await page.locator('.knowledge-count').innerText(), /105/);
  assert.match(await page.getByRole('button', { name: /^待整理/ }).innerText(), /1/);
  await page.screenshot({ path: path.join(profile, 'daily-memory-first-page.png') });
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await waitForMemoryPage(5, 105);
  assert.equal(await page.locator('.knowledge-item').filter({ hasText: 'sentinel' }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true);
  await page.screenshot({ path: path.join(profile, 'daily-memory-last-page.png') });
  await page.getByRole('button', { name: /^待整理/ }).click();
  await waitForMemoryPage(1, 1);
  assert.equal(await page.locator('.knowledge-item').filter({ hasText: 'sentinel' }).count(), 1);
  assert.equal(await page.locator('.knowledge-pagination').count(), 0);
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await waitForMemoryPage(100, 105);
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await waitForMemoryPage(5, 105);
  await page.getByLabel('搜索知识', { exact: true }).fill('sentinel');
  await waitForMemoryPage(1, 1);
  assert.match(await page.locator('.knowledge-count').innerText(), /共 1/);
  assert.equal(await page.locator('.knowledge-pagination').count(), 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(profile, 'daily-memory-search.png') });
  console.log(JSON.stringify({ status: 'passed', profile, memories: 105, newerDocuments: 110 }));
} finally {
  await app.close();
}
