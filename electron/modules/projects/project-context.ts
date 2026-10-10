import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';
import { files, minimalEnv, read, searchProject, within } from '../../core/tools/workspace';
import type {
  ChangeScope,
  ProjectChange,
  ProjectChanges,
  ProjectPatch,
  ProjectSearch,
} from '../../../src/shared/project-context';

const exec = promisify(execFile);
async function git(root: string, args: string[]) {
  return (
    await exec(
      'git',
      ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false', ...args],
      {
        cwd: root,
        // Git 本地化消息（如 zh_CN 的“不是 Git 仓库”）会让基于英文的解析失配；
        // 强制 C locale 保证 plumbing 输出稳定，UTF-8 路径由 core.quotepath=false 保证。
        env: { ...minimalEnv(), LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
      },
    )
  ).stdout;
}
async function repository(root: string) {
  try {
    return (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch (e: any) {
    if (String(e.stderr).includes('not a git repository')) return false;
    throw new Error('无法读取 Git 仓库，请检查 Git 安装和目录权限。');
  }
}
function diffArgs(scope: ChangeScope) {
  return [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--relative',
    ...(scope === 'staged' ? ['--cached'] : []),
  ];
}
export async function projectChanges(root: string, scope: ChangeScope): Promise<ProjectChanges> {
  if (!(await repository(root)))
    return { repository: false, branch: '', changes: [], truncated: false };
  const [branch, raw, untracked] = await Promise.all([
    git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '分离 HEAD'),
    git(root, [...diffArgs(scope), '--name-status', '-z', '--', '.']),
    scope === 'unstaged'
      ? git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'])
      : '',
  ]);
  const fields = raw.split('\0');
  const changes: ProjectChange[] = [];
  for (let i = 0; i < fields.length && fields[i]; ) {
    const status = fields[i++];
    const first = fields[i++];
    if (/^[RC]/.test(status))
      changes.push({ status: status[0], previousPath: first, path: fields[i++] });
    else changes.push({ status: status[0], path: first });
  }
  for (const file of untracked.split('\0').filter(Boolean))
    changes.push({ status: '?', path: file });
  return {
    repository: true,
    branch: branch.trim(),
    changes: changes.slice(0, 1000),
    truncated: changes.length > 1000,
  };
}
export async function projectPatch(
  root: string,
  relative: string,
  scope: ChangeScope,
): Promise<ProjectPatch> {
  await within(root, relative, true);
  const changes = await projectChanges(root, scope);
  const change = changes.changes.find((c) => c.path === relative);
  if (!change) throw new Error('此文件的变更已更新，请刷新列表。');
  let patch = '';
  if (change.status === '?') {
    try {
      const content = await read(root, relative);
      const lines = content.split(/\r?\n/);
      if (lines.at(-1) === '') lines.pop();
      patch =
        `--- /dev/null\n+++ b/${relative}\n@@ -0,0 +1,${lines.length} @@\n` +
        lines.map((l) => '+' + l).join('\n');
    } catch (e: any) {
      if (String(e.message).includes('二进制') || String(e.message).includes('500 KB'))
        return {
          path: relative,
          patch: '二进制文件或文件超过 500 KB，请在本地应用中查看。',
          binary: true,
          truncated: false,
        };
      throw e;
    }
  } else {
    try {
      patch = await git(root, [
        ...diffArgs(scope),
        '--unified=3',
        '--',
        ...(change.previousPath ? [change.previousPath] : []),
        relative,
      ]);
    } catch (e: any) {
      if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
        return {
          path: relative,
          patch: '差异超过 2 MB，请缩小修改后查看，或让同舟按文件分析。',
          binary: false,
          truncated: true,
        };
      throw e;
    }
  }
  return {
    path: relative,
    patch: patch.slice(0, 160000),
    binary: /^Binary files /m.test(patch),
    truncated: patch.length > 160000,
  };
}
export async function projectSearch(
  root: string,
  query: string,
  mode: 'path' | 'content',
): Promise<ProjectSearch> {
  if (mode === 'content') return searchProject(root, '', query, 100, AbortSignal.timeout(15000));
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const binary = require
    .resolve(
      `@vscode/ripgrep-${process.platform}-${process.arch}/bin/${process.platform === 'win32' ? 'rg.exe' : 'rg'}`,
      { paths: [__dirname, process.cwd()] },
    )
    .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  let stdout = '';
  let truncated = false;
  try {
    stdout = (
      await exec(
        binary,
        [
          '--files',
          '--hidden',
          '--no-require-git',
          '-0',
          '-g',
          '!.git',
          '-g',
          '!node_modules',
          '-g',
          '!dist',
          '-g',
          '!build',
          '-g',
          '!.env*',
          '-g',
          '!*.{pem,key}',
          '--',
          '.',
        ],
        {
          cwd: root,
          env: minimalEnv(),
          windowsHide: true,
          timeout: 15000,
          maxBuffer: 4 * 1024 * 1024,
        },
      )
    ).stdout;
  } catch (e: any) {
    if (e.code === 1) return { matches: [], truncated: false };
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      stdout = String(e.stdout ?? '')
        .split('\0')
        .slice(0, -1)
        .join('\0');
      truncated = true;
    } else throw e;
  }
  const found = stdout
    .split('\0')
    .filter(Boolean)
    .map((p) => p.replace(/^\.([/\\])/, '').replace(/\\/g, '/'))
    .filter((p) => p.toLowerCase().includes(query.toLowerCase().replace(/\\/g, '/')));
  return {
    matches: found.slice(0, 100).map((p) => ({ path: p })),
    truncated: truncated || found.length > 100,
  };
}
export async function projectInstructionsView(root: string) {
  const entries = (await files(root)).filter(
    (f) => !f.directory && /^(agents?\.md|readme(?:\.md)?)$/i.test(f.name),
  );
  return Promise.all(
    entries.map(async (f) => ({ path: f.path, content: await read(root, f.path) })),
  );
}
