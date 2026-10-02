import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../electron/store';
import { Runtime } from '../electron/runtime';
import type { ComputerAdapter } from '../electron/extensions';
import type { AppEvent, Run } from '../src/shared/types';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(handler: (body: any) => any[] | Promise<any[]>, computer?: ComputerAdapter) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tongzhou-runtime-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const b of req) raw += b;
    const body = JSON.parse(raw);
    requests.push(body);
    const events = await handler(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of events) res.write('data: ' + JSON.stringify(event) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const store = new Store(':memory:', { encrypt: (s) => s, decrypt: (s) => s });
  cleanups.push(async () => store.close());
  store.saveProvider({
    id: 'fixture',
    name: 'Fixture',
    protocol: 'openai-chat',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    auth: 'none',
    models: ['mock'],
    maxOutputTokens: 1024,
    contextChars: 50000,
  });
  store.put('project', { id: 'project', name: 'test', path: root, createdAt: Date.now() });
  const session = store.createSession('project');
  const events: AppEvent[] = [];
  const runtime = new Runtime(store, root, (e) => events.push(e), computer);
  cleanups.push(async () => {
    runtime.stop();
    await runtime.waitForIdle();
  });
  return {
    store,
    runtime,
    root,
    events,
    requests,
    input: {
      sessionId: session.id,
      providerId: 'fixture',
      agentId: 'builder',
      model: 'mock',
      prompt: 'Create the file',
    },
  };
}
const text = (content: string) => ({
  choices: [{ delta: { content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 4 },
});
describe('agent execution lifecycle', () => {
  it('uses an explicit model selection instead of silently reverting to Agent defaults', async () => {
    const f = await fixture(() => [text('Selected model answer')]);
    f.store.put('agent', {
      ...f.store.get<any>('agent', 'builder'),
      providerId: 'openai-codex',
      model: 'pinned-model',
    });
    f.runtime.start(f.input);
    await f.runtime.waitForIdle();
    expect(f.requests[0].model).toBe('mock');
    expect(f.store.list<Run>('run')[0].status).toBe('completed');
  });
  it('uses selected computer tools without a project, approves once and preserves the same session after switching', async () => {
    let executed = 0;
    const adapter: ComputerAdapter = {
      specs: () => [
        {
          name: 'computer_screenshot',
          description: 'fixture screenshot',
          parameters: { type: 'object', properties: {} },
        },
      ],
      execute: async () => {
        executed++;
        return {
          text: 'Screenshot of test window',
          images: [{ mimeType: 'image/png', data: 'cGl4ZWxz' }],
        };
      },
    };
    const f = await fixture(
      (body) =>
        body.messages.some((m: any) => m.role === 'tool') || body.model === 'second'
          ? [text('Done without repeating')]
          : [
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'capture',
                          function: { name: 'computer_screenshot', arguments: '{}' },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
              },
            ],
      adapter,
    );
    const session = f.store.createSession();
    f.store.put('agent', { ...f.store.get<any>('agent', 'builder'), computerEnabled: true });
    f.runtime.start({ ...f.input, sessionId: session.id });
    await expect.poll(() => f.runtime.snapshot().approvals.length).toBe(1);
    f.runtime.approve(f.runtime.snapshot().approvals[0].id, true);
    await f.runtime.waitForIdle();
    expect(executed).toBe(1);
    expect(JSON.stringify(f.requests[1])).toContain('cGl4ZWxz');
    f.store.saveProvider({
      ...f.store.get<any>('provider', 'fixture'),
      id: 'other',
      name: 'Other',
    });
    f.runtime.start({
      ...f.input,
      sessionId: session.id,
      providerId: 'other',
      model: 'second',
      prompt: 'Continue',
    });
    await f.runtime.waitForIdle();
    expect(executed).toBe(1);
    expect(f.store.messages(session.id).some((m) => m.content === 'Done without repeating')).toBe(
      true,
    );
    const last = JSON.stringify(f.requests.at(-1));
    expect(last).toContain('Screenshot of test window');
    expect(last).not.toContain('cGl4ZWxz');
    expect(last).not.toContain('"tool_calls"');
    expect(
      f.store.list<Run>('run').every((r) => r.sessionId === session.id && r.status === 'completed'),
    ).toBe(true);
  });
  it('chats and hands history to another model without any project or tools', async () => {
    const f = await fixture(() => [text('Chat answer')]);
    f.store.remove('project', 'project');
    const session = f.store.createSession();
    expect(session.projectId).toBeNull();
    const input = { ...f.input, sessionId: session.id, prompt: 'Hello without a project' };
    f.runtime.start(input);
    await f.runtime.waitForIdle();
    f.runtime.start({ ...input, prompt: 'Continue', model: 'second' });
    await f.runtime.waitForIdle();
    expect(f.requests.every((r) => !r.tools)).toBe(true);
    expect(f.requests[1].messages.some((m: any) => m.content === input.prompt)).toBe(true);
    expect(f.store.list<Run>('run').every((r) => r.status === 'completed')).toBe(true);
    expect(f.runtime.snapshot().approvals).toHaveLength(0);
  });
  it('rejects unsolicited file tools in ordinary chat', async () => {
    const f = await fixture(() => [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'bad',
                  function: {
                    name: 'write_file',
                    arguments: '{"path":"unexpected.txt","content":"no"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]);
    const session = f.store.createSession();
    f.runtime.start({ ...f.input, sessionId: session.id });
    await f.runtime.waitForIdle();
    expect(f.store.list<Run>('run')[0].status).toBe('failed');
    expect(f.runtime.snapshot().approvals).toHaveLength(0);
    await expect(readFile(path.join(f.root, 'unexpected.txt'))).rejects.toThrow();
  });
  it('runs a projectless team without assigning project tools to children', async () => {
    const f = await fixture(() => [text('Discussion finding')]);
    const session = f.store.createSession();
    await f.runtime.team({ ...f.input, sessionId: session.id }, ['reviewer', 'architect']);
    await f.runtime.waitForIdle();
    expect(f.store.list<Run>('run').every((r) => r.status === 'completed')).toBe(true);
    expect(f.requests.every((r) => !r.tools)).toBe(true);
    expect(f.store.messages(session.id).at(-1)?.content).toContain('Discussion finding');
  });
  it('completes a tool loop, waits for approval, and records actual usage', async () => {
    const f = await fixture((body) =>
      body.messages.some((m: any) => m.role === 'tool')
        ? [text('File created')]
        : [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call',
                        function: {
                          name: 'write_file',
                          arguments: JSON.stringify({
                            path: 'result.txt',
                            content: 'hello from model',
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 3 },
            },
          ],
    );
    f.runtime.start(f.input);
    await expect.poll(() => f.runtime.snapshot().approvals.length).toBe(1);
    await expect(readFile(path.join(f.root, 'result.txt'))).rejects.toThrow();
    f.runtime.approve(f.runtime.snapshot().approvals[0].id, true);
    await f.runtime.waitForIdle();
    expect(await readFile(path.join(f.root, 'result.txt'), 'utf8')).toBe('hello from model');
    expect(f.store.list<Run>('run')[0]).toMatchObject({
      status: 'completed',
      inputTokens: 15,
      outputTokens: 7,
      config: { protocol: 'openai-chat', permission: 'ask' },
    });
    expect(f.requests).toHaveLength(2);
    expect(f.store.messages(f.input.sessionId).at(-1)?.content).toBe('File created');
  });
  it('cancels pending approvals without performing the write', async () => {
    const f = await fixture(() => [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call',
                  function: {
                    name: 'write_file',
                    arguments: '{"path":"never.txt","content":"no"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]);
    f.runtime.start(f.input);
    await expect.poll(() => f.runtime.snapshot().approvals.length).toBe(1);
    await f.runtime.cancel(f.input.sessionId);
    await f.runtime.waitForIdle();
    expect(f.runtime.snapshot().approvals).toHaveLength(0);
    expect(f.store.list<Run>('run')[0].status).toBe('interrupted');
    await expect(readFile(path.join(f.root, 'never.txt'))).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
  });
  it('rejects overlapping runs in one session', async () => {
    const f = await fixture(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return [text('done')];
    });
    f.runtime.start(f.input);
    expect(() => f.runtime.start(f.input)).toThrow('正在执行');
    await f.runtime.waitForIdle();
  });
  it('keeps history when changing models', async () => {
    const f = await fixture(() => [text('done')]);
    f.runtime.start(f.input);
    await f.runtime.waitForIdle();
    f.runtime.start({ ...f.input, model: 'another-model', prompt: 'Continue' });
    await f.runtime.waitForIdle();
    expect(f.requests[1].messages.some((m: any) => m.content === 'Create the file')).toBe(true);
    expect(f.requests[1].model).toBe('another-model');
    expect(f.store.list<Run>('run').map((r) => r.model)).toEqual(['mock', 'another-model']);
  });
  it('runs independent read-only children and consolidates their results', async () => {
    const f = await fixture(() => [text('Independent finding')]);
    await f.runtime.team(f.input, ['reviewer', 'architect']);
    await f.runtime.waitForIdle();
    expect(f.store.list<Run>('run')).toHaveLength(3);
    expect(f.store.messages(f.input.sessionId).at(-1)?.content).toContain('Independent finding');
    expect(
      f.requests.every((r) =>
        r.tools.every((t: any) => ['read_file', 'list_files'].includes(t.function.name)),
      ),
    ).toBe(true);
    expect(f.store.list('agent')).toHaveLength(3);
  });
});
