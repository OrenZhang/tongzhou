import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../../electron/services/storage/store';
import { createTaskFixture } from '../../support/task-system';
import { mediaArguments, mediaResponse } from '../../../electron/modules/canvas/media';
import { canvasMediaTools } from '../../../src/shared/canvas';
import type { CanvasNode } from '../../../src/shared/canvas';
import type { PluginTool } from '../../../src/shared/types';
import { PluginConnection, normalizeOutput } from '../../../electron/core/tools/extensions';
import { callMiniMaxPlan } from '../../../electron/modules/plugins/minimax-plan';
import { setServiceTransport } from '../../../electron/services/network/service-network';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  setServiceTransport();
});
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=';
const tools: PluginTool[] = [
  {
    name: 'text_to_image',
    description: '生成图片',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        n: { type: 'integer' },
        aspect_ratio: { enum: ['1:1', '16:9'] },
        resolution: { enum: ['1K', '2K'] },
      },
      required: ['prompt'],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'generate_video',
    description: '生成视频',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        model: { enum: ['video-test'] },
        duration: { type: 'number' },
        resolution: { enum: ['768P'] },
        ratio: { enum: ['16:9'] },
      },
      required: ['prompt', 'model', 'duration'],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'query_video_generation',
    description: '查询视频',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' }, model: { type: 'string' } },
      required: ['task_id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'text_to_audio',
    description: '语音生成',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        voice_id: { type: 'string' },
        speed: { type: 'number', minimum: 0.5, maximum: 2 },
      },
      required: ['text'],
    },
    annotations: { readOnlyHint: false },
  },
];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tongzhou-media-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
  cleanups.push(() => store.close());
  const script = path.join(root, 'media.cjs'),
    log = path.join(root, 'calls.jsonl');
  await writeFile(
    script,
    `const fs=require('node:fs'),readline=require('node:readline');const tools=${JSON.stringify(tools)};readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result={};if(r.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'media-test',version:'1'}};if(r.method==='tools/list')result={tools};if(r.method==='tools/call'){fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(r.params)+'\\n');const name=r.params.name,args=r.params.arguments;if(name==='text_to_image'){const calls=fs.readFileSync(${JSON.stringify(log)},'utf8').trim().split('\\n').map(JSON.parse).filter(c=>c.name==='text_to_image').length;result=args.prompt.includes('partial')&&calls===2?{isError:true,content:[{type:'text',text:'fixture failure'}]}:{content:[{type:'image',mimeType:'image/png',data:'${png}'}]};}else if(name==='text_to_audio')result={content:[{type:'resource',resource:{uri:'speech.wav',mimeType:'audio/wav',blob:Buffer.from('RIFFfixture-audio').toString('base64')}}]};else if(name==='generate_video')result={content:[{type:'text',text:JSON.stringify({task_id:'video-job-1',status:'processing'})}]};else {const calls=fs.readFileSync(${JSON.stringify(log)},'utf8').trim().split('\\n').map(JSON.parse),prompt=calls.find(c=>c.name==='generate_video')?.arguments.prompt ?? ''; if(prompt==='hold')result={content:[{type:'text',text:JSON.stringify({task_id:'video-job-1',status:'processing'})}]};else if(prompt==='resume'&&calls.filter(c=>c.name==='query_video_generation').length===1)result={isError:true,content:[{type:'text',text:'query disconnected'}]};else result={content:[{type:'resource',resource:{uri:'result.mp4',mimeType:'video/mp4',blob:'AAAAGGZ0eXBpc29tAAACAGlzb21pc28y'}}]};}}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`,
  );
  store.put('plugin', {
    id: 'media',
    name: '媒体测试',
    transport: 'stdio',
    command: process.execPath,
    args: [script],
    url: '',
    enabled: true,
    readOnlyTools: ['query_video_generation'],
    catalog: tools,
  });
  const session = store.createSession();
  store.setSessionPermission(session.id, 'full-access');
  const system = await createTaskFixture(store, root);
  cleanups.push(() => system.dispose());
  const canvas = (node: CanvasNode) =>
    system.domains.canvases.save({
      title: '媒体工作流',
      nodes: [node],
      edges: [],
      selection: [node.id],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
  const calls = async () => {
    try {
      return (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const run = async (
    c: ReturnType<typeof canvas>,
    regenerate?: import('../../../src/shared/canvas').CanvasExecute['regenerate'],
    saveResource = false,
  ) => {
    const started = system.domains.canvasWorkflows.start({
      canvasId: c.id,
      version: c.version,
      sessionId: session.id,
      reuse: true,
      regenerate,
      ...(saveResource ? { saveResource: true, nodeIds: [c.nodes[0].id] } : {}),
    });
    await expect
      .poll(() => system.domains.canvases.runs.get(started.id).status)
      .not.toBe('running');
    return system.domains.canvases.runs.get(started.id);
  };
  return { root, store, system, session, canvas, calls, run };
}
const image = (count = 3): CanvasNode => ({
  id: 'image',
  kind: 'image',
  title: '人物候选',
  x: 0,
  y: 0,
  text: '雨夜钟表师人物设定',
  media: {
    pluginId: 'media',
    tool: 'text_to_image',
    count,
    mode: 'text',
    aspectRatio: '1:1',
    resolution: '1K',
  },
});

describe('media plugin nodes', () => {
  it('saves and previews the MiniMax plan batch response through the canvas task pipeline', async () => {
    const f = await fixture();
    f.store.setCapability('computer', true);
    const vendor = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 0,
            success_items: [
              {
                is_success: true,
                output_file: 'slot_0.png',
                output_url: 'https://cdn.example.test/character.png',
                has_image_output: true,
              },
            ],
            failed_items: [],
            base_resp: { status_code: 0 },
          }),
        ),
    );
    const download = vi.fn(
      async () =>
        new Response(Buffer.from(png, 'base64'), { headers: { 'Content-Type': 'image/png' } }),
    );
    setServiceTransport(download);
    vi.spyOn(PluginConnection.prototype, 'call').mockImplementation(async (_name, args, signal) =>
      normalizeOutput(
        await callMiniMaxPlan(
          'minimax-multimedia',
          'text_to_image',
          { prompt: args.prompt, aspect_ratio: args.aspect_ratio, resolution: args.resolution },
          'https://agent.minimax.cn',
          'test-token',
          signal,
          vendor,
        ),
        true,
      ),
    );
    const c = f.canvas(image(1));
    const run = await f.run(c);
    expect(run.status, JSON.stringify(run.nodes)).toBe('completed');
    const ref = run.nodes.image.output!.resources.find((r) => r.kind === 'artifact')!;
    expect(f.system.domains.artifacts.preview(ref.id).type).toBe('image');
    expect(vendor).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(1);
    expect((await f.run(c)).nodes.image.status).toBe('cached');
    expect(vendor).toHaveBeenCalledTimes(1);
  });
  it('generates and previews an image with desktop control enabled but no desktop adapter', async () => {
    const f = await fixture();
    f.store.setCapability('computer', true);
    const c = f.canvas(image(1));
    const run = await f.run(c);
    expect(run.status).toBe('completed');
    expect((await f.calls()).filter((c) => c.name === 'text_to_image')).toHaveLength(1);
    const resource = run.nodes.image.output!.resources.find((r) => r.kind === 'artifact')!;
    expect(resource).toBeDefined();
    expect(f.system.domains.artifacts.preview(resource.id).type).toBe('image');
    expect((await f.run(c)).nodes.image.status).toBe('cached');
    expect((await f.calls()).filter((c) => c.name === 'text_to_image')).toHaveLength(1);
  });
  it('runs audio batches through the real MCP task pipeline, saves originals and reuses unchanged output', async () => {
    const f = await fixture();
    const c = f.canvas({
      id: 'voice',
      kind: 'audio',
      title: '旁白',
      x: 0,
      y: 0,
      text: '欢迎来到同舟',
      media: {
        pluginId: 'media',
        tool: 'text_to_audio',
        voice: 'narrator',
        speed: 1.1,
        count: 2,
        mode: 'text',
        destination: { kind: 'content', libraryId: 'default' },
      },
    });
    const first = await f.run(c);
    expect(first.status).toBe('completed');
    expect(first.nodes.voice.generation).toHaveLength(2);
    expect(first.nodes.voice.output!.resources.some((r) => r.kind === 'content')).toBe(true);
    const calls = await f.calls();
    expect(calls.filter((c) => c.name === 'text_to_audio')).toHaveLength(2);
    expect(calls[0].arguments).toEqual({ text: '欢迎来到同舟', voice_id: 'narrator', speed: 1.1 });
    const again = await f.run(c);
    expect(again.nodes.voice.status).toBe('cached');
    expect((await f.calls()).filter((c) => c.name === 'text_to_audio')).toHaveLength(2);
    const changed = f.system.domains.canvases.apply(c.id, c.version, [
      { type: 'put_node', node: { ...c.nodes[0], media: { ...c.nodes[0].media, speed: 1.4 } } },
    ]);
    expect((await f.run(changed)).status).toBe('completed');
    expect((await f.calls()).filter((c) => c.name === 'text_to_audio')).toHaveLength(4);
  });
  it('previews larger canvas image originals without changing the content-library thumbnail limit', async () => {
    const f = await fixture(),
      doc = f.system.domains.knowledge.importFile(
        '4K.png',
        Buffer.concat([Buffer.from(png, 'base64'), Buffer.alloc(3_000_000)]),
      );
    expect(f.system.domains.content.preview(doc.id).type).toBe('file');
    expect(
      f.system.domains.canvasWorkflows.resources.preview({
        kind: 'content',
        id: doc.id,
        version: doc.version,
      }).type,
    ).toBe('image');
  });
  it('persists node dimensions and reuses generation when only the card is resized', async () => {
    const f = await fixture(),
      c = f.canvas({ ...image(1), width: 430, height: 310 });
    await f.run(c);
    const resized = f.system.domains.canvases.apply(c.id, c.version, [
      { type: 'put_node', node: { ...c.nodes[0], width: 550, height: 400 } },
    ]);
    expect((await f.run(resized)).nodes.image.status).toBe('cached');
    expect(await f.calls()).toHaveLength(1);
    expect(f.system.domains.canvases.get(c.id).nodes[0]).toMatchObject({ width: 550, height: 400 });
  });
  it('saves existing image nodes to artifacts by default and exports to a selected directory without a model or media service', async () => {
    const f = await fixture(),
      doc = f.system.domains.knowledge.importFile('原有图片.png', Buffer.from(png, 'base64'));
    const source: CanvasNode = {
      id: 'existing',
      kind: 'image',
      title: '现有图片',
      x: 0,
      y: 0,
      resource: { kind: 'content', id: doc.id, version: doc.version },
      media: { mode: 'existing' },
    };
    const c = f.canvas(source),
      r = await f.run(c, undefined, true);
    expect(r.status).toBe('completed');
    const ref = r.nodes.existing.output!.resources.find((r) => r.kind === 'artifact')!;
    expect(f.system.domains.artifacts.bytes((ref as any).id)).toEqual(Buffer.from(png, 'base64'));
    expect(await f.calls()).toEqual([]);
    const folder = path.join(f.root, '现有图另存'),
      next = f.system.domains.canvases.apply(c.id, c.version, [
        {
          type: 'put_node',
          node: {
            ...source,
            media: { mode: 'existing', destination: { kind: 'directory', path: folder } },
          },
        },
      ]);
    expect((await f.run(next, undefined, true)).status).toBe('completed');
    expect(await readdir(folder)).toHaveLength(1);
    expect((await f.run(next)).nodes.existing.output!.resources).toEqual([source.resource]);
  });
  it('combines referenced prompt content and per-node custom prompts for actual image generation', async () => {
    const f = await fixture(),
      doc = f.system.domains.content.write({
        title: '镜头提示词',
        content: '雨夜老钟表铺，竖屏电影感',
        libraryId: 'default',
      });
    const source: CanvasNode = {
      id: 'prompt',
      kind: 'resource',
      title: '自定义提示词',
      x: 0,
      y: 0,
      text: '蓝色光线，保留怀表',
      resource: { kind: 'content', id: doc.id, version: doc.version },
    };
    const n = { ...image(1), text: '' };
    const c = f.system.domains.canvases.save({
      title: '提示词生成',
      nodes: [source, n],
      edges: [{ id: 'e', from: 'prompt', to: 'image', kind: 'reference' }],
      selection: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    const run = await f.run(c);
    expect(run.status).toBe('completed');
    expect((await f.calls())[0].arguments.prompt).toContain('竖屏电影感');
    expect((await f.calls())[0].arguments.prompt).toContain('蓝色光线，保留怀表');
    expect(f.system.domains.content.document(doc.id).content).toBe('雨夜老钟表铺，竖屏电影感');
  });
  it('executes a generic MCP node through the registered node plugin and normal tool pipeline', async () => {
    const f = await fixture(),
      c = f.canvas({
        id: 'tool',
        kind: 'plugin',
        pluginId: 'plugin',
        title: '工具插件节点',
        text: '按提示词生成',
        x: 0,
        y: 0,
        config: { pluginId: 'media', tool: 'text_to_image', arguments: { aspect_ratio: '1:1' } },
      });
    const run = await f.run(c);
    expect(run.status).toBe('completed');
    expect(run.nodes.tool.plugin).toEqual({ id: 'plugin', version: 1 });
    expect((await f.calls())[0].arguments.prompt).toContain('按提示词生成');
    expect(run.nodes.tool.output!.resources.some((r) => r.kind === 'artifact')).toBe(true);
    expect(f.store.list<any>('run').every((r) => !r.config.executionCore)).toBe(true);
  });
  it('maps explicit first/tail frames, references, ratio and resolution to supported plugin parameters', async () => {
    const f = await fixture(),
      base = await f.run(f.canvas(image(1))),
      step = base.nodes.image;
    const origin = { sessionId: step.taskSessionId!, runId: step.taskRunId! };
    const first = await f.system.domains.artifacts.save(
        { name: 'first.png', url: 'https://example.com/first.png' },
        origin,
      ),
      last = await f.system.domains.artifacts.save(
        { name: 'last.png', url: 'https://example.com/last.png' },
        origin,
      );
    const a = { kind: 'artifact' as const, id: first.id },
      b = { kind: 'artifact' as const, id: last.id };
    const tool: PluginTool = {
      name: 'video',
      description: '',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          first_frame_image_url: { type: 'string' },
          last_frame_image_url: { type: 'string' },
          ratio: { enum: ['9:16'] },
          resolution: { enum: ['1080P'] },
          duration: { type: 'integer', minimum: 4, maximum: 10 },
          seed: { type: 'integer' },
        },
        required: ['prompt'],
      },
    };
    const n: CanvasNode = {
      id: 'v',
      title: '镜头',
      kind: 'video',
      x: 0,
      y: 0,
      text: '镜头缓慢向前',
      media: {
        mode: 'frames',
        firstFrame: a,
        lastFrame: b,
        aspectRatio: '9:16',
        resolution: '1080P',
        duration: 6,
        parameters: { seed: 42 },
      },
    };
    const args = await mediaArguments(n, tool, [], f.system.domains, path.join(f.root, 'frames'));
    const wired = await mediaArguments(
      { ...n, media: { ...n.media, mode: 'text', firstFrame: undefined, lastFrame: undefined } },
      tool,
      [
        { text: '尾帧说明不会混入提示词', resources: [b], inputPort: 'lastFrame' },
        { text: '首帧说明不会混入提示词', resources: [a], inputPort: 'firstFrame' },
        { text: '保持镜头稳定', resources: [], inputPort: 'prompt' },
      ],
      f.system.domains,
      path.join(f.root, 'wired-frames'),
    );
    expect(wired.first_frame_image_url).toBe('https://example.com/first.png');
    expect(wired.last_frame_image_url).toBe('https://example.com/last.png');
    expect(wired.prompt).toBe('镜头缓慢向前\n\n保持镜头稳定');
    expect(args).toMatchObject({
      prompt: '镜头缓慢向前',
      first_frame_image_url: 'https://example.com/first.png',
      last_frame_image_url: 'https://example.com/last.png',
      ratio: '9:16',
      resolution: '1080P',
      duration: 6,
      seed: 42,
    });
    await expect(
      mediaArguments(
        { ...n, media: { ...n.media, lastFrame: undefined } },
        tool,
        [],
        f.system.domains,
        path.join(f.root, 'missing'),
      ),
    ).rejects.toThrow('需要两张');
    await expect(
      mediaArguments(
        n,
        {
          ...tool,
          inputSchema: {
            ...tool.inputSchema,
            properties: {
              prompt: { type: 'string' },
              first_frame_image_url: { type: 'string' },
              ratio: { enum: ['9:16'] },
              resolution: { enum: ['1080P'] },
              duration: { type: 'integer' },
              seed: { type: 'integer' },
            },
          },
        },
        [],
        f.system.domains,
        path.join(f.root, 'unsupported'),
      ),
    ).rejects.toThrow('不支持尾帧');
    const referenceTool = {
      ...tool,
      inputSchema: {
        type: 'object',
        properties: { prompt: { type: 'string' }, input_urls: { type: 'array' } },
      },
    };
    const reference = {
      ...image(1),
      media: { mode: 'reference' as const, referenceImages: [a, b] },
    };
    expect(
      await mediaArguments(
        { ...reference, media: { ...reference.media, referenceImages: [a] } },
        referenceTool,
        [{ text: '', resources: [a, b], inputPort: 'reference' }],
        f.system.domains,
        path.join(f.root, 'combined-ref'),
      ),
    ).toMatchObject({
      input_urls: ['https://example.com/first.png', 'https://example.com/last.png'],
    });
    expect(
      await mediaArguments(
        reference,
        referenceTool,
        [],
        f.system.domains,
        path.join(f.root, 'ref'),
      ),
    ).toMatchObject({
      input_urls: ['https://example.com/first.png', 'https://example.com/last.png'],
    });
  });
  it('generates multiple real artifacts without an LLM, reuses results, and regenerates only one item while retaining old versions', async () => {
    const f = await fixture(),
      c = f.canvas(image()),
      first = await f.run(c);
    expect(first.status).toBe('completed');
    expect(first.nodes.image.generation).toHaveLength(3);
    expect((await f.calls()).filter((c) => c.name === 'text_to_image')).toHaveLength(3);
    const original = first.nodes.image.generation!.map((i) => i.resources[0]);
    for (const ref of original)
      expect(f.system.domains.artifacts.bytes((ref as any).id)).toEqual(Buffer.from(png, 'base64'));
    expect(
      f.store
        .list<any>('run')
        .every((r) => r.inputTokens === 0 && r.outputTokens === 0 && !r.config.executionCore),
    ).toBe(true);
    const cached = await f.run(c);
    expect(cached.nodes.image.status).toBe('cached');
    expect(await f.calls()).toHaveLength(3);
    const next = await f.run(c, { nodeId: 'image', indices: [1] });
    expect(next.status).toBe('completed');
    expect(await f.calls()).toHaveLength(4);
    expect(next.nodes.image.generation![0].resources).toEqual(
      first.nodes.image.generation![0].resources,
    );
    expect(next.nodes.image.generation![1].resources[0]).not.toEqual(original[1]);
    expect(f.system.domains.artifacts.read((original[1] as any).id)).toBeDefined();
  });
  it('retains partial successes and retries only the failed generation item', async () => {
    const f = await fixture(),
      n = { ...image(), text: 'partial' },
      c = f.canvas(n),
      first = await f.run(c);
    expect(first.status).toBe('failed');
    expect(first.nodes.image.generation!.map((i) => i.status)).toEqual([
      'completed',
      'failed',
      'completed',
    ]);
    const second = await f.run(c, { nodeId: 'image', indices: [1] });
    expect(second.status).toBe('completed');
    expect(await f.calls()).toHaveLength(4);
    expect(second.nodes.image.generation![0].resources).toEqual(
      first.nodes.image.generation![0].resources,
    );
  });
  it('saves generated originals into a selected directory and defaults to managed artifacts', async () => {
    const f = await fixture(),
      folder = path.join(f.root, '输出目录'),
      c = f.canvas({
        ...image(2),
        media: { ...image(2).media, destination: { kind: 'directory', path: folder } },
      }),
      r = await f.run(c);
    expect(r.status).toBe('completed');
    expect(await readdir(folder)).toHaveLength(2);
    for (const item of r.nodes.image.generation!)
      expect(await readFile(item.savedPaths![0])).toEqual(Buffer.from(png, 'base64'));
  });
  it('copies media to the chosen content folder using the existing library owner', async () => {
    const f = await fixture(),
      lib = f.system.domains.content.saveLibrary({ name: '漫剧资产' }),
      folder = f.system.domains.knowledge.saveFolder({ name: '人物', libraryId: lib.id });
    const c = f.canvas({
        ...image(1),
        media: {
          ...image(1).media,
          destination: { kind: 'content', libraryId: lib.id, folderId: folder.id },
        },
      }),
      r = await f.run(c);
    expect(r.status).toBe('completed');
    const ref = r.nodes.image.generation![0].resources.find((r) => r.kind === 'content')!;
    expect(f.system.domains.content.document((ref as any).id).folderId).toBe(folder.id);
    expect(f.system.domains.knowledge.originalBytes((ref as any).id)).toEqual(
      Buffer.from(png, 'base64'),
    );
  });
  it('keeps a video task ID and polls instead of submitting another paid generation request', async () => {
    const f = await fixture(),
      c = f.canvas({
        id: 'video',
        kind: 'video',
        title: '镜头一',
        x: 0,
        y: 0,
        text: '雨滴落下',
        media: {
          pluginId: 'media',
          tool: 'generate_video',
          model: 'video-test',
          count: 1,
          duration: 6,
          mode: 'text',
        },
      }),
      r = await f.run(c);
    expect(r.status).toBe('completed');
    expect(r.nodes.video.generation![0].remoteTaskId).toBe('video-job-1');
    const calls = await f.calls();
    expect(calls.filter((c) => c.name === 'generate_video')).toHaveLength(1);
    expect(calls.filter((c) => c.name === 'query_video_generation')).toHaveLength(1);
    const ref = r.nodes.video.generation![0].resources[0];
    expect(f.system.domains.artifacts.preview((ref as any).id).type).toBe('video');
  });
  it('uses existing approval and cancellation before a plugin may submit generation', async () => {
    const f = await fixture();
    f.store.setSessionPermission(f.session.id, 'ask');
    const c = f.canvas(image(1));
    const pending = f.run(c);
    await expect.poll(() => f.system.tasks.snapshot().approvals.length).toBe(1);
    expect(await f.calls()).toEqual([]);
    f.system.approvals.approve(f.system.tasks.snapshot().approvals[0].id, true);
    expect((await pending).status).toBe('completed');
    const second = f.system.domains.canvasWorkflows.start({
      canvasId: c.id,
      version: c.version,
      sessionId: f.session.id,
    });
    await expect.poll(() => f.system.tasks.snapshot().approvals.length).toBe(1);
    await f.system.domains.canvasWorkflows.cancel(second.id);
    await expect.poll(() => f.system.domains.canvases.runs.get(second.id).status).toBe('cancelled');
    expect(await f.calls()).toHaveLength(1);
  });
  it('resumes the selected historical video job without paying for a second submission', async () => {
    const f = await fixture(),
      c = f.canvas({
        id: 'video',
        kind: 'video',
        title: '视频',
        x: 0,
        y: 0,
        text: 'resume',
        media: { pluginId: 'media', tool: 'generate_video', model: 'video-test' },
      });
    const first = await f.run(c);
    expect(first.status).toBe('failed');
    expect(first.nodes.video.generation![0].remoteTaskId).toBe('video-job-1');
    const second = await f.run(c, {
      sourceRunId: first.id,
      nodeId: 'video',
      indices: [0],
      action: 'resume',
    });
    expect(second.status).toBe('completed');
    expect((await f.calls()).filter((c) => c.name === 'generate_video')).toHaveLength(1);
    expect((await f.calls()).filter((c) => c.name === 'query_video_generation')).toHaveLength(2);
  });
  it('cancels polling and keeps its remote task ID for a later explicit resume', async () => {
    const f = await fixture(),
      c = f.canvas({
        id: 'video',
        kind: 'video',
        title: '视频',
        x: 0,
        y: 0,
        text: 'hold',
        media: { pluginId: 'media', tool: 'generate_video', model: 'video-test' },
      });
    const started = f.system.domains.canvasWorkflows.start({
      canvasId: c.id,
      version: c.version,
      sessionId: f.session.id,
    });
    await expect
      .poll(async () => (await f.calls()).some((c) => c.name === 'query_video_generation'))
      .toBe(true);
    await f.system.domains.canvasWorkflows.cancel(started.id);
    await expect
      .poll(() => f.system.domains.canvases.runs.get(started.id).status)
      .toBe('cancelled');
    expect(
      f.system.domains.canvases.runs.get(started.id).nodes.video.generation![0].remoteTaskId,
    ).toBe('video-job-1');
    expect((await f.calls()).filter((c) => c.name === 'generate_video')).toHaveLength(1);
  });
  it('takes regeneration from the displayed historical run and permits whole-group prompt changes', async () => {
    const f = await fixture(),
      c = f.canvas(image(2));
    const first = await f.run(c),
      second = await f.run(c, { nodeId: 'image' });
    const third = await f.run(c, { sourceRunId: first.id, nodeId: 'image', indices: [0] });
    expect(third.nodes.image.generation![1].resources).toEqual(
      first.nodes.image.generation![1].resources,
    );
    expect(third.nodes.image.generation![1].resources).not.toEqual(
      second.nodes.image.generation![1].resources,
    );
    const edited = f.system.domains.canvases.apply(c.id, c.version, [
      { type: 'put_node', node: { ...image(2), text: '新提示词' } },
    ]);
    const fourth = await f.run(edited, { sourceRunId: third.id, nodeId: 'image' });
    expect(fourth.status).toBe('completed');
    expect((await f.calls()).filter((c) => c.name === 'text_to_image')).toHaveLength(7);
  });
  it('retries a failed save without re-generating the image', async () => {
    const f = await fixture(),
      folder = path.join(f.root, 'not-a-folder');
    await writeFile(folder, 'occupied');
    const c = f.canvas({
        ...image(1),
        media: { ...image(1).media, destination: { kind: 'directory', path: folder } },
      }),
      first = await f.run(c);
    expect(first.status).toBe('failed');
    expect(first.nodes.image.generation![0].phase).toBe('save');
    await rm(folder);
    const next = await f.run(c, { nodeId: 'image', indices: [0], action: 'save' });
    expect(next.status).toBe('completed');
    expect(await f.calls()).toHaveLength(1);
  });
  it('checks prompt/model/ratio support and does not silently upload local reference images', async () => {
    const f = await fixture(),
      root = path.join(f.root, 'references'),
      owners = f.system.domains;
    await expect(
      mediaArguments(
        { ...image(1), media: { ...image(1).media, aspectRatio: '99:1' } },
        tools[0],
        [],
        owners,
        root,
      ),
    ).rejects.toThrow('不支持');
    const doc = owners.knowledge.importFile('人物.png', Buffer.from(png, 'base64'));
    await expect(
      mediaArguments(
        {
          ...image(1),
          media: {
            ...image(1).media,
            mode: 'reference',
            aspectRatio: undefined,
            resolution: undefined,
          },
        },
        {
          ...tools[0],
          inputSchema: {
            properties: { prompt: { type: 'string' }, input_urls: { type: 'array' } },
            required: ['prompt'],
          },
        },
        [{ text: '', resources: [{ kind: 'content', id: doc.id, version: doc.version }] }],
        owners,
        root,
      ),
    ).rejects.toThrow('不会自动上传');
    expect(
      canvasMediaTools(f.store.get<any>('plugin', 'media'), 'video').map((t) => t.name),
    ).toEqual(['generate_video']);
    expect(() => mediaResponse({ text: JSON.stringify({ status: 'failed' }) })).toThrow('失败');
  });
  it('downloads generated URL originals with stable identity and detects invalid responses', async () => {
    const f = await fixture(),
      session = f.store.createSession(),
      id = crypto.randomUUID();
    f.store.put('run', { id, sessionId: session.id, status: 'completed', model: 'fixture' });
    const a = await f.system.domains.artifacts.save(
      { name: 'image.png', url: 'https://example.com/result.png' },
      { sessionId: session.id, runId: id },
    );
    await f.system.domains.artifacts.download(
      a.id,
      new AbortController().signal,
      async () =>
        new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } }),
    );
    expect(f.system.domains.artifacts.read(a.id).remoteUrl).toBeUndefined();
    expect(f.system.domains.artifacts.read(a.id).sourceUrl).toContain('example.com');
    expect(f.system.domains.artifacts.bytes(a.id)).toEqual(Buffer.from(png, 'base64'));
    const bad = await f.system.domains.artifacts.save(
      { name: 'bad.png', url: 'https://example.com/bad.png' },
      { sessionId: session.id, runId: id },
    );
    await expect(
      f.system.domains.artifacts.download(
        bad.id,
        new AbortController().signal,
        async () => new Response('<html>error</html>'),
      ),
    ).rejects.toThrow('无效');
    const video = await f.system.domains.artifacts.save(
      { name: 'invalid.mp4', url: 'https://example.com/error' },
      { sessionId: session.id, runId: id },
    );
    await expect(
      f.system.domains.artifacts.download(
        video.id,
        new AbortController().signal,
        async () =>
          new Response('{"error":"not video"}', {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    ).rejects.toThrow('无效');
    expect(f.system.domains.artifacts.read(video.id).remoteUrl).toBeDefined();
  });
});
