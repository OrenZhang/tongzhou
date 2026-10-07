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
  PermissionMode,
} from '../../../src/shared/types';

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
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS messages_sequence ON messages(seq);
      CREATE INDEX IF NOT EXISTS objects_session ON objects(kind, json_extract(value,'$.sessionId'));
      CREATE INDEX IF NOT EXISTS objects_started ON objects(kind, json_extract(value,'$.startedAt') DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(content, tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS message_search_insert AFTER INSERT ON messages BEGIN
        INSERT INTO message_search(rowid,content) VALUES(new.rowid,json_extract(new.value,'$.content'));
      END;
      CREATE TRIGGER IF NOT EXISTS message_search_update AFTER UPDATE ON messages BEGIN
        DELETE FROM message_search WHERE rowid=old.rowid;
        INSERT INTO message_search(rowid,content) VALUES(new.rowid,json_extract(new.value,'$.content'));
      END;
      CREATE TRIGGER IF NOT EXISTS message_search_delete AFTER DELETE ON messages BEGIN
        DELETE FROM message_search WHERE rowid=old.rowid;
      END;
    `);
    if (!this.db.prepare("SELECT 1 FROM metadata WHERE key='message_search_v1'").get()) {
      this.db.exec(`BEGIN; DELETE FROM message_search;
        INSERT INTO message_search(rowid,content) SELECT rowid,json_extract(value,'$.content') FROM messages;
        INSERT INTO metadata VALUES('message_search_v1','1'); COMMIT;`);
    }
    const version = this.db
      .prepare('SELECT value FROM metadata WHERE key=?')
      .get('schema_version') as { value: string };
    if (!['1', '2'].includes(version.value))
      throw new Error('此数据库来自更新版本，请升级同舟后打开。');
    if (!this.list<Provider>('provider').length) {
      this.put('provider', {
        id: 'openai-codex',
        enabled: false,
        name: 'OpenAI · ChatGPT',
        protocol: 'codex',
        baseUrl: '',
        auth: 'chatgpt',
        models: [],
        maxOutputTokens: 8192,
        contextChars: 0,
      });
      this.put('provider', {
        id: 'local',
        enabled: false,
        name: '本地模型',
        protocol: 'openai-chat',
        baseUrl: 'http://127.0.0.1:11434/v1',
        auth: 'none',
        models: [],
        maxOutputTokens: 8192,
        contextChars: 0,
      });
    }
    if (version.value === '1') {
      if (path !== ':memory:' && this.list('agent').length)
        this.db.prepare('VACUUM INTO ?').run(path + '.v1-' + Date.now() + '.bak');
      this.db.exec('BEGIN');
      try {
        const seeds = [
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
        ];
        for (const original of this.list<AgentProfile>('agent')) {
          const seed = seeds.find((s) => s.id === original.id);
          if (
            !seed ||
            original.name !== seed.name ||
            original.description !== seed.description ||
            original.instructions !== seed.instructions ||
            original.permission !== seed.permission ||
            original.providerId ||
            original.model ||
            original.maxSteps !== 16 ||
            original.pluginIds?.length ||
            original.skillIds?.length ||
            original.computerEnabled
          )
            continue;
          this.put('legacyAgent', original);
          this.remove('agent', original.id);
          for (const session of this.list<Session>('session'))
            if (session.agentId === original.id) this.put('session', { ...session, agentId: '' });
        }
        this.db.prepare("UPDATE metadata SET value='2' WHERE key='schema_version'").run();
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    for (const item of this.list<any>('pendingInput'))
      if (['queued', 'dispatching'].includes(item.status))
        this.put('pendingInput', { ...item, status: 'paused' });
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
      thinkingEnabled: p.thinkingEnabled !== false,
      hasSecret: !!this.db.prepare('SELECT id FROM secrets WHERE id=?').get(p.id),
    }));
  }
  saveProvider(input: ProviderInput): Provider {
    const { secret, clearSecret, hasSecret: _, ...provider } = input;
    provider.thinkingEnabled ??=
      this.list<Provider>('provider').find((p) => p.id === input.id)?.thinkingEnabled ?? true;
    provider.enabled ??=
      this.list<Provider>('provider').find((p) => p.id === input.id)?.enabled ?? true;
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
  saveSecret(id: string, value?: string, clear = false) {
    const encrypted = value ? this.codec.encrypt(value) : undefined;
    if (clear) this.db.prepare('DELETE FROM secrets WHERE id=?').run(id);
    if (encrypted)
      this.db
        .prepare(
          'INSERT INTO secrets VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
        )
        .run(id, encrypted);
  }
  hasSecret(id: string) {
    return !!this.db.prepare('SELECT id FROM secrets WHERE id=?').get(id);
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
    this.get<Session>('session', message.sessionId);
    this.db
      .prepare(
        'INSERT INTO messages(id,session_id,value,seq) VALUES(?,?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM messages)) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      )
      .run(message.id, message.sessionId, JSON.stringify(message));
    return message;
  }
  messagesPage(sessionId: string, before?: string, limit = 100): Message[] {
    this.get<Session>('session', sessionId);
    const cursor = before
      ? (
          this.db
            .prepare('SELECT seq FROM messages WHERE id=? AND session_id=?')
            .get(before, sessionId) as { seq: number } | undefined
        )?.seq
      : Number.MAX_SAFE_INTEGER;
    if (cursor === undefined) throw new Error('历史分页位置不存在');
    return (
      this.db
        .prepare(
          'SELECT value FROM messages WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT ?',
        )
        .all(sessionId, cursor, Math.max(1, Math.min(limit, 500))) as { value: string }[]
    )
      .reverse()
      .map((r) => JSON.parse(r.value));
  }
  searchMessages(query: string, sessionId?: string, role?: string, before?: number, limit = 30) {
    if (sessionId) this.get('session', sessionId);
    const rows = this.db
      .prepare(
        `SELECT m.seq,m.value FROM messages m
      JOIN message_search f ON f.rowid=m.rowid
      WHERE f.content LIKE ? AND instr(lower(f.content),lower(?))>0 AND (? IS NULL OR m.session_id=?)
      AND (? IS NULL OR json_extract(m.value,'$.role')=?) AND m.seq<?
      ORDER BY m.seq DESC LIMIT ?`,
      )
      .all(
        '%' + (query.split(/[%_]/).sort((a, b) => b.length - a.length)[0] || '') + '%',
        query,
        sessionId ?? null,
        sessionId ?? null,
        role ?? null,
        role ?? null,
        before ?? Number.MAX_SAFE_INTEGER,
        Math.min(50, Math.max(1, limit)),
      ) as { seq: number; value: string }[];
    return rows.map(({ seq, value }) => {
      const m: Message = JSON.parse(value);
      const at = Math.max(0, m.content.toLowerCase().indexOf(query.toLowerCase()) - 80);
      return {
        id: m.id,
        sessionId: m.sessionId,
        role: m.role,
        createdAt: m.createdAt,
        seq,
        excerpt: m.content.slice(at, at + 600),
        totalChars: m.content.length,
      };
    });
  }
  sessionObjects<T>(kind: string, sessionId: string, limit = 200, before?: string): T[] {
    const cursor = before
      ? (
          this.db
            .prepare(
              "SELECT rowid FROM objects WHERE kind=? AND id=? AND json_extract(value,'$.sessionId')=?",
            )
            .get(kind, before, sessionId) as { rowid: number } | undefined
        )?.rowid
      : Number.MAX_SAFE_INTEGER;
    if (cursor === undefined) throw new Error('分页位置不存在');
    return (
      this.db
        .prepare(
          "SELECT value FROM objects WHERE kind=? AND json_extract(value,'$.sessionId')=? AND rowid<? ORDER BY rowid DESC LIMIT ?",
        )
        .all(kind, sessionId, cursor, Math.min(1000, Math.max(1, limit))) as { value: string }[]
    )
      .reverse()
      .map((r) => JSON.parse(r.value));
  }
  recentRuns(): Run[] {
    return (
      this.db
        .prepare(
          `SELECT value FROM objects WHERE kind='run' AND (rowid IN
      (SELECT MAX(rowid) FROM objects WHERE kind='run' GROUP BY json_extract(value,'$.sessionId'))
      OR json_extract(value,'$.status')='running' OR rowid IN
      (SELECT rowid FROM objects WHERE kind='run' ORDER BY rowid DESC LIMIT 200))
      ORDER BY json_extract(value,'$.startedAt') DESC`,
        )
        .all() as { value: string }[]
    ).map((r) => JSON.parse(r.value));
  }
  readMessage(sessionId: string, messageId: string, offset = 0, limit = 2000) {
    this.get<Session>('session', sessionId);
    const row = this.db
      .prepare('SELECT value FROM messages WHERE id=? AND session_id=?')
      .get(messageId, sessionId) as { value: string } | undefined;
    if (!row) throw new Error('此会话中不存在该消息');
    const message: Message = JSON.parse(row.value);
    const start = Math.max(0, Math.min(Math.floor(offset), message.content.length));
    const end = Math.min(
      message.content.length,
      start + Math.max(1, Math.min(Math.floor(limit), 8000)),
    );
    return {
      id: message.id,
      sessionId,
      role: message.role,
      toolName: message.toolName,
      status: message.status,
      content: message.content.slice(start, end),
      offset: start,
      nextOffset: end < message.content.length ? end : null,
      totalChars: message.content.length,
    };
  }
  createSession(projectId: string | null = null, parentId?: string): Session {
    if (projectId && this.get<Project>('project', projectId).removed)
      throw new Error('工作树已移除，请选择可用项目');
    const provider = this.providers()[0];
    return this.put('session', {
      id: randomUUID(),
      projectId,
      title: '新会话',
      providerId: provider?.id ?? '',
      model: provider?.models[0] ?? '',
      agentId: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archived: false,
      ...(parentId ? { parentId } : {}),
    });
  }
  capabilities() {
    const state = this.list<any>('capabilityState')[0];
    return { computer: state?.computer === true, management: state?.management !== false };
  }
  defaultPermission(): PermissionMode {
    return this.list<{ mode: PermissionMode }>('permissionSettings')[0]?.mode ?? 'ask';
  }
  setSessionPermission(id: string, mode: PermissionMode | null) {
    this.put('session', { ...this.get<Session>('session', id), permission: mode ?? undefined });
  }
  setDefaultPermission(mode: PermissionMode, applyToAll = false) {
    this.db.exec('BEGIN');
    try {
      this.put('permissionSettings', { id: 'global', mode });
      if (applyToAll)
        for (const session of this.list<Session>('session'))
          this.setSessionPermission(session.id, null);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  setCapability(name: 'computer' | 'management', enabled: boolean) {
    this.put('capabilityState', { id: 'global', ...this.capabilities(), [name]: enabled });
  }
  deleteProject(projectIds: Set<string>, sessionIds: Set<string>) {
    this.db.exec('BEGIN');
    try {
      for (const id of sessionIds)
        if (this.list<Session>('session').some((s) => s.id === id)) this.deleteSession(id, true);
      for (const id of projectIds) {
        this.remove('worktree', id);
        this.remove('project', id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  deleteSession(id: string, inTransaction = false) {
    this.get<Session>('session', id);
    const ids = new Set([id]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const s of this.list<Session>('session'))
        if (s.parentId && ids.has(s.parentId) && !ids.has(s.id)) {
          ids.add(s.id);
          changed = true;
        }
    }
    if (!inTransaction) this.db.exec('BEGIN');
    try {
      for (const target of ids) {
        this.put('deletedSession', { id: target, deletedAt: Date.now() });
        this.db.prepare('DELETE FROM messages WHERE session_id=?').run(target);
        for (const kind of [
          'run',
          'runEvent',
          'pendingInput',
          'engineSegment',
          'modelCallState',
          'notificationRule',
          'delivery',
          'channelInbox',
          'contextCheckpoint',
          'taskMemory',
          'knowledgeBinding',
          'knowledgeDismissal',
          'knowledgeCandidate',
          'knowledgeContextPreference',
          'runChanges',
          'terminal',
        ])
          for (const obj of this.list<any>(kind))
            if (obj.sessionId === target) this.remove(kind, obj.id);
        this.remove('session', target);
      }
      for (const channel of this.list<any>('channel'))
        if (ids.has(channel.sessionId))
          this.put('channel', { ...channel, inbound: false, sessionId: undefined });
      if (!inTransaction) this.db.exec('COMMIT');
    } catch (error) {
      if (!inTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
