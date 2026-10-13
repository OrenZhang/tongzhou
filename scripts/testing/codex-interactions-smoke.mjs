import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await mkdir('test-results', { recursive: true });
const root = await mkdtemp(path.resolve('test-results/codex-interactions-'));
await build({
  entryPoints: ['tests/support/task-system.ts', 'electron/services/storage/store.ts'],
  entryNames: '[name]',
  outdir: root,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  packages: 'external',
});
const require = createRequire(import.meta.url);
const { Store } = require(path.join(root, 'store.cjs'));
const { createTaskFixture } = require(path.join(root, 'task-system.cjs'));
const store = new Store(path.join(root, 'fixture.db'), { encrypt: (s) => s, decrypt: (s) => s });
store.saveProvider({
  id: 'fixture',
  name: 'fixture',
  protocol: 'openai-responses',
  auth: 'none',
  baseUrl: 'https://unused.invalid/v1',
  models: ['gpt-6-sol'],
  reasoningEffort: 'high',
  contextChars: 0,
  maxOutputTokens: 8192,
});
store.put('project', { id: 'fixture-project', name: 'fixture', path: root, createdAt: Date.now() });
await writeFile(
  path.join(root, 'AGENTS.md'),
  'Project prompt marker: keep this fixture isolated.\n',
);
const session = store.createSession('fixture-project');
store.setSessionPermission(session.id, 'ask');
const events = [],
  requests = [];
let system,
  rootRound = 0,
  childRound = 0,
  acceptWrite = false;
