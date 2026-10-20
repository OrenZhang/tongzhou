import { openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/tauri-core-'));
const runtime = path.resolve('work/tauri-runtime');
const project = path.join(root, '项目 with spaces');
await mkdir(project);
const modelRequests = [],
  fetched = [],
  authProxy = [],
  native = [],
  events = [];
const server = createServer(async (req, res) => {
  if (req.method === 'GET') {
    if (req.url === '/mcp-proof') {
      fetched.push(req.url);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('TAURI_MCP_PROOF');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'gpt-6-sol' }] }));
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  modelRequests.push(body);
  const round = modelRequests.length;
  const item =
    round <= 2
      ? {
          id: 'tool-' + round,
          type: 'custom_tool_call',
          namespace: 'functions',
          name: 'exec',
          call_id: 'tool-' + round,
          status: 'completed',
          input:
            round === 1
              ? 'const t = ALL_TOOLS.find(t => t.name.includes("mcp_") && t.name.endsWith("discover")); if (!t) throw new Error("MCP discovery missing"); text(await tools[t.name]({action:"call",tool:"fetch_page",arguments:{url:' +
                JSON.stringify(`http://127.0.0.1:${server.address().port}/mcp-proof`) +
                '}}));'
              : 'const t = ALL_TOOLS.find(t => t.name.endsWith("write_file")); text(await tools[t.name]({path:"proof.txt",content:"TAURI_CORE_PROOF"}));',
        }
      : {
          id: 'answer',
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          status: 'completed',
          content: [
            { type: 'output_text', text: 'Tauri 已完成 MCP 读取和文件写入验证。', annotations: [] },
          ],
        };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    [
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.completed',
        response: {
          id: 'response-' + round,
          status: 'completed',
          output: [item],
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        },
      },
    ]
      .map((event) => 'data: ' + JSON.stringify(event) + '\n\n')
      .join(''),
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const proxy = createServer((_req, res) => res.writeHead(502).end());
proxy.on('connect', (req, socket) => {
  authProxy.push(req.url);
  socket.on('error', () => {});
  socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
let child,
  lines,
  sequence = 0,
  readyResolve,
  readyReject;
const pending = new Map();
let ready;
function send(message) {
  child.stdin.write(JSON.stringify(message) + '\n');
}
function invoke(method, ...args) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({
      type: 'invoke',
      id,
      method,
      args,
      undefinedArgs: args.flatMap((value, index) => (value === undefined ? [index] : [])),
    });
  });
}
async function until(check, description) {
  const deadline = Date.now() + 30000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(description + ' timed out');
    await new Promise((r) => setTimeout(r, 80));
  }
}
async function start() {
  ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child = spawn(
    path.join(runtime, 'node_modules/node/bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    [path.join(runtime, 'dist-electron/tauri-host.cjs'), path.join(root, 'profile'), '1.0.4'],
    { cwd: runtime, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  child.stderr.on('data', (data) => process.stderr.write(data));
  child.on('exit', (code) => {
    for (const request of pending.values()) request.reject(new Error('Core exited ' + code));
    pending.clear();
    readyReject(new Error('Core exited ' + code));
  });
  lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === 'ready') readyResolve();
    if (message.type === 'fatal') readyReject(new Error(message.error));
    if (message.type === 'result') {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (request)
        message.ok ? request.resolve(message.value) : request.reject(new Error(message.error));
    }
    if (message.type === 'host') {
      native.push({
        method: message.method,
        args: message.method.startsWith('auth') ? [] : message.args,
      });
      const status = {
        supported: false,
        platform: process.platform,
        screen: 'denied',
        accessibility: false,
        emergencyShortcut: false,
      };
      const value =
        message.method === 'desktopInfo'
          ? { updatesConfigured: false }
          : message.method === 'computerStatus'
            ? status
            : message.method === 'powerStatus'
              ? { onBatteryPower: false, active: false }
              : message.method === 'powerStart'
                ? 7
                : null;
      send({ type: 'host_result', id: message.id, ok: true, value });
    }
    if (message.type === 'event') {
      events.push(message.event);
      if (message.event.type === 'approval')
        void invoke('approve', message.event.approval.id, true).catch(() => {});
    }
  });
  await Promise.race([
    ready,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Core startup timed out')), 30000).unref(),
    ),
  ]);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exit = new Promise((resolve) => child.once('exit', resolve));
  const id = ++sequence;
  send({ type: 'shutdown', id });
  const timeout = setTimeout(() => child.kill(), 15000);
  await exit;
  clearTimeout(timeout);
  lines.close();
}
try {
  await start();
  await invoke('saveProvider', {
    id: 'fixture',
    name: 'Tauri 合成测试',
    enabled: true,
    protocol: 'openai-responses',
    auth: 'none',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: ['gpt-6-sol'],
    reasoningEffort: 'high',
    maxOutputTokens: 8192,
    contextChars: 50000,
  });
  const p = await invoke('addProject', project);
  const session = await invoke('createSession', p.id);
  await invoke('setSessionPermission', session.id, 'ask');
  await invoke('updateSession', session.id, {
    title: 'Tauri UI 验证',
    providerId: 'fixture',
    model: 'gpt-6-sol',
  });
  if (process.argv.includes('--ui')) {
    await stop();
    const metadata = { root, project, sessionId: session.id, profile: path.join(root, 'profile') };
    await writeFile(path.resolve('work/tauri-ui-current.json'), JSON.stringify(metadata, null, 2));
    const log = openSync(path.join(root, 'ui.log'), 'a');
    const ui = spawn(
      path.resolve(
        'src-tauri/target/release/bundle/macos/CoSail.app/Contents/MacOS/cosail-preview',
      ),
      [],
      {
        stdio: ['ignore', log, log],
        env: { ...process.env, TONGZHOU_TAURI_DATA_DIR: metadata.profile },
      },
    );
    closeSync(log);
    console.log('Tauri UI fixture:', root);
    await new Promise((resolve, reject) => {
      ui.on('error', reject);
      ui.on('exit', resolve);
    });
  } else {
    assert.equal((await invoke('updateStatus')).phase, 'unsupported');
    assert.equal((await invoke('computerStatus')).supported, false);
    assert.equal((await invoke('powerStatus')).active, false);
    const runId = await invoke('run', {
      sessionId: session.id,
      providerId: 'fixture',
      model: 'gpt-6-sol',
      agentId: '',
      prompt: '读取夹具网页，再在此项目创建 proof.txt，最后核对结果。',
    });
    let snapshot;
    await until(async () => {
      snapshot = await invoke('snapshot');
      return snapshot.runs.find((r) => r.id === runId)?.status !== 'running';
    }, 'Chat');
    assert.equal(snapshot.runs.find((r) => r.id === runId).status, 'completed');
    assert.equal(fetched.length, 1, 'MCP server must perform a real loopback fetch');
    assert.equal(await readFile(path.join(project, 'proof.txt'), 'utf8'), 'TAURI_CORE_PROOF');
    assert.ok(events.some((e) => e.type === 'approval'));
    const terminal = await invoke('startTerminal', session.id);
    await invoke(
      'writeTerminal',
      session.id,
      terminal.id,
      "node -e \"console.log('TAURI_' + 'PTY_PROOF')\"\r",
    );
    await until(
      async () =>
        (await invoke('readTerminal', session.id, terminal.id, undefined)).output.includes(
          'TAURI_PTY_PROOF',
        ),
      'PTY',
    );
    await invoke('resizeTerminal', session.id, terminal.id, 100, 30);
    await invoke('stopTerminal', session.id, terminal.id);
    const emergency = await invoke('startTerminal', session.id);
    send({ type: 'host_event', name: 'emergencyStop', payload: null });
    await until(
      async () => (await invoke('readTerminal', session.id, emergency.id)).status !== 'running',
      'Native emergency stop',
    );
    const provider = (await invoke('snapshot')).providers.find((p) => p.id === 'openai-codex');
    await invoke('saveProvider', {
      ...provider,
      enabled: true,
      network: { mode: 'proxy', proxyUrl: `http://127.0.0.1:${proxy.address().port}` },
    });
    await invoke('codexLogin', 'device', provider.id);
    await until(
      async () => (await invoke('codexStatus', provider.id)).login?.phase === 'error',
      'Device authorization proxy failure',
    );
    assert.ok(authProxy.includes('auth.openai.com:443'));
    await invoke('codexLogin', 'browser', provider.id);
    await until(() => native.some((n) => n.method === 'authOpen'), 'Browser authorization handoff');
    await invoke('codexLoginCancel', provider.id);
    await until(() => native.some((n) => n.method === 'authClose'), 'Authorization cancellation');
    await stop();
    await start();
    assert.ok(
      (await invoke('messages', session.id)).some(
        (m) => m.role === 'assistant' && m.content.includes('Tauri'),
      ),
    );
    await stop();
    const database = new DatabaseSync(path.join(root, 'profile/tongzhou.db'));
    database
      .prepare('INSERT OR REPLACE INTO objects(kind,id,value) VALUES(?,?,?)')
      .run(
        'preferences',
        'power',
        JSON.stringify({ id: 'power', keepAwakeOnAC: true, keepAwakeWhenLidClosed: false }),
      );
    database.close();
    await start();
    assert.equal((await invoke('powerStatus')).active, true);
    const disconnected = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.end();
    await Promise.race([
      disconnected,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Core did not exit after native parent EOF')),
          5000,
        ).unref(),
      ),
    ]);
    await writeFile(
      path.join(root, 'report.json'),
      JSON.stringify(
        {
          sessionId: session.id,
          runId,
          modelRequests: modelRequests.length,
          mcpFetches: fetched.length,
          pty: true,
          desktopStatus: true,
          emergencyStop: true,
          parentDisconnectCleanup: true,
          authorization:
            'real Codex browser handoff/cancel and device proxy routing; no user login',
          restartPersistence: true,
        },
        null,
        2,
      ),
    );
    console.log('Tauri Node host passed:', root);
  }
} finally {
  await stop();
  server.closeAllConnections();
  proxy.closeAllConnections();
  await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => proxy.close(r))]);
}
