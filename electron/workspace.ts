import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile,
  rm,
  chmod,
} from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { FileEntry } from '../src/shared/types';
import type { ToolSpec } from './providers';

const writeLocks = new Map<string, Promise<void>>();
async function withFileLock<T>(file: string, action: () => Promise<T>) {
  const key = process.platform === 'win32' ? file.toLowerCase() : file;
  const previous = writeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeLocks.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (writeLocks.get(key) === current) writeLocks.delete(key);
  }
}

export function minimalEnv(): NodeJS.ProcessEnv {
  const allowed =
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|LANG|LC_.*|TERM|SHELL|USER|USERNAME|HOMEDRIVE|HOMEPATH|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS?_PROXY|NO_PROXY)$/i;
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => allowed.test(k)));
}
export async function within(root: string, relative: string, write = false): Promise<string> {
  if (relative.includes('\0') || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative))
    throw new Error('只接受项目内的相对路径');
  const canonical = await realpath(root);
  const target = path.resolve(canonical, relative);
  const rel = path.relative(canonical, target);
  if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel))
    throw new Error('路径超出项目范围');
  if (write && rel.split(path.sep).some((p) => p.toLowerCase() === '.git'))
    throw new Error('不允许直接写入 .git');
  let cursor = canonical;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('为避免越界，文件工具不跟随符号链接或目录联接');
    } catch (e: any) {
      if (e.code === 'ENOENT' && write) continue;
      throw e;
    }
  }
  return target;
}
export async function files(root: string, relative = ''): Promise<FileEntry[]> {
  const full = await within(root, relative);
  const entries = await readdir(full, { withFileTypes: true });
  return entries
    .filter((e) => !['.git', 'node_modules', '.DS_Store'].includes(e.name) && !e.isSymbolicLink())
    .sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
    )
    .slice(0, 500)
    .map((e) => ({ name: e.name, path: path.join(relative, e.name), directory: e.isDirectory() }));
}
export async function read(root: string, relative: string): Promise<string> {
  const full = await within(root, relative);
  const stat = await lstat(full);
  if (!stat.isFile() || stat.size > 500000) throw new Error('仅支持读取 500 KB 以内的文本文件');
  const content = await readFile(full, 'utf8');
  if (content.includes('\0')) throw new Error('此文件是二进制文件');
  return content;
}
export async function command(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeout = 120000,
  onOutput?: (text: string) => void,
): Promise<string> {
  const result = await commandResult(executable, args, cwd, signal, timeout, onOutput);
  if (result.status !== 'completed')
    throw new Error(result.status === 'cancelled' ? '执行已停止' : '命令执行超时');
  return `exit code: ${result.exitCode}\n${result.output}${result.truncated ? '\n[输出已截断]' : ''}`;
}
export interface CommandResult {
  commandId: string;
  cwd: string;
  exitCode: number | null;
  status: 'completed' | 'cancelled' | 'timeout';
  stdout: string;
  stderr: string;
  output: string;
  truncated: boolean;
  durationMs: number;
}
export const projectShell =
  process.platform === 'win32'
    ? 'Windows PowerShell 5.1（不支持 &&；工作目录已设置为项目目录；调用带引号的可执行路径用 &）'
    : '/bin/sh（工作目录已设置为项目目录）';

function projectCommandEnv() {
  const env = minimalEnv();
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const nodeRoot = path
    .dirname(require.resolve('node/package.json', { paths: [__dirname, process.cwd()] }))
    .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  const ownBin = path.join(path.dirname(nodeRoot), '.bin');
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const normalize = (p: string) =>
    process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  // npm injects this app's .bin in development. Its node.ps1 targets a placeholder
  // file on Windows, and must not shadow the user's working Node installation.
  const parts = (env[key] ?? '')
    .split(path.delimiter)
    .filter((p) => p && normalize(p) !== normalize(ownBin));
  env[key] = [...parts, path.join(nodeRoot, 'bin')].join(path.delimiter);
  return env;
}

