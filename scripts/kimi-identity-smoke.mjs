import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import TOML from '@iarna/toml';

// Real bundled Kimi + its OpenAI SDK, with a local model server and disposable home.
// No user credentials, OAuth login or live inference are needed.
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/kimi-identity-'));
const home = path.join(root, 'home');
await mkdir(home);
const received = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  received.push({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(
    'data: ' +
      JSON.stringify({
        id: 'fixture',
        object: 'chat.completion.chunk',
        model: 'fixture',
        choices: [
          { index: 0, delta: { role: 'assistant', content: 'fixture ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }) +
      '\n\ndata: [DONE]\n\n',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let client;
try {
  await writeFile(
    path.join(home, 'config.toml'),
    TOML.stringify({
      default_model: 'fixture',
      providers: {
        fixture: {
          type: 'kimi',
          base_url: `http://127.0.0.1:${server.address().port}/v1`,
          api_key: 'fixture-key',
          custom_headers: { 'X-Fixture': 'preserved', 'user-agent': 'OpenAI/JS 6.34.0' },
        },
      },
      models: {
        fixture: {
          provider: 'fixture',
          model: 'fixture',
          max_context_size: 32768,
          capabilities: [],
        },
      },
    }),
  );
  const bundle = path.join(root, 'native.cjs');
  await build({
    entryPoints: ['electron/node-request-identity.ts'],
    outfile: path.join(root, 'node-request-identity.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  await build({
    entryPoints: ['electron/native-engine.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  const { NativeClient } = createRequire(import.meta.url)(bundle);
  client = new NativeClient('kimi', home);
  client.on('request', (request) => client.reject(request.id));
  await client.start();
  const session = await client.request('session/new', { cwd: root, mcpServers: [] });
  const response = await client.request(
    'session/prompt',
    {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'Reply briefly without using tools.' }],
    },
    30000,
  );
  assert.equal(response.stopReason, 'end_turn');
  assert.ok(received.length > 0, 'Kimi must send an actual model request');
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  for (const request of received) {
    assert.equal(request.headers['user-agent'], `Tongzhou/${version}`);
    assert.equal(request.headers.authorization, 'Bearer fixture-key');
    assert.equal(request.headers['x-fixture'], 'preserved');
    assert.ok(request.body.messages.length > 0);
  }
  console.log(
    `PASS: real Kimi/OpenAI SDK sent ${received.length} local request(s) with Tongzhou/${version}; auth and custom headers preserved.`,
  );
} finally {
  client?.stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
