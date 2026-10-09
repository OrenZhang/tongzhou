import { authorizeKnowledgeFixtures } from '../../support/knowledge-fixture';
import { seedAgents } from '../../support/fixtures';
import {
  readPersonalization,
  savePersonalization,
} from '../../../electron/modules/agents/personalization';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../../../electron/services/storage/store';
import { Runtime } from '../../../electron/core/runtime/runtime';
import {
  greetingReply,
  introductionReply,
  builtinReplyModel,
} from '../../../electron/modules/agents/assistant-identity';
import { KNOWLEDGE_ORGANIZER_ID } from '../../../src/shared/builtin-agents';
import { Attachments } from '../../../electron/modules/artifacts/attachments';
import type { ComputerAdapter } from '../../../electron/core/tools/extensions';
import { mcpName } from '../../../electron/core/tools/extensions';
import type { AppEvent, Run } from '../../../src/shared/types';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(handler: (body: any) => any[] | Promise<any[]>, computer?: ComputerAdapter) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tongzhou-runtime-'));
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const b of req) raw += b;
    const body = JSON.parse(raw);
    requests.push(body);
    let events;
    try {
      events = await handler(body);
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
      return;
    }
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
  it('keeps deletion confirmation visible even when the running chat has full access', async () => {
    const f = await fixture(() => [text('unused')]);
    f.store.put('run', {
      id: 'deletion-confirmation',
      sessionId: f.input.sessionId,
      status: 'running',
      config: { permission: 'full-access' },
    });
    const signal = new AbortController().signal;
    expect(await f.runtime.approvalQueue.ask(f.input.sessionId, '普通操作', '{}', signal)).toBe(
      true,
    );
    const deletion = f.runtime.approvalQueue.ask(f.input.sessionId, '删除文档', '{}', signal, true);
    expect(f.runtime.snapshot().approvals).toHaveLength(1);
    f.runtime.approvalQueue.approve(f.runtime.snapshot().approvals[0].id, false);
    expect(await deletion).toBe(false);
    f.store.remove('run', 'deletion-confirmation');
  });
  it('edits a bound document through generic tools without acquiring project or personal-memory capabilities', async () => {
    let docId = '';
    const f = await fixture((body) =>
      body.messages.some((m: any) => m.role === 'tool')
        ? [text('已保存文档')]
        : [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'edit-doc',
                        function: {
                          name: 'content_patch',
                          arguments: JSON.stringify({
                            id: docId,
                            version: 1,
                            before: '原文',
                            after: '改写后的正文',
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
    const doc = f.runtime.content.write({ libraryId: 'default', title: '文章', content: '原文' });
    authorizeKnowledgeFixtures(f.runtime.knowledge, doc);
    docId = doc.id;
    const session = f.store.get<any>('session', f.input.sessionId);
    f.store.put('session', {
      ...session,
      knowledgeJob: true,
      contentContext: { libraryId: 'default', documentId: doc.id },
    });
    f.runtime.start({ ...f.input, agentId: '', prompt: '请改写并保存这篇文章' });
    await f.runtime.waitForIdle();
    expect(f.runtime.knowledge.get(doc.id).content).toBe('改写后的正文');
    expect(f.store.list<any>('run')[0].status).toBe('completed');
    const tools = f.requests[0].tools.map((t: any) => t.function.name);
    expect(tools).toContain('content_patch');
    expect(tools).not.toContain('run_command');
    expect(tools).not.toContain('knowledge_write');
    expect(f.runtime.knowledge.memory.candidates()).toHaveLength(0);
  });
  it('exposes the built-in organizer and confines it to knowledge jobs', async () => {
    const f = await fixture(() => [text('已查看资料')]);
    expect(f.runtime.snapshot().agents.filter((a) => a.builtin)).toHaveLength(2);
    const input = { ...f.input, agentId: KNOWLEDGE_ORGANIZER_ID };
    expect(() => f.runtime.start(input)).toThrow('请从智库选择资料');
    expect(f.store.list('run')).toHaveLength(0);
    const session = f.store.get<any>('session', input.sessionId);
    f.store.put('session', { ...session, knowledgeJob: true });
    f.store.put('skill', {
      id: 'unrelated',
      name: '外部技能',
      enabled: true,
      description: '不要进入知识整理上下文',
    });
    f.runtime.start(input);
    await f.runtime.waitForIdle();
    const run = f.store.list<Run>('run')[0];
    expect(run).toMatchObject({ status: 'completed', agentName: '知识整理' });
    expect(run.config?.instructions).toContain('内置知识整理 Agent');
    expect(run.config?.instructions).not.toContain('不要进入知识整理上下文');
    const tools = f.requests[0].tools.map((t: any) => t.function.name);
    expect(tools).toContain('knowledge_write');
    expect(tools).not.toContain('run_command');
    expect(tools.some((name: string) => /^(terminal_|client_|computer_)/.test(name))).toBe(false);
  });
  it('does not preload knowledge even with legacy settings and pins; the agent searches and reads it through tools', async () => {
    let docId = '';
    const f = await fixture((body) => {
      const results = body.messages.filter((m: any) => m.role === 'tool');
      if (results.length >= 2) return [text('已读取库存规则')];
      return [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'knowledge-' + results.length,
                    function: {
                      name: results.length ? 'knowledge_read' : 'knowledge_search',
                      arguments: JSON.stringify(
                        results.length ? { id: docId } : { query: '库存规则' },
                      ),
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
    const doc = f.runtime.knowledge.save({
      title: '库存规则',
      kind: 'source',
      content: 'UNIQUE_KNOWLEDGE_EVIDENCE：库存扣减必须使用事务。',
    });
    authorizeKnowledgeFixtures(f.runtime.knowledge, doc);
    docId = doc.id;
    f.runtime.automations.save({
      ...f.runtime.automations.state().rules.find((r) => r.kind === 'memory')!,
      enabled: false,
    });
    f.store.put('knowledgeBinding', {
      id: f.input.sessionId,
      sessionId: f.input.sessionId,
      documentIds: [doc.id],
    });
    f.runtime.start({ ...f.input, prompt: '查询库存规则' });
    await f.runtime.waitForIdle();
    expect(JSON.stringify(f.requests[0].messages)).not.toContain('UNIQUE_KNOWLEDGE_EVIDENCE');
    expect(
      f.requests.every(
        (request) =>
          !request.messages
            .filter((m: any) => m.role === 'system')
            .some((m: any) => m.content.includes('UNIQUE_KNOWLEDGE_EVIDENCE')),
      ),
    ).toBe(true);
    expect(
      f.requests
        .at(-1)
        .messages.some(
          (m: any) => m.role === 'tool' && m.content.includes('UNIQUE_KNOWLEDGE_EVIDENCE'),
        ),
    ).toBe(true);
    expect(f.store.list<Run>('run')[0].knowledgeReferences).toEqual([
      expect.objectContaining({ id: doc.id, mode: 'tool', excerpt: doc.content }),
    ]);
    expect(f.runtime.knowledge.settings()).toEqual({ autoCollect: false });
  });
  it('consolidates queued memories through a restricted background agent without creating sidebar chats', async () => {
    const f = await fixture((body) => {
      if (!body.tools.some((t: any) => t.function.name === 'memory_commit'))
        return [text('库存必须使用事务扣减，验证待完成。')];
      expect(
        body.tools
          .map((t: any) => t.function.name)
          .filter((name: string) => name !== 'request_user_input')
          .sort(),
      ).toEqual(['memory_commit', 'memory_source']);
      if (body.messages.some((m: any) => m.role === 'tool')) return [text('每日记忆已整理')];
      const prompt = body.messages.find(
        (m: any) => m.role === 'user' && m.content?.includes('candidateId'),
      ).content;
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
    f.runtime.automations.tick();
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
  it('imports complete legacy history once and leaves compaction to Codex', async () => {
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
    expect(f.store.list('contextCheckpoint')).toHaveLength(0);
    expect(JSON.stringify(f.requests[0]).length).toBeGreaterThan(300000);
    expect(
      f.requests[0].messages.some((m: any) => m.content?.includes('开发后台，禁止删除订单数据')),
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
      const f = await fixture((body) =>
        !body.tools?.length
          ? [text('上下文摘要：继续读取 large.txt，保留用户目标。')]
          : ++calls <= 8
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
      expect(f.requests.length).toBeGreaterThanOrEqual(9);
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
      expect(f.store.list('contextCheckpoint')).toHaveLength(0);
      expect(f.store.list<any>('engineSegment').at(-1)?.completed).toBe(true);
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
    expect(messages.map((m) => m.content)).toEqual(['先解释。', '最终结果。']);
    expect(messages.every((m) => m.status === 'complete')).toBe(true);
    expect(messages.map((m) => m.segments?.length)).toEqual([1, 1]);
    expect(messages[0].segments![0].seq).toBeGreaterThan(thoughts[0].seq);
    expect(messages[0].segments![0].seq).toBeLessThan(thoughts[1].seq);
    expect(messages[1].segments![0].seq).toBeGreaterThan(thoughts[1].seq);
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
    f.runtime.start({ ...f.input, sessionId: s.id, agentId: '', prompt: '解释一下什么是版本控制' });
    expect(f.runtime.events(s.id)[0].text).toBe('准备上下文');
    await f.runtime.waitForIdle();
    expect(f.store.messages(s.id).at(-1)?.content).toBe('Hello');
    expect(f.runtime.events(s.id).at(-1)?.text).toBe('已完成');
  });
  it.each([
    'openai-chat',
    'openai-responses',
    'anthropic',
    'gemini',
    'codex',
    'kimi',
    'minimax',
  ] as const)(
    'uses the same local identity for %s without requests, tools or checkpoints',
    async (protocol) => {
      const f = await fixture(() => [text('我是其他助手')]);
      const provider = f.store.get<any>('provider', 'fixture');
      f.store.put('provider', { ...provider, protocol });
      for (const [prompt, reply] of [
        ['你好', greetingReply],
        ['你好，你是谁？', introductionReply],
      ]) {
        const id = f.runtime.start({ ...f.input, prompt });
        await f.runtime.waitForIdle();
        expect(f.store.get<Run>('run', id)).toMatchObject({
          status: 'completed',
          model: builtinReplyModel,
          agentName: '同舟',
          inputTokens: 0,
          outputTokens: 0,
        });
        expect(
          f.store
            .messages(f.input.sessionId)
            .filter((m) => m.runId === id && m.role === 'assistant')
            .map((m) => m.content),
        ).toEqual([reply]);
      }
      expect(f.requests).toHaveLength(0);
      expect(f.store.list('runChanges')).toHaveLength(0);
      expect(f.store.messages(f.input.sessionId).filter((m) => m.role === 'tool')).toHaveLength(0);
      expect(f.runtime.isActive(f.input.sessionId)).toBe(false);
    },
  );
  it('injects the common prompt into every turn of existing conversations without rewriting tasks', async () => {
    const f = await fixture(() => [text('task answer')]);
    f.store.message({
      id: 'old-identity',
      sessionId: f.input.sessionId,
      role: 'assistant',
      content: '我是 Mavis',
      createdAt: 1,
    });
    for (const prompt of ['你好，解释一下 Git', '你是什么模型？']) {
      f.runtime.start({ ...f.input, prompt });
      await f.runtime.waitForIdle();
    }
    expect(f.requests).toHaveLength(2);
    for (const request of f.requests) {
      const system = request.messages.find((m: any) => m.role === 'system').content;
      expect(system).toContain('【同舟通用提示词】');
      expect(system).toContain('"mock"');
      expect(system).toContain('Use tools when needed.');
    }
    expect(f.store.messages(f.input.sessionId).find((m) => m.id === 'old-identity')?.content).toBe(
      '我是 Mavis',
    );
  });
  it('keeps attachments on the model path even when the caption is a greeting', async () => {
    const f = await fixture(() => [text('已阅读附件')]);
    const attachment = new Attachments(f.store, f.root).save({
      name: 'context.txt',
      mimeType: 'text/plain',
      data: Buffer.from('请核对附件').toString('base64'),
    });
    f.runtime.start({ ...f.input, prompt: '你好', attachmentIds: [attachment.id] });
    await f.runtime.waitForIdle();
    expect(f.requests).toHaveLength(1);
    expect(f.store.messages(f.input.sessionId).at(-1)?.content).toBe('已阅读附件');
  });
  it('refreshes personality and preferences in existing and new conversations', async () => {
    const f = await fixture(() => [text('answer')]);
    const profile = savePersonalization(f.store, {
      ...readPersonalization(f.store),
      soul: '温和的技术导师',
      userPreferences: '称呼我小林',
    });
    const agent = f.store.get<any>('agent', 'builder');
    f.store.put('agent', { ...agent, soul: '用小例子解释代码' });
    f.runtime.start({ ...f.input, prompt: '解释版本控制' });
    await f.runtime.waitForIdle();
    savePersonalization(f.store, { ...profile, userPreferences: '称呼我小周' });
    for (const sessionId of [f.input.sessionId, f.store.createSession().id]) {
      f.runtime.start({ ...f.input, sessionId, prompt: '解释提交的用途' });
      await f.runtime.waitForIdle();
    }
    const systems = f.requests.map((r) => r.messages.find((m: any) => m.role === 'system').content);
    expect(systems[0]).toContain('称呼我小林');
    for (const system of systems.slice(1)) {
      expect(system).toContain('称呼我小周');
      expect(system).not.toContain('称呼我小林');
      expect(system).toContain('温和的技术导师');
      expect(system).toContain('用小例子解释代码');
      expect(system).toContain('【同舟通用提示词】');
    }
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
    await f.runtime.sessions.deleteSession(s.id);
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
          images: [
            {
              mimeType: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            },
          ],
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
    f.runtime.approvalQueue.approve(f.runtime.snapshot().approvals[0].id, true);
    await f.runtime.waitForIdle();
    expect(executed).toBe(1);
    expect(JSON.stringify(f.requests[1])).toContain(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    );
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
    expect(last).not.toContain(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    );
    expect(last).not.toContain('"tool_calls"');
    expect(
      f.store.list<Run>('run').every((r) => r.sessionId === session.id && r.status === 'completed'),
    ).toBe(true);
  });
  it('hands ordinary chat history to another model while exposing native Codex file tools', async () => {
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
        r.tools.every(
          (t: any) =>
            [
              'request_user_input',
              'get_goal',
              'create_goal',
              'update_goal',
              'view_image',
              'read_attachment',
              'task_memory',
              'search_history',
              'read_history',
              'knowledge_search',
              'knowledge_read',
              'knowledge_audit',
              'knowledge_folders',
              'knowledge_graph',
              'content_list',
              'content_read',
              'artifact_list',
              'artifact_read',
              'artifact_create',
              'artifact_publish',
              'artifact_materialize',
              'knowledge_write',
              'content_write',
              'content_patch',
              'content_derive',
              'content_folder',
              'terminal_read',
              'terminal_start',
              'terminal_write',
              'terminal_stop',
            ].includes(t.function.name) ||
            /(?:^|_)(shell_command|exec_command|shell|write_stdin|apply_patch)$/.test(
              t.function.name,
            ),
        ),
      ),
    ).toBe(true);
    expect(f.requests[1].messages.some((m: any) => m.content?.includes(input.prompt))).toBe(true);
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
          [
            'request_user_input',
            'get_goal',
            'create_goal',
            'update_goal',
            'view_image',
            'read_attachment',
            'task_memory',
            'search_history',
            'read_history',
            'knowledge_search',
            'knowledge_read',
            'knowledge_audit',
            'knowledge_folders',
            'knowledge_graph',
            'content_list',
            'content_read',
            'artifact_list',
            'artifact_read',
            'terminal_read',
          ].includes(t.function.name),
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
    f.runtime.approvalQueue.approve(f.runtime.snapshot().approvals[0].id, true);
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
    expect(f.requests[1].messages.some((m: any) => m.content?.includes('Create the file'))).toBe(
      true,
    );
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
            'request_user_input',
            'get_goal',
            'create_goal',
            'update_goal',
            'view_image',
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
            'knowledge_folders',
            'knowledge_graph',
            'content_list',
            'content_read',
            'artifact_list',
            'artifact_read',
          ].includes(t.function.name),
        ),
      ),
    ).toBe(true);
    expect(f.store.list('agent')).toHaveLength(3);
  });
});

it('rejects new runs and queued inputs once shutdown starts', async () => {
  const { runtime, input } = await fixture(() => []);
  const shutdown = runtime.stop();
  expect(runtime.stop()).toBe(shutdown);
  expect(() => runtime.start(input)).toThrow('应用正在退出');
  await expect(runtime.enqueue(input, 'next')).rejects.toThrow('应用正在退出');
  await expect(runtime.team(input, ['builder'])).rejects.toThrow('应用正在退出');
  await runtime.waitForIdle();
});
