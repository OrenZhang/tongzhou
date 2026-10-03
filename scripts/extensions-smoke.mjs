import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
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
  await page.waitForSelector('.welcome');
  await app.evaluate(({ BrowserWindow, dialog }, skill) => {
    BrowserWindow.getAllWindows().forEach((w) => w.setIgnoreMouseEvents(true));
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [skill] });
  }, skill);
  await page.getByRole('button', { name: '插件与工具', exact: true }).click();
  await page.getByRole('button', { name: '添加 MCP', exact: true }).click();
  await page.getByLabel('插件名称', { exact: true }).fill('测试笔记插件');
  await page.getByLabel('启动命令', { exact: true }).fill(process.execPath);
  await page.getByLabel('启动参数（每行一个）', { exact: true }).fill(mcp);
  await page.getByRole('button', { name: '保存并检查连接', exact: true }).click();
  await page.getByRole('dialog').getByText('read_note', { exact: true }).waitFor();
  await page.getByRole('button', { name: '保存插件', exact: true }).click();
  await page.getByRole('button', { name: '导入 Skill 文件夹', exact: true }).click();
  await page.getByRole('heading', { name: 'sample-skill', exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.tongzhou.snapshot())).agents.length, 0);
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
  await page.getByRole('button', { name: '工作空间', exact: true }).click();
  await page.getByLabel('当前连接', { exact: true }).selectOption('fixture-a');
  await page.getByLabel('消息', { exact: true }).fill('读取测试笔记');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  const approval = page.getByRole('dialog', { name: '测试笔记插件 · read_note', exact: true });
  await approval.waitFor();
  await approval.getByRole('button', { name: '批准本次', exact: true }).click();
  await page.getByText('插件笔记已读取。', { exact: true }).waitFor();
  const before = await page.evaluate(() => window.tongzhou.snapshot());
  const id = before.sessions[0].id;
  await page.getByLabel('当前连接', { exact: true }).selectOption('fixture-b');
  await page.getByRole('button', { name: '插件与工具', exact: true }).click();
  await page.getByRole('button', { name: '工作空间', exact: true }).click();
  assert.equal(await page.getByLabel('当前连接', { exact: true }).inputValue(), 'fixture-b');
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
  await page.waitForSelector('.welcome');
  const persisted = await page.evaluate(() => window.tongzhou.snapshot());
  assert.equal(persisted.sessions[0].model, 'model-b');
  assert.equal(persisted.plugins.length, 1);
  assert.equal(persisted.skills.length, 1);
  console.log(
    'Extensions UI passed: MCP discovery, Skill import, global plugin switches, approval, projectless tools, same-session provider handoff and persistence.',
  );
} finally {
  await app.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
