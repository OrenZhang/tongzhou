import { describe, expect, it, vi } from 'vitest';
import { historyChars, portableHistory } from '../../../electron/core/runtime/history';
import { requestBody, type CompletionInput } from '../../../electron/core/models/providers';
import { providerSchema } from '../../../electron/services/storage/validation';
import { Store } from '../../../electron/services/storage/store';
import type { Message } from '../../../src/shared/types';

const user: Message = {
  id: 'u',
  sessionId: 's',
  runId: 'r',
  role: 'user',
  content: '继续修复，保留数据。',
  createdAt: 0,
};
const exchange = (i: number, length = 16000): Message[] => [
  {
    ...user,
    id: `a${i}`,
    role: 'assistant',
    content: '',
    toolCalls: [
      {
        id: `c${i}`,
        name: 'read_file',
        arguments: '{"path":"src.ts"}',
        signature: 'vendor-signature',
        signatureModel: 'test',
      },
    ],
  },
  {
    ...user,
    id: `t${i}`,
    role: 'tool',
    toolCallId: `c${i}`,
    toolName: 'read_file',
    content: 'HEAD-' + 'x'.repeat(length) + '-TAIL',
  },
];
const provider: CompletionInput['provider'] = {
  id: 'p',
  name: 'test',
  protocol: 'openai-chat',
  auth: 'none',
  baseUrl: 'http://localhost/v1',
  models: ['test'],
  maxOutputTokens: 16384,
  contextChars: 0,
};
const input: CompletionInput = {
  provider,
  model: 'test',
  secret: '',
  instructions: '',
  messages: [],
  tools: [],
  signal: new AbortController().signal,
  onDelta: () => {},
};

describe('optional local history compaction', () => {
  it('sends over 100,000 characters intact when unlimited and excludes UI metadata from requests', () => {
    const history = [user, ...Array.from({ length: 10 }, (_, i) => exchange(i)).flat()];
    const checkpoint = vi.fn();
    expect(portableHistory(history, 0, checkpoint)).toEqual(history);
    const body = requestBody({ ...input, messages: history }).body as any;
    expect(JSON.stringify(body).length).toBeGreaterThan(100000);
    expect(body.messages.filter((m: any) => m.role === 'tool')).toHaveLength(10);
    expect(checkpoint).not.toHaveBeenCalled();
    const withUI = history.map((m) => ({
      ...m,
      segments: Array.from({ length: 500 }, (_, seq) => ({ seq, start: 0, end: 1, time: 123 })),
    }));
    expect(historyChars(withUI)).toBe(historyChars(history));
    expect(requestBody({ ...input, messages: withUI })).toEqual(
      requestBody({ ...input, messages: history }),
    );
  });
  it('compacts a long active tool turn without discarding the prompt, signatures or source history', () => {
    const history = [user, ...Array.from({ length: 10 }, (_, i) => exchange(i)).flat()];
    const original = JSON.stringify(history);
    const checkpoint = vi.fn();
    const compact = portableHistory(history, 8000, checkpoint);
    expect(historyChars(compact)).toBeLessThanOrEqual(8000);
    expect(compact.find((m) => m.id === 'u')).toEqual(user);
    expect(compact.at(-1)?.content).toContain('HEAD-');
    expect(compact.at(-1)?.content).toContain('-TAIL');
    expect(compact.at(-1)?.content).toContain('read_history');
    expect(compact.at(-2)?.toolCalls?.[0].signature).toBe('vendor-signature');
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(JSON.stringify(history)).toBe(original);
    const declared = compact.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id));
    expect(
      compact
        .filter((m) => m.role === 'tool')
        .map((m) => m.toolCallId)
        .sort(),
    ).toEqual(declared.sort());
  });
  it('retains multiple tool results and interleaved user supplements as a complete exchange', () => {
    const [call, result] = exchange(0);
    call.toolCalls!.push({ id: 'c1', name: 'list_files', arguments: '{}' });
    const extra: Message = { ...user, id: 'extra', content: '还要运行测试。' };
    const messages = [user, call, result, extra, { ...result, id: 't1', toolCallId: 'c1' }];
    const compact = portableHistory(messages, 8000);
    expect(compact.filter((m) => m.role === 'user')).toEqual([user, extra]);
    expect(compact.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['c0', 'c1']);
  });
  it('never cuts oversized user input or opaque native call state to meet a local target', () => {
    const [call, result] = exchange(0);
    call.anthropicContent = [
      { type: 'thinking', thinking: 'x'.repeat(18000), signature: 'signed-content' },
      { type: 'tool_use', id: 'c0', name: 'read_file', input: { path: 'src.ts' } },
    ];
    const bigUser = { ...user, content: '目标'.repeat(10000) };
    const compact = portableHistory([bigUser, call, result], 4000);
    expect(compact[0]).toEqual(bigUser);
    expect(compact[1].anthropicContent).toEqual(call.anthropicContent);
    expect(compact.at(-1)?.toolCallId).toBe('c0');
  });
  it('accepts zero as unlimited and validates optional positive targets', () => {
    for (const contextChars of [0, 4000, 1000000])
      expect(providerSchema.safeParse({ ...provider, contextChars }).success).toBe(true);
    for (const contextChars of [-1, 1, 3999, 1000001])
      expect(providerSchema.safeParse({ ...provider, contextChars }).success).toBe(false);
  });
  it('retrieves original text in bounded slices and rejects a different session', () => {
    const store = new Store(':memory:', { encrypt: (s) => s, decrypt: (s) => s });
    try {
      const session = store.createSession();
      const other = store.createSession();
      store.message({
        ...user,
        sessionId: session.id,
        content: 'head' + 'x'.repeat(10000) + 'tail',
      });
      const first = store.readMessage(session.id, user.id, 0, 20000);
      expect(first.content).toHaveLength(8000);
      expect(first.nextOffset).toBe(8000);
      const last = store.readMessage(session.id, user.id, first.nextOffset!);
      expect(last.content).toHaveLength(2000);
      expect(store.readMessage(session.id, user.id, 10000).content).toBe('xxxxtail');
      expect(store.readMessage(session.id, user.id, 10000).nextOffset).toBeNull();
      expect(() => store.readMessage(other.id, user.id)).toThrow('不存在');
    } finally {
      store.close();
    }
  });
});
