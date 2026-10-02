import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FileEntry } from '../src/shared/types';
import type { ToolSpec } from './providers';

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
export function command(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeout = 120000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('已停止'));
      return;
    }
    const child = spawn(executable, args, {
      cwd,
      env: minimalEnv(),
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
    });
    let output = '';
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
    const append = (b: Buffer) => {
      if (output.length < 200000) output += b.toString().slice(0, 200000 - output.length);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
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
        if (reason) reject(new Error(reason));
        else
          resolve(
            `exit code: ${code}\n${output}${output.length >= 200000 ? '\n[输出已截断]' : ''}`,
          );
      }
    });
  });
}
export const toolSpecs: ToolSpec[] = [
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
    description:
      '在项目目录执行 shell 命令，每次必须经过用户审批。Windows 使用 PowerShell，macOS 使用 /bin/sh。',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
];
export async function executeTool(
  name: string,
  raw: string,
  root: string,
  permission: 'read-only' | 'ask',
  signal: AbortSignal,
  approve: (title: string, detail: string) => Promise<boolean>,
): Promise<string> {
  if (signal.aborted) throw new Error('已停止');
  const args = JSON.parse(raw);
  if (name === 'list_files')
    return JSON.stringify(
      await files(root, z.object({ path: z.string().max(1000) }).parse(args).path),
    );
  if (name === 'read_file')
    return read(root, z.object({ path: z.string().max(1000) }).parse(args).path);
  if (permission === 'read-only') throw new Error('此 Agent 只有只读权限');
  if (name === 'write_file') {
    const { path: relative, content } = z
      .object({ path: z.string().min(1).max(1000), content: z.string().max(500000) })
      .parse(args);
    let target = await within(root, relative, true);
    let before = '';
    try {
      before = await read(root, relative);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
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
    await writeFile(temp, content, { flag: 'wx' });
    await rename(temp, target);
    return `已写入 ${relative} (${Buffer.byteLength(content)} bytes)`;
  }
  if (name === 'run_command') {
    const { command: cmd } = z.object({ command: z.string().trim().min(1).max(16000) }).parse(args);
    if (
      !(await approve(
        '执行终端命令',
        `工作目录：${root}\n\n${cmd}\n\n此命令以你的系统用户权限运行，可能访问项目外文件和网络。`,
      ))
    )
      return '用户拒绝了命令执行。';
    return process.platform === 'win32'
      ? command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], root, signal)
      : command('/bin/sh', ['-c', cmd], root, signal);
  }
  throw new Error('未知工具：' + name);
}
