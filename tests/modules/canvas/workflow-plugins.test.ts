import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../../../electron/services/storage/store';
import { createDomainServices } from '../../../electron/modules/domain-services';
import { ApplicationEvents } from '../../../electron/core/application-events';
import { ToolScope } from '../../../electron/core/tools/extensions';
import {
  CanvasNodePlugins,
  type CanvasNodeContext,
} from '../../../electron/modules/canvas/node-plugins';
import {
  registerWorkflowPlugins,
  renderWorkflowText,
} from '../../../electron/modules/canvas/workflow-plugins';
import { canvasAutomationHandler } from '../../../electron/modules/canvas/canvas-automation';
import { Automations } from '../../../electron/modules/automation/automations';
import { AutomationHandlers } from '../../../electron/modules/automation/automation-handlers';
import type { AutomationJob, AutomationInput } from '../../../src/shared/automation';
import type { CanvasNode, CanvasRun } from '../../../src/shared/canvas';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const node = (id: string, pluginId: string, config?: Record<string, unknown>): CanvasNode => ({
  id,
  kind: 'plugin',
  pluginId,
  title: id,
  x: 0,
  y: 0,
  config,
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'tongzhou-scheduled-canvas-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
  cleanups.push(() => store.close());
  const domains = createDomainServices(store, root),
    events = new ApplicationEvents(() => {}),
    owner = store.createSession();
  store.setSessionPermission(owner.id, 'full-access');
  const tasks = {
    start: vi.fn(() => {
      throw new Error('No model expected');
    }),
    cancel: vi.fn(async () => {}),
    setSessionPermission: vi.fn(),
  };
  domains.canvasWorkflows.configure(tasks as any, events);
  cleanups.push(() => domains.canvasWorkflows.stop());
  let now = Date.now();
  const runtime = {
    ...tasks,
    content: domains.content,
    knowledge: domains.knowledge,
    changed: vi.fn(),
  };
  const handlers = new AutomationHandlers().register(
    canvasAutomationHandler(store, domains.canvasWorkflows),
  );
  const scheduler = new Automations(store, runtime, () => now, handlers);
  const canvas = domains.canvases.save({
    title: 'daily digest',
    viewport: { x: 0, y: 0, zoom: 1 },
    selection: [],
    nodes: [
      node('clock', 'workflow.schedule', {
        schedule: { kind: 'interval', minutes: 5 },
        missed: 'once',
      }),
      { ...node('template', 'workflow.template'), text: '任务：{{input}}' },
      node('unconnected', 'workflow.delay', { seconds: 300 }),
    ],
    edges: [
      {
        id: 'link',
        from: 'clock',
        fromPort: 'result',
        to: 'template',
        toPort: 'context',
        kind: 'dependency',
      },
    ],
  });
  const input: AutomationInput = {
    name: 'test',
    enabled: true,
    kind: 'canvas',
    trigger: 'schedule',
    permission: 'ask',
    missed: 'once',
    schedule: { kind: 'interval', minutes: 5 },
    canvas: { id: canvas.id, version: canvas.version, nodeId: 'clock', sessionId: owner.id },
  };
  const job = () => store.list<AutomationJob>('automationJob')[0];
  return {
    store,
    domains,
    owner,
    tasks,
    runtime,
    handlers,
    scheduler,
    canvas,
    input,
    job,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
describe('canvas scheduling and workflow nodes', () => {
  it('executes only the scheduled branch without a model, records results and disables a one-shot', async () => {
    const f = fixture();
    const rule = f.scheduler.save({
      ...f.input,
      schedule: { kind: 'once', at: Date.now() + 1000 },
    });
    f.advance(2000);
    f.scheduler.tick();
    expect(f.job().status).toBe('running');
    expect(f.store.get<any>('session', f.job().sessionId!).permission).toBe('ask');
    await vi.waitFor(() =>
      expect(f.domains.canvases.runs.get(f.job().runId!).status).toBe('completed'),
    );
    f.scheduler.tick();
    expect(f.job().status).toBe('completed');
    expect(f.job().result).toContain('任务：');
    expect(Object.keys(f.domains.canvases.runs.get(f.job().runId!).nodes)).toEqual([
      'clock',
      'template',
    ]);
    expect(f.store.get<any>('automation', rule.id).enabled).toBe(false);
    expect(f.tasks.start).not.toHaveBeenCalled();
  });
  it('rejects stale versions, duplicate publications and read-only owners', () => {
    const f = fixture();
    f.scheduler.save(f.input);
    expect(() => f.scheduler.save(f.input)).toThrow('已发布');
    expect(() => f.scheduler.save({ ...f.input, enabled: false })).toThrow('已发布');
    const { updatedAt: _, ...input } = f.canvas;
    f.domains.canvases.save({ ...input, title: 'edited' });
    f.advance(300001);
    f.scheduler.tick();
    expect(f.job()).toBeUndefined();
    expect(f.scheduler.state().rules[0]).toMatchObject({
      enabled: false,
      error: expect.stringContaining('重新发布'),
    });
    const next = f.domains.canvases.get(f.canvas.id);
    f.store.setSessionPermission(f.owner.id, 'read-only');
    expect(() =>
      f.scheduler.save({
        ...f.scheduler.state().rules[0],
        enabled: true,
        canvas: { ...f.input.canvas!, version: next.version },
      }),
    ).toThrow('只读');
  });
  it('checks pinned versions again for queued work and never asks a model to execute a changed graph', () => {
    const f = fixture(),
      rule = f.scheduler.save(f.input);
    f.scheduler.run(rule.id);
    const { updatedAt: _, ...input } = f.canvas;
    f.domains.canvases.save({ ...input, title: 'changed after enqueue' });
    f.scheduler.tick();
    expect(f.job().status).toBe('failed');
    expect(f.job().error).toContain('重新发布');
    expect(f.domains.canvases.runs.list()).toHaveLength(0);
  });
  it('does not overlap occurrences and cancels a running delay, including its descendants', async () => {
    const f = fixture();
    const { updatedAt: _, ...input } = f.canvas;
    const canvas = f.domains.canvases.save({
      ...input,
      nodes: f.canvas.nodes.map((n) =>
        n.id === 'template' ? node('template', 'workflow.delay', { seconds: 300 }) : n,
      ),
    });
    const rule = f.scheduler.save({
      ...f.input,
      canvas: { ...f.input.canvas!, version: canvas.version },
    });
    f.advance(300001);
    f.scheduler.tick();
    await vi.waitFor(() =>
      expect(f.domains.canvases.runs.get(f.job().runId!).nodes.template.status).toBe('running'),
    );
    f.advance(300001);
    f.scheduler.tick();
    expect(f.store.list('automationJob')).toHaveLength(1);
    await f.scheduler.cancel(f.job().id);
    expect(f.job().status).toBe('cancelled');
    await vi.waitFor(() =>
      expect(f.domains.canvases.runs.get(f.job().runId!).status).toBe('cancelled'),
    );
    expect(f.scheduler.state().rules.find((r) => r.id === rule.id)?.enabled).toBe(true);
  });
  it('recovers completed domain work after restart without re-execution and reports missing history', async () => {
    const f = fixture(),
      rule = f.scheduler.save(f.input);
    f.scheduler.run(rule.id);
    f.scheduler.tick();
    await vi.waitFor(() =>
      expect(f.domains.canvases.runs.get(f.job().runId!).status).toBe('completed'),
    );
    new Automations(f.store, f.runtime, Date.now, f.handlers);
    expect(f.job().status).toBe('completed');
    f.store.put('automationJob', { ...f.job(), status: 'running', runId: 'missing' });
    expect(() => new Automations(f.store, f.runtime, Date.now, f.handlers)).not.toThrow();
    expect(f.job().status).toBe('failed');
    expect(f.tasks.start).not.toHaveBeenCalled();
  });
  it('does not allow public execution to use an automation-owned session', () => {
    const f = fixture();
    f.store.put('session', { ...f.owner, permission: 'ask', automationJob: 'fake' });
    expect(() =>
      f.domains.canvasWorkflows.start({
        canvasId: f.canvas.id,
        version: f.canvas.version,
        sessionId: f.owner.id,
      }),
    ).toThrow('普通会话');
  });
  it('substitutes text without evaluation, keeps input order and fails absent input indices', () => {
    const inputs = [
      { text: '{{time}} <script>alert(1)</script>', resources: [] },
      { text: '第二个', resources: [] },
    ];
    expect(renderWorkflowText('{{input.2}}\n{{input.1}}', inputs, 0)).toBe(
      '第二个\n{{time}} <script>alert(1)</script>',
    );
    expect(renderWorkflowText('{{date}}', [], 0)).toBe('1970-01-01');
    expect(() => renderWorkflowText('{{input.3}}', inputs, 0)).toThrow('不存在');
  });
});

describe('canvas notification approval boundary', () => {
  async function execute(approve: boolean, status = 'sent', text = '上游摘要') {
    const plugins = new CanvasNodePlugins(),
      send = vi.fn(async () => ({ id: 'receipt', status })),
      ask = vi.fn(async () => approve);
    registerWorkflowPlugins(plugins, send, () => 'stable-automation-job');
    const controller = new AbortController();
    const scope = new ToolScope(controller.signal, ask, () => {});
    const context = {
      node: {
        ...node('notify', 'workflow.notify', { targetId: 'fixed-target' }),
        text: '{{input}}',
      },
      run: { id: 'run-2', sessionId: 'worker', startedAt: 0, nodes: {} } as CanvasRun,
      inputs: [{ text, resources: [] }],
      options: {},
      permission: 'ask',
      signal: controller.signal,
      task: async (operation: any) => {
        await operation.prepare(scope);
        return { text: await operation.execute(scope), resources: [] };
      },
    } as unknown as CanvasNodeContext;
    const result = plugins.execute(context);
    return { result, send, ask, plugins };
  }
  it('rejecting approval never dispatches a message', async () => {
    const f = await execute(false);
    await expect(f.result).rejects.toThrow('未批准');
    expect(f.send).not.toHaveBeenCalled();
  });
  it('uses a fixed target and stable job/node idempotency key; notifications cannot use cache', async () => {
    const f = await execute(true);
    await expect(f.result).resolves.toMatchObject({ text: '通知已发送 · receipt' });
    expect(f.send).toHaveBeenCalledWith(
      'fixed-target',
      '上游摘要',
      'worker',
      'canvas:stable-automation-job:notify',
      expect.any(AbortSignal),
    );
    expect(f.ask).toHaveBeenCalled();
    expect(f.plugins.list().find((p) => p.id === 'workflow.notify')?.cache).toBe('never');
  });
  it('does not call an unknown delivery successful or silently truncate oversized text', async () => {
    const f = await execute(true, 'unknown');
    await expect(f.result).rejects.toThrow('未确认');
    const oversized = await execute(true, 'sent', 'x'.repeat(4001));
    await expect(oversized.result).rejects.toThrow('4000');
    expect(oversized.send).not.toHaveBeenCalled();
  });
});
