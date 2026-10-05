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
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('button', { name: /^内置与自定义/ }).click();
  const builtins = (await page.evaluate(() => window.tongzhou.snapshot())).plugins;
  assert.deepEqual(builtins.map((p) => p.id).sort(), ['tongzhou-system', 'tongzhou-web']);
  assert.ok(builtins.every((p) => !p.enabled));
  const webCard = page
    .locator('.provider-card')
    .filter({ has: page.getByRole('heading', { name: '网页读取 · 内置', exact: true }) });
  const systemCard = page
    .locator('.provider-card')
    .filter({ has: page.getByRole('heading', { name: '系统环境 · 内置', exact: true }) });
  await systemCard.getByRole('checkbox').check();
  await page.waitForFunction(
    async () =>
      (await window.tongzhou.snapshot()).plugins.find((p) => p.id === 'tongzhou-system').enabled,
  );
  assert.equal(await webCard.getByRole('checkbox').isChecked(), false);
  await systemCard.getByRole('button', { name: '连接检查' }).click();
  await page
    .getByRole('status')
    .getByText('系统环境 · 内置：连接成功，发现 2 个工具', { exact: true })
    .waitFor();
  await webCard.getByRole('button', { name: '连接检查' }).click();
  await page
    .getByRole('status')
    .getByText('网页读取 · 内置：连接成功，发现 1 个工具', { exact: true })
    .waitFor();
  assert.equal(await webCard.getByRole('checkbox').isChecked(), false);
  assert.ok(!(await webCard.innerText()).includes('builtin-mcp.cjs'));
  await page.screenshot({ path: 'test-results/builtin-plugins.png' });
  // Exercise the actual bundled servers, including rejecting cross-plugin calls.
  for (const config of builtins) {
    const client = new Client({ name: 'builtin-smoke', version: '1' });
    try {
      await client.connect(
        new StdioClientTransport({ command: config.command, args: config.args }),
      );
      const { tools } = await client.listTools();
      if (config.id === 'tongzhou-system') {
        assert.deepEqual(tools.map((t) => t.name).sort(), ['current_time', 'system_info']);
        const time = JSON.parse(
          (await client.callTool({ name: 'current_time', arguments: {} })).content[0].text,
        );
        assert.ok(Math.abs(Date.parse(time.utc) - Date.now()) < 10000);
        assert.ok(time.timeZone && time.local && Number.isFinite(time.utcOffsetMinutes));
        const info = JSON.parse(
          (await client.callTool({ name: 'system_info', arguments: {} })).content[0].text,
        );
        assert.equal(info.platform, process.platform);
        assert.ok(info.memory.totalBytes > 0 && info.cpu.logicalCores > 0 && info.runtime.node);
        assert.equal(info.env, undefined);
        await assert.rejects(
          client.callTool({ name: 'fetch_page', arguments: {} }),
          /Unknown tool/,
        );
      } else {
        assert.deepEqual(
          tools.map((t) => t.name),
          ['fetch_page'],
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
      }
    } finally {
      await client.close();
    }
  }
  await systemCard.getByRole('checkbox').uncheck();
  await page.waitForFunction(
    async () =>
      !(await window.tongzhou.snapshot()).plugins.find((p) => p.id === 'tongzhou-system').enabled,
  );
  assert.equal(await page.getByRole('button', { name: /^Skills/ }).count(), 0);
  await page.getByRole('button', { name: '添加插件', exact: true }).click();
  await page.getByRole('button', { name: '连接 MCP 服务', exact: true }).click();
  await page.getByLabel('插件名称', { exact: true }).fill('测试笔记插件');
  await page.getByLabel('启动命令', { exact: true }).fill(process.execPath);
  await page.getByLabel('启动参数', { exact: true }).fill(mcp);
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '保存并检查连接', exact: true }).click();
  await page.getByRole('dialog').getByText('read_note', { exact: true }).waitFor();
  await page.getByRole('button', { name: '保存插件', exact: true }).click();
  await page.getByRole('button', { name: '添加插件', exact: true }).click();
  await page.screenshot({ path: 'test-results/plugin-type-picker.png' });
  await page.getByRole('button', { name: '导入 Skill 技能', exact: true }).click();
  await page.getByRole('heading', { name: 'sample-skill', exact: true }).waitFor();
  const skillCard = page
    .locator('.provider-card')
    .filter({ has: page.getByRole('heading', { name: 'sample-skill', exact: true }) });
  await skillCard.getByText('Skill 技能', { exact: true }).waitFor();
  await page.getByLabel('类型', { exact: true }).selectOption('skill');
  assert.equal(await page.locator('.provider-grid .provider-card:visible').count(), 1);
  await skillCard.getByRole('checkbox').uncheck();
  await page.waitForFunction(async () => !(await window.tongzhou.snapshot()).skills[0].enabled);
  await skillCard.getByRole('checkbox').check();
  await page.waitForFunction(async () => (await window.tongzhou.snapshot()).skills[0].enabled);
  await skillCard.getByText('查看指令', { exact: true }).click();
  await skillCard.locator('pre').waitFor();
  assert.ok((await skillCard.locator('pre').innerText()).includes('Use concise answers.'));
  await page.getByLabel('类型', { exact: true }).selectOption('mcp');
  assert.equal(await page.getByRole('heading', { name: 'sample-skill', exact: true }).count(), 0);
  assert.equal(await page.locator('.provider-grid .provider-card:visible').count(), 1);
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
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  await chooseOption(page, '当前连接', 'fixture-a');
  await page.getByLabel('消息', { exact: true }).fill('读取测试笔记');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const approval = page.getByRole('dialog', { name: '测试笔记插件 · read_note', exact: true });
  await approval.waitFor();
  await approval.getByRole('button', { name: '批准本次', exact: true }).click();
  await page.getByText('插件笔记已读取。', { exact: true }).waitFor();
  const before = await page.evaluate(() => window.tongzhou.snapshot());
  const id = before.sessions[0].id;
  await chooseOption(page, '当前连接', 'fixture-b');
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
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
  assert.equal(persisted.plugins.length, 3);
  assert.equal(persisted.skills.length, 1);
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('button', { name: /^内置与自定义/ }).click();
  await skillCard.getByRole('button', { name: '移除', exact: true }).click();
  await page.waitForFunction(async () => (await window.tongzhou.snapshot()).skills.length === 0);
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
