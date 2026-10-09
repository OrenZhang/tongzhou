import { authorizeKnowledgeFixtures } from '../../support/knowledge-fixture';
import { DatabaseSync } from 'node:sqlite';
import { unzipSync } from 'fflate';
import {
  DataMaintenance,
  decryptBackup,
} from '../../../electron/services/storage/data-maintenance';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../../../electron/services/storage/store';
import { Knowledge } from '../../../electron/modules/knowledge/knowledge';
import { ContentWorkspace } from '../../../electron/modules/content/content';
import {
  Automations,
  nextSchedule,
  scheduleSchema,
} from '../../../electron/modules/automation/automations';
import {
  MEMORY_AUTOMATION_ID,
  type AutomationJob,
  type AutomationRule,
} from '../../../src/shared/automation';
import type { Run, RunInput, Session } from '../../../src/shared/types';
import type {
  MemoryCandidate,
  MemoryJob,
} from '../../../electron/modules/knowledge/knowledge-memory';
import { ClientCommands } from '../../../electron/core/tools/client-commands';
import { registerAutomationServices } from '../../../electron/modules/automation/automation-services';
import { ToolScope } from '../../../electron/core/tools/extensions';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function fixture(autoCollect = true) {
  const root = mkdtempSync(path.join(tmpdir(), 'tongzhou-auto-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:', { encrypt: (s) => s, decrypt: (s) => s });
  cleanup.push(() => store.close());
  const knowledge = new Knowledge(store, root),
    content = new ContentWorkspace(store, knowledge);
  knowledge.configure({ autoCollect });
  store.saveProvider({
    id: 'test',
    name: 'Test',
    protocol: 'openai-chat',
    baseUrl: 'http://localhost/v1',
    auth: 'none',
    models: ['fixture'],
    enabled: true,
    maxOutputTokens: 1000,
    contextChars: 50000,
  });
  let now = Date.parse('2026-10-07T00:00:00Z');
  const runtime = {
    store,
    knowledge,
    content,
    changed: vi.fn(),
    cancel: vi.fn(async () => {}),
    start: vi.fn((input: RunInput) => {
      const id = crypto.randomUUID();
      store.put('run', {
        id,
        sessionId: input.sessionId,
        providerId: input.providerId,
        model: input.model,
        status: 'running',
        startedAt: now,
      });
      return id;
    }),
  };
  const a = new Automations(store, runtime, () => now);
  const services = { ...runtime, automations: a };
  const flow = a.saveFlow({
    name: '摘要',
    prompt: '提取要点',
    providerId: 'test',
    model: 'fixture',
  });
  const doc = content.write({ libraryId: 'default', title: '资料', content: '内容一' });
  authorizeKnowledgeFixtures(knowledge, doc);
  const rule = (patch: Partial<AutomationRule> = {}) =>
    a.save({
      name: '自动整理',
      enabled: true,
      kind: 'content',
      trigger: 'manual',
      flowId: flow.id,
      libraryId: 'default',
      permission: 'read-only',
      missed: 'once',
      ...patch,
    });
  const complete = (job: AutomationJob, text = '生成摘要') => {
    const run = store.get<Run>('run', job.runId!);
    store.put('run', { ...run, status: 'completed' });
    store.message({
      id: crypto.randomUUID(),
      sessionId: job.sessionId!,
      runId: job.runId,
      role: 'assistant',
      content: text,
      status: 'complete',
      createdAt: now,
    });
  };
  return {
    root,
    store,
    runtime: services,
    a,
    flow,
    doc,
    content,
    knowledge,
    rule,
    complete,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    jobs: () => store.list<AutomationJob>('automationJob'),
  };
}
describe('automation scheduling', () => {
  it('calculates daily, weekly, once and interval in saved timezones', () => {
    const daily = {
      kind: 'daily' as const,
      time: '09:00',
      timezone: 'Asia/Shanghai',
      weekdays: [1],
    };
    expect(nextSchedule(daily, Date.parse('2026-10-07T00:00Z'))).toBe(
      Date.parse('2026-10-07T01:00Z'),
    );
    expect(
      nextSchedule({ ...daily, kind: 'weekly', weekdays: [1] }, Date.parse('2026-10-07T00:00Z')),
    ).toBe(Date.parse('2026-10-12T01:00Z'));
    expect(nextSchedule({ kind: 'once', at: 100 }, 101)).toBeUndefined();
    expect(nextSchedule({ kind: 'interval', minutes: 5 }, 100)).toBe(300100);
    expect(() => scheduleSchema.parse({ ...daily, timezone: 'Not/AZone' })).toThrow();
  });
  it('skips nonexistent DST time and avoids repeating a folded wall-clock occurrence', () => {
    const s = {
      kind: 'daily' as const,
      time: '02:30',
      timezone: 'America/New_York',
      weekdays: [1],
    };
    expect(nextSchedule(s, Date.parse('2026-03-08T05:00Z'))).toBe(Date.parse('2026-03-09T06:30Z'));
    expect(nextSchedule({ ...s, time: '01:30' }, Date.parse('2026-11-01T05:30Z'))).toBe(
      Date.parse('2026-11-02T06:30Z'),
    );
    expect(
      nextSchedule(
        { ...s, time: '01:30' },
        Date.parse('2026-11-01T06:20Z'),
        Date.parse('2026-11-01T05:30Z'),
      ),
    ).toBe(Date.parse('2026-11-02T06:30Z'));
  });
  it('coalesces missed intervals, persists next execution, pauses and skips missed schedules', () => {
    const f = fixture(),
      r = f.rule({ trigger: 'schedule', schedule: { kind: 'interval', minutes: 5 } });
    f.advance(3600000);
    f.a.tick();
    expect(f.jobs()).toHaveLength(1);
    expect(f.jobs()[0].status).toBe('running');
    f.a.tick();
    expect(f.jobs()).toHaveLength(1);
    const current = f.store.get<AutomationRule>('automation', r.id);
    expect(current.nextRunAt).toBe(f.now() + 300000);
    f.a.save({ ...current, enabled: false });
    f.advance(3600000);
    f.a.tick();
    expect(f.jobs()).toHaveLength(1);
    const skip = f.rule({
      trigger: 'schedule',
      missed: 'skip',
      schedule: { kind: 'once', at: f.now() + 1000 },
    });
    f.advance(120000);
    f.a.tick();
    expect(f.jobs().some((j) => j.rule.id === skip.id)).toBe(false);
    expect(f.store.get<AutomationRule>('automation', skip.id).enabled).toBe(false);
  });
});
describe('content workflow execution', () => {
  it('blocks archived source events and rechecks queued snapshots before model execution', () => {
    const f = fixture();
    const rule = f.rule({ trigger: 'ready' });
    f.a.event('ready', f.doc.id);
    expect(f.jobs()).toHaveLength(1);
    f.knowledge.documents.put({ ...f.knowledge.get(f.doc.id), status: 'archived' });
    f.a.tick();
    expect(f.runtime.start).not.toHaveBeenCalled();
    expect(f.jobs()[0].status).toBe('failed');
    f.a.event('ready', f.doc.id);
    expect(f.jobs()).toHaveLength(1);
    expect(() => f.a.run(rule.id)).toThrow('没有可处理');
  });
  it('deduplicates events per version, pins flow and input, saves one draft with the actual source version', () => {
    const f = fixture();
    f.rule({ trigger: 'ready' });
    f.a.event('ready', f.doc.id);
    f.a.event('ready', f.doc.id);
    expect(f.jobs()).toHaveLength(1);
    f.a.saveFlow({ ...f.flow, prompt: '新的指令' });
    f.content.write({
      id: f.doc.id,
      version: 1,
      libraryId: 'default',
      title: '资料',
      content: '内容二',
    });
    f.a.tick();
    const j = f.jobs()[0];
    expect(j.flow?.prompt).toBe('提取要点');
    expect(j.source?.version).toBe(1);
    expect(vi.mocked(f.runtime.start).mock.calls[0][0].prompt).toContain('内容一');
    expect(f.store.get<any>('session', j.sessionId!).permission).toBe('read-only');
    f.complete(j);
    f.a.tick();
    f.a.tick();
    const result = f.knowledge.get(j.id);
    expect(result.status).toBe('draft');
    expect(result.sources[0].version).toBe(1);
    expect(result.content).toBe('生成摘要');
    expect(f.a.state().jobs[0].result).toBeUndefined();
    expect(f.a.state().jobs[0].source).not.toHaveProperty('content');
    expect(f.a.readJob(j.id).result).toBe('生成摘要');
    expect(f.a.readJob(j.id)).toMatchObject({ sourceState: 'changed' });
    expect(f.knowledge.read(j.id).changedSourceIds).toEqual([f.doc.id]);
    expect(f.jobs()[0].status).toBe('completed');
    expect(f.knowledge.all()).toHaveLength(2);
  });
  it('matches library/directory imports without triggering generated output', () => {
    const f = fixture(),
      folder = f.knowledge.saveFolder({ name: '导入', libraryId: 'default' });
    f.rule({ trigger: 'import', folderId: folder.id });
    f.a.event('import', f.doc.id);
    expect(f.jobs()).toHaveLength(0);
    f.knowledge.moveWiki(f.doc.id, folder.id, f.doc.version);
    f.a.event('import', f.doc.id);
    expect(f.jobs()).toHaveLength(1);
    f.a.tick();
    f.complete(f.jobs()[0]);
    f.a.tick();
    expect(f.jobs()).toHaveLength(1);
    const all = f.rule();
    f.a.run(all.id);
    expect(f.jobs()).toHaveLength(2);
    expect(f.jobs()[1].source?.id).toBe(f.doc.id);
  });
  it('preserves queued work across restart, marks interrupted work failed, retries and cancels', async () => {
    const f = fixture(),
      r = f.rule();
    f.a.run(r.id);
    f.a.run(r.id);
    f.a.tick();
    expect(f.jobs().map((j) => j.status)).toEqual(['running', 'queued']);
    const recovered = new Automations(f.store, f.runtime, f.now);
    expect(f.jobs()[0].status).toBe('failed');
    recovered.retry(f.jobs()[0].id);
    expect(f.jobs()[0].attempt).toBe(2);
    await recovered.cancel(f.jobs()[0].id);
    expect(f.jobs()[0].status).toBe('cancelled');
    recovered.tick();
    expect(f.jobs()[1].status).toBe('running');
    await recovered.cancel(f.jobs()[1].id);
    expect(f.runtime.cancel).toHaveBeenCalledWith(f.jobs()[1].sessionId);
  });
  it('recovers completed output idempotently even if the final job status was not saved', () => {
    const f = fixture();
    const r = f.rule();
    f.a.run(r.id);
    f.a.tick();
    const running = f.jobs()[0];
    f.complete(running);
    f.a.tick();
    f.store.put('automationJob', running);
    new Automations(f.store, f.runtime, f.now);
    expect(f.jobs()[0].status).toBe('completed');
    expect(f.knowledge.all()).toHaveLength(2);
  });
  it('rejects cross-library targets, stale edits, unavailable connection and protects dependent flows', () => {
    const f = fixture(),
      other = f.content.saveLibrary({ name: '其他' }),
      folder = f.knowledge.saveFolder({ name: '目录', libraryId: other.id });
    expect(() => f.rule({ outputFolderId: folder.id })).toThrow('目录');
    const r = f.rule();
    f.a.save({ ...r, name: '新名称' });
    expect(() => f.a.save(r)).toThrow('已更新');
    expect(() => f.a.deleteFlow(f.flow.id)).toThrow('引用');
    f.store.put('provider', {
      ...f.store.providers().find((p) => p.id === 'test'),
      id: 'test',
      enabled: false,
    });
    expect(() => f.a.run(r.id)).toThrow('连接不可用');
    expect(f.jobs()).toHaveLength(0);
  });
  it('times out background execution and retains explicit permission for general tasks', () => {
    const f = fixture();
    const r = f.a.save({
      name: '检查',
      enabled: true,
      kind: 'task',
      trigger: 'manual',
      prompt: '检查状态',
      providerId: 'test',
      model: 'fixture',
      permission: 'ask',
      missed: 'once',
    });
    f.a.run(r.id);
    f.a.tick();
    const j = f.jobs()[0];
    expect(f.store.get<any>('session', j.sessionId!).permission).toBe('ask');
    f.advance(31 * 60000);
    f.a.tick();
    expect(f.jobs()[0].status).toBe('failed');
    expect(f.jobs()[0].error).toContain('30 分钟');
  });
});

describe('automation backup', () => {
  it('restores configurations paused and cancels pending work without changing live data', () => {
    const f = fixture(),
      r = f.rule();
    f.a.run(r.id);
    const password = 'test-backup-password';
    const bytes = new DataMaintenance(f.store, f.root).backup(password);
    const entries = unzipSync(decryptBackup(bytes, password));
    const file = path.join(f.root, 'backup-check.db');
    writeFileSync(file, entries['tongzhou.db']);
    const db = new DatabaseSync(file);
    try {
      const records = db.prepare("SELECT value FROM objects WHERE kind='automation'").all() as {
        value: string;
      }[];
      expect(JSON.parse(records[0].value).enabled).toBe(false);
      const jobs = db.prepare("SELECT value FROM objects WHERE kind='automationJob'").all() as {
        value: string;
      }[];
      expect(JSON.parse(jobs[0].value).status).toBe('cancelled');
      expect(f.jobs()[0].status).toBe('queued');
      expect(f.store.get<AutomationRule>('automation', r.id).enabled).toBe(true);
    } finally {
      db.close();
    }
  });
});

function memoryCandidate(f: ReturnType<typeof fixture>, text = '需要保留的用户事实') {
  const s = f.store.createSession();
  f.store.put('session', { ...s, updatedAt: Date.now() - 180000 });
  const id = crypto.randomUUID();
  f.store.message({
    id: crypto.randomUUID(),
    sessionId: s.id,
    runId: id,
    role: 'user',
    content: text,
    status: 'complete',
    createdAt: Date.now() - 180000,
  });
  const c: MemoryCandidate = {
    id,
    sessionId: s.id,
    providerId: 'test',
    model: 'fixture',
    day: '2026-10-07',
    occurredAt: Date.now() - 180000,
    updatedAt: Date.now() - 180000,
    status: 'pending',
    attempts: 0,
  };
  f.store.put('knowledgeCandidate', c);
  return c;
}
describe('built-in memory automation', () => {
  it('migrates the old switch exactly once and protects the unique built-in task', () => {
    const f = fixture(false);
    const rule = f.a.state().rules.find((r) => r.id === MEMORY_AUTOMATION_ID)!;
    expect(rule).toMatchObject({ kind: 'memory', enabled: false, trigger: 'idle' });
    const enabled = f.a.save({ ...rule, enabled: true, trigger: 'manual' });
    expect(f.knowledge.settings().autoCollect).toBe(true);
    new Automations(f.store, f.runtime, f.now);
    expect(f.a.state().rules.filter((r) => r.kind === 'memory')).toEqual([enabled]);
    expect(() => f.a.delete(enabled.id)).toThrow('不能删除');
    expect(() => f.a.save({ ...enabled, id: undefined })).toThrow('重复创建');
    expect(() => f.a.save({ ...enabled, kind: 'task' })).toThrow('更改任务类型');
    expect(() => f.a.save({ ...enabled, trigger: 'import' })).toThrow('触发方式');
  });
  it('skips empty checks, deduplicates requests and defers memory while interactive work runs', () => {
    const f = fixture();
    expect(f.a.run(MEMORY_AUTOMATION_ID).queued).toBe(0);
    f.a.tick();
    expect(f.jobs()).toHaveLength(0);
    memoryCandidate(f);
    const interactiveId = crypto.randomUUID();
    f.store.put('run', { id: interactiveId, status: 'running' });
    expect(f.a.run(MEMORY_AUTOMATION_ID).queued).toBe(1);
    expect(f.a.run(MEMORY_AUTOMATION_ID).queued).toBe(0);
    f.a.tick();
    expect(f.runtime.start).not.toHaveBeenCalled();
    expect(f.jobs()[0].status).toBe('queued');
    f.store.put('run', { id: interactiveId, status: 'completed' });
    f.a.tick();
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    const job = f.jobs()[0];
    expect(f.store.get<Session>('session', job.sessionId!)).toMatchObject({
      memoryJob: job.context?.memoryJobId,
      automationJob: job.id,
      permission: 'read-only',
      agentId: 'builtin-memory-organizer',
    });
  });
  it('schedules only eligible idle input, commits once and recovers a committed run after restart', () => {
    const f = fixture();
    const c = memoryCandidate(f);
    f.store.put('knowledgeCandidate', { ...c, updatedAt: Date.now() });
    f.a.tick();
    expect(f.jobs()).toHaveLength(0);
    f.store.put('knowledgeCandidate', c);
    f.advance(31000);
    f.a.tick();
    const job = f.jobs()[0];
    f.knowledge.memory.commit(job.context!.memoryJobId, {
      entries: [
        {
          category: 'fact',
          subject: '事实',
          relation: '记录',
          content: '需要保留的用户事实',
          evidence: [{ candidateId: c.id, quote: '需要保留的用户事实' }],
        },
      ],
    });
    // A crash after the domain commit but before final run status must not regenerate memory.
    new Automations(f.store, f.runtime, f.now);
    const result = f.a.readJob(job.id);
    expect(result.status).toBe('completed');
    expect(result.result).toContain('新增 1 条记忆');
    expect(result.outputId).toBeTruthy();
    // A persisted document remains authoritative if candidate bookkeeping lagged a crash.
    f.store.put('knowledgeCandidate', { ...c, status: 'pending' });
    expect(f.a.run(MEMORY_AUTOMATION_ID).queued).toBe(0);
    expect(f.knowledge.memory.queueState().pending).toBe(0);
    expect(f.knowledge.all().filter((d) => d.kind === 'memory')).toHaveLength(1);
  });
  it('fails uncommitted responses, retries the same batch and releases cancelled candidates', async () => {
    const f = fixture();
    const c = memoryCandidate(f);
    f.a.run(MEMORY_AUTOMATION_ID);
    f.a.tick();
    const job = f.jobs()[0];
    f.complete(job, '声称完成，但未提交');
    f.a.tick();
    expect(f.jobs()[0].status).toBe('failed');
    expect(f.knowledge.memory.candidates()[0].status).toBe('failed');
    f.a.retry(job.id);
    f.a.tick();
    const retry = f.jobs()[0];
    expect(retry.attempt).toBe(2);
    expect(
      f.store.get<MemoryJob>('knowledgeMemoryJob', retry.context!.memoryJobId).candidateIds,
    ).toEqual([c.id]);
    await f.a.cancel(job.id);
    expect(f.jobs()[0].status).toBe('cancelled');
    expect(f.knowledge.memory.candidates()[0].status).toBe('failed');
    expect(f.runtime.cancel).toHaveBeenCalledWith(retry.sessionId);
  });
  it('pauses queued work, blocks manual runs while disabled, and supports scheduled execution', () => {
    const f = fixture();
    memoryCandidate(f);
    f.a.run(MEMORY_AUTOMATION_ID);
    const rule = f.a.state().rules.find((r) => r.kind === 'memory')!;
    const paused = f.a.save({ ...rule, enabled: false });
    expect(f.jobs()[0].status).toBe('cancelled');
    expect(f.knowledge.settings().autoCollect).toBe(false);
    expect(() => f.a.run(rule.id)).toThrow('暂停');
    f.a.save({
      ...paused,
      enabled: true,
      trigger: 'schedule',
      schedule: { kind: 'once', at: f.now() + 1000 },
    });
    f.advance(2000);
    f.a.tick();
    expect(f.jobs()[1].status).toBe('running');
    expect(f.a.state().rules.find((r) => r.id === rule.id)?.trigger).toBe('manual');
  });
  it('applies the memory timeout and releases its batch for retry', () => {
    const f = fixture();
    memoryCandidate(f);
    f.a.run(MEMORY_AUTOMATION_ID);
    f.a.tick();
    f.advance(181000);
    f.a.tick();
    expect(f.jobs()[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('3 分钟'),
    });
    expect(f.knowledge.memory.candidates()[0].status).toBe('failed');
  });
  it('recalculates the next time when switching back from manual to the same schedule', () => {
    const f = fixture();
    const rule = f.a.state().rules.find((r) => r.kind === 'memory')!;
    const scheduled = f.a.save({
      ...rule,
      trigger: 'schedule',
      schedule: { kind: 'interval', minutes: 5 },
    });
    const manual = f.a.save({ ...scheduled, trigger: 'manual' });
    f.advance(60000);
    const next = f.a.save({ ...manual, trigger: 'schedule' });
    expect(next.nextRunAt).toBe(f.now() + 300000);
  });
  it('records a disabled-model failure and retries the released batch once the connection is repaired', () => {
    const f = fixture();
    memoryCandidate(f);
    const provider = f.store.providers().find((p) => p.id === 'test')!;
    f.store.put('provider', {
      ...provider,
      enabled: false,
    });
    f.a.run(MEMORY_AUTOMATION_ID);
    f.a.tick();
    expect(f.jobs()[0].status).toBe('failed');
    expect(f.knowledge.memory.candidates()[0].status).toBe('failed');
    f.store.put('provider', { ...provider, enabled: true });
    f.a.retry(f.jobs()[0].id);
    f.a.tick();
    expect(f.jobs()[0].status).toBe('running');
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
  });
});

describe('automation client capability sharing', () => {
  it('discovers registered modules and routes approved client actions through the same scheduler', async () => {
    const f = fixture();
    const commands = new ClientCommands();
    registerAutomationServices((...args) => commands.register(...args), f.runtime);
    const session = f.store.createSession();
    const ask = vi.fn(async () => true);
    const scope = new ToolScope(new AbortController().signal, ask, () => {});
    commands.attach(scope, false, () => true, session.id);
    try {
      const catalog = await scope.call('client_query', {
        method: 'automationCapabilities',
        args: [],
      });
      expect(catalog.text).toContain('memory');
      const r = f.rule();
      const result = await scope.call('client_change', { method: 'automationRun', args: [r.id] });
      expect(result.isError).not.toBe(true);
      expect(f.jobs()).toHaveLength(1);
      expect(ask).toHaveBeenCalledTimes(1);
      expect(
        (
          await scope.call('client_query', {
            method: 'automationList',
            args: [crypto.randomUUID()],
          })
        ).isError,
      ).toBe(true);
      f.store.put('session', { ...session, automationJob: 'background' });
      expect(
        (await scope.call('client_change', { method: 'automationRun', args: [r.id] })).isError,
      ).toBe(true);
      expect(f.jobs()).toHaveLength(1);
    } finally {
      await scope.close();
    }
  });
  it('does not expose disabled folder results or allow an Agent to bypass folder authorization', async () => {
    const f = fixture();
    const rule = f.rule();
    f.a.run(rule.id);
    f.a.tick();
    f.complete(f.jobs()[0]);
    f.a.tick();
    const commands = new ClientCommands();
    registerAutomationServices((...args) => commands.register(...args), f.runtime);
    const session = f.store.createSession();
    const scope = new ToolScope(
      new AbortController().signal,
      async () => true,
      () => {},
    );
    commands.attach(scope, false, () => true, session.id);
    f.knowledge.documents.put({ ...f.knowledge.get(f.doc.id), status: 'archived' });
    try {
      const list = JSON.parse(
        (await scope.call('client_query', { method: 'automationList', args: [session.id] })).text!,
      );
      expect(list.rules.some((r: AutomationRule) => r.id === rule.id)).toBe(false);
      expect(list.jobs).toHaveLength(0);
      expect(
        (
          await scope.call('client_query', {
            method: 'automationResult',
            args: [session.id, f.jobs()[0].id],
          })
        ).isError,
      ).toBe(true);
      expect(
        (await scope.call('client_change', { method: 'automationRun', args: [rule.id] })).isError,
      ).toBe(true);
    } finally {
      await scope.close();
    }
  });
});

describe('registered automation handlers', () => {
  it('runs a registered module without a scheduler branch and rejects duplicate registrations', () => {
    const f = fixture();
    const completed = vi.fn(() => undefined);
    const handler = {
      kind: 'report',
      validate: () => {},
      inputIds: () => [undefined],
      capture: () => ({}),
      prepare: () => ({
        config: { providerId: 'test', model: 'fixture' },
        prompt: '生成通用报告',
        session: { permission: 'read-only' as const },
      }),
      complete: completed,
    };
    f.a.handlers.register(handler);
    expect(() => f.a.handlers.register(handler)).toThrow('已注册');
    const r = f.rule({ kind: 'report' });
    f.a.run(r.id);
    f.a.tick();
    f.complete(f.jobs()[0]);
    f.a.tick();
    expect(f.jobs()[0].status).toBe('completed');
    expect(completed).toHaveBeenCalledTimes(1);
    expect(() => f.rule({ kind: 'missing' })).toThrow('不可用');
  });
  it('saves only the final response, excluding progress narration', () => {
    const f = fixture();
    f.a.run(f.rule().id);
    f.a.tick();
    const job = f.jobs()[0];
    f.store.message({
      id: crypto.randomUUID(),
      sessionId: job.sessionId!,
      runId: job.runId,
      role: 'assistant',
      content: '我先读取资料。',
      status: 'complete',
      createdAt: f.now(),
    });
    f.complete(job, '# 最终成果');
    f.a.tick();
    expect(f.knowledge.get(job.id).content).toBe('# 最终成果');
  });
});
