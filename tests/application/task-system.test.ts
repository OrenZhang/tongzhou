import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../../electron/services/storage/store';
import { ApplicationEvents } from '../../electron/core/application-events';
import { createDomainServices } from '../../electron/modules/domain-services';
import { createTaskSystem } from '../../electron/application/task-system';
import { Automations } from '../../electron/modules/automation/automations';
import { Terminals } from '../../electron/services/desktop/terminals';
import { CodexExecution } from '../../electron/core/codex/execution';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tongzhou-task-system-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new Store(':memory:', { encrypt: (value) => value, decrypt: (value) => value });
  cleanups.push(() => store.close());
  const events = new ApplicationEvents(vi.fn());
  const domains = createDomainServices(store, root);
  return {
    store,
    events,
    create: () =>
      createTaskSystem(store, root, events, domains, { resolve: async (profile) => profile }),
  };
}

describe('task service ownership', () => {
  it('rolls back producers, engine resources and subscriptions after failed startup', async () => {
    const f = await fixture();
    const start = Automations.prototype.start;
    const stop = vi.spyOn(Automations.prototype, 'stop');
    const terminals = vi.spyOn(Terminals.prototype, 'dispose');
    const execution = vi.spyOn(CodexExecution.prototype, 'close');
    vi.spyOn(Automations.prototype, 'start').mockImplementation(function (this: Automations) {
      start.call(this);
      throw new Error('fixture startup failure');
    });
    await expect(f.create()).rejects.toThrow('fixture startup failure');
    expect(stop).toHaveBeenCalled();
    expect(terminals).toHaveBeenCalled();
    expect(execution).toHaveBeenCalledTimes(1);
    expect(f.events.eventNames()).toEqual([]);
  });

  it('rejects pending approvals, stops new work and releases only its own subscriptions', async () => {
    const f = await fixture();
    const observer = vi.fn();
    f.events.on('engineInvalidated', observer);
    const system = await f.create();
    cleanups.push(system.dispose);
    const session = f.store.createSession();
    const approval = system.approvals.ask(
      session.id,
      'fixture',
      '{}',
      new AbortController().signal,
    );
    const close = vi.spyOn(system.execution, 'close');
    const stopping = system.dispose();
    expect(system.dispose()).toBe(stopping);
    await stopping;
    expect(await approval).toBe(false);
    expect(system.tasks.snapshot().approvals).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(f.events.listeners('engineInvalidated')).toEqual([observer]);
    expect(f.events.listenerCount('shutdown')).toBe(0);
    await expect(system.terminals.start(session.id)).rejects.toThrow('正在退出');
    expect(() =>
      system.tasks.start({
        sessionId: session.id,
        providerId: 'openai-codex',
        model: 'fixture',
        agentId: '',
        prompt: 'test',
      }),
    ).toThrow('正在退出');
  });

  it('still closes the engine and detaches subscriptions when a producer fails cleanup', async () => {
    const f = await fixture();
    const system = await f.create();
    const stop = vi.spyOn(system.automations, 'stop');
    const close = vi.spyOn(system.execution, 'close');
    vi.spyOn(system.terminals, 'dispose').mockImplementation(() => {
      throw new Error('fixture terminal cleanup failure');
    });
    await expect(system.dispose()).rejects.toThrow('部分任务资源未能正常释放');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(f.events.eventNames()).toEqual([]);
    expect(system.automations.processMemory()).toEqual({ started: false });
    const task = f.store.createSession();
    expect(() =>
      system.tasks.start({
        sessionId: task.id,
        providerId: 'openai-codex',
        model: 'fixture',
        agentId: '',
        prompt: 'test',
      }),
    ).toThrow('正在退出');
  });

  it('invalidates only the selected provider without constructing a login client', async () => {
    const f = await fixture();
    const system = await f.create();
    cleanups.push(system.dispose);
    const invalidate = vi.spyOn(system.execution, 'invalidate').mockResolvedValue(undefined);
    f.events.emit('engineInvalidated', { providerId: 'openai-codex' });
    expect(invalidate).toHaveBeenCalledExactlyOnceWith('openai-codex');
    invalidate.mockClear();
    f.events.emit('engineInvalidated', { protocol: 'kimi' });
    expect(invalidate.mock.calls.map(([id]) => id)).toEqual(
      f.store
        .providers()
        .filter((p) => p.protocol === 'kimi')
        .map((p) => p.id),
    );
  });
});
