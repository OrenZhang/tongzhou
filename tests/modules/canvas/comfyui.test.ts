import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../../../electron/services/storage/store';
import { createTaskFixture } from '../../support/task-system';
import { parseComfyWorkflow, comfyConfig } from '../../../electron/modules/canvas/comfyui-format';
import { CanvasTransfer } from '../../../electron/modules/canvas/transfer';
import type { Canvas, CanvasNode } from '../../../src/shared/canvas';
import { connectCanvasPorts } from '../../../src/shared/canvas-ports';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=';
const catalog = {
  TextImage: {
    input: {
      required: {
        text: ['STRING', { default: '' }],
        seed: ['INT', { default: 1, min: 0, max: 1000 }],
      },
    },
    output: ['IMAGE'],
  },
  LoadImage: {
    input: { required: { image: [['input.png'], { image_upload: true }] } },
    output: ['IMAGE', 'MASK'],
  },
  SaveImage: {
    input: { required: { images: ['IMAGE'], filename_prefix: ['STRING', { default: 'ComfyUI' }] } },
    output: [],
    output_node: true,
  },
};
const apiWorkflow = {
  '1': { class_type: 'TextImage', inputs: { text: 'cat', seed: 1 } },
  '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'test' } },
};
const write = ({ updatedAt: _time, ...canvas }: Canvas) => canvas;
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture({ ws = false } = {}) {
  const sockets = new Set<import('node:net').Socket>();
  let posts = 0,
    failHistory = false,
    pending = false,
    uploads = 0;
  let submitted: any;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/object_info') res.end(JSON.stringify(catalog));
    else if (req.url === '/prompt') {
      submitted = JSON.parse(body);
      posts++;
      res.end(JSON.stringify({ prompt_id: 'job-1', node_errors: {} }));
    } else if (req.url === '/history/job-1') {
      for (const socket of sockets) {
        for (const payload of [
          { type: 'executing', data: { prompt_id: 'job-1', node: '1' } },
          { type: 'progress', data: { prompt_id: 'job-1', node: '1', value: 1, max: 2 } },
        ]) {
          const body = Buffer.from(JSON.stringify(payload));
          const header =
            body.length < 126
              ? Buffer.from([0x81, body.length])
              : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
          socket.write(Buffer.concat([header, body]));
        }
      }
      if (failHistory) {
        failHistory = false;
        res.statusCode = 503;
        res.end('{}');
      } else
        res.end(
          JSON.stringify(
            pending
              ? {}
              : {
                  'job-1': {
                    status: { completed: true, status_str: 'success' },
                    outputs: {
                      '2': { images: [{ filename: 'output.png', subfolder: '', type: 'output' }] },
                    },
                  },
                },
          ),
        );
    } else if (req.url?.startsWith('/view?')) {
      res.setHeader('Content-Type', 'image/png');
      res.end(Buffer.from(png, 'base64'));
    } else if (req.url === '/upload/image') {
      uploads++;
      res.end(JSON.stringify({ name: 'uploaded.png' }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  server.on('upgrade', (req, socket) => {
    if (!ws) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1')
      .update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
        accept +
        '\r\n\r\n',
    );
    sockets.add(socket as import('node:net').Socket);
    socket.on('close', () => sockets.delete(socket as import('node:net').Socket));
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>(
        (resolve, reject) => (
          sockets.forEach((socket) => socket.destroy()),
          server.close((e) => (e ? reject(e) : resolve()))
        ),
      ),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture');
  const root = await mkdtemp(path.join(os.tmpdir(), 'cosail-comfy-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
  cleanup.push(() => store.close());
  store.put('plugin', {
    id: 'comfy',
    name: 'Comfy fixture',
    protocol: 'comfyui',
    transport: 'http',
    command: '',
    args: [],
    url: `http://127.0.0.1:${address.port}`,
    enabled: true,
    readOnlyTools: [],
  });
  const session = store.createSession();
  store.setSessionPermission(session.id, 'full-access');
  const system = await createTaskFixture(store, root);
  cleanup.push(() => system.dispose());
  const workflows = system.domains.canvasWorkflows,
    canvases = system.domains.canvases;
  const run = async (canvas: Canvas, extra = {}) => {
    const started = workflows.start({
      canvasId: canvas.id,
      version: canvas.version,
      sessionId: session.id,
      ...extra,
    });
    await expect
      .poll(() => canvases.runs.get(started.id).status, { timeout: 10000 })
      .not.toBe('running');
    return canvases.runs.get(started.id);
  };
  return {
    system,
    store,
    session,
    workflows,
    canvases,
    run,
    posts: () => posts,
    submitted: () => submitted,
    uploads: () => uploads,
    failHistory: () => {
      failHistory = true;
    },
    pending: () => {
      pending = true;
    },
    finish: () => {
      pending = false;
    },
  };
}
describe('ComfyUI workflow adapter', () => {
  it('imports expanded API graphs, executes once through TaskService and saves original image outputs', async () => {
    const f = await fixture(),
      canvas = await f.workflows.comfy.import(JSON.stringify(apiWorkflow), 'comfy');
    expect(canvas.nodes).toHaveLength(2);
    expect(canvas.edges).toHaveLength(1);
    const result = await f.run(canvas);
    expect(result.status, result.error).toBe('completed');
    expect(f.posts()).toBe(1);
    expect(f.submitted().prompt['2'].inputs.images).toEqual(['1', 0]);
    const output = result.nodes[canvas.nodes[1].id].output!.resources[0];
    expect(output.kind).toBe('artifact');
    expect(f.system.domains.artifacts.preview((output as { id: string }).id).type).toBe('image');
    expect(f.system.domains.artifacts.bytes((output as { id: string }).id)).toEqual(
      Buffer.from(png, 'base64'),
    );
    expect(result.nodes[canvas.nodes[0].id].taskRunId).toBe(
      result.nodes[canvas.nodes[1].id].taskRunId,
    );
  });
  it.each([0.4, 1])(
    'imports UI version %s without a service, then resolves widgets using the selected service',
    async (version) => {
      const f = await fixture();
      const raw = {
        version,
        nodes: [
          {
            id: 1,
            type: 'TextImage',
            pos: [10, 20],
            widgets_values: ['cat', 1, 'fixed'],
            inputs: [],
            outputs: [{ name: 'IMAGE' }],
          },
          {
            id: 2,
            type: 'SaveImage',
            pos: [350, 20],
            widgets_values: ['test'],
            inputs: [{ name: 'images', link: 1 }],
            outputs: [],
          },
        ],
        links:
          version === 0.4
            ? [[1, 1, 0, 2, 0, 'IMAGE']]
            : [{ id: 1, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0 }],
      };
      const canvas = await f.workflows.comfy.import(JSON.stringify(raw));
      expect(comfyConfig(canvas.nodes[0])!.issues?.length).toBeGreaterThan(0);
      const configured = await f.workflows.comfy.configure(canvas, 'comfy');
      expect(configured.warnings).toEqual([]);
      expect(configured.canvas.nodes[0].id).toBe(canvas.nodes[0].id);
      expect(configured.canvas.nodes[0].x).toBe(10);
      expect((await f.run(configured.canvas)).status).toBe('completed');
    },
  );
  it('routes host text into a ComfyUI parameter and returns materialized files to native save nodes', async () => {
    const f = await fixture();
    let canvas = await f.workflows.comfy.import(JSON.stringify(apiWorkflow), 'comfy');
    const text: CanvasNode = {
      id: 'prompt',
      kind: 'text',
      title: 'prompt',
      text: 'blue bird',
      x: -300,
      y: 0,
    };
    const save: CanvasNode = { id: 'save', kind: 'save', title: '保存生成图', x: 700, y: 0 };
    canvas = f.canvases.save({
      ...write(canvas),
      nodes: [...canvas.nodes, text, save],
      edges: [
        ...canvas.edges,
        {
          id: 'prompt-edge',
          from: text.id,
          to: canvas.nodes[0].id,
          kind: 'dependency',
          fromPort: 'result',
          toPort: 'in:text',
        },
        {
          id: 'file-edge',
          from: canvas.nodes[1].id,
          to: save.id,
          kind: 'dependency',
          fromPort: 'files',
          toPort: 'context',
        },
      ],
    });
    const result = await f.run(canvas);
    expect(result.status, result.error).toBe('completed');
    expect(f.submitted().prompt['1'].inputs.text).toBe('blue bird');
    expect(result.nodes.save.output?.resources.some((r) => r.kind === 'content')).toBe(true);
  });
  it('recovers a remote task after query failure without submitting it again, and rejects changed parameters', async () => {
    const f = await fixture(),
      canvas = await f.workflows.comfy.import(JSON.stringify(apiWorkflow), 'comfy');
    f.failHistory();
    const failed = await f.run(canvas);
    expect(failed.status).toBe('failed');
    const resumed = await f.run(canvas, { resumeRunId: failed.id });
    expect(resumed.status, resumed.error).toBe('completed');
    expect(f.posts()).toBe(1);
    const edited = f.canvases.save({
      ...write(canvas),
      nodes: canvas.nodes.map((n, i) =>
        i ? n : { ...n, config: { ...n.config, values: { text: 'changed', seed: 1 } } },
      ),
    });
    const rejected = await f.run(edited, { resumeRunId: failed.id });
    expect(rejected.status).toBe('failed');
    expect(f.posts()).toBe(1);
  });
  it('runs and resumes the single workflow API node using the same submission path', async () => {
    const f = await fixture();
    const node: CanvasNode = {
      id: 'api',
      kind: 'plugin',
      pluginId: 'comfyui.workflow',
      title: 'API workflow',
      x: 0,
      y: 0,
      config: {
        connectionId: 'comfy',
        workflow: JSON.stringify(apiWorkflow),
        bindings: [{ port: 'prompt', nodeId: '1', field: 'text' }],
      },
    };
    const canvas = f.canvases.save({
      title: 'API',
      nodes: [node, { id: 'text', kind: 'text', title: 'prompt', text: 'ocean', x: -300, y: 0 }],
      edges: [
        {
          id: 'e',
          from: 'text',
          to: node.id,
          kind: 'dependency',
          fromPort: 'result',
          toPort: 'prompt',
        },
      ],
      selection: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    f.failHistory();
    const first = await f.run(canvas);
    expect(first.status).toBe('failed');
    expect(f.submitted().prompt['1'].inputs.text).toBe('ocean');
    const result = await f.run(canvas, { resumeRunId: first.id });
    expect(result.status, result.error).toBe('completed');
    expect(f.posts()).toBe(1);
    expect(result.nodes.api.output?.resources).toHaveLength(1);
  });
  it('round-trips import sources and editable API changes through existing canvas packages', async () => {
    const f = await fixture();
    let canvas = await f.workflows.comfy.import(JSON.stringify(apiWorkflow), 'comfy');
    canvas = f.canvases.save({
      ...write(canvas),
      nodes: canvas.nodes.map((n, i) =>
        i ? n : { ...n, config: { ...n.config, values: { text: 'edited', seed: 8 } } },
      ),
    });
    const exported = JSON.parse(f.workflows.comfy.export(canvas));
    expect(exported['1'].inputs.text).toBe('edited');
    const d = f.system.domains,
      transfer = new CanvasTransfer(
        d.canvases,
        d.canvasWorkflows.resources,
        d.content,
        d.knowledge,
        d.artifacts,
      );
    const packed = await transfer.encode(canvas.id, canvas.version, 'template');
    expect(packed).not.toContain('"connectionId"');
    const restored = await transfer.decode(packed);
    expect(comfyConfig(restored.nodes[0])!.sourceId).not.toBe(
      comfyConfig(canvas.nodes[0])!.sourceId,
    );
    expect(JSON.parse(f.workflows.comfy.export(restored))).toEqual(exported);
  });
  it('rejects missing nodes and invalid model options without submitting a prompt', async () => {
    const f = await fixture();
    const canvas = await f.workflows.comfy.import(
      JSON.stringify({
        ...apiWorkflow,
        '1': { class_type: 'MissingNode', inputs: { text: 'cat' } },
      }),
      'comfy',
    );
    expect((await f.run(canvas)).status).toBe('failed');
    expect(f.posts()).toBe(0);
    const invalid = await f.workflows.comfy.import(
      JSON.stringify({
        ...apiWorkflow,
        '1': { class_type: 'TextImage', inputs: { text: 'cat', seed: 1.5 } },
      }),
      'comfy',
    );
    expect((await f.run(invalid)).status).toBe('failed');
    expect(f.posts()).toBe(0);
  });
  it('keeps opaque engine ports isolated and rejects mixed graph cycles before execution', async () => {
    const f = await fixture();
    const parsed = parseComfyWorkflow(apiWorkflow, randomUUID(), catalog, 'comfy');
    const host: CanvasNode = { id: 'host', kind: 'agent', title: 'Agent', x: 0, y: 0 };
    const canvas: Canvas = {
      id: randomUUID(),
      version: 1,
      updatedAt: Date.now(),
      title: 'mixed',
      nodes: [...parsed.nodes, host],
      edges: parsed.edges,
      selection: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    };
    expect(() =>
      connectCanvasPorts(
        canvas,
        {
          id: 'bad',
          from: parsed.nodes[0].id,
          to: host.id,
          kind: 'dependency',
          fromPort: 'out:0',
          toPort: 'context',
        },
        [],
      ),
    ).toThrow('不兼容');
    const order = [...parsed.nodes.map((n) => n.id), host.id];
    expect(() =>
      f.workflows.canvases.plugins.plan(
        {
          ...canvas,
          edges: [
            ...canvas.edges,
            { id: 'a', from: parsed.nodes[0].id, to: host.id, kind: 'dependency' },
            { id: 'b', from: host.id, to: parsed.nodes[1].id, kind: 'dependency' },
          ],
        },
        order,
      ),
    ).toThrow('循环');
  });
  it('requires approval before upload or generation, and rejecting it performs no remote mutation', async () => {
    const f = await fixture(),
      canvas = await f.workflows.comfy.import(JSON.stringify(apiWorkflow), 'comfy');
    f.store.setSessionPermission(f.session.id, 'ask');
    const started = f.workflows.start({
      canvasId: canvas.id,
      version: canvas.version,
      sessionId: f.session.id,
    });
    await expect.poll(() => f.system.approvals.snapshot().length).toBe(1);
    expect(f.posts()).toBe(0);
    expect(f.uploads()).toBe(0);
    f.system.approvals.approve(f.system.approvals.snapshot()[0].id, false);
    await expect.poll(() => f.canvases.runs.get(started.id).status).toBe('failed');
    expect(f.posts()).toBe(0);
  });
  it('stops local tracking and resumes the original task after cancellation without a second submit', async () => {
    const f = await fixture(),
      canvas = await f.workflows.comfy.import(JSON.stringify(apiWorkflow), 'comfy');
    f.pending();
    const started = f.workflows.start({
      canvasId: canvas.id,
      version: canvas.version,
      sessionId: f.session.id,
    });
    await expect
      .poll(
        () =>
          f.canvases.runs.get(started.id).external?.[comfyConfig(canvas.nodes[0])!.sourceId]
            ?.promptId,
      )
      .toBe('job-1');
    await f.workflows.cancel(started.id);
    await expect.poll(() => f.canvases.runs.get(started.id).status).toBe('cancelled');
    f.finish();
    const resumed = await f.run(canvas, { resumeRunId: started.id });
    expect(resumed.status, resumed.error).toBe('completed');
    expect(f.posts()).toBe(1);
  });
  it('uploads actual reference bytes through an API node binding rather than passing a local path', async () => {
    const f = await fixture();
    const doc = f.system.domains.knowledge.importFile(
      'input.png',
      Buffer.from(png, 'base64'),
      undefined,
      'default',
    );
    const workflow = {
      '1': { class_type: 'LoadImage', inputs: { image: 'input.png' } },
      '2': apiWorkflow['2'],
    };
    const node: CanvasNode = {
      id: 'api',
      kind: 'plugin',
      pluginId: 'comfyui.workflow',
      title: 'Reference',
      x: 0,
      y: 0,
      config: {
        connectionId: 'comfy',
        workflow: JSON.stringify(workflow),
        bindings: [{ port: 'reference', nodeId: '1', field: 'image' }],
      },
    };
    const canvas = f.canvases.save({
      title: 'Reference',
      nodes: [
        node,
        {
          id: 'resource',
          kind: 'resource',
          title: 'image',
          x: -300,
          y: 0,
          resource: { kind: 'content', id: doc.id, version: doc.version },
        },
      ],
      edges: [
        {
          id: 'ref',
          from: 'resource',
          to: node.id,
          kind: 'dependency',
          fromPort: 'result',
          toPort: 'reference',
        },
      ],
      selection: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    const result = await f.run(canvas);
    expect(result.status, result.error).toBe('completed');
    expect(f.uploads()).toBe(1);
    expect(f.submitted().prompt['1'].inputs.image).toBe('uploaded.png');
  });
  it('preserves missing custom widgets but blocks ambiguous execution instead of dropping their values', async () => {
    const f = await fixture();
    const canvas = await f.workflows.comfy.import(
      JSON.stringify({
        version: 0.4,
        nodes: [
          {
            id: 1,
            type: 'TextImage',
            widgets_values: ['cat', 1, 'fixed', 'custom-widget'],
            inputs: [],
            outputs: [{ name: 'IMAGE' }],
          },
          {
            id: 2,
            type: 'SaveImage',
            widgets_values: ['out'],
            inputs: [{ name: 'images', link: 1 }],
          },
        ],
        links: [[1, 1, 0, 2, 0, 'IMAGE']],
      }),
      'comfy',
    );
    expect(comfyConfig(canvas.nodes[0])!.issues?.join()).toContain('自定义控件');
    expect((await f.run(canvas)).status).toBe('failed');
    expect(f.posts()).toBe(0);
    expect(
      f.canvases.imports.get(comfyConfig(canvas.nodes[0])!.sourceId).raw.nodes[0].widgets_values,
    ).toHaveLength(4);
  });
  it('exports current graph edits without resurrecting deleted nodes from the original source', async () => {
    const f = await fixture(),
      canvas = await f.workflows.comfy.import(JSON.stringify(apiWorkflow), 'comfy');
    const deleted = f.canvases.save({ ...write(canvas), nodes: [canvas.nodes[1]], edges: [] });
    const result = JSON.parse(f.workflows.comfy.export(deleted));
    expect(Object.keys(result)).toEqual(['2']);
    expect(result['2'].inputs.images).toBeUndefined();
  });
  it('maps real websocket events to imported node progress and still completes by history', async () => {
    const f = await fixture({ ws: true }),
      canvas = await f.workflows.comfy.import(JSON.stringify(apiWorkflow), 'comfy');
    f.pending();
    const started = f.workflows.start({
      canvasId: canvas.id,
      version: canvas.version,
      sessionId: f.session.id,
    });
    await expect
      .poll(() => f.canvases.runs.get(started.id).nodes[canvas.nodes[0].id].progress)
      .toEqual({ value: 1, max: 2 });
    f.finish();
    await expect.poll(() => f.canvases.runs.get(started.id).status).toBe('completed');
    expect(f.posts()).toBe(1);
  });
  it('records bounded random seeds and advances increment controls only for new submissions', async () => {
    const f = await fixture();
    let canvas = await f.workflows.comfy.import(JSON.stringify(apiWorkflow), 'comfy');
    canvas = f.canvases.save({
      ...write(canvas),
      nodes: canvas.nodes.map((n, i) =>
        i ? n : { ...n, config: { ...n.config, controls: { seed: 'increment' } } },
      ),
    });
    expect((await f.run(canvas)).status).toBe('completed');
    expect(f.submitted().prompt['1'].inputs.seed).toBe(1);
    const second = await f.run(canvas);
    expect(second.status).toBe('completed');
    expect(f.submitted().prompt['1'].inputs.seed).toBe(2);
    await f.run(canvas, { resumeRunId: second.id });
    expect(f.posts()).toBe(2);
    canvas = f.canvases.save({
      ...write(canvas),
      nodes: canvas.nodes.map((n, i) =>
        i ? n : { ...n, config: { ...n.config, controls: { seed: 'randomize' } } },
      ),
    });
    const random = await f.run(canvas);
    expect(random.status).toBe('completed');
    expect(f.submitted().prompt['1'].inputs.seed).toBeGreaterThanOrEqual(0);
    expect(f.submitted().prompt['1'].inputs.seed).toBeLessThanOrEqual(1000);
  });
});
