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
  let output =
    organize && tools.length === 0
      ? call('knowledge_read', { id: sourceId })
      : organize && tools.length === 1
        ? call('knowledge_write', {
            title: '库存处理 Wiki',
            content:
              '# 库存处理\n\n确认订单后扣减，退款完成后回补。\n\n## 待验证\n并发订单场景仍需要测试。',
            sourceIds: [sourceId],
            assertions: [
              {
                subject: '订单',
                subjectType: 'concept',
                relation: 'fact',
                object: '确认后扣减库存',
                sourceId,
                quote: '订单确认后扣减库存',
              },
            ],
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
  const memoryPrompt = body.messages.find(
    (m) =>
      m.role === 'user' &&
      typeof m.content === 'string' &&
      m.content.startsWith('你是同舟后台记忆整理 Agent'),
  )?.content;
  if (!organize && !memoryPrompt) {
    if (!tools.length) output = call('knowledge_search', { query: '库存扣减' });
    else if (tools.length === 1) output = call('knowledge_read', { id: sourceId });
  }
  if (memoryPrompt) {
    const candidateId = memoryPrompt.match(/"candidateId":"([^"]+)"/)[1];
    output = tools.length
      ? { choices: [{ delta: { content: '每日记忆已整理' }, finish_reason: 'stop' }] }
      : call('memory_commit', {
          entries: [
            {
              category: 'fact',
              subject: '库存',
              relation: '扣减时间',
              content: '订单确认后扣减库存；根据回复整理，仍需核对。',
              evidence: [{ candidateId, quote: '订单确认后扣减库存' }],
            },
          ],
        });
  }
  const audit = body.messages.some(
    (m) =>
      m.role === 'user' &&
      typeof m.content === 'string' &&
      m.content.startsWith('排查当前范围的智库'),
  );
  if (audit)
    output =
      tools.length === 0
        ? call('knowledge_audit', {})
        : tools.length === 1
          ? call('knowledge_read', { id: sourceId })
          : {
              choices: [
                {
                  delta: { content: '已排查知识来源，库存并发验证仍需补充。' },
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
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const builtin = page.locator('.agent-card').filter({ hasText: '内置 · 知识整理' });
  await builtin.getByRole('heading', { name: '知识整理', exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/knowledge-agent-card.png' });
  await builtin.getByRole('button', { name: '配置', exact: true }).click();
  await page
    .getByLabel('角色指令', { exact: true })
    .fill('知识配置测试：整理可复用结论，并保留来源。');
  await page.getByRole('button', { name: '保存 Agent', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await builtin.getByRole('button', { name: '配置', exact: true }).click();
  assert.match(await page.getByLabel('角色指令', { exact: true }).inputValue(), /知识配置测试/);
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  const reset = await page.evaluate(async () =>
    (await window.tongzhou.snapshot()).agents.find((a) => a.builtin === 'knowledge-organizer'),
  );
  assert.equal(reset.customized, false);
  assert.match(reset.instructions, /内置知识整理 Agent/);
  const memoryCard = page.locator('.agent-card').filter({ hasText: '内置 · 记忆整理' });
  await memoryCard.getByRole('button', { name: '配置', exact: true }).click();
  await page
    .getByLabel('角色指令', { exact: true })
    .fill('记忆配置测试：优先整理工程经验与开发决策。');
  await page.getByRole('button', { name: '保存 Agent', exact: true }).click();
  const savedWiki = await page.evaluate(async () => {
    const document = await window.tongzhou.knowledgeSave({
      title: '手动新建整理文档',
      kind: 'wiki',
      content: '正文',
    });
    const saved = await window.tongzhou.knowledgeRead(document.id);
    await window.tongzhou.knowledgeDelete(document.id, document.version);
    return saved.document.content;
  });
  assert.equal(savedWiki, '正文');
  await builtin.getByRole('button', { name: '前往智库', exact: true }).click();
  await page.getByRole('heading', { name: '智库', exact: true }).waitFor();
  await page.getByRole('button', { name: '智库', exact: true }).click();
  await page.getByRole('tab', { name: /^内容库/ }).click();
  await page.getByRole('button', { name: '查看来源记录', exact: true }).click();
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
    for (const agent of (await window.tongzhou.snapshot()).agents.filter((a) => a.builtin)) {
      await window.tongzhou.saveAgent({
        ...agent,
        providerId: 'knowledge-fixture',
        model: agent.builtin === 'memory-organizer' ? 'memory-model' : 'organizer-model',
      });
    }
    const s = await window.tongzhou.createSession();
    await window.tongzhou.updateSession(s.id, {
      providerId: 'knowledge-fixture',
      model: 'fixture',
      title: '知识联动测试',
    });
    return s.id;
  }, `http://127.0.0.1:${server.address().port}/v1`);
  await page.locator(`[data-session-id="${sessionId}"]`).click();
  await page.getByRole('button', { name: '智库', exact: true }).click();
  await page.getByRole('button', { name: '智库', exact: true }).click();
  await page.getByRole('tab', { name: /^内容库/ }).click();
  await page.getByRole('button', { name: '查看来源记录', exact: true }).click();
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await page.getByRole('heading', { name: '库存参考.md', exact: true }).waitFor();
  sourceId = await page.evaluate(
    async () =>
      (await window.tongzhou.knowledgeState()).documents.find((d) => d.title === '库存参考.md').id,
  );
  await page.evaluate(async (id) => {
    const api = window.tongzhou;
    const folder = await api.knowledgeFolderSave({ name: '允许检索的资料' });
    const source = (await api.knowledgeRead(id)).document;
    await api.knowledgeMove(source.id, folder.id, source.version);
  }, sourceId);
  assert.equal(await page.getByRole('button', { name: '引用到当前会话', exact: true }).count(), 0);
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
  const organized = await page.evaluate(() => window.tongzhou.snapshot());
  const organizeSession = organized.sessions.find((s) => s.knowledgeJob);
  assert.equal(organizeSession.agentId, 'builtin-knowledge-organizer');
  assert.equal(
    organized.runs.find((r) => r.sessionId === organizeSession.id).agentName,
    '知识整理',
  );
  await page.getByRole('button', { name: '智库', exact: true }).click();
  await page.getByRole('button', { name: '智库', exact: true }).click();
  await page.getByRole('tab', { name: /^内容库/ }).click();
  await page.getByRole('button', { name: '查看来源记录', exact: true }).click();
  await page.locator('.knowledge-item').filter({ hasText: '库存处理 Wiki' }).click();
  await page.getByText('AI 整理待核对', { exact: true }).waitFor();
  await page.getByRole('button', { name: '核对并收录', exact: true }).click();
  await page.getByRole('button', { name: '确认已核对', exact: true }).click();
  await page.getByText('已核对并收录', { exact: true }).waitFor();

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
  await page.waitForFunction(
    async () => (await window.tongzhou.knowledgeState()).memoryQueue.pending === 1,
  );
  assert.ok(!requests.at(-1).messages[0].content.includes('订单确认后扣减库存'));
  assert.ok(
    requests
      .at(-1)
      .messages.some((m) => m.role === 'tool' && m.content.includes('订单确认后扣减库存')),
  );
  assert.equal(await page.locator('.knowledge-reference-button').count(), 0);
  const knowledgeRun = await page.evaluate(
    async (id) => (await window.tongzhou.snapshot()).runs.find((r) => r.sessionId === id),
    sessionId,
  );
  assert.ok(knowledgeRun.knowledgeReferences.some((r) => r.id === sourceId && r.mode === 'tool'));
  await page.getByRole('button', { name: '智库', exact: true }).click();
  await page.getByRole('button', { name: '智库', exact: true }).click();
  await page.getByRole('tab', { name: /^内容库/ }).click();
  await page.getByRole('button', { name: '查看来源记录', exact: true }).click();
  await page.getByLabel('搜索知识', { exact: true }).fill('');
  await page.locator('.knowledge-maintenance > summary').click();
  await page.getByRole('button', { name: '管理记忆任务', exact: true }).click();
  const memoryTaskCard = page
    .locator('.automation-cards article')
    .filter({ has: page.getByRole('heading', { name: /记忆整理/ }) });
  await memoryTaskCard.getByRole('button', { name: '立即运行', exact: true }).click();
  await page.waitForFunction(async () =>
    (await window.tongzhou.knowledgeState()).documents.some((d) => d.kind === 'memory'),
  );
  await page.waitForFunction(async () =>
    (await window.tongzhou.automationState()).jobs.some(
      (j) => j.rule.kind === 'memory' && j.status === 'completed',
    ),
  );
  await page.getByRole('button', { name: /任务与结果/ }).click();
  await page.locator('.automation-job-list button').filter({ hasText: '记忆整理' }).click();
  await page.getByText(/已处理 1 个会话轮次，新增 1 条记忆/).waitFor();
  assert.equal(await page.getByRole('button', { name: '打开执行会话', exact: true }).count(), 0);
  await page.screenshot({ path: 'test-results/memory-automation-result.png', fullPage: true });
  await page.getByRole('button', { name: '查看记忆', exact: true }).click();
  await page.getByText('每日记忆已整理，等待核对', { exact: true }).waitFor();
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  await page.getByRole('button', { name: /任务与结果/ }).click();
  await page.locator('.automation-job-list button').filter({ hasText: '记忆整理' }).click();
  await page.getByRole('button', { name: '查看记忆', exact: true }).click();
  await page.getByText('每日记忆已整理，等待核对', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '知识与记忆', exact: false }).click();
  await page
    .locator('.knowledge-subnav')
    .getByRole('button', { name: '每日记忆', exact: true })
    .click();
  await page.locator('.knowledge-item').filter({ hasText: '每日记忆' }).click();
  await page.getByText('每日记忆已整理，等待核对', { exact: true }).waitFor();
  const memoryRequest = requests.find((r) => r.model === 'memory-model');
  assert.ok(memoryRequest);
  assert.ok(
    memoryRequest.messages.some((m) => m.role === 'system' && m.content.includes('记忆配置测试')),
  );
  assert.ok(requests.some((r) => r.model === 'organizer-model'));
  const memoryRun = await page.evaluate(async () =>
    (await window.tongzhou.snapshot()).runs.find((r) => r.agentName === '记忆整理'),
  );
  assert.equal(memoryRun.config.maxSteps, 0);
  assert.equal(memoryRun.config.permission, 'read-only');

  await page.getByRole('button', { name: '核对并收录', exact: true }).click();
  await page.getByRole('button', { name: '确认已核对', exact: true }).click();
  await page.getByText('已核对并收录', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '知识与记忆', exact: false }).click();
  await page.locator('.ontology-fact').filter({ hasText: '订单' }).first().waitFor();
  await page
    .locator('.knowledge-subnav')
    .getByRole('button', { name: '每日记忆', exact: true })
    .click();
  await page.locator('.knowledge-item').filter({ hasText: '每日记忆' }).click();
  await page.locator('.ontology-editor > summary').click();
  await page.getByRole('button', { name: '修正此条记忆', exact: true }).first().click();
  await page
    .getByLabel('修正记忆内容', { exact: true })
    .fill('订单确认后扣减库存，退款完成后回补；并发条件待验证。');
  await page.getByRole('button', { name: '核对并保存', exact: true }).click();
  await page.getByText('记忆已更新', { exact: true }).waitFor();
  await page.getByRole('button', { name: '移除此条记忆', exact: true }).first().click();
  await page.getByRole('button', { name: '确认移除', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.knowledge-reader .ontology-editor'));
  await page.getByRole('button', { name: 'Agent 排查', exact: true }).click();
  await page.getByText('已排查知识来源，库存并发验证仍需补充。', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: '智库', exact: true }).click();
  await page.getByRole('button', { name: '智库', exact: true }).click();
  await page.getByRole('tab', { name: /^内容库/ }).click();
  await page.getByRole('button', { name: '查看来源记录', exact: true }).click();
  const state = await page.evaluate(() => window.tongzhou.knowledgeState());
  assert.equal(state.documents.filter((d) => d.kind === 'wiki').length, 1);
  assert.equal(state.documents.filter((d) => d.kind === 'memory').length, 1);
  const catalog = await page.evaluate(() => window.tongzhou.clientMethods());
  assert.ok(catalog.methods.some((m) => m.name === 'knowledgeRead'));
  assert.ok(!catalog.methods.some((m) => m.name === 'knowledgeArchive'));
  assert.ok(
    !catalog.methods.some((m) =>
      ['knowledgeBind', 'knowledgeExclude', 'knowledgeReferenceState'].includes(m.name),
    ),
  );
  assert.equal(catalog.methods.find((m) => m.name === 'knowledgeReview').access, 'change');
  assert.ok(!(await page.locator('[data-session-id]').filter({ hasText: '后台记忆整理' }).count()));
  assert.ok((await readFile(path.join(state.root, 'index.md'), 'utf8')).includes('库存处理 Wiki'));
  await page.getByLabel('搜索知识', { exact: true }).fill('');
  await page
    .locator('.knowledge-filters')
    .getByRole('button', { name: '全部', exact: true })
    .click();
  await page.locator('.knowledge-item').filter({ hasText: '库存参考.md' }).click();
  assert.equal(
    await page
      .locator('.knowledge-page')
      .getByRole('button', { name: '归档', exact: true })
      .count(),
    0,
  );
  await page.getByRole('button', { name: '永久删除', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.ok(
    (await page.evaluate(() => window.tongzhou.knowledgeState())).documents.some(
      (d) => d.id === sourceId,
    ),
  );
  await page.getByRole('button', { name: '永久删除', exact: true }).click();
  await page.getByRole('button', { name: '确认永久删除', exact: true }).click();
  await page.getByText('资料已永久删除', { exact: true }).waitFor();
  assert.ok(
    !(await page.evaluate(() => window.tongzhou.knowledgeState())).documents.some(
      (d) => d.id === sourceId,
    ),
  );
  assert.ok((await readFile(importedFile, 'utf8')).includes('订单确认后扣减库存'));
  await page
    .locator('.knowledge-filters')
    .getByRole('button', { name: '整理文档', exact: true })
    .click();
  await page.locator('.knowledge-item').filter({ hasText: '库存处理 Wiki' }).click();
  await page.getByText('来源已删除，需要复核', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '库存参考.md · 来源已删除' }).isDisabled(),
    true,
  );
  await page.reload();
  assert.ok(
    !(await page.evaluate(() => window.tongzhou.knowledgeState())).documents.some(
      (d) => d.id === sourceId,
    ),
  );
  await page.getByRole('button', { name: '智库', exact: true }).click();
  await page.getByRole('button', { name: '智库', exact: true }).click();
  await page.getByRole('tab', { name: /^内容库/ }).click();
  await page.getByRole('button', { name: '查看来源记录', exact: true }).click();
  await page
    .locator('.knowledge-filters')
    .getByRole('button', { name: '整理文档', exact: true })
    .click();
  await page.getByRole('button', { name: '新建目录', exact: true }).click();
  await page.getByLabel('目录名称', { exact: true }).fill('研发');
  await page.getByRole('button', { name: '保存目录', exact: true }).click();
  await page.locator('.wiki-folder-name').filter({ hasText: '研发' }).waitFor();
  await page.getByRole('button', { name: '新建目录', exact: true }).click();
  await page.getByLabel('目录名称', { exact: true }).fill('API');
  await page.getByRole('button', { name: '保存目录', exact: true }).click();
  await page.getByRole('button', { name: '管理目录 API', exact: true }).click();
  await page.getByLabel('目录名称', { exact: true }).fill('接口文档');
  await page.getByRole('button', { name: '保存目录', exact: true }).click();
  await page.getByRole('button', { name: '折叠目录 研发', exact: true }).click();
  assert.equal(await page.locator('.wiki-folder-name').filter({ hasText: '接口文档' }).count(), 0);
  await page.getByRole('button', { name: '展开目录 研发', exact: true }).click();
  await page.getByRole('button', { name: '管理目录 接口文档', exact: true }).click();
  await page.getByRole('button', { name: '上级目录', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '顶层目录', exact: true }).click();
  await page.getByRole('button', { name: '保存目录', exact: true }).click();
  await page.waitForFunction(
    async () =>
      !(await window.tongzhou.knowledgeState()).folders.find((f) => f.name === '接口文档')
        ?.parentId,
  );
  await page.getByRole('button', { name: '管理目录 接口文档', exact: true }).click();
  await page.getByRole('button', { name: '上级目录', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '研发', exact: true }).click();
  await page.getByRole('button', { name: '保存目录', exact: true }).click();
  await page.getByRole('button', { name: '全部文档', exact: true }).click();
  await page.locator('.knowledge-item').filter({ hasText: '库存处理 Wiki' }).click();
  await page.getByRole('button', { name: '移动到目录', exact: true }).click();
  await page.getByRole('button', { name: '文档目标目录', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '研发 / 接口文档', exact: true }).click();
  await page.getByRole('button', { name: '确认移动', exact: true }).click();
  await page.getByText('整理文档已移动，正文与来源引用已保留', { exact: true }).waitFor();
  await page
    .locator('.knowledge-document-heading')
    .getByText('研发 / 接口文档', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: '新建笔记', exact: true }).click();
  await page.getByLabel('知识标题', { exact: true }).fill('目录内新页');
  assert.equal(await page.getByLabel('知识类型', { exact: true }).inputValue(), '笔记与原件');
  assert.equal(await page.getByLabel('知识类型', { exact: true }).getAttribute('readonly'), '');
  await page.getByLabel('知识正文', { exact: true }).fill('需要长期保留的接口经验。');
  assert.equal(
    await page.getByRole('button', { name: '文档所属目录', exact: true }).textContent(),
    '研发 / 接口文档',
  );
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await page.getByRole('heading', { name: '目录内新页', exact: true }).waitFor();
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
    await page.screenshot({ path: `test-results/wiki-folders-${theme}.png`, fullPage: true });
  }
  const folderState = await page.evaluate(() => window.tongzhou.knowledgeState());
  assert.equal(folderState.documents.find((d) => d.title === '目录内新页').kind, 'source');
  const wikiBefore = folderState.documents.find((d) => d.title === '库存处理 Wiki');
  assert.ok(wikiBefore.folderId);
  const folderBefore = folderState.folders.find((f) => f.name === '研发');
  await page.reload();
  assert.deepEqual(
    (await page.evaluate(() => window.tongzhou.knowledgeState())).folders,
    folderState.folders,
  );
  await page.getByRole('button', { name: '智库', exact: true }).click();
  await page.getByRole('button', { name: '智库', exact: true }).click();
  await page.getByRole('tab', { name: /^内容库/ }).click();
  await page.getByRole('button', { name: '查看来源记录', exact: true }).click();
  await page
    .locator('.knowledge-filters')
    .getByRole('button', { name: '整理文档', exact: true })
    .click();
  await page.locator('.wiki-folder-name').filter({ hasText: '研发' }).click();
  await page.getByRole('button', { name: '管理目录 研发', exact: true }).click();
  await page.getByRole('button', { name: '删除目录', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.ok(
    (await page.evaluate(() => window.tongzhou.knowledgeState())).folders.some(
      (f) => f.id === folderBefore.id,
    ),
  );
  await page.getByRole('button', { name: '管理目录 研发', exact: true }).click();
  await page.getByRole('button', { name: '删除目录', exact: true }).click();
  await page.getByRole('button', { name: '确认删除目录', exact: true }).click();
  await page.waitForFunction(
    async () =>
      !(await window.tongzhou.knowledgeState()).folders.some((f) =>
        ['研发', '接口文档'].includes(f.name),
      ),
  );
  const wikiAfter = await page.evaluate((id) => window.tongzhou.knowledgeRead(id), wikiBefore.id);
  assert.equal(wikiAfter.document.folderId, undefined);
  assert.deepEqual(wikiAfter.document.sources, wikiBefore.sources);
  assert.equal(
    (await page.evaluate(() => window.tongzhou.knowledgeState())).documents.filter(
      (d) => d.kind === 'wiki',
    ).length,
    1,
  );
  const finalCatalog = await page.evaluate(() => window.tongzhou.clientMethods());
  for (const name of ['knowledgeFolderSave', 'knowledgeFolderDelete', 'knowledgeMove'])
    assert.ok(finalCatalog.methods.some((m) => m.name === name));
  assert.deepEqual(errors, []);
  console.log(
    'Knowledge desktop passed: import, notes, revisions, model tool synthesis, source links, scoped context, auto capture, reload, client catalog, light/dark, direct deletion, Wiki folder create/rename/move/collapse/delete, page moves and preservation.',
  );
} finally {
  await app.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
