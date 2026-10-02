import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AgentProfile,
  Message,
  Project,
  Provider,
  ProviderInput,
  Run,
  Session,
} from '../src/shared/types';

export interface SecretCodec {
  encrypt(value: string): string;
  decrypt(value: string): string;
}
export class Store {
  readonly db: DatabaseSync;
  constructor(
    path: string,
    private codec: SecretCodec,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS objects (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);
      INSERT OR IGNORE INTO metadata VALUES ('schema_version','1');`);
    const version = this.db
      .prepare('SELECT value FROM metadata WHERE key=?')
      .get('schema_version') as { value: string };
    if (version.value !== '1') throw new Error('此数据库来自更新版本，请升级同舟后打开。');
    if (!this.list<Provider>('provider').length) {
      this.put('provider', {
        id: 'openai-codex',
        name: 'OpenAI · ChatGPT',
        protocol: 'codex',
        baseUrl: '',
        auth: 'chatgpt',
        models: [],
        maxOutputTokens: 8192,
        contextChars: 180000,
      });
      this.put('provider', {
        id: 'local',
        name: '本地模型',
        protocol: 'openai-chat',
        baseUrl: 'http://127.0.0.1:11434/v1',
        auth: 'none',
        models: [],
        maxOutputTokens: 8192,
        contextChars: 60000,
      });
    }
    if (!this.list('agent').length)
      for (const agent of [
        {
          id: 'builder',
          name: '协作助手',
          description: '分析问题、实现功能并验证结果',
          instructions:
            '你是同舟的编程助手。先理解项目和需求，再进行有依据的修改，验证结果。使用中文回复。不要声称执行了未执行的操作。',
          permission: 'ask',
        },
        {
          id: 'reviewer',
          name: '代码审查',
          description: '只读检查，寻找具体问题和改进建议',
          instructions:
            '你是只读代码审查员。读取相关文件，关注正确性、安全性和回归风险。给出文件路径、证据和可执行的建议，不修改文件。',
          permission: 'read-only',
        },
        {
          id: 'architect',
          name: '架构规划',
          description: '梳理需求、模块边界与实现步骤',
          instructions:
            '你是架构规划师。先阅读现有代码，明确需求和约束，再给出可执行的方案、风险和验证方式。只读，不修改文件。',
          permission: 'read-only',
        },
      ])
        this.put('agent', { ...agent, providerId: '', model: '', maxSteps: 16 });
    // An interrupted process must never appear to still be executing after restart.
    for (const run of this.list<Run>('run'))
      if (run.status === 'running')
        this.put('run', {
          ...run,
          status: 'interrupted',
          endedAt: Date.now(),
          error: '应用退出，执行已中断；已保存的操作不会自动重放。',
        });
    const stale = this.db
      .prepare("SELECT value FROM messages WHERE json_extract(value, '$.status')='streaming'")
      .all() as { value: string }[];
    for (const row of stale) this.message({ ...JSON.parse(row.value), status: 'interrupted' });
  }
  list<T = any>(kind: string): T[] {
    return (
      this.db.prepare('SELECT value FROM objects WHERE kind=? ORDER BY rowid').all(kind) as {
        value: string;
      }[]
    ).map((r) => JSON.parse(r.value));
  }
  get<T>(kind: string, id: string): T {
    const row = this.db.prepare('SELECT value FROM objects WHERE kind=? AND id=?').get(kind, id) as
      | { value: string }
      | undefined;
    if (!row) throw new Error('记录不存在或已删除');
    return JSON.parse(row.value);
  }
  put<T extends { id: string }>(kind: string, value: T): T {
    this.db
      .prepare(
        'INSERT INTO objects(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value',
      )
      .run(kind, value.id, JSON.stringify(value));
    return value;
  }
  remove(kind: string, id: string) {
    this.db.prepare('DELETE FROM objects WHERE kind=? AND id=?').run(kind, id);
  }
  providers(): Provider[] {
    return this.list<Provider>('provider').map((p) => ({
      ...p,
      hasSecret: !!this.db.prepare('SELECT id FROM secrets WHERE id=?').get(p.id),
    }));
  }
  saveProvider(input: ProviderInput): Provider {
    const { secret, clearSecret, hasSecret: _, ...provider } = input;
    const encrypted = secret ? this.codec.encrypt(secret) : null;
    this.db.exec('BEGIN');
    try {
      if (clearSecret) this.db.prepare('DELETE FROM secrets WHERE id=?').run(provider.id);
      if (encrypted)
        this.db
          .prepare(
            'INSERT INTO secrets VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
          )
          .run(provider.id, encrypted);
      this.put('provider', provider);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return this.providers().find((p) => p.id === provider.id)!;
  }
  secret(id: string): string {
    const row = this.db.prepare('SELECT value FROM secrets WHERE id=?').get(id) as
      | { value: string }
      | undefined;
    return row ? this.codec.decrypt(row.value) : '';
  }
  deleteProvider(id: string) {
    this.remove('provider', id);
    this.db.prepare('DELETE FROM secrets WHERE id=?').run(id);
  }
  messages(sessionId: string): Message[] {
    return (
      this.db
        .prepare('SELECT value FROM messages WHERE session_id=? ORDER BY seq')
        .all(sessionId) as { value: string }[]
    ).map((r) => JSON.parse(r.value));
  }
  message(message: Message): Message {
    this.db
      .prepare(
        'INSERT INTO messages(id,session_id,value,seq) VALUES(?,?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM messages)) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      )
      .run(message.id, message.sessionId, JSON.stringify(message));
    return message;
  }
  createSession(projectId: string | null = null, parentId?: string): Session {
    if (projectId) this.get<Project>('project', projectId);
    const provider = this.providers()[0];
    return this.put('session', {
      id: randomUUID(),
      projectId,
      title: '新会话',
      providerId: provider?.id ?? '',
      model: provider?.models[0] ?? '',
      agentId: 'builder',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archived: false,
      ...(parentId ? { parentId } : {}),
    });
  }
  close() {
    this.db.close();
  }
}
