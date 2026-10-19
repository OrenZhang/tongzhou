import { randomUUID, randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Store } from '../../services/storage/store';
import { validateCanvasPorts } from '../../../src/shared/canvas-ports';
import { serviceFetch } from '../../services/network/service-network';
import { pluginSecret } from '../plugins/code-hosting';
import type {
  Canvas,
  CanvasNode,
  CanvasOutput,
  CanvasRun,
  CanvasResource,
} from '../../../src/shared/canvas';
import type { ArtifactOutput } from '../../../src/shared/artifacts';
import type { PluginConfig } from '../../../src/shared/types';
import type { Canvases } from './canvas';
import { executionOrder } from './canvas';
import {
  parseComfyWorkflow,
  comfyConfig,
  comfyFields,
  comfyHash,
  type ComfyCatalog,
} from './comfyui-format';

const MAX_JSON = 4 * 1024 * 1024;
async function bytes(response: Response, limit: number) {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('ComfyUI 请求失败，HTTP ' + response.status);
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('ComfyUI 返回内容超过大小限制');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
export class ComfyClient {
  readonly config: PluginConfig;
  private identity: string;
  constructor(
    private store: Store,
    id: string,
    requireEnabled = true,
  ) {
    this.config = structuredClone(store.get<PluginConfig>('plugin', id));
    if (this.config.protocol !== 'comfyui' || (requireEnabled && !this.config.enabled))
      throw new Error('请选择已启用的 ComfyUI 服务连接');
    this.identity = this.connectionIdentity(this.config);
  }
  private connectionIdentity(config: PluginConfig) {
    return comfyHash({
      id: config.id,
      url: config.url,
      enabled: config.enabled,
      protocol: config.protocol,
      secret: pluginSecret(this.store, config),
    });
  }
  get signature() {
    return this.identity;
  }
  current() {
    const p = this.store.get<PluginConfig>('plugin', this.config.id);
    if (this.connectionIdentity(p) !== this.identity)
      throw new Error('ComfyUI 服务配置已变化，请重新检查');
  }
  private async request(route: string, signal: AbortSignal, init: RequestInit = {}) {
    this.current();
    const headers = new Headers(JSON.parse(pluginSecret(this.store, this.config) || '{}'));
    if (init.body && typeof init.body === 'string') headers.set('Content-Type', 'application/json');
    const response = await serviceFetch(this.config.url.replace(/\/$/, '') + route, {
      ...init,
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      redirect: 'error',
    });
    this.current();
    return response;
  }
  async json(route: string, signal: AbortSignal, body?: unknown) {
    return JSON.parse(
      (
        await bytes(
          await this.request(
            route,
            signal,
            body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) },
          ),
          route === '/object_info' ? 16 * 1024 * 1024 : MAX_JSON,
        )
      ).toString('utf8'),
    );
  }
  async catalog(signal: AbortSignal): Promise<ComfyCatalog> {
    const result = await this.json('/object_info', signal);
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new Error('ComfyUI 返回了无效节点目录');
    return result;
  }
  async upload(name: string, content: Buffer, signal: AbortSignal) {
    if (content.length > 25 * 1024 * 1024) throw new Error('ComfyUI 输入素材超过 25 MB');
    const data = new FormData();
    data.set('image', new Blob([new Uint8Array(content)]), name);
    data.set('overwrite', 'false');
    data.set('type', 'input');
    const result = JSON.parse(
      (
        await bytes(
          await this.request('/upload/image', signal, { method: 'POST', body: data }),
          MAX_JSON,
        )
      ).toString(),
    );
    if (typeof result.name !== 'string') throw new Error('ComfyUI 未返回上传素材名称');
    return (result.subfolder ? result.subfolder + '/' : '') + result.name;
  }
  async file(file: { filename: string; subfolder?: string; type?: string }, signal: AbortSignal) {
    if (
      typeof file.filename !== 'string' ||
      !file.filename ||
      /[\\/]/.test(file.filename) ||
      file.filename.includes('\0')
    )
      throw new Error('ComfyUI 输出文件名无效');
    const query = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder ?? '',
      type: file.type ?? 'output',
    });
    return bytes(await this.request('/view?' + query, signal), 25 * 1024 * 1024);
  }
  async observe(clientId: string, signal: AbortSignal, event: (type: string, data: any) => void) {
    // Native WebSocket has no custom-header API. Authenticated/proxied services retain HTTP polling.
    if (pluginSecret(this.store, this.config) || typeof WebSocket === 'undefined') return () => {};
    const url = new URL(this.config.url.replace(/\/$/, '') + '/ws');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('clientId', clientId);
    const socket = new WebSocket(url);
    let currentNode: string | undefined;
    socket.addEventListener('message', (message) => {
      if (typeof message.data !== 'string' || message.data.length > 100000) return;
      try {
        const value = JSON.parse(message.data);
        if (value.type === 'executing') currentNode = value.data?.node ?? undefined;
        event(value.type, { ...value.data, node: value.data?.node ?? currentNode });
      } catch {
        /* Ignore preview frames and unsupported messages. */
      }
    });
    socket.addEventListener('error', () => {});
    const close = () => {
      signal.removeEventListener('abort', close);
      socket.close();
    };
    signal.addEventListener('abort', close, { once: true });
    if (signal.aborted) close();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.addEventListener('open', finish, { once: true });
      socket.addEventListener('error', finish, { once: true });
      socket.addEventListener('close', finish, { once: true });
    });
    return close;
  }
  async wait(promptId: string, signal: AbortSignal, progress: (text: string) => void) {
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const history = (await this.json('/history/' + encodeURIComponent(promptId), signal))[
        promptId
      ];
      if (history) {
        if (
          history.status?.status_str === 'error' ||
          history.status?.messages?.some((m: any) =>
            ['execution_error', 'execution_interrupted'].includes(m[0]),
          )
        )
          throw new Error('ComfyUI 执行失败或被中断，请检查服务运行记录');
        if (history.status?.completed === true || history.status?.status_str === 'success')
          return history;
      }
      progress('ComfyUI 任务处理中 · ' + promptId);
      await delay(1000, undefined, { signal });
    }
    throw new Error('ComfyUI 查询超时，任务可能仍在服务端执行，请使用继续查询');
  }
}
export interface ComfySource {
  id: string;
  raw: any;
  hash: string;
  format: 'api' | 'ui';
  warnings: string[];
}
export class ComfyWorkflows {
  constructor(
    private store: Store,
    private canvases: Canvases,
  ) {}
  async import(text: string, connectionId?: string) {
    if (Buffer.byteLength(text) > MAX_JSON) throw new Error('ComfyUI 工作流超过 4 MB');
    const raw = JSON.parse(text),
      id = randomUUID();
    const catalog = connectionId
      ? await new ComfyClient(this.store, connectionId).catalog(AbortSignal.timeout(30000))
      : {};
    const parsed = parseComfyWorkflow(raw, id, catalog, connectionId);
    executionOrder(parsed);
    const source: ComfySource = {
      id,
      raw,
      hash: comfyHash(raw),
      format: parsed.format,
      warnings: parsed.warnings,
    };
    this.canvases.imports.put(source);
    try {
      return this.canvases.save({
        title: raw.extra?.title || 'ComfyUI 工作流',
        nodes: parsed.nodes,
        edges: parsed.edges,
        selection: [],
        viewport: { x: 40, y: 40, zoom: 1 },
      });
    } catch (error) {
      this.canvases.imports.remove(id);
      throw error;
    }
  }
  async configure(canvas: Canvas, connectionId: string) {
    const catalog = await new ComfyClient(this.store, connectionId).catalog(
      AbortSignal.timeout(30000),
    );
    const warnings: string[] = [];
    const sources = new Map<string, ReturnType<typeof parseComfyWorkflow>>();
    const nodes = canvas.nodes.map((n) => {
      const c = comfyConfig(n);
      if (!c) return n;
      if (!sources.has(c.sourceId)) {
        const source = this.canvases.imports.get(c.sourceId);
        if (comfyHash(source.raw) !== source.hash) throw new Error('ComfyUI 导入原件校验失败');
        sources.set(c.sourceId, parseComfyWorkflow(source.raw, source.id, catalog, connectionId));
      }
      const parsed = sources.get(c.sourceId)!;
      const replacement = parsed.nodes.find((v) => comfyConfig(v)!.nodeId === c.nodeId);
      if (!replacement) throw new Error('ComfyUI 原件中缺少节点：' + c.nodeId);
      const fresh = comfyConfig(replacement)!;
      if (!catalog[c.classType]) warnings.push('服务缺少节点：' + c.classType);
      warnings.push(...(fresh.issues ?? []).map((issue) => n.title + '：' + issue));
      return {
        ...n,
        pluginId: replacement.pluginId,
        definition: replacement.definition,
        config: {
          ...fresh,
          values: c.issues?.length ? fresh.values : c.values,
          ...(c.controls ? { controls: c.controls } : {}),
        },
      };
    });
    const { updatedAt: _updatedAt, ...write } = canvas;
    const next = this.canvases.save({ ...write, nodes });
    return { canvas: next, warnings: [...new Set(warnings)] };
  }
  async prepare(
    canvas: Canvas,
    nodes: CanvasNode[],
    signal: AbortSignal,
    external = new Map<string, CanvasOutput[]>(),
  ) {
    const configs = nodes.map((n) => comfyConfig(n)!);
    if (new Set(configs.map((c) => c.nodeId)).size !== configs.length)
      throw new Error('ComfyUI 内部节点 ID 重复，请重新导入工作流或为副本指定不同 ID');
    const connectionId = configs[0].connectionId;
    if (
      !connectionId ||
      configs.some((c) => c.connectionId !== connectionId || c.sourceId !== configs[0].sourceId)
    )
      throw new Error('ComfyUI 执行单元需要同一服务与工作流');
    const client = new ComfyClient(this.store, connectionId),
      catalog = await client.catalog(signal);
    const prompt: Record<string, any> = Object.create(null);
    const freshNodes = new Map<string, CanvasNode>();
    for (const node of nodes) {
      const c = comfyConfig(node)!,
        info = Object.hasOwn(catalog, c.classType) ? catalog[c.classType] : undefined;
      if (!info) throw new Error('ComfyUI 服务缺少节点：' + c.classType);
      if (c.issues?.length) throw new Error(node.title + '：' + c.issues.join('；'));
      const fresh = parseComfyWorkflow(
        { [c.nodeId]: { class_type: c.classType, inputs: c.values } },
        c.sourceId,
        catalog,
        connectionId,
      ).nodes[0];
      // Catalog changes must be checked explicitly, not silently remap a saved graph.
      freshNodes.set(node.id, { ...node, definition: fresh.definition });
      const currentFields = comfyFields(info);
      const allowed = new Set(Object.keys(currentFields));
      const values = { ...c.values };
      for (const key of Object.keys(values))
        if (!allowed.has(key)) throw new Error(`${node.title}：服务不支持参数 ${key}`);
      for (const edge of canvas.edges.filter(
        (e) => e.to === node.id && nodes.some((n) => n.id === e.from),
      )) {
        const source = comfyConfig(nodes.find((n) => n.id === edge.from)!)!;
        const slot = /^out:(\d+)$/.exec(edge.fromPort ?? '');
        const name = edge.toPort?.slice(3);
        if (!slot || !edge.toPort?.startsWith('in:') || !name || !allowed.has(name))
          throw new Error('ComfyUI 内部端口无效，请重新检查服务');
        const outputs =
          catalog[source.classType]?.output ??
          catalog[source.classType]?.outputs?.map((o: any) => o.type) ??
          [];
        if (Number(slot[1]) >= outputs.length)
          throw new Error('ComfyUI 输出槽已变化，请重新检查服务');
        values[name] = [source.nodeId, Number(slot[1])];
      }
      const linked = new Set(
        canvas.edges.filter((e) => e.to === node.id).map((e) => e.toPort?.slice(3)),
      );
      for (const [key, schema] of Object.entries(
        fresh.definition!.configSchema.properties ?? {},
      ) as [string, any][]) {
        if (linked.has(key) || values[key] === undefined) continue;
        const value = values[key];
        if (
          (schema.enum && !schema.enum.includes(value)) ||
          (['number', 'integer'].includes(schema.type) &&
            (typeof value !== 'number' ||
              !Number.isFinite(value) ||
              (schema.type === 'integer' && !Number.isSafeInteger(value)) ||
              value < (schema.minimum ?? -Infinity) ||
              value > (schema.maximum ?? Infinity))) ||
          (schema.type === 'string' && typeof value !== 'string') ||
          (schema.type === 'boolean' && typeof value !== 'boolean')
        )
          throw new Error(`${node.title}：参数 ${key} 无效或当前服务不支持`);
      }
      for (const name of Object.keys(
        info.input?.required ??
          (info.inputs
            ? Object.fromEntries(
                Object.entries(info.inputs).filter(([, v]: any) => !v.isOptional && !v.hidden),
              )
            : {}),
      )) {
        if (
          values[name] === undefined &&
          !(external.get(node.id) ?? []).some((value) => value.inputPort === 'in:' + name)
        ) {
          const defaults = currentFields[name]?.[1];
          if (defaults?.default !== undefined) values[name] = defaults.default;
          else throw new Error(`${node.title}：缺少必填输入 ${name}`);
        }
      }
      prompt[c.nodeId] = { class_type: c.classType, inputs: values };
    }
    for (const edge of canvas.edges.filter((e) => freshNodes.has(e.to))) {
      const source = freshNodes.get(edge.from) ?? canvas.nodes.find((n) => n.id === edge.from),
        target = freshNodes.get(edge.to)!;
      if (source)
        validateCanvasPorts(
          edge,
          source,
          target,
          source.definition ??
            this.canvases.plugins.list().find((p) => p.id === (source.pluginId ?? source.kind)),
          target.definition,
        );
    }
    if (
      !nodes.some(
        (n) =>
          catalog[comfyConfig(n)!.classType]?.output_node ||
          catalog[comfyConfig(n)!.classType]?.isOutputNode,
      )
    )
      throw new Error('请选择包含 ComfyUI 输出节点的执行范围');
    return { client, prompt, connectionId, catalog };
  }
  async execute(
    canvas: Canvas,
    nodes: CanvasNode[],
    run: CanvasRun,
    signal: AbortSignal,
    inputs: Map<string, CanvasOutput[]>,
    resolve: (ref: CanvasResource) => Promise<{ name: string; bytes: Buffer }>,
    progress: (text: string) => void,
    persist: () => void,
    resume?: CanvasRun,
  ) {
    const prepared = await this.prepare(canvas, nodes, signal, inputs);
    const { client, prompt, connectionId, catalog } = prepared;
    const key = comfyConfig(nodes[0])!.sourceId;
    const logical = (id: string) => comfyConfig(nodes.find((n) => n.id === id)!)?.nodeId ?? id;
    const fingerprint = comfyHash({
      nodes: nodes.map((n) => ({ config: n.config, definition: n.definition })),
      edges: canvas.edges
        .filter((e) => nodes.some((n) => n.id === e.to))
        .map((e) => ({
          from: logical(e.from),
          to: logical(e.to),
          fromPort: e.fromPort,
          toPort: e.toPort,
          kind: e.kind,
        })),
      inputs: [...inputs].map(([id, values]) => [logical(id), values]),
      connection: client.signature,
    });
    const old = resume?.external?.[key];
    if (
      resume &&
      (!old?.promptId || old.fingerprint !== fingerprint || old.connectionId !== connectionId)
    )
      throw new Error('远端任务不存在或参数已变化，不能继续查询；请检查原记录');
    const record: NonNullable<CanvasRun['external']>[string] = old
      ? structuredClone(old)
      : {
          connectionId,
          clientId: randomUUID(),
          fingerprint,
          nodeIds: nodes.map((n) => n.id),
          submittedAt: Date.now(),
        };
    run.external ??= {};
    run.external[key] = record;
    persist();
    const close = await client.observe(record.clientId, signal, (type, data) => {
      if (!record.promptId || data.prompt_id !== record.promptId) return;
      if (type === 'execution_cached' && Array.isArray(data.nodes)) {
        for (const n of nodes)
          if (data.nodes.includes(comfyConfig(n)!.nodeId) && run.nodes[n.id])
            run.nodes[n.id].externalStatus = 'cached';
        persist();
      }
      const node = nodes.find((n) => comfyConfig(n)!.nodeId === String(data.node));
      if (node && run.nodes[node.id]) {
        const step = run.nodes[node.id];
        if (
          type === 'progress' &&
          Number.isFinite(data.value) &&
          Number.isFinite(data.max) &&
          data.max > 0
        )
          step.progress = { value: data.value, max: data.max };
        if (type === 'executing') step.externalStatus = 'running';
        if (type === 'executed') step.externalStatus = 'executed';
        persist();
      }
      if (type === 'progress') progress(`ComfyUI · ${data.node ?? ''} · ${data.value}/${data.max}`);
    });
    try {
      if (!old) {
        for (const node of nodes) {
          const c = comfyConfig(node)!;
          for (const value of inputs.get(node.id) ?? []) {
            const field = value.inputPort?.startsWith('in:') ? value.inputPort.slice(3) : undefined;
            if (!field || !(field in comfyFields(catalog[c.classType])))
              throw new Error('ComfyUI 外部输入需要明确的参数端口');
            const [type, options = {}] = comfyFields(catalog[c.classType])[field];
            if (
              value.resources.length &&
              !(options.image_upload || (c.classType === 'LoadImage' && field === 'image'))
            )
              throw new Error('此 ComfyUI 参数不接受上传图片');
            const scalar = value.value ?? value.text;
            if (
              !value.resources.length &&
              ((type === 'STRING' && typeof scalar !== 'string') ||
                (type === 'INT' && !Number.isSafeInteger(scalar)) ||
                (type === 'FLOAT' && (typeof scalar !== 'number' || !Number.isFinite(scalar))) ||
                (type === 'BOOLEAN' && typeof scalar !== 'boolean') ||
                (Array.isArray(type) && !type.includes(scalar)))
            )
              throw new Error('ComfyUI 上游参数类型或选项不兼容：' + field);
            if (value.resources.length) {
              if (value.resources.length !== 1)
                throw new Error('ComfyUI 素材端口每次只接受一个原件');
              const file = await resolve(value.resources[0]);
              prompt[c.nodeId].inputs[field] = await client.upload(file.name, file.bytes, signal);
            } else prompt[c.nodeId].inputs[field] = value.value ?? value.text;
          }
        }
        const previous = this.canvases.runs
          .list()
          .filter(
            (r) => r.id !== run.id && r.canvasId === run.canvasId && r.external?.[key]?.promptId,
          )
          .sort((a, b) => b.startedAt - a.startedAt)[0]?.external?.[key];
        record.controls = {};
        for (const node of nodes) {
          const c = comfyConfig(node)!;
          for (const [field, mode] of Object.entries(c.controls ?? {})) {
            const base = prompt[c.nodeId].inputs[field];
            if (Array.isArray(base)) continue;
            const limits = comfyFields(catalog[c.classType])[field]?.[1] ?? {};
            const old =
              previous?.connectionId === connectionId
                ? previous.controls?.[c.nodeId + ':' + field]
                : undefined;
            let value = base;
            if (mode === 'randomize')
              value = randomInt(
                Math.max(0, limits.min ?? 0),
                Math.min(2 ** 32 - 1, limits.max ?? 2 ** 32 - 1) + 1,
              );
            else if (
              (mode === 'increment' || mode === 'decrement') &&
              old &&
              old.base === base &&
              old.mode === mode
            )
              value = old.value + (mode === 'increment' ? 1 : -1);
            if (
              !Number.isSafeInteger(value) ||
              value < (limits.min ?? -Infinity) ||
              value > (limits.max ?? Infinity)
            )
              throw new Error('种子策略超出服务参数范围，请调整种子');
            prompt[c.nodeId].inputs[field] = value;
            record.controls[c.nodeId + ':' + field] = { base, value, mode };
          }
        }
        record.submittedPrompt = structuredClone(prompt);
        record.uncertain = true;
        persist();
        // A failed submission can have reached the server. Never automatically repeat this POST.
        const queued = await client
          .json('/prompt', signal, { prompt, client_id: record.clientId })
          .catch((error) => {
            throw new Error(
              'ComfyUI 提交未确认，服务端可能已接收，请先检查队列，勿自动重新生成：' +
                String(error),
            );
          });
        if (
          queued.error ||
          (queued.node_errors && Object.keys(queued.node_errors).length) ||
          typeof queued.prompt_id !== 'string'
        )
          throw new Error(
            'ComfyUI 拒绝工作流：' +
              JSON.stringify(queued.node_errors ?? queued.error ?? {}).slice(0, 1200),
          );
        record.promptId = queued.prompt_id;
        record.uncertain = false;
        persist();
      }
      const history = await client.wait(record.promptId!, signal, progress);
      const artifacts: ArtifactOutput[] = [],
        byNode = new Map<string, string[]>();
      for (const node of nodes) {
        const c = comfyConfig(node)!,
          output = history.outputs?.[c.nodeId];
        const names: string[] = [];
        for (const values of Object.values(output ?? {}))
          for (const file of Array.isArray(values) ? values : []) {
            if (!file || typeof file.filename !== 'string') continue;
            if (artifacts.length >= 32)
              throw new Error('ComfyUI 输出超过 32 个文件，请缩小执行范围');
            const data = await client.file(file, signal),
              name =
                c.nodeId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) +
                '-' +
                artifacts.length +
                '-' +
                file.filename.slice(-120);
            artifacts.push({ name: name.slice(-180), data: data.toString('base64') });
            names.push(name.slice(-180));
          }
        byNode.set(node.id, names);
      }
      if (!artifacts.length) throw new Error('ComfyUI 已结束但未返回可保存文件，请检查输出节点');
      return { artifacts, byNode, text: 'ComfyUI 已完成，生成 ' + artifacts.length + ' 个文件' };
    } finally {
      close();
    }
  }
  export(canvas: Canvas) {
    const nodes = canvas.nodes.filter((n) => comfyConfig(n));
    if (!nodes.length || nodes.length !== canvas.nodes.length)
      throw new Error('ComfyUI 导出仅支持完整的 ComfyUI 图，请先单独保存该工作流');
    const prompt: Record<string, any> = Object.create(null);
    for (const node of nodes) {
      const c = comfyConfig(node)!;
      if (c.issues?.length) throw new Error('工作流还有未适配的控件，不能导出为可执行 API 格式');
      const inputs = { ...c.values };
      for (const edge of canvas.edges.filter((e) => e.to === node.id)) {
        const source = comfyConfig(nodes.find((n) => n.id === edge.from)!);
        if (!source || !edge.toPort?.startsWith('in:') || !edge.fromPort?.startsWith('out:'))
          throw new Error('存在无法转换的 ComfyUI 连线');
        inputs[edge.toPort.slice(3)] = [source.nodeId, Number(edge.fromPort.slice(4))];
      }
      prompt[c.nodeId] = { class_type: c.classType, inputs, _meta: { title: node.title } };
    }
    return JSON.stringify(prompt, null, 2);
  }
}