function windowsCommand(script: string): string[] {
  // Parse the supplied script only after configuring UTF-8, including parse-error output.
  // Encode the user script to preserve Unicode and quotes without PowerShell's CLIXML host mode.
  const wrapper = `
$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ProgressPreference = 'SilentlyContinue'
try {
  & ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(script, 'utf16le').toString('base64')}'))))
  $tongzhouCommandSucceeded = $?
  if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }
  if (-not $tongzhouCommandSucceeded) { exit 1 }
} catch {
  [Console]::Error.WriteLine($_.ToString())
  exit 1
}
`;
  return ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-Command', wrapper];
}
export function commandResult(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeout = 120000,
  onOutput?: (text: string) => void,
  env: NodeJS.ProcessEnv = minimalEnv(),
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const commandId = randomUUID(),
      startedAt = Date.now();
    if (signal.aborted) {
      reject(new Error('已停止'));
      return;
    }
    const child = spawn(executable, args, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let output = '';
    let stdout = '',
      stderr = '',
      truncated = false;
    let reason = '';
    let settled = false;
    const terminate = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => child.kill());
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };
    const stop = () => {
      reason = '执行已停止';
      terminate();
    };
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => {
      reason = '命令执行超时';
      terminate();
    }, timeout);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    };
    const append = (text: string, errorStream: boolean) => {
      onOutput?.(text);
      if (
        output.length + text.length > 200000 ||
        (errorStream ? stderr : stdout).length + text.length > 100000
      )
        truncated = true;
      if (output.length < 200000) output += text.slice(0, 200000 - output.length);
      if (errorStream) stderr = (stderr + text).slice(0, 100000);
      else stdout = (stdout + text).slice(0, 100000);
    };
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      stream?.on('data', (b) => append(decoder.write(b), stream === child.stderr));
      stream?.on('end', () => append(decoder.end(), stream === child.stderr));
    }
    child.on('error', (e) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(e);
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve({
          commandId,
          cwd,
          exitCode: code,
          status: !reason ? 'completed' : reason === '执行已停止' ? 'cancelled' : 'timeout',
          stdout,
          stderr,
          output,
          truncated,
          durationMs: Date.now() - startedAt,
        });
      }
    });
  });
}
export const toolSpecs: ToolSpec[] = [
  {
    name: 'apply_edits',
    description:
      '按版本哈希批量精确替换多个文件。先校验整批内容并一次审批，再逐文件提交；中断或并发冲突时明确报告已应用的文件，不保证跨文件原子提交。',
    parameters: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              expectedHash: { type: 'string' },
              oldText: { type: 'string' },
              newText: { type: 'string' },
            },
            required: ['path', 'expectedHash', 'oldText', 'newText'],
            additionalProperties: false,
          },
        },
      },
      required: ['edits'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_files',
    description:
      '在项目文本文件中搜索关键词，返回相对路径、行号与内容。跳过依赖、构建目录和二进制文件；有界扫描。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        path: { type: 'string' },
        limit: { type: 'integer' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_range',
    description:
      '按行读取项目文件并返回 sha256。编辑已有文件时先取得完整文件版本哈希，再使用 apply_edit。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'integer' },
        endLine: { type: 'integer' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'apply_edit',
    description:
      '精确修改文件中的唯一文本片段。expectedHash 必须来自最近 read_range，旧文本需唯一匹配；文件变化则拒绝，写入需审批。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        expectedHash: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
      },
      required: ['path', 'expectedHash', 'oldText', 'newText'],
      additionalProperties: false,
    },
  },
  {
    name: 'project_instructions',
    description:
      '读取项目已有 agent.md / AGENTS.md 说明及初始化所需的 README 和脚本清单。生成说明前先调用，不覆盖已有文件。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_files',
    description: '列出项目相对目录中的文件，不跟随符号链接。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_file',
    description: '读取项目内文本文件，返回内容。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    description: '创建或覆盖项目内文本文件，需要用户审批；先读取原文件。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_command',
    description: `在项目目录执行 shell 命令，每次必须经过用户审批。当前 shell：${projectShell}。`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 1800000 },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
];
export const readOnlyToolSpecs = toolSpecs.filter((t) =>
  ['list_files', 'read_file', 'read_range', 'search_files', 'project_instructions'].includes(
    t.name,
  ),
);
export const fileHash = (content: string) => createHash('sha256').update(content).digest('hex');

export async function projectInstructions(root: string) {
  const names = await files(root);
  const wanted = names.filter(
    (f) =>
      /^(agents?\.md|readme\.md|package\.json|pyproject\.toml|cargo\.toml)$/i.test(f.name) &&
      !f.directory,
  );
  const result: { path: string; content: string }[] = [];
  for (const f of wanted)
    result.push({ path: f.path, content: (await read(root, f.path)).slice(0, 24000) });
  return result;
}

