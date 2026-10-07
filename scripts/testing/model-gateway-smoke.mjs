import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/model-gateway-'));
await build({
  entryPoints: ['electron/core/codex/codex.ts', 'electron/core/models/model-gateway.ts'],
  entryNames: '[name]',
  outdir: root,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  packages: 'external',
});
const require = createRequire(import.meta.url);
const { CodexClient } = require(path.join(root, 'codex.cjs'));
const { modelGateway } = require(path.join(root, 'model-gateway.cjs'));
const requests = [],
  executed = [];
const automatic = process.argv.includes('--auto-compact');
const provider = {
  id: 'fixture',
  name: 'fixture',
  protocol: 'openai-chat',
  auth: 'none',
  baseUrl: 'http://unused',
  models: ['fixture-model'],
  contextChars: 0,
  maxOutputTokens: 1000,
};
const createGateway = () =>
  modelGateway({
    sessionId: 'fixture',
    resolve: async () => ({ provider, model: 'fixture-model', secret: '' }),
    complete: async (input) => {
      requests.push(input);
      if (
        !input.tools.length ||
        input.messages.some(
          (m) =>
            m.content.includes('Continue after restart') ||
            m.content.includes('Saved document remains'),
        )
      )
        return {
          text: 'Saved document remains; continue from summary.',
          toolCalls: [],
          inputTokens: 10,
          outputTokens: 5,
        };
      if (input.messages.some((m) => m.role === 'tool')) {
        input.onDelta('Verified saved content.');
        return { text: 'Verified saved content.', toolCalls: [], inputTokens: 15, outputTokens: 4 };
      }
      const tool = input.tools.find((t) => t.name.endsWith('save_document'));
      assert.ok(tool, 'Codex must expose the dynamic tool to the model adapter');
      return {
        text: '',
        toolCalls: [{ id: 'call_write', name: tool.name, arguments: '{"content":"real content"}' }],
        inputTokens: automatic ? 3500 : 10,
        outputTokens: 4,
      };
    },
  });
let gateway = await createGateway();
let client = new CodexClient(path.join(root, 'home'), undefined, undefined, {
  ...gateway,
  contextWindow: automatic ? 4096 : 128000,
});
let finish, fail;
const done = new Promise((resolve, reject) => {
  finish = resolve;
  fail = reject;
});
done.catch(() => {});
function bind() {
  client.on('request', (r) => {
    if (r.method !== 'item/tool/call') {
      client.reject(r.id, 'Unexpected request');
      return;
    }
    executed.push(r.params);
    client.reply(r.id, {
      success: true,
      contentItems: [{ type: 'inputText', text: '{"saved":true}' }],
    });
  });
  client.on('notification', ({ method, params }) => {
    if (method === 'turn/completed')
      params.turn.status === 'completed' ? finish(params) : fail(Error(JSON.stringify(params)));
  });
  client.on('failure', (error) => fail(error));
}
bind();
const timeout = setTimeout(() => fail(Error('Real Codex gateway timed out')), 60000);
try {
  await client.start();
  const { thread } = await client.request('thread/start', {
    model: 'fixture-model',
    modelProvider: 'tongzhou-model',
    cwd: root,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    dynamicTools: [
      {
        type: 'function',
        name: 'save_document',
        description: 'Save the requested document.',
        inputSchema: {
          type: 'object',
          properties: { content: { type: 'string' } },
          required: ['content'],
          additionalProperties: false,
        },
      },
    ],
    ephemeral: false,
  });
  await client.request('turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: 'Save a document.' }],
  });
  await done;
  assert.equal(executed.length, 1);
  assert.deepEqual(executed[0].arguments, { content: 'real content' });
  assert.ok(requests.length >= 2);
  if (automatic)
    assert.ok(
      requests.some((r) => !r.tools.length),
      'Codex must auto-compact after reported token limit',
    );
  assert.ok(
    requests.some((request) =>
      request.messages.some((m) => m.role === 'tool' && m.content.includes('saved')),
    ),
  );
  let compactDone = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  await client.request('thread/compact/start', { threadId: thread.id });
  await compactDone;
  assert.ok(
    requests.some((r) => !r.tools.length),
    'Codex must request model compaction',
  );
  client.removeAllListeners('failure');
  client.removeAllListeners('notification');
  client.stop();
  gateway = await createGateway();
  client = new CodexClient(path.join(root, 'home'), undefined, undefined, {
    ...gateway,
    contextWindow: automatic ? 4096 : 128000,
  });
  bind();
  const resumeDone = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  await client.start();
  await client.request('thread/resume', {
    threadId: thread.id,
    model: 'fixture-model',
    modelProvider: 'tongzhou-model',
    cwd: root,
    approvalPolicy: 'never',
    sandbox: 'read-only',
  });
  await client.request('turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: 'Continue after restart without repeating the write.' }],
  });
  await resumeDone;
  assert.equal(executed.length, 1, 'Resuming must not replay the committed write');
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('Saved document remains'));
  console.log(
    'PASS real Codex core: tool loop, model compaction, process restart/resume without write replay. ' +
      root,
  );
} finally {
  clearTimeout(timeout);
  client.stop();
  await writeFile(path.join(root, 'requests.json'), JSON.stringify(requests, null, 2));
}
