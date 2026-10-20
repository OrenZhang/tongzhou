import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ExecutionApplication } from '../../electron/application/execution-application';
import type { ExecutionEnvironment } from '../../electron/application/execution-context';
import { localSecretCodec } from '../../electron/services/storage/local-secret-codec';
import { writeLocalFile } from '../../electron/services/storage/file-transfer';
import type { Store } from '../../electron/services/storage/store';
import type { AppEvent, Session, Run } from '../../src/shared/types';

async function main() {
  assert.equal(process.versions.electron, undefined, 'Must run in ordinary Node');
  const root = await mkdtemp(path.resolve('test-results/execution-'));
  const project = path.join(root, '项目 with spaces');
  await mkdir(project);
  const profile = path.join(root, 'profile');
  const requests: any[] = [],
    events: AppEvent[] = [],
    dialogs: string[] = [];
  let round = 0;
  const unavailable = async () => {
    throw new Error('No native UI in this host');
  };
  let app: ExecutionApplication;
  const environment: ExecutionEnvironment = {
    dataDir: profile,
    bundleDir: __dirname,
    createSecretCodec: () => localSecretCodec(profile),
    emit(event) {
      events.push(event);
      if (event.type === 'approval')
        setImmediate(() => {
          if (event.approval.kind === 'question')
            app.client.invoke('answerQuestions', event.approval.id, { scope: ['当前目录'] });
          else app.client.invoke('approve', event.approval.id, true);
        });
    },
    host: {
      version: 'fixture',
      documents: {
        chooseFiles: unavailable,
        readImport: readFile,
        saveCopy: unavailable,
        writeTo: writeLocalFile,
        openPath: unavailable,
        openExternal: unavailable,
      },
      dialogs: {
        async showOpenDialog(options) {
          dialogs.push(options.title ?? '');
          return { canceled: true, filePaths: [] };
        },
        async showSaveDialog(options) {
          dialogs.push(options.title ?? '');
          return { canceled: true };
        },
      },
      writeClipboard: unavailable,
      restart: unavailable,
    },
    modelTransport: async () => async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      assert.equal(body.reasoning.effort, 'high');
      round++;
      const item =
        round === 1
          ? {
              id: 'scope',
              type: 'function_call',
              namespace: 'functions',
              name: 'request_user_input',
              call_id: 'scope',
              status: 'completed',
              arguments: JSON.stringify({
                questions: [
                  {
                    id: 'scope',
                    header: '范围',
                    question: '确认夹具范围',
                    options: [
                      { label: '当前目录', description: '仅夹具项目' },
                      { label: '其他', description: '其他范围' },
                    ],
                  },
                ],
              }),
            }
          : round === 2
            ? {
                id: 'write',
                type: 'custom_tool_call',
                namespace: 'functions',
                name: 'exec',
                call_id: 'write',
                status: 'completed',
                input:
                  'const t = ALL_TOOLS.find(t => t.name.endsWith("write_file")); if (!t) throw new Error("business tool missing"); text(await tools[t.name]({path:"proof.txt",content:"Node execution verified"}));',
              }
            : {
                id: 'answer',
                type: 'message',
                role: 'assistant',
                phase: 'final_answer',
                status: 'completed',
                content: [
                  { type: 'output_text', text: '已创建并核对 proof.txt。', annotations: [] },
                ],
              };
      return new Response(
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
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  };
  app = new ExecutionApplication(environment);
  try {
    await app.start();
    const store = app.kernel.get<Store>('tzStore');
    assert.equal(app.kernel.context.get('tzDesktop', false), undefined);
    assert.equal(app.kernel.context.get('tzAccountBrowser', false), undefined);
    const catalog: any = app.client.invoke('clientMethods');
    assert.ok(catalog.methods.some((m: any) => m.name === 'run'));
    assert.ok(!catalog.methods.some((m: any) => m.name === 'computerStatus'));
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
    store.saveSecret('fixture-proof', 'fixture-secret');
    assert.equal(store.secret('fixture-proof'), 'fixture-secret');
    store.put('project', {
      id: 'fixture-project',
      name: 'fixture',
      path: project,
      createdAt: Date.now(),
    });
    const session = app.client.invoke('createSession', 'fixture-project') as Session;
    app.client.invoke('setSessionPermission', session.id, 'ask');
    const input = {
      sessionId: session.id,
      providerId: 'fixture',
      model: 'gpt-6-sol',
      agentId: '',
      prompt:
        '在此夹具项目中创建 proof.txt，内容为 Node execution verified，询问范围并在完成后核对。',
    };
    const id = app.client.invoke('run', input) as string;
    await app.tasks.waitForIdle();
    const run = store.get<Run>('run', id);
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert.equal(
      await readFile(path.join(project, 'proof.txt'), 'utf8'),
      'Node execution verified',
    );
    assert.ok(events.some((e) => e.type === 'approval' && e.approval.kind === 'question'));
    assert.ok(events.some((e) => e.type === 'approval' && e.approval.kind !== 'question'));
    assert.ok(requests.length >= 3);
    assert.ok(
      store
        .messages(session.id)
        .some((m) => m.role === 'assistant' && m.content.includes('proof.txt')),
    );
    assert.equal(await app.client.invoke('exportSession', session.id), null);
    assert.deepEqual(dialogs, ['导出会话']);
    const canvas: any = app.client.invoke('canvasSave', {
      title: 'Node workflow',
      nodes: [{ id: 'text', kind: 'text', title: '输入', text: '可复用的画布内容', x: 0, y: 0 }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      selection: [],
    });
    app.client.invoke('canvasBind', session.id, canvas.id);
    const workflowId = (
      app.client.invoke('canvasExecute', {
        canvasId: canvas.id,
        version: canvas.version,
        sessionId: session.id,
      }) as { id: string }
    ).id;
    const workflows = app.kernel.context.tzCanvases;
    // Workflow handles own their asynchronous loops, separately from chat tasks.
    const deadline = Date.now() + 15000;
    while (
      workflows.state(canvas.id).runs.some((r) => r.id === workflowId && r.status === 'running')
    ) {
      if (Date.now() > deadline) throw new Error('Workflow timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const workflow: any = workflows.state(canvas.id).runs.find((r) => r.id === workflowId);
    assert.equal(workflow?.status, 'completed');
    assert.equal(workflow.nodes.text.output.text, '可复用的画布内容');
    const client = app.client;
    await app.stop();
    assert.throws(() => client.invoke('snapshot'), /正在退出/);
    assert.equal(app.kernel.context.get('tzStore', false), undefined);
    app = new ExecutionApplication(environment);
    await app.start();
    const reopened = app.kernel.get<Store>('tzStore');
    assert.equal(reopened.secret('fixture-proof'), 'fixture-secret');
    assert.ok(reopened.messages(session.id).some((m) => m.role === 'assistant'));
    assert.equal(reopened.get<Session>('session', session.id).activeCanvasId, canvas.id);
    await writeFile(
      path.join(root, 'report.json'),
      JSON.stringify(
        {
          runtime: process.version,
          electron: false,
          runId: id,
          requests: requests.length,
          approvals: events.filter((e) => e.type === 'approval').length,
          workflow: workflowId,
          persistence: true,
        },
        null,
        2,
      ),
    );
    console.log('Node execution passed:', root);
  } finally {
    await app.stop();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
