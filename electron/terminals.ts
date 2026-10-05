import { fork, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { sessionWorkspace } from './session-workspace';
import { z } from 'zod';
import { projectCommandEnv } from './workspace';
import type { Store } from './store';
import type { ToolScope } from './extensions';
import type { Project, Session } from '../src/shared/types';
import type { TerminalRecord } from '../src/shared/task';

export class Terminals {
  private disposed = false;
  private active = new Map<
    string,
    { child: ChildProcess; record: TerminalRecord; timer?: NodeJS.Timeout }
  >();
  constructor(
    private store: Store,
    private changed: () => void,
    private dataDir: string,
    private host = path
      .join(__dirname, 'terminal-host.cjs')
      .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep),
  ) {
    for (const t of store.list<TerminalRecord>('terminal'))
      if (t.status === 'running')
        store.put('terminal', { ...t, status: 'interrupted', endedAt: Date.now() });
  }
  list(sessionId: string) {
    this.store.get('session', sessionId);
    return this.store
      .sessionObjects<TerminalRecord>('terminal', sessionId, 50)
      .map((t) => this.active.get(t.id)?.record ?? t);
  }
  cwd(sessionId: string) {
    return sessionWorkspace(this.store, this.dataDir, sessionId);
  }
  private owned(sessionId: string, id: string) {
    const record = this.active.get(id)?.record ?? this.store.get<TerminalRecord>('terminal', id);
    if (record.sessionId !== sessionId) throw new Error('终端不属于当前会话');
    return record;
  }
  async start(sessionId: string, title = '终端', command = '') {
    if (this.disposed) throw new Error('客户端正在退出');
    const session = this.store.get<Session>('session', sessionId);
    if (session.archived) throw new Error('请先恢复已归档的会话');
    if (session.knowledgeJob) throw new Error('知识整理任务不使用终端，请在普通会话中打开');
    const project = session.projectId
      ? this.store.get<Project>('project', session.projectId)
      : undefined;
    if (project?.removed) throw new Error('项目已移除');
    const cwd = this.cwd(sessionId);
    if (!project) await mkdir(cwd, { recursive: true });
    if (
      this.active.size >= 12 ||
      [...this.active.values()].filter((t) => t.record.sessionId === sessionId).length >= 4
    )
      throw new Error('请先停止不再使用的终端（每会话最多 4 个）');
    const require = createRequire(path.join(process.cwd(), 'package.json'));
    const root = path
      .dirname(require.resolve('node/package.json', { paths: [__dirname, process.cwd()] }))
      .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    const execPath = path.join(root, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
    const child = fork(this.host, [], {
      execPath,
      windowsHide: true,
      env: projectCommandEnv(),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const record: TerminalRecord = {
      id: randomUUID(),
      sessionId,
      projectId: project?.id,
      cwd,
      title: title.slice(0, 80),
      status: 'running',
      startedAt: Date.now(),
      output: '',
      offset: 0,
    };
    const entry = { child, record, timer: undefined as NodeJS.Timeout | undefined };
    this.active.set(record.id, entry);
    this.store.put('terminal', record);
    const finish = (code?: number) => {
      if (!this.active.has(record.id)) return;
      clearTimeout(entry.timer);
      record.status = 'exited';
      record.exitCode = code;
      record.endedAt = Date.now();
      this.store.put('terminal', record);
      this.active.delete(record.id);
      this.changed();
    };
    const append = (data: string) => {
      if (this.disposed || !this.active.has(record.id)) return;
      record.output += data;
      const excess = Math.max(0, record.output.length - 500000);
      if (excess) {
        record.output = record.output.slice(excess);
        record.offset += excess;
      }
      if (!entry.timer)
        entry.timer = setTimeout(() => {
          entry.timer = undefined;
          this.store.put('terminal', record);
        }, 1000);
    };
    child.stderr?.on('data', (b) => append(String(b)));
    child.on('exit', (code) => finish(code ?? undefined));
    child.on('error', (e) => {
      append('\r\n' + e.message);
      finish();
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('终端启动超时'));
      }, 15000);
      child.on('message', (m: any) => {
        if (m.type === 'ready') {
          clearTimeout(timer);
          if (command) child.send({ type: 'write', data: command + '\r' });
          resolve();
        }
        if (m.type === 'data') append(m.data);
        if (m.type === 'exit') finish(m.code);
        if (m.type === 'error') {
          clearTimeout(timer);
          append(m.error);
          child.kill();
          reject(new Error(m.error));
        }
      });
      child.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('终端未能启动'));
      });
      child.send({
        type: 'start',
        cwd,
        env: projectCommandEnv(),
        shell: process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/sh',
        args: process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : ['-i'],
      });
    });
    this.changed();
    return record;
  }
  read(sessionId: string, id: string, offset = 0) {
    const t = this.owned(sessionId, id);
    const start = Math.max(t.offset, offset);
    return {
      ...t,
      output: t.output.slice(start - t.offset, start - t.offset + 64000),
      offset: start,
      nextOffset: Math.min(t.offset + t.output.length, start + 64000),
    };
  }
  write(sessionId: string, id: string, data: string) {
    this.owned(sessionId, id);
    const entry = this.active.get(id);
    if (!entry?.child.connected) throw new Error('终端已经结束');
    entry.child.send({ type: 'write', data });
  }
  resize(sessionId: string, id: string, cols: number, rows: number) {
    this.owned(sessionId, id);
    this.active.get(id)?.child.send({ type: 'resize', cols, rows });
  }
  stop(sessionId: string, id: string) {
    this.owned(sessionId, id);
    const child = this.active.get(id)?.child;
    if (child?.connected) child.send({ type: 'stop' });
  }
  stopAll() {
    for (const t of this.active.values()) if (t.child.connected) t.child.send({ type: 'stop' });
  }
  stopSession(sessionId: string) {
    for (const t of this.active.values())
      if (t.record.sessionId === sessionId) {
        clearTimeout(t.timer);
        this.stop(sessionId, t.record.id);
        this.active.delete(t.record.id);
      }
  }
  dispose() {
    this.disposed = true;
    for (const t of this.active.values()) {
      clearTimeout(t.timer);
      if (t.child.connected) t.child.send({ type: 'stop' });
      t.record.status = 'interrupted';
      this.store.put('terminal', t.record);
    }
    this.active.clear();
  }
  attach(scope: ToolScope, sessionId: string, readOnly: boolean) {
    scope.add(
      {
        name: 'terminal_read',
        description:
          '读取本会话持久终端日志。无 id 列出终端；offset 从上次 nextOffset 继续。运行中只代表进程存在，不代表验证通过。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 } },
          additionalProperties: false,
        },
      },
      '读取终端',
      async (raw) => {
        const p = z
          .object({ id: z.string().optional(), offset: z.number().int().min(0).default(0) })
          .parse(raw);
        return {
          text: JSON.stringify(
            p.id
              ? this.read(sessionId, p.id, p.offset)
              : this.list(sessionId).map(({ output, ...t }) => t),
          ),
        };
      },
      false,
    );
    if (readOnly) return;
    scope.add(
      {
        name: 'terminal_start',
        description:
          '启动持久交互终端并执行命令，适合开发服务器或需要输入的命令。跨轮次保留；必须随后 terminal_read 验证。验证测试优先用 run_command 获取退出码。',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' }, title: { type: 'string' } },
          required: ['command'],
          additionalProperties: false,
        },
      },
      '启动持久终端',
      async (raw) => {
        const p = z
          .object({
            command: z.string().min(1).max(16000),
            title: z.string().max(80).default('开发终端'),
          })
          .parse(raw);
        const { output, ...t } = await this.start(sessionId, p.title, p.command);
        return { text: JSON.stringify(t) };
      },
      true,
    );
    scope.add(
      {
        name: 'terminal_write',
        description:
          '向本会话终端输入文字或控制键。回车用 \r，Ctrl+C 用 \u0003。随后读取日志验证。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' }, data: { type: 'string' } },
          required: ['id', 'data'],
          additionalProperties: false,
        },
      },
      '终端输入',
      async (raw) => {
        const p = z.object({ id: z.string(), data: z.string().max(16000) }).parse(raw);
        this.write(sessionId, p.id, p.data);
        return { text: '输入已送交终端，请读取结果。' };
      },
      true,
    );
    scope.add(
      {
        name: 'terminal_stop',
        description: '停止指定持久终端及其任务。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      '停止终端',
      async (raw) => {
        const p = z.object({ id: z.string() }).parse(raw);
        this.stop(sessionId, p.id);
        return { text: '已请求停止，请读取终态。' };
      },
      true,
    );
  }
}
