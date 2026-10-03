import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../electron/store';
import { Channels } from '../electron/channels';
import { Bots } from '../electron/bots';
import { Worktrees } from '../electron/worktrees';
const cleanup: (() => any)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});
function store() {
  const s = new Store(':memory:', {
    encrypt: (v) => Buffer.from(v).toString('base64'),
    decrypt: (v) => Buffer.from(v, 'base64').toString(),
  });
  cleanup.push(() => s.close());
  return s;
}
const mail = {
  id: 'mail',
  name: '测试邮件',
  kind: 'email',
  enabled: true,
  password: 'fixture-password',
  smtp: {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    user: 'me@example.com',
    from: 'me@example.com',
    to: ['you@example.com'],
    subject: '测试',
  },
};
describe('notification targets and lifecycle rules', () => {
  it('encrypts SMTP secrets, requires TLS and distinguishes verify from send', async () => {
    const s = store(),
      sendMail = vi.fn(async () => ({ accepted: ['you@example.com'], rejected: [] })),
      verify = vi.fn(async () => true),
      close = vi.fn();
    const factory = vi.fn(() => ({ sendMail, verify, close }));
    const c = new Channels(s, () => {}, fetch, factory as any);
    cleanup.push(() => c.dispose());
    c.save(mail);
    expect(JSON.stringify(s.list('channel'))).not.toContain('fixture-password');
    expect(s.secret('channel_mail_mail')).toBe('fixture-password');
    await c.testEmail('mail');
    expect(verify).toHaveBeenCalledOnce();
    expect(sendMail).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        requireTLS: true,
        secure: false,
        auth: { user: 'me@example.com', pass: 'fixture-password' },
        disableFileAccess: true,
      }),
    );
    expect((await c.send('mail', 'hello', undefined, 'unique')).status).toBe('sent');
    await c.send('mail', 'hello', undefined, 'unique');
    expect(sendMail).toHaveBeenCalledOnce();
    expect(() =>
      c.save({ ...mail, password: '', smtp: { ...mail.smtp, host: 'different.example.com' } }),
    ).toThrow('授权码');
  });
  it('filters end-of-turn hooks by project/model/duration and consumes one-shot before SMTP dispatch', async () => {
    const s = store();
    s.put('project', { id: 'project', name: 'p', path: 'fixture', createdAt: 1 });
    const session = s.createSession('project');
    const sendMail = vi.fn(async () => {
      expect(s.get<any>('notificationRule', 'rule').enabled).toBe(false);
      throw new Error('timeout private account');
    });
    const c = new Channels(s, () => {}, fetch, (() => ({ sendMail, close() {} })) as any);
    cleanup.push(() => c.dispose());
    c.save(mail);
    c.saveRule({
      id: 'rule',
      channelId: 'mail',
      sessionId: session.id,
      projectId: 'project',
      models: ['model'],
      minDurationSeconds: 10,
      once: true,
      enabled: true,
      events: ['ended'],
      template: '{title} {status}',
    });
    const r: any = {
      id: 'run',
      sessionId: session.id,
      model: 'other',
      startedAt: 1000,
      endedAt: 21000,
    };
    await c.notify(r, 'completed');
    expect(sendMail).not.toHaveBeenCalled();
    r.model = 'model';
    r.endedAt = 5000;
    await c.notify(r, 'completed');
    expect(sendMail).not.toHaveBeenCalled();
    r.endedAt = 21000;
    await Promise.all([c.notify(r, 'interrupted'), c.notify(r, 'interrupted')]);
    expect(sendMail).toHaveBeenCalledOnce();
    expect(s.list<any>('delivery')[0].status).toBe('unknown');
    expect(JSON.stringify(s.list('delivery'))).not.toContain('private account');
  });
});
describe('remote bots', () => {
  function setup() {
    const s = store(),
      first = s.createSession(),
      second = s.createSession();
    for (const a of [first, second]) s.put('session', { ...a, model: 'model' });
    const runtime: any = {
      changed: vi.fn(),
      enqueue: vi.fn(async () => {}),
      cancel: vi.fn(),
      snapshot: () => ({ approvals: [] }),
    };
    const b = new Bots(s, runtime, (() => ({ close() {} })) as any);
    cleanup.push(() => b.dispose());
    const config = {
      id: 'b',
      name: 'bot',
      kind: 'feishu',
      appId: 'app',
      secret: 'private-bot-secret',
      enabled: true,
      allowedSenders: ['alice', 'bob'],
      allowedChats: ['group'],
      allSessions: false,
      sessionIds: [first.id],
      allowExecute: false,
    };
    b.save(config);
    return { s, b, runtime, config, first, second };
  }
  const message = (
    id: string,
    text: string,
    sender = 'alice',
    chat = 'private',
    group = false,
  ) => ({ id, text, sender, chat, group });
  it('rejects unknown identities/groups, limits progress visibility and defaults to read-only', async () => {
    const { b, runtime, first, second } = setup();
    expect(await b.receive('b', message('1', '/sessions', 'outsider'))).toBeUndefined();
    expect(await b.receive('b', message('2', '/sessions', 'alice', 'other', true))).toBeUndefined();
    const result = await b.receive('b', message('3', '/sessions'));
    expect(result).toContain(first.id.slice(0, 8));
    expect(result).not.toContain(second.id.slice(0, 8));
    expect(await b.receive('b', message('4', '/status ' + second.id))).toContain('请先');
    expect(await b.receive('b', message('5', '/run hello'))).toContain('仅允许查看');
    expect(runtime.enqueue).not.toHaveBeenCalled();
    expect(JSON.stringify(b.list())).not.toContain('private-bot-secret');
  });
  it('deduplicates commands and isolates each sender and conversation binding', async () => {
    const { b, runtime, config, first, second } = setup();
    b.save({ ...config, allowExecute: true, sessionIds: [first.id, second.id] });
    await b.receive('b', message('u1', '/use ' + first.id));
    await b.receive('b', message('u2', '/use ' + second.id, 'bob'));
    await Promise.all([
      b.receive('b', message('run1', '/run first')),
      b.receive('b', message('run1', '/run first')),
    ]);
    await b.receive('b', message('run2', '/run second', 'bob'));
    expect(runtime.enqueue).toHaveBeenCalledTimes(2);
    expect(runtime.enqueue.mock.calls[0][0].sessionId).toBe(first.id);
    expect(runtime.enqueue.mock.calls[1][0].sessionId).toBe(second.id);
    expect(
      await b.receive('b', message('run3', '/run should not run', 'alice', 'group', true)),
    ).toContain('请先');
    expect(runtime.enqueue).toHaveBeenCalledTimes(2);
    b.save({ ...config, enabled: false });
    expect(await b.receive('b', message('disabled', '/sessions'))).toBeUndefined();
  });
  it('invalidates saved credentials when bot identity changes', () => {
    const { b, config } = setup();
    expect(() => b.save({ ...config, appId: 'other', secret: '' })).toThrow('密钥');
  });
});
describe('managed Git worktrees', () => {
  it('keeps primary changes, creates isolated branches, guards removal and preserves session history', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tongzhou-worktrees-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const git = async (cwd: string, args: string[]) =>
      (await promisify(execFile)('git', args, { cwd, windowsHide: true })).stdout;
    await git(dir, ['init', '-b', 'main']);
    await git(dir, ['config', 'user.email', 'test@example.com']);
    await git(dir, ['config', 'user.name', 'Fixture']);
    await writeFile(path.join(dir, 'tracked.txt'), 'original');
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-m', 'initial']);
    const s = store();
    s.put('project', { id: 'root', name: 'repo', path: dir, createdAt: 1 });
    const w = new Worktrees(s, path.join(dir, 'app-data'), () => {});
    await writeFile(path.join(dir, 'tracked.txt'), 'primary dirty');
    const p = await w.create('root', 'feature/test', 'HEAD');
    expect(await readFile(path.join(p.path, 'tracked.txt'), 'utf8')).toBe('original');
    expect(await readFile(path.join(dir, 'tracked.txt'), 'utf8')).toBe('primary dirty');
    expect((await w.list('root')).find((x) => x.projectId === p.id)).toMatchObject({
      managed: true,
      main: false,
      dirty: false,
    });
    await expect(w.remove('root')).rejects.toThrow('同舟创建');
    await writeFile(path.join(p.path, 'untracked'), 'retain');
    await expect(w.remove(p.id)).rejects.toThrow('未跟踪');
    await rm(path.join(p.path, 'untracked'));
    const session = s.createSession(p.id);
    s.put('run', { id: 'running', sessionId: session.id, status: 'running' });
    await expect(w.remove(p.id)).rejects.toThrow('运行中');
    s.remove('run', 'running');
    await writeFile(path.join(p.path, 'tracked.txt'), 'commit');
    await git(p.path, ['add', '.']);
    await git(p.path, ['commit', '-m', 'local change']);
    await expect(w.remove(p.id)).rejects.toThrow('尚未推送');
    // A local bare remote exercises real push/ref behavior without contacting any account.
    const remote = path.join(dir, 'fixture-remote.git');
    await git(dir, ['init', '--bare', remote]);
    await git(dir, ['remote', 'add', 'origin', remote]);
    await git(p.path, ['push', '-u', 'origin', 'feature/test']);
    await w.remove(p.id);
    expect(s.get<any>('session', session.id).archived).toBe(true);
    expect(s.get<any>('project', p.id).removed).toBe(true);
    expect(() => s.createSession(p.id)).toThrow('已移除');
    expect((await git(dir, ['branch', '--list', 'feature/test'])).trim()).toContain('feature/test');
  }, 30000);
});
