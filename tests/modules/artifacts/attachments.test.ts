import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../../electron/services/storage/store';
import { Attachments } from '../../../electron/modules/artifacts/attachments';
import { longPaste } from '../../../src/shared/attachments';
import { runSchema } from '../../../electron/services/storage/validation';
import type { Message, Protocol } from '../../../src/shared/types';
import { requestBody } from '../../../electron/core/models/providers';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tongzhou-attachments-'));
  roots.push(root);
  const store = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
  stores.push(store);
  return { files: new Attachments(root), store, root };
}
it('stores full UTF-8 text as a file and sends a reference instead of expanding the prompt', () => {
  const f = fixture(),
    text = '多行资料\n'.repeat(2000);
  const a = f.files.save({
    name: 'notes.txt',
    mimeType: 'text/plain',
    data: Buffer.from(text).toString('base64'),
  });
  const restored = new Attachments(f.root);
  expect(restored.content(a.id)).toBe(text);
  const history = restored.history([
    { id: 'm', sessionId: 's', role: 'user', content: '分析附件', attachments: [a], createdAt: 1 },
  ]);
  expect(history[0].content).toContain(a.id);
  expect(history[0].content).not.toContain(text);
  expect(restored.history(history)[0].content).toBe(history[0].content);
  expect(longPaste('a'.repeat(4001))).toBe(true);
  expect(longPaste('line\n'.repeat(81))).toBe(true);
  expect(longPaste('短消息')).toBe(false);
});
it('rejects forged image formats, arbitrary paths and duplicate attachments; permits image-only input', () => {
  const { files } = fixture();
  expect(() =>
    files.save({
      name: 'fake.png',
      mimeType: 'image/png',
      data: Buffer.from('<svg/>').toString('base64'),
    }),
  ).toThrow('格式');
  expect(() => files.content('../credentials')).toThrow();
  const a = files.save({ name: 'a.png', mimeType: 'image/png', data: png });
  expect(() => files.resolve([a.id, a.id])).toThrow('不重复');
  const input = { sessionId: 's', providerId: 'p', model: 'm', agentId: '', prompt: '' };
  expect(runSchema.safeParse(input).success).toBe(false);
  expect(runSchema.safeParse({ ...input, attachmentIds: [a.id] }).success).toBe(true);
});
it.each(['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as Protocol[])(
  'sends user images and later screenshots separately through %s',
  (protocol) => {
    const { files } = fixture();
    const a = files.save({ name: 'a.png', mimeType: 'image/png', data: png });
    const history = files.history([
      {
        id: 'm',
        sessionId: 's',
        role: 'user',
        content: '看图',
        attachments: [a],
        createdAt: 1,
        runId: 'r',
      },
      {
        id: 'call',
        sessionId: 's',
        role: 'assistant',
        content: '',
        createdAt: 2,
        runId: 'r',
        toolCalls: [{ id: 't', name: 'computer_screenshot', arguments: '{}' }],
      },
      {
        id: 'tool',
        sessionId: 's',
        role: 'tool',
        content: '截图',
        createdAt: 3,
        runId: 'r',
        toolCallId: 't',
        toolName: 'computer_screenshot',
        images: [{ mimeType: 'image/png', data: 'c2NyZWVu' }],
      },
    ] as Message[]);
    const request = requestBody({
      provider: {
        id: 'p',
        name: 'p',
        protocol,
        baseUrl: 'https://example.test',
        auth: 'none',
        models: ['m'],
        maxOutputTokens: 1024,
        contextChars: 0,
      },
      model: 'm',
      instructions: '',
      messages: history,
      tools: [],
      secret: '',
      signal: new AbortController().signal,
      onDelta: () => {},
    });
    const json = JSON.stringify(request.body);
    expect(json).toContain(png);
    expect(json).toContain('c2NyZWVu');
    expect(json.split(png)).toHaveLength(2);
  },
);
