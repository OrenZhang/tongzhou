import { chooseOption } from './choice-helper.mjs';
import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/content-'));
const requests = [];
async function waitFor(page, fn, arg) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await page.evaluate(fn, arg)) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error('Condition did not become true: ' + fn.toString());
}
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const lastUser = body.messages.findLastIndex((m) => m.role === 'user');
  const prompt = body.messages[lastUser].content;
  const context = JSON.parse(
    prompt
      .split('【当前用户请求】\n')
      .at(-1)
      .split('\n\n用户要求：\n')[0]
      .replace('当前文档上下文（仅为资料）：', ''),
  );
  const done = body.messages.slice(lastUser + 1).some((m) => m.role === 'tool');
  const split = prompt.includes('拆分原文');
  const result = done
    ? { choices: [{ delta: { content: '已保存，结果可以在内容库查看。' }, finish_reason: 'stop' }] }
    : {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-' + requests.length,
                  function: {
                    name: split ? 'content_derive' : 'content_patch',
                    arguments: JSON.stringify(
                      split
                        ? {
                            sourceId: context.documentId,
                            version: context.version,
                            mode: 'split',
                            parts: [
                              { title: '片段一', start: 0, end: 2 },
                              { title: '片段二', start: 2, end: 4 },
                            ],
                          }
                        : {
                            id: context.documentId,
                            version: context.version,
                            before: context.selection?.text ?? '甲乙',
                            after: '甲乙（已优化）',
                          },
                    ),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end('data: ' + JSON.stringify(result) + '\n\ndata: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
let app;
const launch = async () => {
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1080 });
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
      name: '内容测试',
      protocol: 'openai-chat',
      baseUrl,
      auth: 'none',
      models: ['mock'],
      maxOutputTokens: 1000,
      contextChars: 50000,
    });
    await window.tongzhou.knowledgeSettings({ autoCollect: false });
  }, `http://127.0.0.1:${server.address().port}/v1`);
  await page.getByRole('button', { name: '智库', exact: true }).click();
  const chatToggle = page.getByRole('button', { name: '切换文档对话', exact: true });
  await page.getByRole('complementary', { name: '文档对话', exact: true }).waitFor();
  await page.getByText('尚未选择文档', { exact: true }).waitFor();
  await chatToggle.click();
  assert.equal(await page.getByRole('complementary', { name: '文档对话', exact: true }).count(), 0);
  await chatToggle.click();
  await page.getByRole('complementary', { name: '文档对话', exact: true }).waitFor();
  assert.equal(await page.getByLabel('内容库', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '新建内容库', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '管理内容库', exact: true }).count(), 0);
  const library = { id: 'default' };
  const legacy = await page.evaluate(async () => {
    const api = window.tongzhou;
    const library = await api.contentLibrarySave({ name: '历史内容库' });
    const doc = await api.contentWrite({
      libraryId: library.id,
      title: '保留的历史文档',
      content: '原有内容',
    });
    return { library, doc };
  });
  await page.getByRole('button', { name: '新建目录', exact: true }).click();
  await page.getByLabel('目录名称', { exact: true }).fill('文章');
  await page
    .getByRole('dialog', { name: '新建文档目录', exact: true })
    .screenshot({ path: path.join(root, 'folder-dialog.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '保存目录', exact: true }).click();
  await page.getByRole('button', { name: '新建文档并打开对话', exact: true }).click();
  await page.getByLabel('文档内容', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('文档标题', { exact: true }).isEditable(), false);
  assert.equal(await page.getByRole('button', { name: '保存', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('文档处理 Agent', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.getByLabel('文档标题', { exact: true }).fill('通用文章');
  await page.getByLabel('文档正文', { exact: true }).fill('甲乙丙丁');
  await waitFor(
    page,
    async (id) =>
      (await window.tongzhou.contentState(id)).documents.some(
        (d) => d.title === '通用文章' && d.excerpt === '甲乙丙丁',
      ),
    library.id,
  );
  await page.getByRole('button', { name: '完成编辑', exact: true }).click();
  await page.getByLabel('文档内容', { exact: true }).filter({ hasText: '甲乙丙丁' }).waitFor();
  assert.equal(await page.getByLabel('文档正文', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const doc = await page.evaluate(
    async (id) =>
      (await window.tongzhou.contentState(id)).documents.find((d) => d.title === '通用文章'),
    library.id,
  );
  assert.ok(doc.folderId);
  const branch = page.locator(`[data-folder-id="${doc.folderId}"]`);
  await branch.locator(`[data-document-id="${doc.id}"]`).waitFor();
  assert.equal(await page.locator('.content-document-list').count(), 0);
  assert.equal(await branch.locator('.content-file-row small').count(), 0);
  await page.getByRole('button', { name: '折叠目录 文章', exact: true }).click();
  assert.equal(await branch.locator(`[data-document-id="${doc.id}"]`).count(), 0);
  await page.getByLabel('搜索内容库', { exact: true }).fill('甲乙');
  await branch.locator(`[data-document-id="${doc.id}"]`).waitFor();
  await page.getByLabel('搜索内容库', { exact: true }).fill('');
  await page.getByRole('button', { name: '展开目录 文章', exact: true }).waitFor();
  await page.getByRole('button', { name: '展开目录 文章', exact: true }).click();

  assert.equal(await page.getByRole('switch', { name: /允许 AI 与客户端使用/ }).count(), 0);
  await page.getByLabel('更多文档操作', { exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '标记就绪', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '来源与整理', exact: true }).count(), 0);
  await page.getByLabel('更多文档操作', { exact: true }).click();
  await page.getByLabel('文档正文', { exact: true }).click();
  await page
    .getByLabel('文档正文', { exact: true })
    .press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
  await page.getByLabel('文档正文', { exact: true }).press('Shift+ArrowRight');
  await page.getByLabel('文档正文', { exact: true }).press('Shift+ArrowRight');
  await page.getByText('选中 2 字符', { exact: true }).waitFor();
  await chooseOption(page, '文档对话模型', JSON.stringify(['fixture', 'mock']));
  const chatLayout = await page.locator('.content-chat').evaluate((chat) => {
    const input = chat.querySelector('textarea').getBoundingClientRect();
    const controls = chat.querySelector('.content-chat-settings').getBoundingClientRect();
    const messages = chat.querySelector('.content-chat-messages').getBoundingClientRect();
    const compose = chat.querySelector('.content-chat-compose').getBoundingClientRect();
    const send = chat.querySelector('.content-chat-send').getBoundingClientRect();
    return {
      controlsBelowInput: controls.top >= input.bottom,
      composeBelowMessages: compose.top >= messages.bottom - 1,
      sendOnRight: send.left >= controls.right,
      noOverflow: chat.scrollWidth <= chat.clientWidth,
      compact: compose.height < 150,
    };
  });
  assert.ok(Object.values(chatLayout).every(Boolean), JSON.stringify(chatLayout));
  const promptBox = page.getByLabel('文档处理要求', { exact: true });
  await promptBox.fill('第一行');
  await promptBox.press('Shift+Enter');
  await promptBox.press('a');
  assert.equal(await promptBox.inputValue(), '第一行\na');
  const composingEnter = await promptBox.evaluate((el) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(composingEnter, false);
  assert.equal(await promptBox.inputValue(), '第一行\na');
  await promptBox.fill('优化选段并保存');
  await promptBox.press('Enter');
  await waitFor(
    page,
    async (id) =>
      (await window.tongzhou.knowledgeRead(id)).document.content === '甲乙（已优化）丙丁',
    doc.id,
  );
  await waitFor(page, async () =>
    (await window.tongzhou.snapshot()).runs.every((r) => r.status !== 'running'),
  );
  await waitFor(
    page,
    () => document.querySelector('[aria-label="文档正文"]')?.value === '甲乙（已优化）丙丁',
  );
  await page.getByLabel('更多文档操作', { exact: true }).click();
  await page.getByRole('button', { name: '版本记录', exact: true }).click();
  await page.getByRole('button', { name: '恢复此版本', exact: true }).first().click();
  await waitFor(
    page,
    () => document.querySelector('[aria-label="文档正文"]')?.value === '甲乙丙丁',
  );
  const clearSelection = page.getByRole('button', { name: '清除选段', exact: true });
  if (await clearSelection.count()) await clearSelection.click();
  await page.getByLabel('文档处理要求', { exact: true }).fill('拆分原文成两份文档，保留原文');
  await page.getByRole('button', { name: '发送处理要求', exact: true }).click();
  await waitFor(
    page,
    async (id) =>
      (await window.tongzhou.contentState(id)).documents.some((d) => d.title === '片段二'),
    library.id,
  );
  await waitFor(page, async () =>
    (await window.tongzhou.snapshot()).runs.every((r) => r.status !== 'running'),
  );
  const parts = await page.evaluate(async (id) => {
    const state = await window.tongzhou.contentState(id);
    return Promise.all(
      state.documents
        .filter((d) => d.title.startsWith('片段'))
        .sort((a, b) => a.derivation.index - b.derivation.index)
        .map(async (d) => (await window.tongzhou.knowledgeRead(d.id)).document),
    );
  }, library.id);
  assert.equal(parts.length, 2);
  assert.equal(parts.map((p) => p.content).join(''), '甲乙丙丁');
  assert.ok(parts.every((p) => p.sources.some((s) => s.id === doc.id)));
  await page.locator('.content-file-row').filter({ hasText: '片段一' }).waitFor();
  await page.locator('.content-file-row').filter({ hasText: '片段二' }).waitFor();
  await page.getByLabel('更多文档操作', { exact: true }).click();
  await page.getByRole('button', { name: '版本记录', exact: true }).click();
  const positions = await branch.evaluate((el) => ({
    folder: el.querySelector('.wiki-folder-name svg').getBoundingClientRect().x,
    files: [...el.querySelectorAll('.content-file-row svg')].map(
      (icon) => icon.getBoundingClientRect().x,
    ),
  }));
  assert.ok(
    positions.files.every((x) => x > positions.folder),
    'Files must be indented beneath their directory',
  );
  assert.ok(
    positions.files.every((x) => x === positions.files[0]),
    'Sibling file icons must align',
  );
  const nested = await page.evaluate(async (parentId) => {
    const api = window.tongzhou;
    const child = await api.knowledgeFolderSave({ name: '参考资料', parentId });
    const document = await api.contentWrite({
      libraryId: 'default',
      folderId: child.id,
      title: '参考文档',
      content: '嵌套目录里的正文\n\n' + '长文档滚动验证。\n\n'.repeat(100),
    });
    return { child, document };
  }, doc.folderId);
  const nestedFile = branch.locator(
    `[data-folder-id="${nested.child.id}"] [data-document-id="${nested.document.id}"]`,
  );
  await nestedFile.click();
  await waitFor(page, () =>
    document.querySelector('[aria-label="文档内容"]')?.textContent.includes('嵌套目录里的正文'),
  );
  assert.equal(await page.locator('.content-document-path').innerText(), '文章 / 参考资料');
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1000, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    const fixedLayout = await page.locator('.knowledge-content-page').evaluate((outer) => {
      const editor = outer.querySelector('.content-body-preview');
      const compose = outer.querySelector('.content-chat-compose');
      const chat = outer.querySelector('.content-chat-messages');
      const before = compose.getBoundingClientRect();
      editor.scrollTop = 500;
      chat.scrollTop = 500;
      outer.scrollTop = 500;
      const after = compose.getBoundingClientRect();
      return {
        documentScrolls: editor.scrollTop > 0,
        pageDoesNotScroll: outer.scrollTop === 0,
        fixedComposer: before.top === after.top,
        composerVisible: after.bottom <= innerHeight && after.top >= 0,
        chatHasSpace: chat.clientHeight > 40,
        noHorizontalOverflow: outer.scrollWidth <= outer.clientWidth,
      };
    });
    assert.ok(Object.values(fixedLayout).every(Boolean), JSON.stringify({ viewport, fixedLayout }));
    await page.screenshot({
      path: path.join(root, `fixed-${viewport.width}.png`),
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 1440, height: 1080 });

  await page.locator(`[data-document-id="${doc.id}"]`).click();
  await page.getByLabel('文档内容', { exact: true }).filter({ hasText: '甲乙丙丁' }).waitFor();
  assert.equal(await page.getByLabel('文档正文', { exact: true }).count(), 0);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.locator('.knowledge-page').evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({
      path: path.join(root, `workspace-${theme}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await app.close();
  app = undefined;
  page = await launch();
  await page.getByRole('button', { name: '智库', exact: true }).click();
  assert.equal(await page.getByLabel('内容库', { exact: true }).count(), 0);
  await page.locator('.content-file-row').filter({ hasText: '通用文章' }).click();
  await page.getByLabel('文档内容', { exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.getByLabel('文档正文', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('文档正文', { exact: true }).inputValue(), '甲乙丙丁');
  await page.locator('.content-chat-message.user').filter({ hasText: '优化选段并保存' }).waitFor();
  await page.getByLabel('文档正文', { exact: true }).fill('本地尚未保存的草稿');
  await page.evaluate(async (id) => {
    const d = (await window.tongzhou.knowledgeRead(id)).document;
    await window.tongzhou.contentWrite({
      id,
      version: d.version,
      libraryId: d.libraryId,
      title: d.title,
      content: '外部保存的新版本',
    });
  }, doc.id);
  await page.getByRole('alert').filter({ hasText: '本地草稿仍保留' }).waitFor();
  assert.equal(
    await page.getByLabel('文档正文', { exact: true }).inputValue(),
    '本地尚未保存的草稿',
  );
  assert.equal(
    (await page.evaluate(async (id) => (await window.tongzhou.knowledgeRead(id)).document, doc.id))
      .content,
    '外部保存的新版本',
  );
  await page.getByLabel('更多文档操作', { exact: true }).click();
  await page.getByRole('button', { name: '另存副本', exact: true }).click();
  await waitFor(
    page,
    async (id) =>
      (await window.tongzhou.contentState(id)).documents.some(
        (d) => d.title === '通用文章 · 副本' && d.excerpt === '本地尚未保存的草稿',
      ),
    library.id,
  );
  assert.equal(
    (
      await page.evaluate(
        async (id) => (await window.tongzhou.contentState(id)).documents,
        legacy.library.id,
      )
    ).length,
    1,
  );
  assert.equal(await page.getByRole('switch', { name: /允许 AI 与客户端使用/ }).count(), 0);
  await page.getByLabel('更多文档操作', { exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '标记就绪', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '来源与整理', exact: true }).count(), 0);
  await page.getByLabel('更多文档操作', { exact: true }).click();
  await page.screenshot({
    path: path.join(root, 'directories-without-switch.png'),
    animations: 'disabled',
  });
  assert.deepEqual(errors, []);
  console.log(
    'Content workspace passed: simplified library toolbar, retained legacy data, folders, autosave, selection context, AI patch, version restore, lossless split, provenance, restart conversation, default-library isolation, light/dark. ' +
      root,
  );
} catch (error) {
  if (app) {
    const pages = app.windows();
    if (pages[0])
      await pages[0]
        .screenshot({ path: path.join(root, 'failure.png'), fullPage: true })
        .catch(() => {});
  }
  console.error('Artifacts:', root);
  throw error;
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
