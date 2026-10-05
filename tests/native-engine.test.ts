import { seedAgents } from './fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeAccount, NativeClient, loginDetails, modelCatalog } from '../electron/native-engine';
import { Runtime } from '../electron/runtime';
import { Store } from '../electron/store';
import { Attachments } from '../electron/attachments';
import { providerSchema } from '../electron/validation';

const fake = vi.hoisted(() => ({
  children: [] as any[],
  calls: [] as any[],
  replies: [] as any[],
  authenticated: false,
  stopReason: 'end_turn',
  updates: [] as any[],
  images: false,
}));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    // This suite mocks process launch; the real bootstrap is exercised by engine smoke tests.
    existsSync: (file: Parameters<typeof actual.existsSync>[0]) =>
      String(file).endsWith('node-request-identity.cjs') || actual.existsSync(file),
  };
});
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { EventEmitter } = await import('node:events');
  const { PassThrough, Writable } = await import('node:stream');
  return {
    spawn: vi.fn((executable: string, args: string[], options: any) => {
      if (executable === 'git') return actual.spawn(executable, args, options);
      if (executable === 'taskkill') {
        const target = fake.children.find((c) => String(c.pid) === args[1]);
        if (target) {
          target.exitCode = 1;
          target.emit('exit', 1);
          target.emit('close', 1);
        }
        return new EventEmitter();
      }
      const child: any = new EventEmitter();
      child.pid = 700000 + fake.children.length;
      child.exitCode = null;
      child.args = args;
      child.options = options;
      child.executable = executable;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn();
      const emit = (msg: any) =>
        child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
      child.send = emit;
      let activeSession = '';
      let pendingPrompt: number;
      child.stdin = new Writable({
        write(buffer, _encoding, done) {
          const msg = JSON.parse(String(buffer));
          if (!msg.method) {
            fake.replies.push(msg);
            if (msg.id === 'permission')
              emit({ id: pendingPrompt, result: { stopReason: fake.stopReason } });
            done();
            return;
          }
          fake.calls.push({ ...msg, child });
          let result: any = {};
          if (msg.method === 'initialize')
            result = { agentCapabilities: { promptCapabilities: { image: fake.images } } };
          if (msg.method === 'authenticate' && !fake.authenticated) {
            emit({ id: msg.id, error: { code: -32000, message: 'Authentication required' } });
            done();
            return;
          }
          if (msg.method === 'logout') fake.authenticated = false;
          if (msg.method === 'session/new') {
            activeSession = `session-${fake.calls.length}`;
            result = {
              sessionId: activeSession,
              modes: { availableModes: [{ id: 'plan' }, { id: 'default' }] },
              configOptions: [
                {
                  id: 'model',
                  category: 'model',
                  options: [{ value: 'native-model', name: 'Friendly model' }],
                },
                { id: 'permissionMode', options: [{ value: 'default', name: 'Ask' }] },
                {
                  id: 'thinking',
                  category: 'thought_level',
                  currentValue: 'off',
                  options: [{ value: 'off' }, { value: 'on' }],
                },
              ],
            };
          }
          if (msg.method === 'session/prompt') {
            pendingPrompt = msg.id;
            for (const update of fake.updates.length
              ? fake.updates
              : [
                  {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'Native answer' },
                  },
                ])
              emit({
                method: 'session/update',
                params: {
                  sessionId: activeSession,
                  update,
                },
              });
            emit({
              id: 'permission',
              method: 'session/request_permission',
              params: {
                sessionId: activeSession,
                toolCall: { title: 'Write a file' },
                options: [
                  { optionId: 'once', kind: 'allow_once' },
                  { optionId: 'always', kind: 'allow_always' },
                ],
              },
            });
          } else emit({ id: msg.id, result });
          done();
        },
      });
      fake.children.push(child);
      return child;
    }),
  };
});
let root: string;
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.spyOn(process, 'kill').mockImplementation(() => true);
  root = mkdtempSync(path.join(os.tmpdir(), 'tongzhou-native-'));
  fake.children.length = fake.calls.length = fake.replies.length = 0;
  fake.authenticated = false;
  fake.stopReason = 'end_turn';
  fake.updates = [];
  fake.images = false;
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function account(kind: 'kimi' | 'minimax' = 'kimi') {
  const synced = vi.fn();
  const changed = vi.fn();
  const auth = new NativeAccount(kind, path.join(root, kind), changed, synced);
  cleanups.push(() => auth.dispose());
  return { auth, synced, changed };
}
describe('official native engine account integration', () => {
  it('only exposes official HTTPS login links and a bounded device code', () => {
    expect(
      loginDetails(
        'kimi',
        'Opening browser: https://www.kimi.com/code/authorize\nenter code: ABCD-1234',
      ),
    ).toEqual({ url: 'https://www.kimi.com/code/authorize', userCode: 'ABCD-1234' });
    expect(
      loginDetails('minimax', 'Open: https://agent.minimax.cn/auth\nCode: ABCD-1234'),
    ).toMatchObject({ userCode: 'ABCD-1234' });
    for (const link of [
      'https://www.kimi.com.evil.test/a',
      'https://user:pass@www.kimi.com/a',
      'http://www.kimi.com',
      'https://www.kimi.com:8080/a',
      'https://agent.minimax.cn/a',
    ])
      expect(loginDetails('kimi', link).url).toBeUndefined();
  });
  it('validates native providers independently from API credentials', () => {
    const p = {
      id: 'kimi',
      name: 'Kimi',
      protocol: 'kimi',
      auth: 'native',
      baseUrl: '',
      models: [],
      maxOutputTokens: 4096,
      contextChars: 50000,
    };
    expect(providerSchema.parse(p)).toMatchObject(p);
    expect(providerSchema.safeParse({ ...p, secret: 'private' }).success).toBe(false);
    expect(
      providerSchema.safeParse({
        ...p,
        protocol: 'openai-chat',
        baseUrl: 'https://example.test/v1',
      }).success,
    ).toBe(false);
  });
  it('extracts grouped model options and preserves opaque IDs and friendly names', () => {
    expect(
      modelCatalog({
        configOptions: [
          {
            id: 'modelPicker',
            category: 'model',
            options: [{ options: [{ value: 'model:minimax:M3', name: 'MiniMax M3' }] }],
          },
        ],
      }),
    ).toEqual({
      optionId: 'modelPicker',
      models: ['model:minimax:M3'],
      modelLabels: { 'model:minimax:M3': 'MiniMax M3' },
    });
    expect(
      modelCatalog({ models: { availableModels: [{ modelId: 'k', name: 'Kimi' }] } }).models,
    ).toEqual(['k']);
  });
  it.each(['kimi', 'minimax'] as const)(
    'starts %s with the shared network bootstrap and no inherited API secrets',
    async (kind) => {
      process.env.OPENAI_API_KEY = 'must-not-leak';
      try {
        if (kind === 'minimax')
          writeFileSync(path.join(root, 'config.yaml'), 'defaultModel: fixture\n');
        const client = new NativeClient(kind, root);
        cleanups.push(() => client.stop());
        await client.start();
        const child = fake.children[0];
        expect(child.executable).toMatch(/node[/\\]bin[/\\]node/);
        expect(child.args[0]).toBe('--require');
        expect(child.args[1]).toMatch(/node-request-identity\.cjs$/);
        expect(child.options.env.NODE_OPTIONS).toBeUndefined();
        expect(child.options.env.KIMI_CODE_HOME).toBe(root);
        expect(child.options.env.OPENAI_API_KEY).toBeUndefined();
        expect(child.options.shell).toBe(false);
        await expect(client.authenticate()).rejects.toMatchObject({ code: -32000 });
      } finally {
        delete process.env.OPENAI_API_KEY;
      }
    },
  );
  it('requires verified auth and model discovery before reporting login success', async () => {
    const { auth, synced } = account();
    auth.start('cn');
    const child = fake.children[0];
    child.stderr.write('Opening browser: https://www.kimi.com/login\nenter code: ABCD-1234\n');
    expect(auth.state.phase).toBe('waiting');
    expect(auth.state.authenticated).toBe(false);
    fake.authenticated = true;
    child.exitCode = 0;
    child.emit('close', 0);
    await expect.poll(() => auth.state.phase).toBe('success');
    expect(synced).toHaveBeenCalledWith(expect.objectContaining({ models: ['native-model'] }));
    expect(auth.state.url).toBeUndefined();
    expect(auth.state.userCode).toBeUndefined();
  });
  it('does not report success from a zero exit code without a valid account', async () => {
    const { auth, synced } = account('minimax');
    auth.start('global');
    expect(fake.children[0].args).toContain('--no-browser');
    fake.children[0].exitCode = 0;
    fake.children[0].emit('close', 0);
    await expect.poll(() => auth.state.phase).toBe('error');
    expect(synced).not.toHaveBeenCalled();
  });
  it('cancels immediately, clears one-time data and ignores late completion', async () => {
    const { auth, synced } = account();
    auth.start('cn');
    const child = fake.children[0];
    child.stderr.write('https://www.kimi.com/login\nenter code: ABCD-1234\n');
    auth.cancel();
    fake.authenticated = true;
    child.emit('close', 0);
    await Promise.resolve();
    expect(auth.state.phase).toBe('cancelled');
    expect(auth.state.url).toBeUndefined();
    expect(synced).not.toHaveBeenCalled();
  });
  it('bounds device authorization waits and clears expired links', async () => {
    vi.useFakeTimers();
    const { auth } = account();
    auth.start('cn');
    await vi.advanceTimersByTimeAsync(600001);
    expect(auth.state.phase).toBe('error');
    expect(auth.state.error).toContain('超时');
  });
  it('reads actual login state and logs out through the official engine', async () => {
    const { auth } = account();
    expect((await auth.read()).authenticated).toBe(false);
    fake.authenticated = true;
    expect((await auth.read()).authenticated).toBe(true);
    await auth.logout();
    expect(auth.state.authenticated).toBe(false);
    expect(fake.authenticated).toBe(false);
  });
});

