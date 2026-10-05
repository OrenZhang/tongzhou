import { seedAgents } from './fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../electron/store';
import { Runtime } from '../electron/runtime';
import { Attachments } from '../electron/attachments';
import type { ComputerAdapter } from '../electron/extensions';
import { mcpName } from '../electron/extensions';
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
  seedAgents(store);
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
describe('conversation input and lifecycle changes', () => {
  it('consolidates queued memories through a restricted background agent without creating sidebar chats', async () => {
    const f = await fixture((body) => {
      if (!body.tools.some((t: any) => t.function.name === 'memory_commit'))
        return [text('库存必须使用事务扣减，验证待完成。')];
      expect(body.tools.map((t: any) => t.function.name).sort()).toEqual([
        'memory_commit',
        'memory_source',
      ]);
      if (body.messages.some((m: any) => m.role === 'tool')) return [text('每日记忆已整理')];
      const prompt = body.messages.find((m: any) => m.role === 'user').content;
      const candidateId = prompt.match(/"candidateId":"([^"]+)"/)[1];
      return [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'memory-result',
                    function: {
                      name: 'memory_commit',
                      arguments: JSON.stringify({
                        entries: [
                          {
                            category: 'decision',
                            subject: '库存',
                            relation: '扣减规则',
                            content: '库存必须使用事务扣减；尚待验证',
                            evidence: [{ candidateId, quote: '库存必须使用事务扣减' }],
                          },
                        ],
                      }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ];
    });
    const session = f.store.createSession();
    f.runtime.start({ ...f.input, sessionId: session.id, prompt: '库存必须使用事务扣减' });
    await f.runtime.waitForIdle();
    expect(f.runtime.knowledge.all()).toHaveLength(0);
    expect(f.runtime.knowledge.memory.queueState().pending).toBe(1);
    const before = f.runtime.snapshot().sessions.length;
    expect(f.runtime.processMemory(true).started).toBe(true);
    await f.runtime.waitForIdle();
    expect(f.runtime.knowledge.all()[0].memoryEntries).toHaveLength(1);
    expect(f.runtime.knowledge.memory.queueState()).toMatchObject({
      pending: 0,
      running: 0,
      failed: 0,
    });
    expect(f.runtime.snapshot().sessions).toHaveLength(before);
    expect(f.runtime.knowledge.memory.candidates()).toHaveLength(1);
  });
  it('rejects disabled providers before starting a run, retaining secrets and history', async () => {
    const f = await fixture(() => [text('unexpected')]);
    const provider = f.store.providers().find((p) => p.id === 'fixture')!;
    f.store.saveProvider({ ...provider, enabled: false, secret: 'saved-key' });
    expect(() => f.runtime.start(f.input)).toThrow('已停用');
    expect(f.store.list('run')).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
    f.store.saveProvider({ ...provider, enabled: undefined });
    expect(f.store.providers().find((p) => p.id === 'fixture')?.enabled).toBe(false);
    expect(f.store.secret('fixture')).toBe('saved-key');
  });
  it('shares user attachments with read-only collaborators without losing the parent reference', async () => {
    const f = await fixture(() => [text('read attachment')]);
    const a = new Attachments(f.store, f.root).save({
      name: 'team.txt',
      mimeType: 'text/plain',
      data: Buffer.from('协作资料').toString('base64'),
    });
    await f.runtime.team({ ...f.input, attachmentIds: [a.id] }, ['reviewer', 'architect']);
    await f.runtime.waitForIdle();
    expect(f.requests.every((r) => JSON.stringify(r.messages).includes(a.id))).toBe(true);
    expect(f.store.messages(f.input.sessionId)[0].attachments?.[0].id).toBe(a.id);
  });
  it('reads the complete pasted file without expanding its text and denies another conversation attachment', async () => {
    let selected = '';
    const f = await fixture((body) =>
      body.messages.at(-1)?.role === 'tool'
        ? [text('read complete')]
        : [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'attachment-read',
                        function: {
                          name: 'read_attachment',
                          arguments: JSON.stringify({
                            attachmentId: selected,
                            offset: 100,
                            limit: 50,
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          ],
    );
    const files = new Attachments(f.store, f.root);
    const contents = '完整资料，不应截断。'.repeat(1000);
    const a = files.save({
      name: 'paste.txt',
      mimeType: 'text/plain',
      data: Buffer.from(contents).toString('base64'),
    });
    selected = a.id;
    const session = f.store.createSession();
    f.runtime.start({ ...f.input, sessionId: session.id, prompt: '', attachmentIds: [a.id] });
    await f.runtime.waitForIdle();
    expect(JSON.stringify(f.requests[0].messages)).not.toContain(contents);
    expect(f.store.messages(session.id).find((m) => m.role === 'tool')?.content).toContain(
      contents.slice(100, 150),
    );
    expect(f.store.messages(session.id)[0].attachments?.[0].id).toBe(a.id);
    const other = f.store.createSession();
    f.runtime.start({ ...f.input, sessionId: other.id });
    await f.runtime.waitForIdle();
    expect(f.store.messages(other.id).find((m) => m.role === 'tool')?.content).toContain(
      '不属于当前会话',
    );
  });
  it('automatically compacts zero-manual-limit history and retains the original goal across turns', async () => {
    const f = await fixture(() => [text('continued from compressed history')]);
    const provider = f.store.providers().find((p) => p.id === 'fixture')!;
    f.store.saveProvider({ ...provider, contextChars: 0 });
    f.store.message({
      id: 'original-goal',
      sessionId: f.input.sessionId,
      role: 'user',
      content: '开发后台，禁止删除订单数据',
      createdAt: 1,
    });
    f.store.message({
      id: 'old-big-output',
      sessionId: f.input.sessionId,
      role: 'assistant',
      content: '旧工具信息'.repeat(60000),
      createdAt: 2,
    });
    f.runtime.start(f.input);
    await f.runtime.waitForIdle();
    expect(f.store.list('contextCheckpoint')).toHaveLength(1);
    expect(JSON.stringify(f.requests[0]).length).toBeLessThan(180000);
    expect(
      f.requests[0].messages.some((m: any) => m.content === '开发后台，禁止删除订单数据'),
    ).toBe(true);
    expect(f.requests[0].tools.some((t: any) => t.function.name === 'read_history')).toBe(true);
    expect(f.store.readMessage(f.input.sessionId, 'old-big-output').totalChars).toBe(300000);
  });
  it('continues the default agent past 32 model rounds without a hidden cap', async () => {
    let calls = 0;
    const f = await fixture(() =>
      ++calls <= 34
        ? [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'read-' + calls,
                        function: { name: 'list_files', arguments: '{"path":""}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          ]
        : [text('finished after 34 tool rounds')],
    );
    f.runtime.start({ ...f.input, agentId: '' });
    await f.runtime.waitForIdle();
    expect(f.requests).toHaveLength(35);
    expect(f.store.list<Run>('run')[0].status).toBe('completed');
  });
  it.each([0, 8000])(
    'continues a long tool loop with history setting %s and preserves originals',
    async (contextChars) => {
      let calls = 0;
      const f = await fixture(() =>
        ++calls <= 8
          ? [
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'read-' + calls,
                          function: { name: 'read_file', arguments: '{"path":"large.txt"}' },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
              },
            ]
          : [text('completed long task')],
      );
      const provider = f.store.providers().find((p) => p.id === 'fixture')!;
      f.store.saveProvider({ ...provider, contextChars });
      await writeFile(path.join(f.root, 'large.txt'), 'a'.repeat(18000));
      f.runtime.start(f.input);
      await f.runtime.waitForIdle();
      expect(f.store.list<Run>('run')[0].status).toBe('completed');
      expect(f.requests).toHaveLength(9);
      expect(f.store.messages(f.input.sessionId).filter((m) => m.role === 'tool')).toHaveLength(8);
      expect(
        f.store
          .messages(f.input.sessionId)
          .filter((m) => m.role === 'tool')
          .every((m) => m.content.includes('a'.repeat(18000))),
      ).toBe(true);
      for (const body of f.requests) {
        const declared = body.messages.flatMap((m: any) =>
          (m.tool_calls ?? []).map((c: any) => c.id),
        );
        const results = body.messages
          .filter((m: any) => m.role === 'tool')
          .map((m: any) => m.tool_call_id);
        expect(results.sort()).toEqual(declared.sort());
      }
      if (contextChars === 0) {
        expect(JSON.stringify(f.requests.at(-1)).length).toBeGreaterThan(100000);
        expect(f.store.list('contextCheckpoint')).toHaveLength(0);
      } else {
        expect(f.store.list('contextCheckpoint')).toHaveLength(1);
        expect(
          f.requests.at(-1).messages.some((m: any) => m.content?.includes('工具记录摘录')),
        ).toBe(true);
      }
    },
  );
  it('persists separate thought/text stages, including rapid transitions within one response', async () => {
    const f = await fixture(() => [
      { choices: [{ delta: { reasoning_content: '第一段思考' } }] },
      { choices: [{ delta: { content: '先解释。' } }] },
      { choices: [{ delta: { reasoning_content: '第二段思考' } }] },
      text('最终结果。'),
    ]);
    f.runtime.start(f.input);
    await f.runtime.waitForIdle();
    const thoughts = f.runtime.events(f.input.sessionId).filter((e) => e.type === 'reasoning');
    const messages = f.store.messages(f.input.sessionId).filter((m) => m.role === 'assistant');
    expect(thoughts.map((e) => e.text)).toEqual(['第一段思考', '第二段思考']);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('先解释。最终结果。');
    expect(messages[0].segments).toHaveLength(2);
    expect(messages[0].segments![0].seq).toBeGreaterThan(thoughts[0].seq);
    expect(messages[0].segments![0].seq).toBeLessThan(thoughts[1].seq);
    expect(messages[0].segments![1].seq).toBeGreaterThan(thoughts[1].seq);
  });
  it('preserves the throttled text tail on output limits and never executes partial tool arguments', async () => {
    const f = await fixture(() => [
      { choices: [{ delta: { content: '已收到正文，' } }] },
      {
        choices: [
          {
            delta: {
              content: '保留最后一段。',
              tool_calls: [
                {
                  index: 0,
                  id: 'truncated',
                  function: { name: 'write_file', arguments: '{"path":"never.txt"' },
                },
              ],
            },
            finish_reason: 'length',
          },
        ],
      },
    ]);
    f.runtime.start(f.input);
    await f.runtime.waitForIdle();
    const state = f.runtime.snapshot();
    expect(state.runs[0].status).toBe('failed');
    expect(state.runs[0].error).toContain('1,024 Tokens');
    expect(state.runs[0].error).toContain('本次工具调用未执行');
    expect(f.store.messages(f.input.sessionId).find((m) => m.role === 'assistant')?.content).toBe(
      '已收到正文，保留最后一段。',
    );
    await expect(readFile(path.join(f.root, 'never.txt'))).rejects.toThrow();
    expect(state.approvals).toHaveLength(0);
    expect(f.requests).toHaveLength(1);
  });
  it('uses the session override for real writes and freezes approval policy for the active turn', async () => {
    const f = await fixture((body) =>
      body.messages.some((m: any) => m.role === 'tool')
        ? [text('done')]
        : [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'permission-write',
                        function: {
                          name: 'write_file',
                          arguments: '{"path":"permission.txt","content":"full access wrote this"}',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          ],
    );
    f.store.setSessionPermission(f.input.sessionId, 'full-access');
    f.runtime.start(f.input);
    f.store.setSessionPermission(f.input.sessionId, 'ask');
    await f.runtime.waitForIdle();
    expect(await readFile(path.join(f.root, 'permission.txt'), 'utf8')).toBe(
      'full access wrote this',
    );
    expect(f.events.filter((e) => e.type === 'approval')).toHaveLength(0);
    expect(f.store.list<Run>('run')[0].config?.permission).toBe('full-access');
  });
  it('honors a session read-only override over the global full-access default', async () => {
    const f = await fixture((body) =>
      body.messages.some((m: any) => m.role === 'tool')
        ? [text('denied')]
        : [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'blocked-write',
                        function: {
                          name: 'write_file',
                          arguments: '{"path":"forbidden.txt","content":"must not write"}',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          ],
    );
    f.store.setDefaultPermission('full-access');
    f.store.setSessionPermission(f.input.sessionId, 'read-only');
    f.runtime.start(f.input);
    await f.runtime.waitForIdle();
    await expect(readFile(path.join(f.root, 'forbidden.txt'))).rejects.toThrow();
    expect(f.requests[0].tools.some((t: any) => t.function.name === 'write_file')).toBe(false);
    expect(f.events.filter((e) => e.type === 'approval')).toHaveLength(0);
    expect(f.store.list<Run>('run')[0].config?.permission).toBe('read-only');
  });
  it('automatically approves enabled plugin calls only for a full-access run', async () => {
    const name = mcpName('clock-fixture', 'current_time');
    const f = await fixture((body) =>
      body.messages.some((m: any) => m.role === 'tool')
        ? [text('clock complete')]
        : [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, id: 'clock', function: { name, arguments: '{}' } }],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          ],
    );
    const file = path.join(f.root, 'clock.cjs');
    await writeFile(
      file,
      `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result={};if(r.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'clock',version:'1'}};if(r.method==='tools/list')result={tools:[{name:'current_time',inputSchema:{type:'object',properties:{}}}]};if(r.method==='tools/call')result={content:[{type:'text',text:'SYNTHETIC_CLOCK_RESULT'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`,
    );
    f.store.put('plugin', {
      id: 'clock-fixture',
      name: 'Clock fixture',
      transport: 'stdio',
      command: process.execPath,
      args: [file],
      url: '',
      enabled: true,
      readOnlyTools: ['current_time'],
      catalog: [{ name: 'current_time', inputSchema: { type: 'object', properties: {} } }],
    });
    f.store.setDefaultPermission('full-access');
    const id = f.runtime.start(f.input);
    await f.runtime.waitForIdle();
    expect(
      f.store
        .messages(f.input.sessionId)
        .some((m) => m.role === 'tool' && m.content.includes('SYNTHETIC_CLOCK_RESULT')),
    ).toBe(true);
    expect(f.store.get<Run>('run', id).config?.permission).toBe('full-access');
    expect(f.events.filter((e) => e.type === 'approval')).toHaveLength(0);
  });
  it('accepts ordinary chat with no Agent and records progress before the first response', async () => {
    const f = await fixture(() => [text('Hello')]);
    const s = f.store.createSession();
    f.runtime.start({ ...f.input, sessionId: s.id, agentId: '', prompt: '你好' });
    expect(f.runtime.events(s.id)[0].text).toBe('准备上下文');
    await f.runtime.waitForIdle();
    expect(f.store.messages(s.id).at(-1)?.content).toBe('Hello');
    expect(f.runtime.events(s.id).at(-1)?.text).toBe('已完成');
  });
  it('persists a queued next turn and runs it once after the current turn', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const f = await fixture(async () => {
      if (++calls === 1) await gate;
      return [text('answer ' + calls)];
    });
    f.runtime.start(f.input);
    await f.runtime.enqueue({ ...f.input, prompt: 'next requirement' }, 'next');
    expect(f.runtime.snapshot().pendingInputs).toHaveLength(1);
    release();
    await f.runtime.waitForIdle();
    expect(calls).toBe(2);
    expect(
      f.store
        .messages(f.input.sessionId)
        .filter((m) => m.role === 'user')
        .map((m) => m.content),
    ).toEqual(['Create the file', 'next requirement']);
    expect(f.runtime.snapshot().pendingInputs).toHaveLength(0);
  });
  it('deletes an archived conversation and refuses a late write', async () => {
    const f = await fixture(() => [text('answer')]);
    f.runtime.start(f.input);
    await f.runtime.waitForIdle();
    const s = f.store.get<any>('session', f.input.sessionId);
    const last = f.store.messages(s.id).at(-1)!;
    f.store.put('session', { ...s, archived: true });
    await f.runtime.deleteSession(s.id);
    expect(f.store.messages(s.id)).toHaveLength(0);
    expect(f.runtime.events(s.id)).toHaveLength(0);
    expect(() => f.store.message(last)).toThrow();
    expect(f.store.list('project')).toHaveLength(1);
  });
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
    f.store.setCapability('computer', true);
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
  it('chats and hands history to another model with only attachment and knowledge tools', async () => {
    const f = await fixture(() => [text('Chat answer')]);
    f.store.remove('project', 'project');
    const session = f.store.createSession();
    expect(session.projectId).toBeNull();
    const input = { ...f.input, sessionId: session.id, prompt: 'Hello without a project' };
    f.runtime.start(input);
    await f.runtime.waitForIdle();
    f.runtime.start({ ...input, prompt: 'Continue', model: 'second' });
    await f.runtime.waitForIdle();
    expect(
      f.requests.every((r) =>
        r.tools.every((t: any) =>
          [
            'read_attachment',
            'knowledge_search',
            'knowledge_read',
            'knowledge_audit',
            'knowledge_write',
          ].includes(t.function.name),
        ),
      ),
    ).toBe(true);
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
  it('restricts a project-linked knowledge job to knowledge tools and does not collect itself', async () => {
    const f = await fixture(() => [text('Knowledge summary')]);
    f.store.put('session', {
      ...f.store.get<any>('session', f.input.sessionId),
      knowledgeJob: true,
    });
    f.runtime.start(f.input);
    await f.runtime.waitForIdle();
    const tools = f.requests[0].tools.map((t: any) => t.function.name);
    expect(tools).toContain('knowledge_write');
    expect(tools).not.toContain('write_file');
    expect(tools).not.toContain('run_command');
    expect(f.store.list('knowledge')).toHaveLength(0);
    expect(f.store.list<Run>('run')[0].status).toBe('completed');
  });
  it('runs a projectless team without assigning project tools to children', async () => {
    const f = await fixture(() => [text('Discussion finding')]);
    const session = f.store.createSession();
    await f.runtime.team({ ...f.input, sessionId: session.id }, ['reviewer', 'architect']);
    await f.runtime.waitForIdle();
    expect(f.store.list<Run>('run').every((r) => r.status === 'completed')).toBe(true);
    expect(
      f.requests.every((r) =>
        r.tools.every((t: any) =>
          ['read_attachment', 'knowledge_search', 'knowledge_read', 'knowledge_audit'].includes(
            t.function.name,
          ),
        ),
      ),
    ).toBe(true);
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
        r.tools.every((t: any) =>
          [
            'read_file',
            'list_files',
            'read_range',
            'search_files',
            'project_instructions',
            'read_history',
            'search_history',
            'task_memory',
            'terminal_read',
            'read_attachment',
            'knowledge_search',
            'knowledge_read',
            'knowledge_audit',
          ].includes(t.function.name),
        ),
      ),
    ).toBe(true);
    expect(f.store.list('agent')).toHaveLength(3);
  });
});
