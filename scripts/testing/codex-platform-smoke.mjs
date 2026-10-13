import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Exercise the bundled binary and production execution adapter with a synthetic
// Responses service. No account, API key, external service or user database.
await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/codex-platform-'));
await build({
  entryPoints: [
    'electron/core/codex/execution.ts',
    'electron/core/runtime/run-ledger.ts',
    'electron/core/tools/extensions.ts',
    'electron/services/storage/store.ts',
    'electron/modules/artifacts/attachments.ts',
  ],
  entryNames: '[name]',
  outdir: root,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  packages: 'external',
});
const require = createRequire(import.meta.url);
const { CodexExecution } = require(path.join(root, 'execution.cjs'));
const { RunLedger } = require(path.join(root, 'run-ledger.cjs'));
const { ToolScope } = require(path.join(root, 'extensions.cjs'));
const { Store } = require(path.join(root, 'store.cjs'));
const { Attachments } = require(path.join(root, 'attachments.cjs'));
const store = new Store(path.join(root, 'fixture.db'), { encrypt: (s) => s, decrypt: (s) => s });
store.saveProvider({
  id: 'fixture',
  name: 'fixture',
  protocol: 'openai-responses',
  auth: 'none',
  baseUrl: 'https://unused.invalid/v1',
  models: ['gpt-6-sol'],
  reasoningEffort: 'high',
  maxOutputTokens: 8192,
  contextChars: 0,
});
const session = store.createSession();
const ledger = new RunLedger(
  store,
  () => {},
  () => false,
);
const requests = [];
let writes = 0,
  reads = 0,
  approvals = 0;
