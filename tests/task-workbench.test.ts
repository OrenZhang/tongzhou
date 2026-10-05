import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { Store } from '../electron/store';
import { portableHistory } from '../electron/history';
import { TaskMemories } from '../electron/task-memory';
import { ChangeCheckpoints } from '../electron/run-changes';
import {
  DataMaintenance,
  encryptBackup,
  decryptBackup,
  applyPendingRestore,
} from '../electron/data-maintenance';
import { IdleTimeout } from '../electron/idle-timeout';
import type { Message } from '../src/shared/types';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'tongzhou-reliability-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(path.join(root, 'tongzhou.db'), { encrypt: (s) => s, decrypt: (s) => s });
  cleanup.push(() => store.close());
  const session = store.createSession();
  return { root, store, session };
}
const message = (
  sessionId: string,
  id: string,
  content: string,
  role: Message['role'] = 'user',
): Message => ({ sessionId, id, content, role, createdAt: 1, runId: id });

describe('task continuity and storage', () => {
  it('preserves a mid-task user constraint after long history compression', () => {
    const messages = [
      message('s', 'first', 'Build the project'),
      ...Array.from({ length: 90 }, (_, i) => message('s', 'a' + i, 'x'.repeat(1400), 'assistant')),
      message('s', 'last', 'Continue'),
    ];
    messages.splice(40, 0, message('s', 'correction', 'Keep the existing API and customer data'));
    const result = JSON.stringify(portableHistory(messages, 8000));
    expect(result).toContain('Keep the existing API and customer data');
    expect(result).toContain('correction');
    expect(result).toContain('search_history');
  });
  it('indexes updates, literal wildcard search and deletions without leaking other sessions', () => {
    const { store, session } = fixture(),
      other = store.createSession();
    store.message(message(session.id, 'one', '中途要求：保持客户数据 100%_valid'));
    store.message(message(other.id, 'other', '中途要求：其他会话'));
    expect(store.searchMessages('中途要求', session.id)).toHaveLength(1);
    expect(store.searchMessages('%_', session.id)).toHaveLength(1);
    store.message(message(session.id, 'one', '修订后的目标'));
    expect(store.searchMessages('保持客户', session.id)).toHaveLength(0);
    expect(store.searchMessages('修订后', session.id)).toHaveLength(1);
    store.deleteSession(session.id);
    expect(store.searchMessages('修订后')).toHaveLength(0);
  });
  it('paginates events and search without duplicates across thousands of records', () => {
    const { store, session } = fixture();
    store.db.exec('BEGIN');
    for (let i = 0; i < 5000; i++) {
      store.put('runEvent', { id: 'e' + i, sessionId: session.id, seq: i, time: i });
      if (i < 150) store.message(message(session.id, 'm' + i, '检索' + i));
    }
    store.db.exec('COMMIT');
    const tail = store.sessionObjects<any>('runEvent', session.id, 300),
      prev = store.sessionObjects<any>('runEvent', session.id, 300, tail[0].id);
    expect(tail[0].id).toBe('e4700');
    expect(prev.at(-1).id).toBe('e4699');
    const first = store.searchMessages('检索', session.id),
      next = store.searchMessages('检索', session.id, undefined, first.at(-1)!.seq);
    expect(new Set([...first, ...next].map((m) => m.id)).size).toBe(60);
  });
  it('requires valid same-session sources and removes task memory with its session', () => {
    const { store, session } = fixture(),
      other = store.createSession();
    store.message(message(other.id, 'private', 'private'));
    const memory = new TaskMemories(store),
      value = {
        goal: '目标',
        constraints: ['保留用户改动'],
        decisions: [],
        completed: [],
        nextSteps: ['运行测试'],
        sources: [],
      };
    expect(() => memory.save(session.id, { ...value, sources: ['private'] })).toThrow();
    memory.save(session.id, value);
    expect(memory.read(session.id)?.constraints).toEqual(value.constraints);
    store.deleteSession(session.id);
    expect(store.list('taskMemory')).toHaveLength(0);
  });
  it('uses idle time instead of an absolute stream lifetime and disposes timers', () => {
    vi.useFakeTimers();
    const expire = vi.fn(),
      timer = new IdleTimeout(1000, expire);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(900);
      timer.touch();
    }
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(expire).toHaveBeenCalledOnce();
    timer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
describe('per-turn file protection', () => {
  it('restores the pre-turn user edit and refuses to overwrite later changes', async () => {
    const { root, store, session } = fixture(),
      project = { id: 'p', name: 'p', path: path.join(root, 'project'), createdAt: 0 };
    mkdirSync(project.path);
    store.put('project', project);
    writeFileSync(path.join(project.path, 'source.ts'), 'user edit before task\n');
    const changes = new ChangeCheckpoints(store, root);
    await changes.begin('run', session.id, project);
    writeFileSync(path.join(project.path, 'source.ts'), 'agent edit\n');
    await changes.finish('run');
    expect(await changes.patch('run', 'source.ts')).toContain('-user edit before task');
    writeFileSync(path.join(project.path, 'source.ts'), 'newer user edit\n');
    await expect(changes.restore('run', 'source.ts')).rejects.toThrow('已被修改');
    writeFileSync(path.join(project.path, 'source.ts'), 'agent edit\n');
    await changes.restore('run', 'source.ts');
    expect(readFileSync(path.join(project.path, 'source.ts'), 'utf8')).toBe(
      'user edit before task\n',
    );
  });
  it('does not mistake a file that grew beyond the capture limit for a deletion', async () => {
    const { root, store, session } = fixture(),
      p = { id: 'p', name: 'p', path: path.join(root, 'p'), createdAt: 0 };
    mkdirSync(p.path);
    store.put('project', p);
    writeFileSync(path.join(p.path, 'large.txt'), 'before');
    const c = new ChangeCheckpoints(store, root);
    await c.begin('r', session.id, p);
    writeFileSync(path.join(p.path, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
    const r = await c.finish('r');
    expect(r.files).toHaveLength(0);
    expect(r.skipped).toBeGreaterThan(0);
  });
});
describe('encrypted work-data backups', () => {
  it('authenticates encryption and rejects a modified archive or wrong password', () => {
    const bytes = encryptBackup(Buffer.from('private history'), 'a long backup password');
    expect(bytes.toString()).not.toContain('private history');
    expect(decryptBackup(bytes, 'a long backup password').toString()).toBe('private history');
    expect(() => decryptBackup(bytes, 'wrong password')).toThrow();
    bytes[bytes.length - 1] ^= 1;
    expect(() => decryptBackup(bytes, 'a long backup password')).toThrow();
  });
  it('roundtrips messages and attachments, excluding saved credentials and disabling restored connections', () => {
    const { root, store, session } = fixture();
    store.message(message(session.id, 'm', 'History to restore'));
    store.saveProvider({
      id: 'private',
      enabled: true,
      name: 'Private',
      auth: 'api-key',
      protocol: 'openai-chat',
      baseUrl: 'https://example.invalid',
      models: ['test'],
      contextChars: 0,
      maxOutputTokens: 1000,
      secret: 'UNIQUE_PRIVATE_TOKEN_DO_NOT_EXPORT',
    });
    const maintenance = new DataMaintenance(store, root),
      backup = maintenance.backup('a long backup password');
    const files = unzipSync(decryptBackup(backup, 'a long backup password'));
    expect(
      Buffer.from(files['tongzhou.db']).includes(Buffer.from('UNIQUE_PRIVATE_TOKEN_DO_NOT_EXPORT')),
    ).toBe(false);
    const target = path.join(root, 'restored');
    mkdirSync(target);
    const temporary = new Store(path.join(target, 'tongzhou.db'), {
      encrypt: (s) => s,
      decrypt: (s) => s,
    });
    const restore = new DataMaintenance(temporary, target);
    restore.prepareRestore(backup, 'a long backup password');
    temporary.close();
    applyPendingRestore(target);
    const restored = new Store(path.join(target, 'tongzhou.db'), {
      encrypt: (s) => s,
      decrypt: (s) => s,
    });
    try {
      expect(restored.messages(session.id)[0].content).toBe('History to restore');
      expect(restored.hasSecret('private')).toBe(false);
      expect(restored.get<any>('provider', 'private').enabled).toBe(false);
    } finally {
      restored.close();
    }
    expect(existsSync(path.join(target, 'restore-pending'))).toBe(false);
  });
  it('preserves registered unsent attachments while cleaning orphan files', () => {
    const { root, store } = fixture();
    const draft = '11111111-1111-4111-8111-111111111111',
      orphan = '22222222-2222-4222-8222-222222222222';
    mkdirSync(path.join(root, 'attachments'));
    writeFileSync(path.join(root, 'attachments', draft), 'unsent draft');
    writeFileSync(path.join(root, 'attachments', orphan), 'orphan');
    store.put('attachment', { id: draft, name: 'draft.txt' });
    expect(new DataMaintenance(store, root).cleanUnused().files).toBe(1);
    expect(readFileSync(path.join(root, 'attachments', draft), 'utf8')).toBe('unsent draft');
    expect(existsSync(path.join(root, 'attachments', orphan))).toBe(false);
  });
  it('rejects archive path traversal before writing and exports no private diagnostics', () => {
    const { root, store } = fixture(),
      m = new DataMaintenance(store, root);
    const evil = encryptBackup(
      zipSync({ '../escape': Buffer.from('bad') }),
      'a long backup password',
    );
    expect(() => m.prepareRestore(evil, 'a long backup password')).toThrow('路径');
    expect(existsSync(path.join(root, 'restore-pending'))).toBe(false);
    const diagnostic = JSON.stringify(m.diagnostics('test'));
    expect(diagnostic).not.toContain(root);
    expect(diagnostic).not.toContain('baseUrl');
  });
});
