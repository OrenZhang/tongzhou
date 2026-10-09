import { FileRecords } from '../../../electron/services/storage/local-files';
import type { KnowledgeDocument } from '../../../src/shared/knowledge';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const roots: string[] = [];
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../../../electron/services/storage/store';
import { resolveAgent } from '../../../electron/core/runtime/context';
import { defaultReply, replyInstructions } from '../../../src/shared/personalization';
import {
  readPersonalization,
  savePersonalization,
  personalizationState,
  personalizationInstructions,
} from '../../../electron/modules/agents/personalization';
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const store = new Store(':memory:', { encrypt: (s) => s, decrypt: (s) => s });
  stores.push(store);
  const session = store.createSession();
  const entry = {
    id: randomUUID(),
    category: 'preference' as const,
    scope: 'session' as const,
    subject: '用户',
    relation: '篇幅',
    content: '偏好简洁回复',
    quotes: ['以后回答简洁些'],
    sessionId: session.id,
    occurredAt: Date.now(),
    sources: [],
  };
  const doc = {
    id: randomUUID(),
    title: '每日记忆',
    kind: 'memory' as const,
    status: 'draft' as const,
    content: '',
    tags: [],
    sources: [],
    origin: 'automatic' as const,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    memoryEntries: [entry],
  };
  const root = mkdtempSync(path.join(tmpdir(), 'tz-personalization-'));
  roots.push(root);
  const records = new FileRecords<KnowledgeDocument>(root);
  records.put(doc as KnowledgeDocument);
  const knowledge = { all: () => records.list() };
  const agent = resolveAgent(store);
  return {
    store,
    records,
    knowledge,
    session,
    entry,
    doc,
    agent,
    instructions: () => personalizationInstructions(store, session, agent, knowledge),
  };
}
describe('personality and confirmed cross-session preferences', () => {
  it('loads legacy profiles without losing custom preferences', () => {
    const f = fixture();
    f.store.put('personalization', {
      id: 'default',
      version: 3,
      enabled: true,
      soul: '保持耐心',
      userPreferences: '偏好中文',
      memories: [],
    });
    const profile = readPersonalization(f.store);
    expect(profile.reply).toEqual(defaultReply);
    expect(profile.version).toBe(3);
    expect(profile.userPreferences).toBe('偏好中文');
    expect(f.instructions()).toContain('保持耐心');
  });
  it('injects the selected reply settings on the next turn and suppresses them when paused', () => {
    const f = fixture();
    const reply = { name: '小林', language: 'zh', length: 'concise', tone: 'direct' } as const;
    const saved = savePersonalization(
      f.store,
      { ...readPersonalization(f.store), reply },
      f.knowledge,
    );
    for (const instruction of replyInstructions(reply))
      expect(f.instructions()).toContain(instruction);
    expect(
      personalizationInstructions(f.store, f.store.createSession(), f.agent, f.knowledge),
    ).toContain('称呼我小林');
    expect(() =>
      savePersonalization(f.store, { ...saved, reply: { ...reply, tone: 'unknown' } }, f.knowledge),
    ).toThrow();
    expect(() =>
      savePersonalization(
        f.store,
        { ...saved, reply: { ...reply, name: 'x'.repeat(81) } },
        f.knowledge,
      ),
    ).toThrow();
    savePersonalization(f.store, { ...saved, enabled: false }, f.knowledge);
    for (const instruction of replyInstructions(reply))
      expect(f.instructions()).not.toContain(instruction);
    expect(readPersonalization(f.store).reply).toEqual(reply);
  });
  it('does not inject candidates until explicitly selected and stops using changed or removed entries', () => {
    const f = fixture();
    expect(f.instructions()).not.toContain('偏好简洁回复');
    const candidate = personalizationState(f.store, f.knowledge).candidates[0];
    savePersonalization(
      f.store,
      { ...readPersonalization(f.store), memories: [candidate] },
      f.knowledge,
    );
    expect(f.instructions()).toContain('偏好简洁回复');
    expect(
      personalizationInstructions(f.store, f.store.createSession(), f.agent, f.knowledge),
    ).toContain('偏好简洁回复');
    f.records.put({
      ...f.doc,
      memoryEntries: [{ ...f.entry, content: '现在偏好详细说明' }],
    });
    expect(f.instructions()).not.toContain('偏好简洁回复');
    expect(f.instructions()).not.toContain('现在偏好详细说明');
    expect(personalizationState(f.store, f.knowledge).unavailable).toBe(1);
    const updated = personalizationState(f.store, f.knowledge).candidates[0];
    savePersonalization(
      f.store,
      { ...readPersonalization(f.store), memories: [updated] },
      f.knowledge,
    );
    expect(f.instructions()).toContain('现在偏好详细说明');
    f.records.remove(f.doc.id);
    expect(f.instructions()).not.toContain('现在偏好详细说明');
  });
  it('supports disable and clear, rejects stale saves, invented references and oversize preferences', () => {
    const f = fixture();
    const original = readPersonalization(f.store);
    let saved = savePersonalization(
      f.store,
      {
        ...original,
        userPreferences: '称呼我小林',
        soul: '使用温暖语气',
      },
      f.knowledge,
    );
    expect(f.instructions()).toContain('称呼我小林');
    expect(() => savePersonalization(f.store, original, f.knowledge)).toThrow('其他窗口');
    expect(() =>
      savePersonalization(f.store, { ...saved, userPreferences: 'x'.repeat(4001) }, f.knowledge),
    ).toThrow();
    expect(() =>
      savePersonalization(
        f.store,
        {
          ...saved,
          memories: [
            { documentId: randomUUID(), entryId: randomUUID(), fingerprint: 'a'.repeat(64) },
          ],
        },
        f.knowledge,
      ),
    ).toThrow('修改或删除');
    saved = savePersonalization(f.store, { ...saved, enabled: false }, f.knowledge);
    expect(f.instructions()).not.toContain('称呼我小林');
    expect(f.instructions()).not.toContain('使用温暖语气');
    expect(readPersonalization(f.store).userPreferences).toBe('称呼我小林');
    savePersonalization(
      f.store,
      {
        ...saved,
        userPreferences: '',
        soul: '',
        memories: [],
        enabled: true,
      },
      f.knowledge,
    );
    expect(f.instructions()).not.toContain('称呼我小林');
  });
  it('omits personal context from background, delegated and externally bound sessions', () => {
    const f = fixture();
    savePersonalization(
      f.store,
      { ...readPersonalization(f.store), userPreferences: '私人称呼' },
      f.knowledge,
    );
    for (const flags of [{ memoryJob: 'job' }, { knowledgeJob: true }, { parentId: 'parent' }]) {
      expect(
        personalizationInstructions(f.store, { ...f.session, ...flags }, f.agent, f.knowledge),
      ).toBe('');
    }
    for (const kind of ['botSession', 'botBinding', 'channel']) {
      f.store.put(kind, { id: 'external', sessionId: f.session.id });
      expect(f.instructions()).toBe('');
      f.store.remove(kind, 'external');
    }
  });
  it('does not select facts or archived entries and redacts secrets in settings', () => {
    const f = fixture();
    f.records.put({ ...f.doc, memoryEntries: [{ ...f.entry, category: 'fact' }] });
    expect(personalizationState(f.store, f.knowledge).candidates).toEqual([]);
    f.records.put({ ...f.doc, status: 'archived' });
    expect(personalizationState(f.store, f.knowledge).candidates).toEqual([]);
    savePersonalization(
      f.store,
      {
        ...readPersonalization(f.store),
        userPreferences: 'api_key=secret-example',
        reply: { ...defaultReply, name: 'api_key=secret-name' },
      },
      f.knowledge,
    );
    expect(readPersonalization(f.store).userPreferences).not.toContain('secret-example');
    expect(readPersonalization(f.store).reply?.name).not.toContain('secret-name');
  });
});
