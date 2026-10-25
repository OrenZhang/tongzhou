import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../../../electron/services/storage/store';
import { createDomainServices } from '../../../electron/modules/domain-services';
import { ApplicationEvents } from '../../../electron/core/application-events';
import type { CanvasEdge, CanvasNode, CanvasOutput, CanvasWrite } from '../../../src/shared/canvas';
import { conditionMatches } from '../../../electron/modules/canvas/control-plugins';
import { Canvases } from '../../../electron/modules/canvas/canvas';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
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
const text = (id: string, value: string): CanvasNode => ({
  id,
  kind: 'text',
  title: id,
  x: 0,
  y: 0,
  text: value,
});
const edge = (from: string, to: string, fromPort = 'result'): CanvasEdge => ({
  id: `${from}:${fromPort}:${to}`,
  from,
  to,
  fromPort,
  toPort: 'context',
  kind: 'dependency',
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'canvas-controls-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
  cleanup.push(() => store.close());
  const domains = createDomainServices(store, root),
    owner = store.createSession();
  store.setSessionPermission(owner.id, 'full-access');
  domains.canvasWorkflows.configure(
    {
      start: vi.fn(() => {
        throw new Error('Unexpected model');
      }),
      cancel: vi.fn(async () => {}),
      setSessionPermission: vi.fn(),
    } as any,
    new ApplicationEvents(() => {}),
  );
  cleanup.push(() => domains.canvasWorkflows.stop());
  const effects: { id: string; inputs: CanvasOutput[]; key?: string }[] = [];
  let failOn: unknown;
  domains.canvases.plugins.register({
    definition: {
      id: 'test.effect',
      name: 'effect',
      kind: 'plugin',
      version: 1,
      cache: 'never',
      inputs: ['text', 'json'],
      outputs: ['text', 'json'],
    },
    execute: ({ node, inputs, run }) => {
      effects.push({
        id: node.id,
        inputs: structuredClone(inputs),
        key: run.nodes[node.id].executionKey,
      });
      if (node.config?.fail || (failOn !== undefined && inputs[0]?.value === failOn))
        throw new Error('fixture failure');
      return { text: inputs.map((o) => o.text).join('|'), value: inputs[0]?.value, resources: [] };
    },
  });
  const save = (nodes: CanvasNode[], edges: CanvasEdge[], execution?: CanvasWrite['execution']) =>
    domains.canvases.save({
      title: 'controls',
      nodes,
      edges,
      execution,
      viewport: { x: 0, y: 0, zoom: 1 },
      selection: [],
    });
  const start = (canvas: ReturnType<typeof save>, reuse = false, nodeIds?: string[]) =>
    domains.canvasWorkflows.start({
      canvasId: canvas.id,
      version: canvas.version,
      sessionId: owner.id,
      reuse,
      nodeIds,
    });
  const done = async (id: string) => {
    await expect.poll(() => domains.canvases.runs.get(id).status).not.toBe('running');
    return domains.canvases.runs.get(id);
  };
  return {
    root,
    store,
    domains,
    owner,
    effects,
    save,
    start,
    done,
    fail: (value?: unknown) => {
      failOn = value;
    },
  };
}

describe('canvas control flow integration', () => {
  it('only executes the selected branch, propagates skips and merges active outputs', async () => {
    const f = fixture(),
      c = f.save(
        [
          text('source', '{"score":80}'),
          node('condition', 'workflow.condition', {
            field: 'value.score',
            operator: 'gte',
            value: '60',
          }),
          node('yes', 'test.effect'),
          node('no', 'test.effect'),
          node('no-child', 'test.effect'),
          node('join', 'workflow.join'),
          node('after', 'test.effect'),
        ],
        [
          edge('source', 'condition'),
          edge('condition', 'yes', 'true'),
          edge('condition', 'no', 'false'),
          edge('no', 'no-child'),
          edge('yes', 'join'),
          edge('no-child', 'join'),
          edge('join', 'after'),
        ],
      );
    const r = await f.done(f.start(c).id);
    expect(r.status).toBe('completed');
    expect(f.effects.map((e) => e.id)).toEqual(['yes', 'after']);
    expect(r.nodes.no.status).toBe('skipped');
    expect(r.nodes['no-child'].status).toBe('skipped');
    expect(r.nodes.join.status).toBe('completed');
  });

  it('runs a failure chain, skips normal descendants and allows independent work', async () => {
    const f = fixture(),
      c = f.save(
        [
          node('bad', 'test.effect', { fail: true }),
          node('normal', 'test.effect'),
          node('recover', 'test.effect', { fail: true }),
          node('fallback', 'test.effect'),
          node('independent', 'test.effect'),
        ],
        [
          edge('bad', 'normal'),
          edge('bad', 'recover', '$error'),
          edge('recover', 'fallback', '$error'),
        ],
      );
    const r = await f.done(f.start(c).id);
    expect(r.status).toBe('completed');
    expect(r.nodes.bad).toMatchObject({ status: 'failed', handled: true });
    expect(r.nodes.normal.status).toBe('skipped');
    expect(r.nodes.fallback.status).toBe('completed');
    expect(r.nodes.independent.status).toBe('completed');
    expect(f.effects.find((e) => e.id === 'fallback')!.inputs[0].value).toMatchObject({
      nodeId: 'recover',
      message: 'fixture failure',
    });
    const unhandled = f.save(
      [node('bad', 'test.effect', { fail: true }), node('other', 'test.effect')],
      [],
    );
    expect((await f.done(f.start(unhandled).id)).status).toBe('failed');
    expect(f.effects.some((e) => e.id === 'other')).toBe(true);
  });

  it('enforces bounded parallelism and waits for every branch before joining', async () => {
    const f = fixture(),
      started: string[] = [],
      releases: (() => void)[] = [];
    f.domains.canvases.plugins.register({
      definition: {
        id: 'test.block',
        name: 'block',
        kind: 'plugin',
        version: 1,
        inputs: [],
        outputs: ['text'],
      },
      execute: async ({ node }) => {
        started.push(node.id);
        await new Promise<void>((resolve) => releases.push(resolve));
        return { text: node.id, resources: [] };
      },
    });
    const c = f.save(
      [
        node('a', 'test.block'),
        node('b', 'test.block'),
        node('c', 'test.block'),
        node('join', 'workflow.join'),
        node('after', 'test.effect'),
      ],
      [edge('a', 'join'), edge('b', 'join'), edge('c', 'join'), edge('join', 'after')],
      { concurrency: 2, maxSteps: 50 },
    );
    const r = f.start(c);
    await expect.poll(() => started.length).toBe(2);
    expect(f.effects).toHaveLength(0);
    releases.shift()!();
    await expect.poll(() => started.length).toBe(3);
    expect(f.effects).toHaveLength(0);
    releases.splice(0).forEach((release) => release());
    const done = await f.done(r.id);
    expect(done.status).toBe('completed');
    expect(done.nodes.join.inputs?.map((o) => o.text)).toEqual(['a', 'b', 'c']);
    expect(f.effects[0].inputs[0].value).toEqual(['a', 'b', 'c']);
  });

  it('iterates actual nodes in order, records per-item results and reuses successful iterations', async () => {
    const f = fixture();
    f.fail(2);
    const c = f.save(
      [
        text('source', '[1,2,3]'),
        node('loop', 'workflow.foreach', { endNodeId: 'end', onError: 'continue' }),
        node('body', 'test.effect'),
        node('end', 'workflow.collect'),
        node('after', 'test.effect'),
      ],
      [
        edge('source', 'loop'),
        edge('loop', 'body', 'item'),
        edge('body', 'end'),
        edge('end', 'after'),
      ],
    );
    const r = await f.done(f.start(c).id);
    expect(r.status).toBe('completed');
    expect(r.nodes.loop.iterations?.map((i) => i.status)).toEqual([
      'completed',
      'failed',
      'completed',
    ]);
    expect(r.nodes.end.output?.value).toEqual([1, { index: 1, error: 'fixture failure' }, 3]);
    expect(f.effects.filter((e) => e.id === 'body').map((e) => e.key)).toEqual([
      'loop/0',
      'loop/1',
      'loop/2',
    ]);
    f.fail();
    f.effects.length = 0;
    const retried = await f.done(f.start(c, true).id);
    expect(retried.nodes.loop.iterations?.map((i) => i.status)).toEqual([
      'cached',
      'completed',
      'cached',
    ]);
    expect(retried.nodes.end.output?.value).toEqual([1, 2, 3]);
    expect(f.effects.filter((e) => e.id === 'body')).toHaveLength(1);
  });

  it('supports nested loops and preserves nested iteration history after later items', async () => {
    const f = fixture(),
      c = f.save(
        [
          text('source', '[[1,2],[3]]'),
          node('outer', 'workflow.foreach', { endNodeId: 'outerEnd' }),
          node('inner', 'workflow.foreach', { endNodeId: 'innerEnd' }),
          node('body', 'test.effect'),
          node('innerEnd', 'workflow.collect'),
          node('outerEnd', 'workflow.collect'),
        ],
        [
          edge('source', 'outer'),
          edge('outer', 'inner', 'item'),
          edge('inner', 'body', 'item'),
          edge('body', 'innerEnd'),
          edge('innerEnd', 'outerEnd'),
        ],
      );
    const r = await f.done(f.start(c).id);
    expect(r.status).toBe('completed');
    expect(r.nodes.outerEnd.output?.value).toEqual([[1, 2], [3]]);
    expect(
      r.nodes.outer.iterations?.[0].nodes.inner.iterations?.map((i) => i.output?.value),
    ).toEqual([1, 2]);
    expect(r.nodes.outer.iterations?.[0].nodes.body.status).toBe('completed');
    expect(r.nodes.outer.iterations?.[0].nodes.innerEnd.output?.value).toEqual([1, 2]);
  });

  it('executes empty loops without body effects, expands selection and rejects invalid input before body effects', async () => {
    const f = fixture();
    const graph = (value: string, maxItems = 100) =>
      f.save(
        [
          text('source', value),
          node('loop', 'workflow.foreach', { endNodeId: 'end', maxItems }),
          node('body', 'test.effect'),
          node('end', 'workflow.collect'),
        ],
        [edge('source', 'loop'), edge('loop', 'body', 'item'), edge('body', 'end')],
      );
    const empty = await f.done(f.start(graph('[]'), false, ['body']).id);
    expect(empty.status).toBe('completed');
    expect(empty.nodes.end.output?.value).toEqual([]);
    expect(empty.nodes.body.status).toBe('skipped');
    expect(f.effects).toHaveLength(0);
    for (const c of [graph('{}'), graph('[1,2]', 1)]) {
      expect((await f.done(f.start(c).id)).status).toBe('failed');
      expect(f.effects).toHaveLength(0);
    }
  });

  it('cancels concurrent work and queued work without activating failure handlers', async () => {
    const f = fixture(),
      c = f.save(
        [
          node('a', 'workflow.delay', { seconds: 300 }),
          node('b', 'workflow.delay', { seconds: 300 }),
          node('queued', 'test.effect'),
          node('failure', 'test.effect'),
        ],
        [edge('a', 'failure', '$error')],
        { concurrency: 2, maxSteps: 50 },
      );
    const r = f.start(c);
    await expect.poll(() => f.domains.canvases.runs.get(r.id).nodes.b.status).toBe('running');
    await f.domains.canvasWorkflows.cancel(r.id);
    const done = await f.done(r.id);
    expect(done.status).toBe('cancelled');
    expect(f.effects).toHaveLength(0);
    expect(done.nodes.failure.status).toBe('cancelled');
  });
  it('stops on a plugin lifecycle change without activating recovery branches', async () => {
    const f = fixture();
    let started = false;
    let release!: () => void;
    const dispose = f.domains.canvases.plugins.register({
      definition: {
        id: 'test.lifecycle',
        name: 'lifecycle',
        kind: 'plugin',
        version: 1,
        inputs: [],
        outputs: ['text'],
      },
      execute: async () => {
        started = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { text: 'done', resources: [] };
      },
    });
    const c = f.save(
      [node('work', 'test.lifecycle'), node('recover', 'test.effect')],
      [edge('work', 'recover', '$error')],
    );
    const r = f.start(c);
    await expect.poll(() => started).toBe(true);
    dispose();
    release();
    const stopped = await f.done(r.id);
    expect(stopped.status).toBe('failed');
    expect(stopped.error).toContain('节点插件不可用');
    expect(f.effects).toHaveLength(0);
  });

  it('stops on execution budget exhaustion without treating it as a recoverable node failure', async () => {
    const f = fixture(),
      c = f.save(
        [
          text('source', '[1,2,3]'),
          node('loop', 'workflow.foreach', { endNodeId: 'end' }),
          node('body', 'test.effect'),
          node('end', 'workflow.collect'),
          node('failure', 'test.effect'),
        ],
        [
          edge('source', 'loop'),
          edge('loop', 'body', 'item'),
          edge('body', 'end'),
          edge('loop', 'failure', '$error'),
        ],
        { concurrency: 2, maxSteps: 3 },
      );
    const r = await f.done(f.start(c).id);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('总执行步数');
    expect(f.effects.map((e) => e.id)).toEqual(['body']);
    expect(r.stepsExecuted).toBe(3);
  });

  it('rejects leaking loops and dynamic reference cycles before any plugin executes', () => {
    const f = fixture();
    const c = f.save(
      [
        text('source', '[1]'),
        node('loop', 'workflow.foreach', { endNodeId: 'end' }),
        node('body', 'test.effect'),
        node('leak', 'test.effect'),
        node('end', 'workflow.collect'),
      ],
      [
        edge('source', 'loop'),
        edge('loop', 'body', 'item'),
        edge('body', 'end'),
        edge('body', 'leak'),
      ],
    );
    expect(() => f.start(c)).toThrow('所有执行分支');
    const cycle = f.save(
      [node('a', 'test.effect'), node('b', 'test.effect')],
      [
        { ...edge('a', 'b'), kind: 'reference' },
        { ...edge('b', 'a'), kind: 'reference' },
      ],
    );
    expect(() => f.start(cycle)).toThrow('执行循环');
    expect(f.effects).toHaveLength(0);
  });
  it('keeps static reference cycles usable and persists execution settings atomically', async () => {
    const f = fixture();
    const c = f.save(
      [text('a', 'A'), text('b', 'B')],
      [
        { ...edge('a', 'b'), kind: 'reference', toPort: undefined },
        { ...edge('b', 'a'), kind: 'reference', toPort: undefined },
      ],
    );
    const next = f.domains.canvases.apply(c.id, c.version, [
      { type: 'configure_execution', execution: { concurrency: 1, maxSteps: 10 } },
    ]);
    expect((await f.done(f.start(next).id)).status).toBe('completed');
    expect(() =>
      f.domains.canvases.apply(next.id, next.version, [
        { type: 'configure_execution', execution: { concurrency: 99, maxSteps: 10 } },
      ]),
    ).toThrow();
    expect(f.domains.canvases.get(next.id).version).toBe(next.version);
  });

  it('recovers an atomic external group through a failure outlet on its output node', async () => {
    const f = fixture();
    f.domains.canvases.plugins.register({
      definition: {
        id: 'test.group',
        name: 'group',
        kind: 'plugin',
        version: 1,
        inputs: ['text'],
        outputs: ['text'],
      },
      execute: () => {
        throw new Error('Expected grouped execution');
      },
      group: {
        id: 'test',
        key: () => 'group',
        execute: async () => {
          throw new Error('group failed');
        },
      },
    });
    const c = f.save(
      [node('inside', 'test.group'), node('output', 'test.group'), node('recover', 'test.effect')],
      [edge('inside', 'output'), edge('output', 'recover', '$error')],
    );
    const r = await f.done(f.start(c).id);
    expect(r.status).toBe('completed');
    expect(r.nodes.inside.handled).toBe(true);
    expect(r.nodes.output.handled).toBe(true);
    expect(f.effects[0].inputs[0].value).toMatchObject({
      nodeId: 'output',
      message: 'group failed',
    });
  });

  it('handles a loop failure once and stops future item effects', async () => {
    const f = fixture();
    f.fail(2);
    const c = f.save(
      [
        text('source', '[1,2,3]'),
        node('loop', 'workflow.foreach', { endNodeId: 'end' }),
        node('body', 'test.effect'),
        node('end', 'workflow.collect'),
        node('recover', 'test.effect'),
      ],
      [
        edge('source', 'loop'),
        edge('loop', 'body', 'item'),
        edge('body', 'end'),
        edge('loop', 'recover', '$error'),
      ],
    );
    const r = await f.done(f.start(c).id);
    expect(r.status).toBe('completed');
    expect(r.nodes.loop.handled).toBe(true);
    expect(r.nodes.end.status).toBe('skipped');
    expect(f.effects.filter((e) => e.id === 'body').map((e) => e.inputs[0].value)).toEqual([1, 2]);
    expect(f.effects.filter((e) => e.id === 'recover')).toHaveLength(1);
  });

  it('passes one actual resource reference per resource-list iteration', async () => {
    const f = fixture();
    const docs = ['first', 'second'].map((title) =>
      f.domains.content.write({ libraryId: 'default', title, content: title }),
    );
    const refs = docs.map((doc) => ({
      kind: 'content' as const,
      id: doc.id,
      version: doc.version,
    }));
    f.domains.canvases.plugins.register({
      definition: {
        id: 'test.resources',
        name: 'resources',
        kind: 'plugin',
        version: 1,
        inputs: [],
        outputs: ['resource'],
      },
      execute: () => ({ text: 'two resources', resources: refs }),
    });
    const c = f.save(
      [
        node('source', 'test.resources'),
        node('loop', 'workflow.foreach', { endNodeId: 'end', source: 'resources' }),
        node('body', 'test.effect'),
        node('end', 'workflow.collect'),
      ],
      [edge('source', 'loop'), edge('loop', 'body', 'item'), edge('body', 'end')],
    );
    const r = await f.done(f.start(c).id);
    expect(r.status).toBe('completed');
    expect(f.effects.map((effect) => effect.inputs[0].resources)).toEqual(refs.map((ref) => [ref]));
    expect(r.nodes.end.output?.resources).toEqual([]);
  });

  it('invalidates loop reuse when an external context changes', async () => {
    const f = fixture();
    const c = f.save(
      [
        text('source', '[1]'),
        text('context', 'old'),
        node('loop', 'workflow.foreach', { endNodeId: 'end' }),
        node('body', 'test.effect'),
        node('end', 'workflow.collect'),
      ],
      [
        edge('source', 'loop'),
        edge('loop', 'body', 'item'),
        { ...edge('context', 'body'), kind: 'reference' },
        edge('body', 'end'),
      ],
    );
    await f.done(f.start(c).id);
    f.effects.length = 0;
    const updated = f.domains.canvases.apply(c.id, c.version, [
      { type: 'put_node', node: text('context', 'new') },
    ]);
    const r = await f.done(f.start(updated, true).id);
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0].inputs[1].text).toBe('new');
    expect(r.nodes.loop.iterations?.[0].status).toBe('completed');
  });

  it.each(['failed', 'cancelled'] as const)(
    'never resubmits an unresolved remote task after a %s iteration, including repeated retries',
    async (status) => {
      const f = fixture();
      let submissions = 0;
      f.domains.canvases.plugins.register({
        definition: {
          id: 'test.remote',
          name: 'remote',
          kind: 'plugin',
          version: 1,
          cache: 'never',
          inputs: ['text'],
          outputs: ['text'],
        },
        execute: ({ run, node }) => {
          submissions++;
          run.nodes[node.id].generation = [
            { index: 0, status: 'failed', resources: [], remoteTaskId: 'paid-job' },
          ];
          throw new Error('query disconnected');
        },
      });
      const c = f.save(
        [
          text('source', '[1]'),
          node('loop', 'workflow.foreach', { endNodeId: 'end' }),
          node('remote', 'test.remote'),
          node('end', 'workflow.collect'),
        ],
        [edge('source', 'loop'), edge('loop', 'remote', 'item'), edge('remote', 'end')],
      );
      const first = await f.done(f.start(c).id);
      first.nodes.loop.iterations![0].status = status;
      f.domains.canvases.runs.put(first);
      for (let i = 0; i < 2; i++) {
        const retried = await f.done(f.start(c, true).id);
        expect(retried.status).toBe('failed');
        expect(retried.error).toContain('远端媒体任务 ID');
      }
      expect(submissions).toBe(1);
    },
  );

  it('recovers running iteration records as interrupted without replaying effects', async () => {
    const f = fixture(),
      c = f.save(
        [
          text('source', '[1]'),
          node('loop', 'workflow.foreach', { endNodeId: 'end' }),
          node('body', 'workflow.delay', { seconds: 300 }),
          node('end', 'workflow.collect'),
        ],
        [edge('source', 'loop'), edge('loop', 'body', 'item'), edge('body', 'end')],
      );
    const started = f.start(c);
    await expect
      .poll(() => f.domains.canvases.runs.get(started.id).nodes.body.status)
      .toBe('running');
    const snapshot = f.domains.canvases.runs.get(started.id);
    await f.domains.canvasWorkflows.cancel(started.id);
    await f.done(started.id);
    f.domains.canvases.runs.put(snapshot);
    const recovered = new Canvases(f.store, f.root).runs.get(started.id);
    expect(recovered.status).toBe('interrupted');
    expect(recovered.nodes.loop.iterations?.[0].status).toBe('cancelled');
    expect(recovered.nodes.loop.iterations?.[0].nodes.body.status).toBe('cancelled');
  });
});

it('compares structured values without evaluating field paths or coercing invalid numbers', () => {
  const inputs = [{ text: '{"score":80,"ok":false}', resources: [] }];
  expect(conditionMatches(inputs, { field: 'value.score', operator: 'gte', value: '80' })).toBe(
    true,
  );
  expect(conditionMatches(inputs, { field: 'value.ok', operator: 'equals', value: 'false' })).toBe(
    true,
  );
  expect(() =>
    conditionMatches(inputs, { field: 'value.score', operator: 'gt', value: 'oops' }),
  ).toThrow('有限数字');
  expect(() => conditionMatches(inputs, { field: 'value.__proto__', operator: 'empty' })).toThrow(
    '路径',
  );
  expect(
    conditionMatches([{ text: '{"a":1,"b":2}', resources: [] }], {
      field: 'value',
      operator: 'equals',
      value: '{"b":2,"a":1}',
    }),
  ).toBe(true);
});
