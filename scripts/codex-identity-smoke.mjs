import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/codex-identity-'));
await mkdir(path.join(root, 'home'));
const bundle = path.join(root, 'codex.cjs');
await build({
  entryPoints: ['electron/codex.ts', 'electron/codex-transport.ts', 'electron/request-identity.ts'],
  outdir: root,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
});
const require = createRequire(import.meta.url);
const { codexBinary } = require(bundle);
const { codexTransportArgs } = require(path.join(root, 'codex-transport.cjs'));
const { clientIdentity } = require(path.join(root, 'request-identity.cjs'));
const received = [];
const transport = process.argv.includes('--ws') ? 'auto' : 'http';
const server = createServer(async (req, res) => {
  for await (const _chunk of req) {
  }
  received.push({ url: req.url, ua: req.headers['user-agent'] });
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const item = {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'fixture ok', annotations: [] }],
  };
  for (const e of [
    {
      type: 'response.created',
      response: { id: 'resp_fixture', status: 'in_progress', output: [] },
    },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'resp_fixture',
        status: 'completed',
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ])
    res.write('data: ' + JSON.stringify(e) + '\n\n');
  res.end();
});
server.on('upgrade', (req, socket) => {
  received.push({ url: req.url, ua: req.headers['user-agent'], websocket: true });
  socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const provider = `tongzhou_chatgpt_${transport}`;
const child = spawn(
  codexBinary(),
  [
    'app-server',
    '--listen',
    'stdio://',
    ...codexTransportArgs(transport),
    '-c',
    `model_providers.${provider}.base_url="http://127.0.0.1:${server.address().port}/v1"`,
    '-c',
    `model_providers.${provider}.requires_openai_auth=false`,
    '-c',
    'analytics.enabled=false',
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: path.join(root, 'home'),
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    windowsHide: true,
    stdio: 'pipe',
  },
);
const pending = new Map();
let seq = 0;
let stderr = '';
child.stderr.on('data', (data) => (stderr += data));
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  try {
    const r = JSON.parse(line);
    const p = pending.get(r.id);
    if (p) {
      pending.delete(r.id);
      r.error ? p.reject(Error(JSON.stringify(r.error))) : p.resolve(r.result);
    }
  } catch {}
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timeout = setTimeout(
      () => reject(Error(method + ' timed out: ' + stderr.slice(-1000))),
      30000,
    );
    pending.set(id, {
      resolve: (r) => {
        clearTimeout(timeout);
        resolve(r);
      },
      reject: (e) => {
        clearTimeout(timeout);
        reject(e);
      },
    });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
try {
  await request('initialize', { clientInfo: clientIdentity });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const thread = await request('thread/start', {
    model: 'gpt-5.4',
    modelProvider: provider,
    cwd: root,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: true,
  });
  await request('turn/start', {
    threadId: thread.thread.id,
    input: [{ type: 'text', text: 'Reply ok. Do not use tools.' }],
  });
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (received.length) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > 30000) {
        clearInterval(timer);
        reject(Error('No model request: ' + stderr.slice(-1000)));
      }
    }, 100);
  });
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  assert.ok(received.some((r) => r.url === '/v1/responses'));
  for (const r of received) assert.equal(r.ua, `Tongzhou/${version}`);
  if (transport === 'auto')
    assert.ok(
      received.some((r) => r.websocket),
      'Must observe a real WebSocket handshake',
    );
  console.log(
    `PASS: real bundled Codex ${transport} transport sends Tongzhou identity to the local Responses server.`,
  );
} finally {
  child.stdin.end();
  child.kill();
  lines.close();
  for (const p of pending.values()) p.reject(Error('closed'));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
