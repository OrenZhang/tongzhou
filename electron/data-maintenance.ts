import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  renameSync,
  rmSync,
  lstatSync,
} from 'node:fs';
import path from 'node:path';
import { zipSync, unzipSync } from 'fflate';
import type { Store } from './store';

const signature = Buffer.from('TONGZHOU-BACKUP-1\n');
const allowed = (name: string) =>
  name === 'tongzhou.db' ||
  /^attachments\/[a-f0-9-]{36}$/.test(name) ||
  /^checkpoints\/[a-f0-9]{64}$/.test(name) ||
  /^knowledge\/(?:index\.md|(?:sources|wiki|memories)\/[a-f0-9-]{36}\.md|revisions\/[a-f0-9-]{36}-[0-9]+\.json|files\/[a-f0-9-]{36}\.[a-z0-9]{1,8})$/.test(
    name,
  );
const maxBytes = 256 * 1024 * 1024;
export function encryptBackup(data: Uint8Array, password: string) {
  if (password.length < 12 || password.length > 256) throw new Error('备份密码需 12–256 个字符');
  const salt = randomBytes(16),
    iv = randomBytes(12),
    key = scryptSync(password, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(signature);
  return Buffer.concat([signature, salt, iv, ...encrypt()]);
  function encrypt() {
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    return [cipher.getAuthTag(), body];
  }
}
export function decryptBackup(bytes: Buffer, password: string) {
  if (bytes.length > maxBytes || !bytes.subarray(0, signature.length).equals(signature))
    throw new Error('备份格式无效或文件超过 256 MB');
  const offset = signature.length,
    key = scryptSync(password, bytes.subarray(offset, offset + 16), 32);
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(offset + 16, offset + 28));
  decipher.setAAD(signature);
  decipher.setAuthTag(bytes.subarray(offset + 28, offset + 44));
  try {
    return Buffer.concat([decipher.update(bytes.subarray(offset + 44)), decipher.final()]);
  } catch {
    throw new Error('备份密码不正确或文件已损坏');
  }
}
export class DataMaintenance {
  constructor(
    private store: Store,
    private dataDir: string,
  ) {}
  backup(password: string) {
    const temp = path.join(this.dataDir, 'backup-' + randomBytes(8).toString('hex') + '.db');
    try {
      this.store.db.prepare('VACUUM INTO ?').run(temp);
      const db = new DatabaseSync(temp);
      try {
        db.exec(
          "PRAGMA secure_delete=ON; DELETE FROM secrets; DELETE FROM objects WHERE kind IN ('engineSegment','channelInbox','authEvent','channelAuth','networkLease');",
        );
        const configs = db
          .prepare(
            "SELECT kind,id,value FROM objects WHERE kind IN ('provider','connector','plugin','bot','channel','notificationRule')",
          )
          .all() as { kind: string; id: string; value: string }[];
        for (const c of configs) {
          const v = JSON.parse(c.value);
          v.enabled = false;
          v.inbound = false;
          delete v.account;
          delete v.oauthError;
          delete v.checkedAt;
          v.oauthStatus = 'none';
          if (c.kind === 'connector') v.status = 'configured';
          db.prepare('UPDATE objects SET value=? WHERE kind=? AND id=?').run(
            JSON.stringify(v),
            c.kind,
            c.id,
          );
        }
        db.exec('VACUUM; PRAGMA journal_mode=DELETE');
      } finally {
        db.close();
      }
      const entries: Record<string, Uint8Array> = { 'tongzhou.db': readFileSync(temp) };
      let size = entries['tongzhou.db'].length;
      if (size > maxBytes) throw new Error('数据库超过 256 MB');
      for (const folder of ['attachments', 'checkpoints', 'knowledge']) {
        const root = path.join(this.dataDir, folder);
        if (!existsSync(root)) continue;
        for (const name of readdirSync(root, { recursive: folder === 'knowledge' }) as string[]) {
          const key = folder + '/' + name.replaceAll(path.sep, '/');
          if (!allowed(key)) continue;
          const file = path.join(root, name);
          if (
            lstatSync(file).isSymbolicLink() ||
            !lstatSync(file).isFile() ||
            (path.dirname(file) !== root && lstatSync(path.dirname(file)).isSymbolicLink())
          )
            continue;
          size += lstatSync(file).size;
          if (size > maxBytes) throw new Error('工作数据超过 256 MB，请先清理未使用附件');
          entries[key] = readFileSync(file);
        }
      }
      return encryptBackup(zipSync(entries, { level: 1 }), password);
    } finally {
      rmSync(temp, { force: true });
    }
  }
  prepareRestore(bytes: Buffer, password: string) {
    let size = 0;
    const entries = unzipSync(decryptBackup(bytes, password), {
      filter(file) {
        if (!allowed(file.name)) throw new Error('备份包含不支持的文件路径');
        size += file.originalSize;
        if (size > maxBytes) throw new Error('解压后备份超过 256 MB');
        return true;
      },
    });
    if (!entries['tongzhou.db']) throw new Error('备份缺少工作数据库');
    const stage = path.join(this.dataDir, 'restore-pending');
    if (existsSync(stage)) throw new Error('已有待恢复数据，请重启客户端完成恢复');
    mkdirSync(stage, { recursive: true });
    try {
      for (const [name, data] of Object.entries(entries)) {
        const file = path.join(stage, name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, data);
      }
      const db = new DatabaseSync(path.join(stage, 'tongzhou.db'), { readOnly: true });
      try {
        const check = db.prepare('PRAGMA integrity_check').get() as Record<string, string>;
        if (Object.values(check)[0] !== 'ok') throw new Error('备份数据库完整性检查失败');
        const version = db
          .prepare("SELECT value FROM metadata WHERE key='schema_version'")
          .get() as { value: string };
        if (!['1', '2'].includes(version?.value)) throw new Error('备份来自不兼容版本');
      } finally {
        db.close();
      }
      writeFileSync(path.join(stage, 'ready'), '1');
    } catch (e) {
      rmSync(stage, { recursive: true, force: true });
      throw e;
    }
  }
  diagnostics(version: string) {
    const count = (table: string) =>
      Number(
        (this.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      );
    return {
      version,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      time: new Date().toISOString(),
      counts: { messages: count('messages'), objects: count('objects') },
      providers: this.store.providers().map((p) => ({
        protocol: p.protocol,
        enabled: p.enabled !== false,
        configured: !!p.hasSecret || p.auth === 'none',
        models: p.models.length,
      })),
      runs: this.store
        .recentRuns()
        .slice(0, 30)
        .map((r) => ({
          status: r.status,
          durationMs: r.endedAt ? r.endedAt - r.startedAt : null,
          protocol: r.config?.protocol,
        })),
      privacy: '不包含消息、文件、账号、地址、密钥或原始错误。',
    };
  }
  cleanUnused() {
    // Attachment drafts live in the renderer and may not have a message yet.
    // Keep every registered attachment; only unregistered orphan files are safe.
    const liveAttachments = new Set<string>(
      this.store.list<{ id: string }>('attachment').map((a) => a.id),
    );
    for (const p of this.store.list<any>('pendingInput'))
      for (const id of p.attachmentIds ?? p.input?.attachmentIds ?? []) liveAttachments.add(id);
    for (const row of this.store.db.prepare('SELECT value FROM messages').iterate() as Iterable<{
      value: string;
    }>)
      for (const a of JSON.parse(row.value).attachments ?? []) liveAttachments.add(a.id);
    const liveBlobs = new Set<string>();
    for (const c of this.store.list<any>('runChanges'))
      for (const f of c.files ?? []) for (const h of [f.before, f.after]) if (h) liveBlobs.add(h);
    let files = 0,
      bytes = 0;
    for (const [folder, live] of [
      ['attachments', liveAttachments],
      ['checkpoints', liveBlobs],
    ] as const) {
      const root = path.join(this.dataDir, folder);
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root)) {
        if (live.has(name) || !allowed(folder + '/' + name)) continue;
        const file = path.join(root, name),
          s = lstatSync(file);
        if (s.isSymbolicLink() || !s.isFile()) continue;
        bytes += s.size;
        rmSync(file);
        files++;
      }
    }
    return { files, bytes };
  }
}
/** Called before opening SQLite. A journal makes a partially applied restore restartable. */
export function applyPendingRestore(dataDir: string) {
  const stage = path.join(dataDir, 'restore-pending');
  if (!existsSync(path.join(stage, 'ready'))) return;
  const journal = path.join(stage, 'journal.json');
  const state = existsSync(journal)
    ? JSON.parse(readFileSync(journal, 'utf8'))
    : {
        backup: 'before-restore-' + Date.now(),
        incoming: readdirSync(stage),
        done: [] as string[],
      };
  if (!/^before-restore-\d+$/.test(state.backup)) throw new Error('恢复记录无效');
  const backup = path.join(dataDir, state.backup);
  mkdirSync(backup, { recursive: true });
  writeFileSync(journal, JSON.stringify(state));
  for (const name of [
    'tongzhou.db',
    'tongzhou.db-wal',
    'tongzhou.db-shm',
    'attachments',
    'checkpoints',
    'knowledge',
  ]) {
    if (state.done.includes(name)) continue;
    const target = path.join(dataDir, name),
      old = path.join(backup, name),
      next = path.join(stage, name);
    if (state.incoming.includes(name)) {
      if (existsSync(next)) {
        if (existsSync(target) && !existsSync(old)) renameSync(target, old);
        renameSync(next, target);
      } else if (!existsSync(target)) throw new Error('恢复文件缺失：' + name);
    } else if (existsSync(target) && !existsSync(old)) renameSync(target, old);
    state.done.push(name);
    writeFileSync(journal, JSON.stringify(state));
  }
  rmSync(stage, { recursive: true, force: true });
}