const agent = {
  id: 'fixture',
  name: 'fixture',
  instructions: 'Use the requested business tool.',
  permission: 'ask',
  providerId: 'fixture',
  model: 'gpt-6-sol',
  maxSteps: 0,
};
const sse = (event) => 'data: ' + JSON.stringify(event) + '\n\n';
function response(items) {
  const events = items.flatMap((item, output_index) => [
    { type: 'response.output_item.added', output_index, item },
    { type: 'response.output_item.done', output_index, item },
  ]);
  events.push({
    type: 'response.completed',
    response: {
      id: 'response-' + requests.length,
      status: 'completed',
      output: items,
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    },
  });
  return new Response(events.map(sse).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}
const execution = new CodexExecution({
  store,
  dataDir: root,
  attachments: new Attachments(root),
  sessions: { isDeleting: () => false },
  isStopping: () => false,
  ask: async () => true,
  progress: (...args) => ledger.progress(...args),
  add: (...args) => ledger.add(...args),
  appendText: (...args) => ledger.appendText(...args),
  finishText: (...args) => ledger.finishText(...args),
  message: (...args) => ledger.message(...args),
  modelTransport: async () => async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (requests.length === 3)
      return new Response(
        JSON.stringify({ error: { message: 'fixture outage after committed write' } }),
        { status: 503 },
      );
    if (requests.length > 3) {
      assert.ok(
        JSON.stringify(body.input).includes('receipt-committed'),
        'native resume must retain the tool receipt',
      );
      assert.ok(
        JSON.stringify(body.input).includes('opaque-reasoning-fixture'),
        'native reasoning must survive the failed turn',
      );
      if (requests.length === 4)
        return response([
          {
            id: 'verify',
            type: 'custom_tool_call',
            namespace: 'functions',
            name: 'exec',
            call_id: 'call-verify',
            status: 'completed',
            input:
              'const t = ALL_TOOLS.find(t => t.name.includes("read_fixture_receipt")); text(await tools[t.name]({}));',
          },
        ]);
      return response([
        {
          id: 'answer',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'Verified receipt; continued without another write.',
              annotations: [],
            },
          ],
        },
      ]);
    }
    const item = {
      id: 'exec-' + requests.length,
      type: 'custom_tool_call',
      namespace: 'functions',
      name: 'exec',
      call_id: 'call-' + requests.length,
      status: 'completed',
      input:
        requests.length === 1
          ? 'text(ALL_TOOLS.filter(t => t.name.includes("write_fixture_receipt")));'
          : 'const t = ALL_TOOLS.find(t => t.name.includes("write_fixture_receipt")); text(await tools[t.name]({}));',
    };
    return response(
      requests.length === 1
        ? [
            {
              id: 'reasoning',
              type: 'reasoning',
              encrypted_content: 'opaque-reasoning-fixture',
              summary: [],
            },
            item,
          ]
        : [item],
    );
  },
});
function scope(signal, run) {
  const tools = new ToolScope(
    signal,
    async () => {
      approvals++;
      return true;
    },
    (name, args, result) => {
      ledger.add(session.id, 'tool', JSON.stringify({ args, result: result.text }), {
        runId: run.id,
        toolName: name,
      });
    },
  );
  const parameters = { type: 'object', properties: {}, additionalProperties: false };
  tools.add(
    { name: 'write_fixture_receipt', description: 'Write one fixture receipt.', parameters },
    'Write fixture receipt',
    async () => {
      writes++;
      await writeFile(path.join(root, 'receipt.txt'), 'receipt-committed');
      return { text: 'receipt-committed' };
    },
  );
  tools.add(
    {
      name: 'read_fixture_receipt',
      description: 'Read the persisted fixture receipt.',
      parameters,
    },
    'Read fixture receipt',
    async () => {
      reads++;
      return { text: await readFile(path.join(root, 'receipt.txt'), 'utf8') };
    },
    false,
  );
  for (let i = 0; i < 22; i++)
    tools.add(
      { name: 'unused_fixture_' + i, description: 'Unused fixture query ' + i, parameters },
      'Unused query',
      async () => ({ text: 'unused' }),
      false,
    );
  return tools;
}
function run(id, prompt) {
  const current = {
    id,
    sessionId: session.id,
    providerId: 'fixture',
    model: 'gpt-6-sol',
    agentName: 'fixture',
    status: 'running',
    startedAt: Date.now(),
    inputTokens: 0,
    outputTokens: 0,
    config: {
      protocol: 'openai-responses',
      baseUrl: 'https://unused.invalid/v1',
      instructions: agent.instructions,
      permission: 'ask',
      maxSteps: 0,
    },
  };
  store.put('run', current);
  ledger.add(session.id, 'user', prompt, { runId: id });
  return current;
}
const scopes = [];
try {
  const first = run('first', 'Write a single fixture receipt.');
  const controller = new AbortController();
  scopes.push(scope(controller.signal, first));
  await assert.rejects(
    execution.run(
      {
        sessionId: session.id,
        providerId: 'fixture',
        model: 'gpt-6-sol',
        agentId: 'fixture',
        prompt: 'Write a single fixture receipt.',
      },
      null,
      agent,
      first,
      controller.signal,
      scopes[0],
    ),
    /fixture outage/,
  );
  first.status = 'failed';
  store.put('run', first);
  ledger.add(session.id, 'system', 'fixture outage', { runId: first.id, status: 'error' });
  assert.equal(store.get('engineSegment', first.id).state, 'failed');
  assert.equal(requests.length, 3, 'failed inference must not be automatically retried');
  assert.equal(writes, 1);
  assert.equal(approvals, 1);
  assert.equal(requests[0].reasoning.effort, 'high');
  assert.ok(
    !JSON.stringify(requests[0]).includes('write_fixture_receipt'),
    'deferred schemas must be omitted from the initial prompt',
  );
  assert.ok(
    JSON.stringify(requests[1]).includes('write_fixture_receipt'),
    'discovery must return a callable business tool',
  );
  await execution.close();
  const next = run('next', 'Check the receipt and continue.');
  scopes.push(scope(controller.signal, next));
  await execution.run(
    {
      sessionId: session.id,
      providerId: 'fixture',
      model: 'gpt-6-sol',
      agentId: 'fixture',
      prompt: 'Check the receipt and continue.',
    },
    null,
    agent,
    next,
    controller.signal,
    scopes[1],
  );
  assert.equal(
    store.get('engineSegment', next.id).threadId,
    store.get('engineSegment', first.id).threadId,
  );
  assert.equal(writes, 1, 'resuming must not replay a committed operation');
  assert.equal(reads, 1, 'resumed deferred tools must remain callable through the new scope');
  assert.equal(approvals, 1);
  assert.equal(await readFile(path.join(root, 'receipt.txt'), 'utf8'), 'receipt-committed');
  assert.ok(!JSON.stringify(requests.at(-1)).includes('以下 JSON 行是历史资料'));
  console.log(
    'PASS bundled Codex platform: high effort, deferred discovery and permission gate, failed-turn native resume with reasoning and receipts, no write replay. ' +
      root,
  );
} finally {
  await execution.close();
  for (const tools of scopes) await tools.close();
  store.close();
  await writeFile(path.join(root, 'requests.json'), JSON.stringify(requests, null, 2));
}