let releaseRoot;
let releaseResume;
const parentReady = new Promise((resolve) => {
  releaseRoot = resolve;
});
const resumeReady = new Promise((resolve) => {
  releaseResume = resolve;
});
const sse = (event) => 'data: ' + JSON.stringify(event) + '\n\n';
function response(item) {
  return new Response(
    [
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.completed',
        response: {
          id: 'response-' + requests.length,
          status: 'completed',
          output: [item],
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        },
      },
    ]
      .map(sse)
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
const call = (namespace, name, args, id) => ({
  id,
  type: 'function_call',
  namespace,
  name,
  call_id: id,
  arguments: JSON.stringify(args),
  status: 'completed',
});
const answer = (text, id) => ({
  id,
  type: 'message',
  role: 'assistant',
  phase: 'final_answer',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});
async function until(test) {
  const limit = Date.now() + 15000;
  while (!test()) {
    if (Date.now() > limit) throw new Error('Fixture condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
try {
  system = await createTaskFixture(store, root, (event) => {
    events.push(event);
    if (event.type === 'approval')
      setImmediate(() => {
        if (event.approval.kind === 'question')
          system.approvals.answer(event.approval.id, { scope: ['当前目录'] });
        else if (acceptWrite) system.approvals.approve(event.approval.id, true);
      });
  });
  system.network.transport = async () => async (_url, init) => {
    const body = JSON.parse(init.body);
    const child = body.input.some(
      (item) => item.type === 'agent_message' && item.recipient === '/root/research',
    );
    requests.push({ child, body });
    assert.equal(body.reasoning.effort, 'high');
    assert.ok(
      !JSON.stringify(body).includes('/.agents/skills'),
      'host skills must remain disabled for descendants',
    );
    if (child) {
      childRound++;
      if (childRound <= 2)
        return response({
          id: 'child-tool-' + childRound,
          type: 'custom_tool_call',
          namespace: 'functions',
          name: 'exec',
          call_id: 'child-write-' + childRound,
          status: 'completed',
          input:
            'const t = ALL_TOOLS.find(t => t.name.endsWith("write_file")); if (!t) throw new Error("business tools missing"); text(await tools[t.name]({path:"child.txt",content:"fixture committed once"}));',
        });
      return response(answer('Child verified receipt.', 'child-answer'));
    }
    rootRound++;
    if (rootRound === 1)
      return response(
        call(
          'functions',
          'request_user_input',
          {
            questions: [
              {
                id: 'scope',
                header: '范围',
                question: '选择夹具范围',
                options: [
                  { label: '当前目录', description: '仅此夹具' },
                  { label: '全部', description: '其他' },
                ],
              },
            ],
          },
          'ask-scope',
        ),
      );
    if (rootRound === 2)
      return response(
        call(
          'collaboration',
          'spawn_agent',
          {
            task_name: 'research',
            message: 'Create the requested fixture receipt with the provided business tool.',
            fork_turns: 'all',
          },
          'spawn-child',
        ),
      );
    if (rootRound === 3)
      return response(call('collaboration', 'wait_agent', { timeout_ms: 10000 }, 'wait-child'));
    await resumeReady;
    if (store.list('run').at(-1)?.agents?.[0]?.status === 'interrupted')
      return response(
        call(
          'collaboration',
          'followup_task',
          {
            target: '/root/research',
            message:
              'Continue the fixture task, checking the existing receipt before another write.',
          },
          'resume-child-' + rootRound,
        ),
      );
    await parentReady;
    return response(answer('Parent verified fixture completion.', 'root-answer'));
  };
  const input = {
    sessionId: session.id,
    providerId: 'fixture',
    model: 'gpt-6-sol',
    agentId: '',
    prompt: 'Use one native child Agent to create a fixture receipt, then verify the result.',
  };
  const id = system.tasks.start(input);
  const current = () => store.get('run', id);
  await until(
    () =>
      system.approvals.snapshot().some((a) => a.kind !== 'question') &&
      current().agents?.some((a) => a.turnId),
  );
  const child = current().agents[0];
  assert.equal(child.reasoningEffort, 'high');
  await system.tasks.controlAgent(session.id, child.threadId, 'interrupt');
  await until(() => current().agents[0].status === 'interrupted');
  assert.equal(
    system.approvals.snapshot().length,
    0,
    'child cancellation must clear its pending permission request',
  );
  await assert.rejects(stat(path.join(root, 'child.txt')), { code: 'ENOENT' });
  acceptWrite = true;
  await system.tasks.controlAgent(session.id, child.threadId, 'resume');
  releaseResume();
  await until(() => current().agents[0].status === 'completed');
  assert.equal(await readFile(path.join(root, 'child.txt'), 'utf8'), 'fixture committed once');
  releaseRoot();
  await system.tasks.waitForIdle();
  assert.equal(current().status, 'completed');
  assert.equal(JSON.stringify(requests[0].body).split('Project prompt marker').length - 1, 1);
  assert.ok(
    JSON.stringify(requests[0].body).includes(
      JSON.stringify(current().config.instructions).slice(1, -1),
    ),
  );
  assert.equal(current().agents[0].status, 'completed');
  assert.equal(
    current().inputTokens,
    requests.length * 100,
    'task usage must include descendant requests',
  );
  assert.equal(current().outputTokens, requests.length * 10);
  assert.equal(system.approvals.snapshot().length, 0);
  assert.equal(
    events.filter((e) => e.type === 'approval' && e.approval.kind === 'question').length,
    1,
  );
  assert.equal(
    store.messages(session.id).filter((m) => m.role === 'assistant' && m.phase === 'final_answer')
      .length,
    1,
    'child replies must not be mixed into the parent answer',
  );
  assert.ok(
    requests.some((r) => r.child),
    'a real native child must make its own model requests',
  );
  await assert.rejects(
    async () => system.tasks.controlAgent(session.id, child.threadId, 'resume'),
    /运行/,
  );
  console.log(
    'PASS native interactions: real RPC question, delegated business tools, inherited permissions, child interruption/resume and independent cleanup, final reply phase. ' +
      root,
  );
} finally {
  releaseResume();
  releaseRoot();
  await system?.dispose();
  store.close();
  await writeFile(path.join(root, 'requests.json'), JSON.stringify(requests, null, 2));
}
