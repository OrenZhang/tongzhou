import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertLocalPath,
  atomicWrite,
  managedDirectory,
} from '../../../electron/services/storage/local-files';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'tongzhou-paths-'));
  roots.push(root);
  const real = path.join(root, 'real');
  mkdirSync(real);
  const alias = path.join(root, 'alias');
  symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  return { root, real, alias };
}
it('accepts a trusted data directory under a system alias while keeping writes in its managed root', () => {
  const { real, alias } = fixture();
  const dataDir = path.join(alias, 'data');
  mkdirSync(dataDir);
  const managed = managedDirectory(dataDir, 'knowledge');
  atomicWrite(managed, path.join(managed, 'document.md'), '正文');
  if (process.platform === 'win32')
    expect(() =>
      assertLocalPath(managed.toUpperCase(), path.join(managed, 'document.md')),
    ).not.toThrow();
  expect(readFileSync(path.join(real, 'data', '.tzhou', 'knowledge', 'document.md'), 'utf8')).toBe(
    '正文',
  );
});
it('rejects links at or inside the managed root and lexical traversal before writing', () => {
  const { root, real, alias } = fixture();
  expect(() => assertLocalPath(alias, path.join(alias, 'file'))).toThrow('符号链接');
  const managed = managedDirectory(real, 'knowledge');
  symlinkSync(
    root,
    path.join(managed, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(() => atomicWrite(managed, path.join(managed, 'escape', 'outside.md'), 'bad')).toThrow(
    '符号链接',
  );
  expect(() => atomicWrite(managed, path.resolve(managed, '..', 'outside.md'), 'bad')).toThrow(
    '无效',
  );
  expect(existsSync(path.join(root, 'outside.md'))).toBe(false);
});
