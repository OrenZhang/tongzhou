import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/knowledge-'));
const importedFile = path.join(root, '库存参考.md');
await writeFile(
  importedFile,
  '# 库存说明\n\n## 扣减规则\n订单确认后扣减库存，退款完成后回补库存。',
);
const requests = [];
let sourceId = '';
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const organize = body.messages.some(
    (m) => typeof m.content === 'string' && m.content.startsWith('整理以下知识资料'),
  );
  const tools = body.messages.filter((m) => m.role === 'tool');
  const call = (name, args) => ({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call-' + requests.length,
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });
  const output =
    organize && tools.length === 0
      ? call('knowledge_read', { id: sourceId })
      : organize && tools.length === 1
        ? call('knowledge_write', {
            title: '库存处理 Wiki',
            content:
              '# 库存处理\n\n确认订单后扣减，退款完成后回补。\n\n## 待验证\n并发订单场景仍需要测试。',
            sourceIds: [sourceId],
            tags: ['订单', '库存'],
          })
        : {
            choices: [
              {
                delta: {
                  content: organize
                    ? '已保存库存处理 Wiki 草稿，保留来源及待验证事项。'
                    : '根据知识资料：订单确认后扣减库存。',
                },
                finish_reason: 'stop',
              },
            ],
          };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end('data: ' + JSON.stringify(output) + '\n\ndata: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], env });
const errors = [];
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForSelector('.app-shell');
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, importedFile);
  const sessionId = await page.evaluate(async (base) => {
    await window.tongzhou.saveProvider({
      id: 'knowledge-fixture',
      name: '知识测试模型',
      protocol: 'openai-chat',
      baseUrl: base,
      auth: 'none',
      models: ['fixture'],
      maxOutputTokens: 8192,
      contextChars: 0,
    });
    const s = await window.tongzhou.createSession();
    await window.tongzhou.updateSession(s.id, {
      providerId: 'knowledge-fixture',
      model: 'fixture',
      title: '知识联动测试',
    });
    return s.id;
  }, `http://127.0.0.1:${server.address().port}/v1`);
  await page.locator(`[data-session-id="${sessionId}"]`).click();
  await page.getByRole('button', { name: '知识库', exact: true }).click();
  await page.getByRole('button', { name: '导入文件', exact: true }).click();
  await page.getByRole('heading', { name: '库存参考.md', exact: true }).waitFor();
  sourceId = await page.evaluate(
    async () =>
      (await window.tongzhou.knowledgeState()).documents.find((d) => d.title === '库存参考.md').id,
  );
  await page.getByRole('button', { name: '引用到当前会话', exact: true }).click();
  await page.getByRole('button', { name: '取消会话引用', exact: true }).waitFor();
  await page.getByRole('button', { name: '新建笔记', exact: true }).click();
  await page.getByLabel('知识标题', { exact: true }).fill('团队实践');
  await page
    .getByLabel('知识正文', { exact: true })
    .fill('# 接口约定\n\n错误响应统一返回 code 和 message。');
  await page.getByLabel('知识标签', { exact: true }).fill('接口,规范');
  await page.getByLabel('知识标签', { exact: true }).press('Enter');
  await page.getByRole('button', { name: '预览', exact: true }).click();
  await page.locator('.knowledge-edit-preview h1').waitFor();
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await page.getByRole('heading', { name: '团队实践', exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('知识正文', { exact: true }).fill('# 接口约定\n\n错误响应包含 traceId。');
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await page.locator('.knowledge-provenance summary').click();
  await page.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await page.getByText('错误响应统一返回 code 和 message。', { exact: true }).waitFor();
  await page.getByLabel('搜索知识', { exact: true }).fill('库存');
  await page.locator('.knowledge-item').filter({ hasText: '库存参考.md' }).click();
  await page.getByRole('button', { name: '让 Agent 整理', exact: true }).click();
  await page
    .getByText('已保存库存处理 Wiki 草稿，保留来源及待验证事项。', { exact: true })
    .waitFor();
  await page.waitForFunction(
    async () => !(await window.tongzhou.snapshot()).runs.some((r) => r.status === 'running'),
  );
  await page.getByRole('button', { name: '知识库', exact: true }).click();
  await page.locator('.knowledge-item').filter({ hasText: '库存处理 Wiki' }).click();
  await page.getByText('AI 整理待核对', { exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('已核对内容，允许按需引用到会话', { exact: true }).check();
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => {})),
      ),
    );
    await page.screenshot({ path: `test-results/knowledge-${theme}.png` });
  }
  await page.locator(`[data-session-id="${sessionId}"]`).click();
  await page.getByLabel('消息', { exact: true }).fill('库存什么时候扣减？');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('根据知识资料：订单确认后扣减库存。', { exact: true }).waitFor();
  await page.waitForFunction(async () =>
    (await window.tongzhou.knowledgeState()).documents.some((d) => d.kind === 'memory'),
  );
  assert.ok(requests.at(-1).messages[0].content.includes('订单确认后扣减库存'));
  await page.getByRole('button', { name: '知识库', exact: true }).click();
  await page.getByRole('button', { name: '记忆', exact: true }).click();
  await page.locator('.knowledge-item').filter({ hasText: '知识联动测试' }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: '知识库', exact: true }).click();
  const state = await page.evaluate(() => window.tongzhou.knowledgeState());
  assert.equal(state.documents.filter((d) => d.kind === 'wiki').length, 1);
  assert.equal(state.documents.filter((d) => d.kind === 'memory').length, 1);
  const catalog = await page.evaluate(() => window.tongzhou.clientMethods());
  assert.ok(catalog.methods.some((m) => m.name === 'knowledgeRead'));
  assert.ok((await readFile(path.join(state.root, 'index.md'), 'utf8')).includes('库存处理 Wiki'));
  await page.getByLabel('搜索知识', { exact: true }).fill('');
  await page
    .locator('.knowledge-filters')
    .getByRole('button', { name: '全部', exact: true })
    .click();
  await page.locator('.knowledge-item').filter({ hasText: '库存参考.md' }).click();
  assert.equal(await page.getByRole('button', { name: '永久删除', exact: true }).count(), 0);
  await page
    .locator('.knowledge-document-actions')
    .getByRole('button', { name: '归档', exact: true })
    .click();
  await page
    .locator('.knowledge-filters')
    .getByRole('button', { name: '归档', exact: true })
    .click();
  await page.locator('.knowledge-item').filter({ hasText: '库存参考.md' }).click();
  await page.getByRole('button', { name: '永久删除', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await page.evaluate(() => window.tongzhou.knowledgeState())).archived.length, 1);
  await page.getByRole('button', { name: '永久删除', exact: true }).click();
  await page.getByRole('button', { name: '确认永久删除', exact: true }).click();
  await page.getByText('资料已永久删除', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.tongzhou.knowledgeState())).archived.length, 0);
  assert.ok((await readFile(importedFile, 'utf8')).includes('订单确认后扣减库存'));
  await page
    .locator('.knowledge-filters')
    .getByRole('button', { name: 'Wiki', exact: true })
    .click();
  await page.locator('.knowledge-item').filter({ hasText: '库存处理 Wiki' }).click();
  await page.getByText('来源已删除，需要复核', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '库存参考.md · 来源已删除' }).isDisabled(),
    true,
  );
  await page.reload();
  assert.equal((await page.evaluate(() => window.tongzhou.knowledgeState())).archived.length, 0);
  assert.deepEqual(errors, []);
  console.log(
    'Knowledge desktop passed: import, notes, revisions, model tool synthesis, source links, scoped context, auto capture, reload, client catalog, light/dark, archive deletion with confirmation and missing source indicators.',
  );
} finally {
  await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
