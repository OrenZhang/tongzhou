import { openSidebar } from './navigation-helper.mjs';
import { chooseOption } from './choice-helper.mjs';
import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/extensions-'));
const skill = path.join(root, 'example-skill');
await mkdir(skill);
await writeFile(
  path.join(skill, 'SKILL.md'),
  '---\nname: sample-skill\ndescription: Test portable skill\n---\nUse concise answers.',
);
const mcp = path.join(root, 'mcp.cjs');
await writeFile(
  mcp,
  `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result={};if(r.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};if(r.method==='tools/list')result={tools:[{name:'read_note',description:'Read a test note',inputSchema:{type:'object',properties:{}}}]};if(r.method==='tools/call')result={content:[{type:'text',text:'Fixture note: keep this fact across models.'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`,
);
const requests = [];
const server = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const called = body.messages.some((m) => m.role === 'tool');
  const handoff = body.model === 'model-b';
  const data =
    called || handoff
      ? {
          choices: [
            {
              delta: { content: handoff ? '切换成功，仍记得测试笔记。' : '插件笔记已读取。' },
              finish_reason: 'stop',
            },
          ],
        }
      : {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'note-call',
                    function: {
                      name: body.tools.find((t) => t.function.name.startsWith('mcp_')).function
                        .name,
                      arguments: '{}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end('data: ' + JSON.stringify(data) + '\n\ndata: [DONE]\n\n');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const env = { ...process.env, TONGZHOU_USER_DATA: path.join(root, 'profile') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TONGZHOU_DEV_URL;
const executablePath = process.env.TONGZHOU_SMOKE_EXECUTABLE;
const app = await electron.launch(
  executablePath
    ? { executablePath: path.resolve(executablePath), args: [], cwd: root, env }
    : { args: ['.'], env },
);
try {
  const page = await app.firstWindow();
  await page.waitForSelector('.app-shell');
  await app.evaluate(({ BrowserWindow, dialog }, skill) => {
    BrowserWindow.getAllWindows().forEach((w) => w.setIgnoreMouseEvents(true));
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [skill] });
  }, skill);
  await openSidebar(page, '插件');
  await page.getByRole('button', { name: /^内置插件/ }).click();
  await page.getByLabel('类型', { exact: true }).selectOption('mcp');
  const initial = await page.evaluate(() => window.tongzhou.snapshot());
  const builtins = initial.plugins;
  assert.deepEqual(builtins.map((p) => p.id).sort(), [
    'minimax-coding',
    'minimax-multimedia',
    'tongzhou-kimi-web',
    'tongzhou-web',
  ]);
  assert.ok(builtins.every((p) => p.enabled === (p.id === 'tongzhou-web')));
  // Turn it off for the independent-switch and single-MCP conversation checks below.
  await page.evaluate(async () => {
    const web = (await window.tongzhou.snapshot()).plugins.find((p) => p.id === 'tongzhou-web');
    await window.tongzhou.savePlugin({ ...web, enabled: false });
  });
  const kimiCard = page
    .locator('.plugin-tile')
    .filter({ has: page.getByRole('heading', { name: 'Kimi 搜索与网页读取', exact: true }) });
  await kimiCard.getByRole('button').click();
  assert.equal(await page.getByLabel('认证方式', { exact: true }).inputValue(), 'account');
  await page.getByLabel('认证方式', { exact: true }).selectOption('key');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('请先填写 API Key', { exact: true }).waitFor();
  await page.getByLabel('API Key', { exact: true }).fill('fixture-kimi-key');
  await page.getByRole('button', { name: '保存并检查连接', exact: true }).click();
  await page.getByText(/MCP 连接成功，发现 2 个工具/).waitFor();
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  const savedKimi = (await page.evaluate(() => window.tongzhou.snapshot())).plugins.find(
    (p) => p.id === 'tongzhou-kimi-web',
  );
  assert.ok(savedKimi.hasSecret);
  assert.equal(savedKimi.enabled, false);

  const accountHome = path.join(root, 'profile', 'engines', 'kimi');
  await mkdir(path.join(accountHome, 'credentials'), { recursive: true });
  await writeFile(
    path.join(accountHome, 'config.toml'),
    '[providers."managed:kimi-code"]\ntype="kimi"\nbase_url="https://api.kimi.com/coding/v1"\n[providers."managed:kimi-code".oauth]\nstorage="file"\nkey="oauth/kimi-code"\n',
  );
  await writeFile(
    path.join(accountHome, 'credentials', 'kimi-code.json'),
    JSON.stringify({ access_token: 'fixture-plan-token', expires_at: Date.now() / 1000 + 3600 }),
  );
  await page.evaluate(async () => {
    const data = await window.tongzhou.snapshot();
    await window.tongzhou.saveProvider({
      ...data.providers.find((p) => p.id === 'kimi-account'),
      enabled: true,
    });
  });
  await kimiCard.getByRole('button').click();
  await page.getByLabel('认证方式', { exact: true }).selectOption('account');
  await page.getByLabel('套餐账号', { exact: true }).selectOption('kimi-account');
  assert.equal(await page.getByLabel('API Key', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '保存并检查连接', exact: true }).click();
  await page.getByText(/套餐账号认证配置检查通过，可用 2 个工具/).waitFor();
  const boundKimi = (await page.evaluate(() => window.tongzhou.snapshot())).plugins.find(
    (p) => p.id === 'tongzhou-kimi-web',
  );
  assert.equal(boundKimi.accountProviderId, 'kimi-account');
  assert.ok(boundKimi.hasSecret); // Previous key remains encrypted for switching back.
  assert.ok(!JSON.stringify(boundKimi).includes('fixture-plan-token'));
  await page.getByLabel('认证方式', { exact: true }).selectOption('key');
  await page.getByRole('button', { name: '保存并检查连接', exact: true }).click();
  await page.getByText(/MCP 连接成功，发现 2 个工具/).waitFor();
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  assert.equal(
    (await page.evaluate(() => window.tongzhou.snapshot())).plugins.find(
      (p) => p.id === 'tongzhou-kimi-web',
    ).accountProviderId,
    undefined,
  );

  assert.ok(!JSON.stringify(savedKimi).includes('fixture-kimi-key'));
  assert.equal(savedKimi.catalog.length, 2);
  const minimaxCard = page
    .locator('.plugin-tile')
    .filter({ has: page.getByRole('heading', { name: 'MiniMax 多媒体', exact: true }) });
  await minimaxCard.getByRole('button').click();
  await page.getByLabel('认证方式', { exact: true }).selectOption('key');
  await page.getByLabel('API Key', { exact: true }).fill('fixture-minimax-key');
  await page.getByLabel('密钥所属区域', { exact: true }).selectOption('global');
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await minimaxCard.getByRole('button').click();
  assert.equal(await page.getByLabel('密钥所属区域', { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('密钥所属区域', { exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.locator('.plugin-detail-page').waitFor({ state: 'detached' });
  await page.getByLabel('类型', { exact: true }).selectOption('all');
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 900 });
    const tiles = await page.locator('.plugin-tile').evaluateAll((items) =>
      items.map((el) => ({
        height: el.getBoundingClientRect().height,
        overflow: el.scrollWidth - el.clientWidth,
      })),
    );
    assert.ok(tiles.every((t) => t.height <= 80 && t.overflow <= 1));
    await page.screenshot({ path: path.join(root, 'compact-plugins-' + width + '.png') });
  }
  await page.getByRole('button', { name: '查看 GitHub 仓库工具', exact: true }).click();
  await page.getByRole('button', { name: '检测本地账号', exact: true }).waitFor();
  assert.equal(await page.locator('.plugin-tile:visible').count(), 0);
  await page.screenshot({ path: path.join(root, 'github-detail.png') });
  await page.getByRole('button', { name: '返回插件列表', exact: true }).click();
  await page.getByLabel('类型', { exact: true }).selectOption('mcp');
  await page.setViewportSize({ width: 1440, height: 900 });
  const webCard = page
    .locator('.plugin-tile')
    .filter({ has: page.getByRole('heading', { name: '网页搜索与读取 · 内置', exact: true }) });
  assert.equal(
    await page.getByRole('heading', { name: '系统环境 · 内置', exact: true }).count(),
    0,
  );
  assert.equal((await page.evaluate(() => window.tongzhou.testPlugin('tongzhou-web'))).length, 2);
  assert.equal(await webCard.getByRole('checkbox').isChecked(), false);
  assert.ok(!(await webCard.innerText()).includes('builtin-mcp.cjs'));
  await page.screenshot({ path: 'test-results/builtin-plugins.png' });
  // Exercise the actual bundled servers, including rejecting cross-plugin calls.
  for (const config of builtins.filter((p) => p.id === 'tongzhou-web')) {
    const client = new Client({ name: 'builtin-smoke', version: '1' });
    try {
      await client.connect(
        new StdioClientTransport({ command: config.command, args: config.args }),
      );
      const { tools } = await client.listTools();

      assert.deepEqual(
        tools.map((t) => t.name),
        ['web_search', 'fetch_page'],
      );
      const result = await client.callTool({
        name: 'fetch_page',
        arguments: { url: `http://127.0.0.1:${server.address().port}/` },
      });
      assert.ok(result.content[0].text.includes('model-a'));
      await assert.rejects(
        client.callTool({ name: 'current_time', arguments: {} }),
        /Unknown tool/,
      );
    } finally {
      await client.close();
    }
  }
  assert.equal(await page.getByRole('button', { name: /^Skills/ }).count(), 0);
  await page.getByRole('button', { name: /^个人插件/ }).click();
  await page.getByRole('button', { name: '添加插件', exact: true }).click();
  await page.getByRole('button', { name: '连接 MCP 服务', exact: true }).click();
  await page.getByLabel('插件名称', { exact: true }).fill('测试笔记插件');
  await page.getByLabel('启动命令', { exact: true }).fill(process.execPath);
  await page.getByLabel('启动参数', { exact: true }).fill(mcp);
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '保存并检查连接', exact: true }).click();
  await page.locator('.plugin-detail-page summary').filter({ hasText: '个已发现工具' }).click();
  await page.locator('.plugin-detail-page').getByText('read_note', { exact: true }).waitFor();
  await page.getByRole('button', { name: '保存插件', exact: true }).click();
  await page.getByRole('button', { name: '添加插件', exact: true }).click();
  await page.screenshot({ path: 'test-results/plugin-type-picker.png' });
  await page.getByRole('button', { name: '导入 Skill 技能', exact: true }).click();
  await page.getByRole('heading', { name: 'sample-skill', exact: true }).waitFor();
  const skillCard = page
    .locator('.plugin-tile')
    .filter({ has: page.getByRole('heading', { name: 'sample-skill', exact: true }) });
  await skillCard.getByText('技能', { exact: true }).waitFor();
  assert.equal(await page.locator('.plugin-library .plugin-tile').count(), 2);
  await page.getByLabel('类型', { exact: true }).selectOption('mcp');
  assert.equal(await page.locator('.plugin-library .plugin-tile').count(), 1);
  await page.getByRole('heading', { name: '测试笔记插件', exact: true }).waitFor();
  await page.getByLabel('搜索插件', { exact: true }).fill('不存在的插件');
  await page.getByRole('heading', { name: '没有匹配的插件', exact: true }).waitFor();
  await page.getByLabel('搜索插件', { exact: true }).fill('');
  await page.getByLabel('类型', { exact: true }).selectOption('skill');
  assert.equal(await page.locator('.provider-grid .plugin-tile:visible').count(), 1);
  await skillCard.getByRole('checkbox').uncheck();
  await page.waitForFunction(
    async () =>
      !(await window.tongzhou.snapshot()).skills.find((s) => s.name === 'sample-skill').enabled,
  );
  await skillCard.getByRole('checkbox').check();
  await page.waitForFunction(
    async () =>
      (await window.tongzhou.snapshot()).skills.find((s) => s.name === 'sample-skill').enabled,
  );
  await skillCard.getByRole('button').click();
  await page.locator('.plugin-detail-page pre').waitFor();
  assert.ok(
    (await page.locator('.plugin-detail-page pre').innerText()).includes('Use concise answers.'),
  );
  await page.getByRole('button', { name: '返回插件列表', exact: true }).click();
  await page.getByLabel('类型', { exact: true }).selectOption('mcp');
  assert.equal(await page.getByRole('heading', { name: 'sample-skill', exact: true }).count(), 0);
  assert.equal(await page.locator('.provider-grid .plugin-tile:visible').count(), 1);
  await page.getByLabel('类型', { exact: true }).selectOption('all');
  assert.equal(
    (await page.evaluate(() => window.tongzhou.snapshot())).agents.filter((a) => !a.builtin).length,
    0,
  );
  await page.screenshot({ path: 'test-results/12-extensions.png' });
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  await page.evaluate(async (base) => {
    for (const [id, model] of [
      ['fixture-a', 'model-a'],
      ['fixture-b', 'model-b'],
    ])
      await window.tongzhou.saveProvider({
        id,
        name: id,
        protocol: 'openai-chat',
        baseUrl: base,
        auth: 'none',
        models: [model],
        contextChars: 50000,
        maxOutputTokens: 1000,
      });
  }, base);
  await openSidebar(page, '会话');
  await chooseOption(page, '当前连接', 'fixture-a');
  await page.getByLabel('消息', { exact: true }).fill('读取测试笔记');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const approval = page.getByRole('region', { name: '测试笔记插件 · read_note', exact: true });
  await approval.waitFor();
  await approval.getByRole('button', { name: '批准本次', exact: true }).click();
  await page.getByText('插件笔记已读取。', { exact: true }).waitFor();
  const before = await page.evaluate(() => window.tongzhou.snapshot());
  const id = before.sessions[0].id;
  await chooseOption(page, '当前连接', 'fixture-b');
  await openSidebar(page, '插件');
  await openSidebar(page, '会话');
  assert.equal(
    await page.getByLabel('当前连接', { exact: true }).getAttribute('data-value'),
    'fixture-b',
  );
  await page.getByLabel('消息', { exact: true }).fill('换个供应商继续');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText('切换成功，仍记得测试笔记。', { exact: true }).waitFor();
  const after = await page.evaluate(() => window.tongzhou.snapshot());
  assert.equal(after.sessions.length, 1);
  assert.equal(after.sessions[0].id, id);
  assert.equal(after.sessions[0].providerId, 'fixture-b');
  const last = JSON.stringify(requests.at(-1));
  assert.ok(last.includes('Fixture note'));
  assert.ok(last.includes('Test portable skill'));
  assert.ok(!last.includes('Use concise answers.')); // Skill instructions load on demand.
  assert.ok(!last.includes('"tool_calls"'));
  await page.screenshot({ path: 'test-results/13-plugin-handoff.png' });
  await page.reload();
  await page.waitForSelector('.app-shell');
  const persisted = await page.evaluate(() => window.tongzhou.snapshot());
  assert.equal(persisted.sessions[0].model, 'model-b');
  assert.equal(persisted.plugins.length, 5);
  assert.deepEqual(
    persisted.skills
      .filter((s) => s.name !== 'sample-skill')
      .map((s) => s.id)
      .sort(),
    initial.skills.map((s) => s.id).sort(),
  );
  assert.equal(persisted.skills.filter((s) => s.name === 'sample-skill').length, 1);
  assert.ok(persisted.skills.some((s) => s.id === 'tongzhou-whiteboard-design'));
  assert.ok(persisted.skills.some((s) => s.id === 'tongzhou-canvas-workflow'));
  await openSidebar(page, '插件');
  await page.getByRole('button', { name: /^个人插件/ }).click();
  await skillCard.getByRole('button').click();
  await page.getByRole('button', { name: '移除技能', exact: true }).click();
  await page.waitForFunction(
    async () => !(await window.tongzhou.snapshot()).skills.some((s) => s.name === 'sample-skill'),
  );
  await page.getByLabel('类型', { exact: true }).selectOption('skill');
  await page.getByRole('heading', { name: '暂无此类型的插件', exact: true }).waitFor();
  console.log(
    'Extensions UI passed: MCP discovery, Skill import, global plugin switches, approval, projectless tools, same-session provider handoff and persistence.',
  );
} finally {
  await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