describe('ACP conversation execution', () => {
  it('enables advertised thinking by default and applies off after a provider edit', async () => {
    const f = fixture(false);
    f.runtime.start(f.input);
    await f.runtime.waitForIdle();
    expect(
      fake.calls
        .filter((c) => c.method === 'session/set_config_option' && c.params.configId === 'thinking')
        .at(-1).params.value,
    ).toBe('on');
    f.store.saveProvider({
      ...f.store.providers().find((p) => p.id === 'native')!,
      thinkingEnabled: false,
    });
    f.runtime.start({ ...f.input, prompt: 'continue' });
    await f.runtime.waitForIdle();
    expect(
      fake.calls
        .filter((c) => c.method === 'session/set_config_option' && c.params.configId === 'thinking')
        .at(-1).params.value,
    ).toBe('off');
    expect(fake.calls.filter((c) => c.method === 'session/new')).toHaveLength(2);
  });

  it('keeps native reasoning and tool boundaries between response segments', async () => {
    fake.updates = [
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先检查' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '检查中。' } },
      { sessionUpdate: 'tool_call', status: 'in_progress', title: '工具' },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '再总结' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已完成。' } },
    ];
    const f = fixture(false);
    f.runtime.start(f.input);
    await f.runtime.waitForIdle();
    const message = f.store.messages(f.input.sessionId).find((m) => m.role === 'assistant')!;
    const thoughts = f.runtime.events(f.input.sessionId).filter((e) => e.type === 'reasoning');
    expect(message.content).toBe('检查中。已完成。');
    expect(message.status).toBe('complete');
    expect(message.segments).toHaveLength(2);
    expect(thoughts.map((e) => e.text)).toEqual(['先检查', '再总结']);
    expect(message.segments![0].seq).toBeLessThan(thoughts[1].seq);
    expect(message.segments![1].seq).toBeGreaterThan(thoughts[1].seq);
  });
  function fixture(project: boolean) {
    fake.authenticated = true;
    const store = new Store(':memory:', { encrypt: (s) => s, decrypt: (s) => s });
    seedAgents(store);
    const runtime = new Runtime(store, root, (event) => {
      if (event.type === 'approval') runtime.approve(event.approval.id, true);
    });
    cleanups.push(() => {
      runtime.stop();
      store.close();
    });
    store.saveProvider({
      id: 'native',
      name: 'Kimi',
      protocol: 'kimi',
      auth: 'native',
      baseUrl: '',
      models: ['native-model'],
      maxOutputTokens: 4096,
      contextChars: 50000,
    });
    if (project) store.put('project', { id: 'p', name: 'p', path: root, createdAt: 1 });
    const session = store.createSession(project ? 'p' : null);
    const input = {
      sessionId: session.id,
      providerId: 'native',
      model: 'native-model',
      agentId: 'builder',
      prompt: 'Hello',
    };
    return { store, runtime, input };
  }
  it('supports projectless chat and carries portable history while denying tool permissions', async () => {
    const { store, runtime, input } = fixture(false);
    runtime.start(input);
    await runtime.waitForIdle();
    runtime.start({ ...input, prompt: 'Continue' });
    await runtime.waitForIdle();
    expect(store.list<any>('run').every((r) => r.status === 'completed')).toBe(true);
    expect(
      fake.calls
        .filter((c) => c.method === 'session/set_mode')
        .every((c) => c.params.modeId === 'default'),
    ).toBe(true);
    expect(fake.replies.every((r) => r.result.outcome.outcome === 'cancelled')).toBe(true);
    expect(fake.calls.filter((c) => c.method === 'session/prompt')[1].params.prompt[0].text).toBe(
      'Continue',
    );
    expect(fake.calls.filter((c) => c.method === 'initialize')).toHaveLength(1);
    expect(fake.calls.filter((c) => c.method === 'session/new')).toHaveLength(1);
    expect(store.messages(input.sessionId).some((m) => m.role === 'tool')).toBe(false);
    expect(store.messages(input.sessionId).filter((m) => m.role === 'assistant')).toHaveLength(2);
  });
  it.each([true, false])(
    'honors ACP image capability %s and never silently drops an attachment',
    async (supported) => {
      fake.images = supported;
      const f = fixture(false);
      const a = new Attachments(f.store, root).save({
        name: 'p.png',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      });
      f.runtime.start({ ...f.input, prompt: '', attachmentIds: [a.id] });
      await f.runtime.waitForIdle();
      const prompts = fake.calls.filter((c) => c.method === 'session/prompt');
      if (supported)
        expect(
          prompts[0].params.prompt.some(
            (p: any) => p.type === 'image' && p.mimeType === 'image/png',
          ),
        ).toBe(true);
      else {
        expect(prompts).toHaveLength(0);
        expect(f.store.list<any>('run')[0].status).toBe('failed');
      }
      expect(f.store.messages(f.input.sessionId)[0].attachments?.[0].id).toBe(a.id);
    },
  );
  it.each([false, true])(
    'keeps native supplements inside the same run (project=%s)',
    async (project) => {
      const { store, runtime, input } = fixture(project);
      const runId = runtime.start(input);
      await runtime.enqueue({ ...input, prompt: '补充：检查负库存' }, 'supplement');
      await runtime.waitForIdle();
      expect(store.list<any>('run')).toHaveLength(1);
      expect(store.list<any>('run')[0].status).toBe('completed');
      expect(store.list<any>('pendingInput')[0]).toMatchObject({ status: 'applied', runId });
      const prompts = fake.calls.filter((c) => c.method === 'session/prompt');
      expect(prompts).toHaveLength(2);
      expect(prompts[1].params.prompt[0].text).toContain('补充：检查负库存');
      expect(store.messages(input.sessionId).every((m) => m.runId === runId)).toBe(true);
    },
  );
  it('rebuilds an engine segment after account invalidation or intervening history', async () => {
    const { store, runtime, input } = fixture(false);
    runtime.start(input);
    await runtime.waitForIdle();
    runtime.invalidateNative('kimi');
    runtime.start({ ...input, prompt: 'After account change' });
    await runtime.waitForIdle();
    expect(fake.calls.filter((c) => c.method === 'initialize')).toHaveLength(2);
    expect(
      fake.calls.filter((c) => c.method === 'session/prompt')[1].params.prompt[0].text,
    ).toContain('Native answer');
    store.message({
      id: 'foreign-message',
      sessionId: input.sessionId,
      role: 'assistant',
      content: 'Other model answer',
      createdAt: Date.now(),
    });
    runtime.start({ ...input, prompt: 'Return to Kimi' });
    await runtime.waitForIdle();
    expect(fake.calls.filter((c) => c.method === 'initialize')).toHaveLength(3);
    expect(
      fake.calls.filter((c) => c.method === 'session/prompt')[2].params.prompt[0].text,
    ).toContain('Other model answer');
  });
  it('denies unmanaged native actions and exposes project tools through the controlled bridge', async () => {
    const { store, runtime, input } = fixture(true);
    runtime.start(input);
    await runtime.waitForIdle();
    expect(fake.replies[0].result).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(fake.calls.find((c) => c.method === 'session/new').params.mcpServers[0].name).toBe(
      'tongzhou-tools',
    );
    expect(store.list<any>('run')[0].status).toBe('completed');
  });
  it('rejects stale or unsupported models before sending a prompt', async () => {
    const { store, runtime, input } = fixture(false);
    runtime.start({ ...input, model: 'missing' });
    await runtime.waitForIdle();
    expect(store.list<any>('run')[0].status).toBe('failed');
    expect(fake.calls.some((c) => c.method === 'session/prompt')).toBe(false);
  });
});
