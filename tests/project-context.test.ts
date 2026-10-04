import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {
  projectChanges,
  projectPatch,
  projectSearch,
  projectInstructionsView,
} from '../electron/project-context';
import { diffLines } from '../src/shared/project-context';

const roots: string[] = [];
const git = (root: string, args: string[]) =>
  execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' }).toString();
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tongzhou-context-'));
  roots.push(root);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['config', 'user.email', 'fixture@example.com']);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('project context read services', () => {
  it('handles an unborn repository, new UTF-8 files, literal paths and binary files', async () => {
    const root = await fixture();
    await writeFile(path.join(root, '中文 [新].ts'), 'export const value = 1;\n');
    await writeFile(path.join(root, 'image.png'), Buffer.from([0, 1, 2, 3]));
    expect((await projectChanges(root, 'unstaged')).changes).toEqual(
      expect.arrayContaining([{ path: '中文 [新].ts', status: '?' }]),
    );
    expect((await projectPatch(root, '中文 [新].ts', 'unstaged')).patch).toContain(
      '+export const value = 1;',
    );
    expect((await projectPatch(root, 'image.png', 'unstaged')).binary).toBe(true);
    git(root, ['add', '--', '中文 [新].ts']);
    expect((await projectChanges(root, 'staged')).changes[0]).toMatchObject({
      path: '中文 [新].ts',
      status: 'A',
    });
    expect((await projectPatch(root, '中文 [新].ts', 'staged')).patch).toContain(
      '+export const value = 1;',
    );
    await expect(projectPatch(root, '../outside', 'unstaged')).rejects.toThrow('范围');
  });
  it('keeps index and working tree separate and shows deleted and renamed paths', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'sample.ts'), 'const value = 1;\n');
    await writeFile(path.join(root, 'old name.txt'), 'rename content\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'initial']);
    await writeFile(path.join(root, 'sample.ts'), 'const value = 2;\n');
    git(root, ['add', '.']);
    await writeFile(path.join(root, 'sample.ts'), 'const value = 3;\n');
    expect((await projectPatch(root, 'sample.ts', 'staged')).patch).toContain('+const value = 2;');
    expect((await projectPatch(root, 'sample.ts', 'unstaged')).patch).toContain(
      '-const value = 2;',
    );
    await rename(path.join(root, 'old name.txt'), path.join(root, '新名字.txt'));
    git(root, ['add', '-A']);
    expect((await projectChanges(root, 'staged')).changes).toContainEqual({
      path: '新名字.txt',
      previousPath: 'old name.txt',
      status: 'R',
    });
    expect((await projectPatch(root, '新名字.txt', 'staged')).patch).toContain('rename to');
    await rm(path.join(root, 'sample.ts'));
    expect((await projectPatch(root, 'sample.ts', 'unstaged')).patch).toContain(
      '-const value = 3;',
    );
  });
  it('scopes changes to a project subfolder rather than exposing sibling changes', async () => {
    const root = await fixture();
    const sub = path.join(root, 'sub');
    await mkdir(sub);
    await writeFile(path.join(sub, 'file.txt'), 'before');
    await writeFile(path.join(root, 'sibling.txt'), 'before');
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'initial']);
    await writeFile(path.join(sub, 'file.txt'), 'after');
    await writeFile(path.join(root, 'sibling.txt'), 'after');
    expect((await projectChanges(sub, 'unstaged')).changes).toEqual([
      { path: 'file.txt', status: 'M' },
    ]);
    expect((await projectPatch(sub, 'file.txt', 'unstaged')).patch).toContain('+after');
  });
  it('searches paths and content, respects ignore files and returns instructions without writes', async () => {
    const root = await fixture();
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src', '中文.ts'), 'const needle = 42;\n');
    await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
    await writeFile(path.join(root, 'ignored.txt'), 'needle');
    await writeFile(path.join(root, '.env'), 'needle');
    await writeFile(path.join(root, 'AGENTS.md'), '# Instructions');
    expect((await projectSearch(root, '中文', 'path')).matches).toEqual([{ path: 'src/中文.ts' }]);
    expect((await projectSearch(root, 'needle', 'content')).matches).toHaveLength(1);
    expect((await projectSearch(root, 'not-here', 'path')).matches).toEqual([]);
    expect(await projectInstructionsView(root)).toEqual([
      { path: 'AGENTS.md', content: '# Instructions' },
    ]);
  });
  it('reports a normal folder distinctly from an empty Git diff', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tongzhou-plain-'));
    roots.push(root);
    expect((await projectChanges(root, 'unstaged')).repository).toBe(false);
  });
  it('numbers additions and deletions across hunks, including content beginning with +++', () => {
    const result = diffLines(
      '--- a/test\n+++ b/test\n@@ -2,2 +2,2 @@\n-old\n+++new\n same\n@@ -10 +12 @@\n-x\n+y',
    );
    expect(result[3]).toEqual({ kind: 'remove', text: '-old', oldLine: 2 });
    expect(result[4]).toEqual({ kind: 'add', text: '+++new', newLine: 2 });
    expect(result.at(-1)).toEqual({ kind: 'add', text: '+y', newLine: 12 });
  });
});
