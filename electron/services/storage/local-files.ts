import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import path from 'node:path';
import type { Store } from './store';

/** Managed user files live here; project workspaces keep their user-selected paths. */
export function localFilesRoot(dataDir: string) {
  const root = path.resolve(dataDir, '.tzhou');
  assertLocalPath(root, root);
  mkdirSync(root, { recursive: true });
  return root;
}

export function assertLocalPath(root: string, file: string) {
  root = path.resolve(root);
  file = path.resolve(file);
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('无效的本地文件路径');
  for (let part = file; ; part = path.dirname(part)) {
    if (existsSync(part) && lstatSync(part).isSymbolicLink())
      throw new Error('本地文件目录不能使用符号链接');
    if (part === path.dirname(part)) break;
  }
}

/** A rename is the commit point. Nothing fallible runs after it. */
export function atomicWrite(root: string, file: string, value: string | Buffer) {
  assertLocalPath(root, file);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, value, { flag: 'wx', mode: 0o600 });
    const fd = openSync(temp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* Preserve the original error. */
    }
    throw error;
  }
}

/** Move an existing managed directory once, without overwriting either copy. */
export function managedDirectory(dataDir: string, name: string) {
  if (!/^[a-z][a-z-]*$/.test(name)) throw new Error('无效目录');
  const root = localFilesRoot(dataDir),
    target = path.join(root, name),
    legacy = path.join(dataDir, name);
  assertLocalPath(root, target);
  if (existsSync(target) && existsSync(legacy))
    throw new Error(`本地文件迁移发现两个 ${name} 目录，已保留两份数据，请先核对目录`);
  if (!existsSync(target) && existsSync(legacy)) {
    assertLocalPath(path.resolve(dataDir), path.resolve(legacy));
    renameSync(legacy, target);
  }
  mkdirSync(target, { recursive: true });
  return target;
}

export interface RecordCodec<T> {
  extension: string;
  encode(value: T): string;
  decode(text: string): T;
}
export class FileRecords<T extends { id: string }> {
  constructor(
    readonly root: string,
    private codec: RecordCodec<T> = {
      extension: '.json',
      encode: (value) => JSON.stringify(value, null, 2),
      decode: JSON.parse,
    },
  ) {
    assertLocalPath(root, root);
    mkdirSync(root, { recursive: true });
  }
  file(id: string) {
    if (!/^[a-zA-Z0-9_-]+(?::[0-9]+)?$/.test(id)) throw new Error('无效文件记录 ID');
    const file = path.join(this.root, id.replace(':', '~') + this.codec.extension);
    assertLocalPath(this.root, file);
    return file;
  }
  get(id: string): T {
    let text: string;
    try {
      text = readFileSync(this.file(id), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('记录不存在或已删除');
      throw error;
    }
    const value = this.codec.decode(text);
    if (value.id !== id) throw new Error('文件记录 ID 不匹配');
    return value;
  }
  list(): T[] {
    assertLocalPath(this.root, this.root);
    return readdirSync(this.root)
      .filter((name) => name.endsWith(this.codec.extension))
      .map((name) => this.get(name.slice(0, -this.codec.extension.length).replace('~', ':')));
  }
  put(value: T) {
    atomicWrite(this.root, this.file(value.id), this.codec.encode(value));
  }
  remove(id: string) {
    try {
      unlinkSync(this.file(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  /** Restartable migration: keep SQLite rows until every file has been read back and verified. */
  migrate(store: Store, kind: string) {
    const rows = store.list<T>(kind);
    for (const row of rows) {
      if (!existsSync(this.file(row.id))) this.put(row);
      if (JSON.stringify(this.get(row.id)) !== JSON.stringify(row)) {
        // Codecs may reorder keys, but never discard fields.
        const sorted = (v: T) =>
          JSON.stringify(
            Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))),
          );
        if (sorted(this.get(row.id)) !== sorted(row))
          throw new Error(`本地文件迁移校验失败：${kind}/${row.id}`);
      }
    }
    if (rows.length) store.db.prepare('DELETE FROM objects WHERE kind=?').run(kind);
  }
}
