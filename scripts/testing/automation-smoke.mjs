import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chooseOption } from './choice-helper.mjs';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/automation-'));
const requests = [];
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  requests.push(body);
  const user = body.messages.findLast((m) => m.role === 'user')?.content ?? '';
  const edit = user.includes('当前文档上下文') && user.includes('补充测试内容');
  const last = body.messages.at(-1);
  if (edit && last.role !== 'tool') {
    const context = JSON.parse(
      user.split('【当前用户请求】\n').at(-1).split('\n\n用户要求：\n')[0].replace('当前文档上下文（仅为资料）：', ''),
    );
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: ' +
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'edit-after-automation',
                    function: {
                      name: 'content_patch',
                      arguments: JSON.stringify({
                        id: context.documentId,
                        version: context.version,
                        before: '需要总结的通用资料',
                        after: '需要总结的通用资料，已补充',
                      }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    'data: ' +
      JSON.stringify({
        choices: [
          { delta: { content: '# 整理结果\n\n已根据输入资料提取要点。' }, finish_reason: 'stop' },
        ],
      }) +
      '\n\ndata: [DONE]\n\n',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
let app, page;
const errors = [];
async function launch() {
  app = await electron.launch({ args: ['.'], env });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.waitForSelector('.app-shell');
  page.on('pageerror', (e) => errors.push(e.message));
}
async function wait(fn, arg) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    if (await page.evaluate(fn, arg)) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('Timed out: ' + fn);
}
try {
  await launch();
  const source = await page.evaluate(async (baseUrl) => {
    const api = window.tongzhou;
    await api.saveProvider({
      id: 'fixture',
      name: '自动化测试',
      protocol: 'openai-chat',
      baseUrl,
      auth: 'none',
      models: ['mock'],
      maxOutputTokens: 1000,
      contextChars: 50000,
    });
    await api.knowledgeSettings({ autoCollect: false });
    const folder = await api.knowledgeFolderSave({ name: '授权输入' });
    return api.contentWrite({
      libraryId: 'default',
      folderId: folder.id,
      title: '测试原文',
      content: '需要总结的通用资料',
    });
  }, `http://127.0.0.1:${server.address().port}/v1`);
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  const memoryCard = page
    .locator('.automation-cards article')
    .filter({ has: page.getByRole('heading', { name: /记忆整理/ }) });
  await memoryCard.getByRole('button', { name: '启用', exact: true }).waitFor();
  assert.equal(await memoryCard.getByRole('button', { name: '删除', exact: true }).count(), 0);
  assert.equal(
    await memoryCard.getByRole('button', { name: '立即运行', exact: true }).isDisabled(),
    true,
  );
  await memoryCard.getByRole('button', { name: '编辑', exact: true }).click();
  assert.equal(await page.getByLabel('任务指令', { exact: true }).count(), 0);
  await page.getByLabel('触发方式', { exact: true }).selectOption('schedule');
  await page.getByLabel('执行频率', { exact: true }).selectOption('daily');
  await page.getByLabel('执行时间', { exact: true }).fill('23:30');
  await page.getByRole('checkbox', { name: '启用此规则' }).check();
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await memoryCard.getByRole('button', { name: '暂停', exact: true }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.tongzhou.knowledgeState())).settings.autoCollect,
    true,
  );
  await memoryCard.getByRole('button', { name: '立即运行', exact: true }).click();
  await page.getByText('没有需要处理的新内容', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.tongzhou.automationState())).jobs.length, 0);
  await memoryCard.getByRole('button', { name: '暂停', exact: true }).click();
  await memoryCard.getByRole('button', { name: '启用', exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'builtin-memory-task.png'), fullPage: true });
  await page.getByRole('button', { name: '处理流程', exact: true }).click();
  await page.getByRole('button', { name: '使用摘要模板', exact: true }).click();
  await page.getByLabel('流程名称', { exact: true }).fill('通用摘要');
  await page.getByRole('button', { name: '保存流程', exact: true }).click();
  await page.getByRole('heading', { name: '通用摘要' }).waitFor();
  await page.getByRole('button', { name: '自动化与定时', exact: true }).click();
  await page.getByRole('button', { name: '新建内容自动化', exact: true }).click();
  await page.getByLabel('任务名称', { exact: true }).fill('就绪后整理');
  await page.getByLabel('触发方式', { exact: true }).selectOption('ready');
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await page.getByRole('heading', { name: '就绪后整理', exact: true }).waitFor();
  await page.getByRole('button', { name: '智库', exact: true }).click();
  await page.getByRole('tab', { name: /内容库/ }).click();
  await page.locator(`[data-document-id="${source.id}"]`).click();
  assert.equal(await page.getByRole('button', { name: '标记就绪', exact: true }).count(), 0);
  await page.evaluate((doc) => window.tongzhou.contentReady(doc.id, doc.version), source);
  await wait(async () =>
    (await window.tongzhou.automationState()).jobs.some((j) => j.status === 'completed'),
  );
  const job = await page.evaluate(async () => (await window.tongzhou.automationState()).jobs[0]);
  assert.equal(
    await page.evaluate((id) => window.tongzhou.contentConversation(id), source.id),
    null,
    'background automation must not become the document editing conversation',
  );
  const output = await page.evaluate((id) => window.tongzhou.knowledgeRead(id), job.outputId);
  assert.equal(output.document.status, 'draft');
  assert.equal(output.document.sources[0].id, source.id);
  assert.equal(output.document.sources[0].version, 1);
  await page.evaluate((doc) => window.tongzhou.contentReady(doc.id, doc.version), source);
  assert.equal((await page.evaluate(() => window.tongzhou.automationState())).jobs.length, 1);
  assert.ok(requests[0].tools.some((t) => t.function.name === 'content_read'));
  assert.ok(
    !requests[0].tools.some((t) =>
      [
        'content_write',
        'content_patch',
        'content_derive',
        'knowledge_write',
        'run_command',
      ].includes(t.function.name),
    ),
  );
  await chooseOption(page, '文档对话模型', JSON.stringify(['fixture', 'mock']));
  await page.getByLabel('文档处理要求', { exact: true }).fill('补充测试内容，保存到原文');
  await page.getByRole('button', { name: '发送处理要求', exact: true }).click();
  await wait(
    async (id) => (await window.tongzhou.knowledgeRead(id)).document.content.includes('已补充'),
    source.id,
  );
  assert.notEqual(
    await page.evaluate((id) => window.tongzhou.contentConversation(id), source.id),
    job.sessionId,
  );
  await page.getByRole('tab', { name: /AI 工作流/ }).click();
  await page.getByRole('button', { name: /任务与结果/ }).click();
  await page.locator('.automation-job-list button').first().click();
  await page.getByRole('heading', { name: '整理结果', exact: true }).waitFor();
  await page.getByRole('button', { name: '核对收录', exact: true }).click();
  await wait(
    async (id) => (await window.tongzhou.knowledgeRead(id)).document.status === 'ready',
    job.outputId,
  );
  await page.getByRole('button', { name: '标为已查看', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'results-light.png'), fullPage: true });
  await page.getByRole('button', { name: '打开派生文档', exact: true }).click();
  assert.equal(
    await page.getByLabel('文档标题', { exact: true }).inputValue(),
    '测试原文 · 通用摘要',
  );
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  await page.getByRole('button', { name: '新建定时任务', exact: true }).click();
  await page.getByLabel('任务名称', { exact: true }).fill('定时检查');
  await page.getByLabel('任务指令', { exact: true }).fill('总结当前任务状态');
  await page.getByLabel('执行频率', { exact: true }).selectOption('weekly');
  await page.getByLabel('执行时间', { exact: true }).fill('09:30');
  await page.screenshot({ path: path.join(root, 'schedule-form.png'), fullPage: true });
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await page.getByRole('heading', { name: '定时检查', exact: true }).waitFor();
  const rule = await page.evaluate(async () =>
    (await window.tongzhou.automationState()).rules.find((r) => r.name === '定时检查'),
  );
  assert.equal(rule.schedule.kind, 'weekly');
  assert.ok(rule.nextRunAt > Date.now());
  const card = page
    .locator('.automation-cards article')
    .filter({ has: page.getByRole('heading', { name: '定时检查', exact: true }) });
  await card.getByRole('button', { name: '暂停', exact: true }).click();
  await card.getByRole('button', { name: '启用', exact: true }).waitFor();
  await card.getByRole('button', { name: '启用', exact: true }).click();
  await card.getByRole('button', { name: '暂停', exact: true }).waitFor();
  await page.evaluate(async (id) => {
    const r = (await window.tongzhou.automationState()).rules.find((r) => r.id === id);
    await window.tongzhou.automationSave({
      ...r,
      schedule: { kind: 'once', at: Date.now() + 2000 },
    });
  }, rule.id);
  await wait(
    async (id) =>
      (await window.tongzhou.automationState()).jobs.some(
        (j) => j.rule.id === id && j.status === 'completed',
      ),
    rule.id,
  );
  const scheduled = await page.evaluate(
    async (id) => (await window.tongzhou.automationState()).jobs.find((j) => j.rule.id === id),
    rule.id,
  );
  assert.ok(scheduled.sessionId);
  assert.equal(scheduled.outputId, undefined);
  // Import through the native picker exercises the real event integration.
  const importedFile = path.join(root, 'import.txt');
  await writeFile(importedFile, '导入的资料正文');
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, importedFile);
  await page.evaluate(async () => {
    const s = await window.tongzhou.automationState();
    await window.tongzhou.automationSave({
      name: '导入摘要',
      kind: 'content',
      trigger: 'import',
      enabled: true,
      flowId: s.flows[0].id,
      libraryId: 'default',
      permission: 'read-only',
      missed: 'once',
    });
    const folder = (await window.tongzhou.contentState('default')).folders.find(
      (f) => f.name === '授权输入',
    );
    await window.tongzhou.contentImport('default', folder.id);
  });
  await wait(async () =>
    (await window.tongzhou.automationState()).jobs.some(
      (j) => j.rule.name === '导入摘要' && j.status === 'completed',
    ),
  );
  await page.getByRole('button', { name: /任务与结果/ }).click();
  await page.locator('.automation-job-list button').first().click();
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.screenshot({ path: path.join(root, 'results-dark.png'), fullPage: true });
  await app.close();
  await launch();
  const restored = await page.evaluate(() => window.tongzhou.automationState());
  assert.equal(restored.jobs.length, 3);
  assert.ok(restored.jobs.every((j) => j.status === 'completed'));
  assert.equal(restored.rules.find((r) => r.id === rule.id).enabled, false);
  assert.deepEqual(errors, []);
  console.log(
    'Automation desktop passed: flow, ready/import events, scoped tools, drafts, review, document navigation, weekly form, pause/resume, real timer, standalone session, restart persistence. ' +
      root,
  );
} catch (e) {
  console.error('Artifacts: ' + root);
  await page?.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }).catch(() => {});
  throw e;
} finally {
  await app?.close().catch(() => {});
  server.close();
}