async function searchProject(
  root: string,
  relative: string,
  query: string,
  limit: number,
  signal: AbortSignal,
) {
  await within(root, relative);
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const binary = require
    .resolve(
      `@vscode/ripgrep-${process.platform}-${process.arch}/bin/${process.platform === 'win32' ? 'rg.exe' : 'rg'}`,
      { paths: [__dirname, process.cwd()] },
    )
    .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  const result = await commandResult(
    binary,
    [
      '--json',
      '--fixed-strings',
      '--ignore-case',
      '--hidden',
      '--no-require-git',
      '--max-count',
      String(limit),
      '--max-filesize',
      '500K',
      '-g',
      '!.git/**',
      '-g',
      '!node_modules/**',
      '-g',
      '!.env*',
      '-g',
      '!auth.json',
      '-g',
      '!credentials*',
      '-g',
      '!*.{pem,key,db,sqlite,lock}',
      '--',
      query,
      relative || '.',
    ],
    root,
    signal,
    15000,
  );
  if (result.status !== 'completed') throw new Error('搜索已停止或超时');
  if (result.exitCode !== 0 && result.exitCode !== 1)
    throw new Error('项目搜索失败：' + result.stderr.slice(0, 500));
  const found: { path: string; line: number; text: string }[] = [];
  let scannedFiles = 0;
  for (const line of result.stdout.split('\n')) {
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type === 'begin') scannedFiles++;
    if (record.type === 'match' && record.data.path.text && found.length < limit)
      found.push({
        path: record.data.path.text.replace(/^\.([/\\])/, ''),
        line: record.data.line_number,
        text: record.data.lines.text.trimEnd().slice(0, 1000),
      });
  }
  return {
    matches: found,
    scanned: scannedFiles,
    truncated: result.truncated || found.length >= limit,
  };
}
export async function executeTool(
  name: string,
  raw: string,
  root: string,
  permission: 'read-only' | 'ask',
  signal: AbortSignal,
  approve: (title: string, detail: string) => Promise<boolean>,
  onOutput?: (text: string) => void,
): Promise<string> {
  if (signal.aborted) throw new Error('已停止');
  const args = JSON.parse(raw);
  if (name === 'search_files') {
    const a = z
      .object({
        query: z.string().min(1).max(500),
        path: z.string().max(1000).default(''),
        limit: z.number().int().min(1).max(200).default(60),
      })
      .parse(args);
    return JSON.stringify(await searchProject(root, a.path, a.query, a.limit, signal));
  }
  if (name === 'project_instructions') return JSON.stringify(await projectInstructions(root));
  if (name === 'read_range') {
    const a = z
      .object({
        path: z.string().max(1000),
        startLine: z.number().int().min(1).default(1),
        endLine: z.number().int().min(1).optional(),
      })
      .parse(args);
    const content = await read(root, a.path);
    const lines = content.split(/\r?\n/);
    const end = Math.min(a.endLine ?? a.startLine + 249, a.startLine + 499, lines.length);
    return JSON.stringify({
      path: a.path,
      sha256: fileHash(content),
      totalLines: lines.length,
      startLine: a.startLine,
      endLine: end,
      content: lines
        .slice(a.startLine - 1, end)
        .map((l, i) => `${a.startLine + i}: ${l}`)
        .join('\n'),
    });
  }
  if (name === 'list_files')
    return JSON.stringify(
      await files(root, z.object({ path: z.string().max(1000) }).parse(args).path),
    );
  if (name === 'read_file')
    return read(root, z.object({ path: z.string().max(1000) }).parse(args).path);
  if (permission === 'read-only') throw new Error('此 Agent 只有只读权限');
  if (name === 'apply_edits') {
    const { edits } = z
      .object({
        edits: z
          .array(
            z.object({
              path: z.string().min(1).max(1000),
              expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
              oldText: z.string().min(1).max(500000),
              newText: z.string().max(500000),
            }),
          )
          .min(1)
          .max(20),
      })
      .parse(args);
    if (
      new Set(edits.map((e) => (process.platform === 'win32' ? e.path.toLowerCase() : e.path)))
        .size !== edits.length
    )
      throw new Error('批量修改每个文件只能出现一次');
    if (JSON.stringify(edits).length > 500000) throw new Error('批量修改超过 500 KB，请拆分');
    for (const edit of edits) {
      const before = await read(root, edit.path);
      if (fileHash(before) !== edit.expectedHash || before.split(edit.oldText).length !== 2)
        throw new Error(`${edit.path} 版本或上下文不匹配，整批未执行`);
    }
    if (
      !(await approve(
        '批量修改 ' + edits.length + ' 个文件',
        edits.map((e) => `${e.path}\n旧文本：\n${e.oldText}\n新文本：\n${e.newText}`).join('\n\n'),
      ))
    )
      return '用户拒绝了批量修改，未执行。';
    const applied: string[] = [];
    try {
      for (const edit of edits) {
        signal.throwIfAborted();
        await executeTool(
          'apply_edit',
          JSON.stringify(edit),
          root,
          permission,
          signal,
          async () => true,
        );
        applied.push(edit.path);
      }
    } catch (error) {
      throw new Error(
        `批量修改中断；已应用：${applied.join(', ') || '无'}。其余文件未执行。${String(error)}`,
      );
    }
    return JSON.stringify({ applied });
  }
  if (name === 'apply_edit') {
    const a = z
      .object({
        path: z.string().min(1).max(1000),
        expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
        oldText: z.string().min(1).max(500000),
        newText: z.string().max(500000),
      })
      .parse(args);
    const before = await read(root, a.path);
    if (fileHash(before) !== a.expectedHash) throw new Error('文件已变化，请重新读取后修改');
    if (before.split(a.oldText).length !== 2) throw new Error('旧文本必须在文件中唯一匹配');
    const content = before.replace(a.oldText, () => a.newText);
    return executeTool(
      'write_file',
      JSON.stringify({ path: a.path, content, expectedHash: a.expectedHash }),
      root,
      permission,
      signal,
      approve,
    );
  }
  if (name === 'write_file') {
    const {
      path: relative,
      content,
      expectedHash,
    } = z
      .object({
        path: z.string().min(1).max(1000),
        content: z.string().max(500000),
        expectedHash: z.string().optional(),
      })
      .parse(args);
    let target = await within(root, relative, true);
    return withFileLock(target, async () => {
      signal.throwIfAborted();
      let before = '';
      try {
        before = await read(root, relative);
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (expectedHash && fileHash(before) !== expectedHash)
        throw new Error('文件已变化，请重新读取后修改');
      if (!(await approve(`写入 ${relative}`, `原内容：\n${before}\n\n新内容：\n${content}`)))
        return '用户拒绝了文件写入。';
      if (signal.aborted) throw new Error('已停止');
      target = await within(root, relative, true);
      let current = '';
      try {
        current = await read(root, relative);
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (current !== before) throw new Error('审批期间文件发生变化，请重新读取再修改。');
      await mkdir(path.dirname(target), { recursive: true });
      const temp = target + `.tongzhou-${randomUUID()}.tmp`;
      try {
        await writeFile(temp, content, { flag: 'wx' });
        const mode = await lstat(target)
          .then((s) => s.mode)
          .catch((e) => {
            if (e.code !== 'ENOENT') throw e;
            return undefined;
          });
        if (mode !== undefined) await chmod(temp, mode);
        await rename(temp, target);
      } finally {
        await rm(temp, { force: true });
      }
      return `已写入 ${relative} (${Buffer.byteLength(content)} bytes)`;
    });
  }
  if (name === 'run_command') {
    const { command: cmd, timeoutMs } = z
      .object({
        command: z.string().trim().min(1).max(16000),
        timeoutMs: z.number().int().min(1000).max(1800000).default(120000),
      })
      .parse(args);
    if (
      !(await approve(
        '执行终端命令',
        `工作目录：${root}\n\n${cmd}\n\n此命令以你的系统用户权限运行，可能访问项目外文件和网络。`,
      ))
    )
      return '用户拒绝了命令执行。';
    const result =
      process.platform === 'win32'
        ? await commandResult(
            'powershell.exe',
            windowsCommand(cmd),
            root,
            signal,
            timeoutMs,
            onOutput,
            projectCommandEnv(),
          )
        : await commandResult(
            '/bin/sh',
            ['-c', cmd],
            root,
            signal,
            timeoutMs,
            onOutput,
            projectCommandEnv(),
          );
    return JSON.stringify(result);
  }
  throw new Error('未知工具：' + name);
}
