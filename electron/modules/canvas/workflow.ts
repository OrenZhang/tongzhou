import { ComfyWorkflows } from './comfyui';
import { ComfyNodePlugins } from './comfyui-plugin';
import { sessionWorkspace } from '../sessions/session-workspace';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { CanvasNodeContext, CanvasNodePlugin } from './node-plugins';
import { registerVisualPlugins, textSourceOutput } from './visual-plugins';
import { checkedNodeText } from './text-source';
import { splitPlugin } from './split-plugin';
import { registerWorkflowPlugins, type CanvasNotify } from './workflow-plugins';
import { routeCanvasOutput } from '../../../src/shared/canvas-ports';
import { createMcpNodePlugin, type McpNodeOptions } from './plugin-sdk';
import { canvasNodeKinds } from '../../../src/shared/canvas';
import type { TaskOperation } from '../../core/task-contracts';
import { mediaArguments, executeMedia, saveMedia } from './media';
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../../services/storage/store';
import type { ContentWorkspace } from '../content/content';
import type { Knowledge } from '../knowledge/knowledge';
import type { Artifacts } from '../artifacts/artifacts';
import type { Attachments } from '../artifacts/attachments';
import type { TaskService } from '../../core/task-contracts';
import type { ApplicationEvents } from '../../core/application-events';
import type {
  CanvasExecute,
  CanvasNode,
  CanvasOutput,
  CanvasResource,
  CanvasRun,
  CanvasGenerationItem,
} from '../../../src/shared/canvas';
import type { Provider, Run, Session, Project } from '../../../src/shared/types';
import type { ArtifactPreview } from '../../../src/shared/artifacts';
import { effectivePermission } from '../../../src/shared/permissions';
import { agentProfile } from '../agents/agents';
import { builtinAgent, isCanvasAgent } from '../../../src/shared/builtin-agents';
import { read, within } from '../../core/tools/workspace';
import { Canvases, executeSchema, executionOrder, nodeSchema } from './canvas';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Resources = {
  content: ContentWorkspace;
  knowledge: Knowledge;
  artifacts: Artifacts;
  attachments: Attachments;
};

/** Resolves references through existing owners; the canvas never owns media blobs. */
export class CanvasResources {
  constructor(
    private store: Store,
    private domains: Resources,
  ) {}
  validate(ref: CanvasResource, sessionId?: string) {
    if (ref.kind === 'content') {
      const doc = this.domains.content.document(ref.id, sessionId);
      if (doc.version !== ref.version) throw new Error('资源版本已变化，请重新选择：' + doc.title);
    } else if (ref.kind === 'artifact') {
      this.domains.artifacts.read(ref.id);
      if (sessionId && !this.domains.artifacts.accessible(ref.id, sessionId))
        throw new Error('作品不在当前会话范围');
    } else if (ref.kind === 'message') {
      const source = this.store.get<Session>('session', ref.sessionId);
      if (source.memoryJob || source.canvasContext) throw new Error('不能引用内部任务消息');
      if (!this.store.messages(source.id).some((m) => m.id === ref.id))
        throw new Error('消息已删除');
    } else {
      const project = this.store.get<Project>('project', ref.projectId);
      if (project.removed) throw new Error('工作区已移除');
      if (sessionId && this.store.get<Session>('session', sessionId).projectId !== project.id)
        throw new Error('文件不在当前工作区');
    }
  }
  async resolve(ref: CanvasResource): Promise<CanvasOutput> {
    this.validate(ref);
    if (ref.kind === 'content')
      return { text: this.domains.content.document(ref.id).content, resources: [ref] };
    if (ref.kind === 'artifact') {
      const preview = this.domains.artifacts.preview(ref.id);
      return {
        text:
          preview.type === 'text'
            ? (preview.content ?? '')
            : this.domains.artifacts.read(ref.id).name,
        resources: [ref],
      };
    }
    if (ref.kind === 'message')
      return {
        text: this.store.messages(ref.sessionId).find((m) => m.id === ref.id)!.content,
        resources: [ref],
      };
    const project = this.store.get<Project>('project', ref.projectId);
    const text = await read(project.path, ref.path),
      sha256 = createHash('sha256').update(text).digest('hex');
    if (ref.sha256 && ref.sha256 !== sha256)
      throw new Error('文件内容已变化，请重新选择：' + ref.path);
    return { text, resources: [{ ...ref, sha256 }] };
  }
  async readTextSource(ref: CanvasResource) {
    // A deliberate refresh follows the latest source version; execution keeps the edited snapshot.
    if (ref.kind === 'content')
      ref = { ...ref, version: this.domains.content.document(ref.id).version };
    if (ref.kind === 'file') ref = { ...ref, sha256: undefined };
    this.validate(ref);
    let text: string;
    if (ref.kind === 'content') {
      const doc = this.domains.content.document(ref.id);
      if (doc.blob && doc.indexed === false) {
        if (
          !/\.(html?|svg|md|markdown|txt|css|json|xml|csv|ya?ml|log|[cm]?js|tsx?|jsx|py|sql)$/i.test(
            doc.fileName ?? '',
          )
        )
          throw new Error('请选择 HTML、SVG、Markdown 或其他文本资源');
        text = new TextDecoder('utf-8', { fatal: true }).decode(
          this.domains.knowledge.originalBytes(ref.id),
        );
      } else text = doc.content;
    } else if (ref.kind === 'artifact') {
      const artifact = this.domains.artifacts.read(ref.id);
      if (artifact.remoteUrl) throw new Error('请先将外部作品下载到本地，或使用外部地址导入');
      if (
        !/^text\//.test(artifact.mimeType) &&
        !['application/json', 'application/xml', 'image/svg+xml', 'application/xhtml+xml'].includes(
          artifact.mimeType,
        )
      )
        throw new Error('请选择 HTML、SVG、Markdown 或其他文本资源');
      text = new TextDecoder('utf-8', { fatal: true }).decode(this.domains.artifacts.bytes(ref.id));
    } else if (ref.kind === 'file') {
      const bytes = await this.fileBytes(ref);
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      ref = { ...ref, sha256: createHash('sha256').update(bytes).digest('hex') };
    } else text = (await this.resolve(ref)).text;
    return { text: checkedNodeText(text), resource: ref };
  }
  async fileBytes(ref: Extract<CanvasResource, { kind: 'file' }>) {
    this.validate(ref);
    const project = this.store.get<Project>('project', ref.projectId);
    const file = await within(project.path, ref.path);
    if ((await stat(file)).size > 25 * 1024 * 1024) throw new Error('文件素材超过 25 MB');
    const bytes = await readFile(file);
    if (ref.sha256 && createHash('sha256').update(bytes).digest('hex') !== ref.sha256)
      throw new Error('文件内容已变化，请重新选择：' + ref.path);
    return bytes;
  }
  async resolveNode(node: CanvasNode) {
    const output = await this.resolve(node.resource!);
    if (node.text?.trim()) {
      output.prompt = [
        ['image', 'video', 'audio'].includes(this.preview(node.resource!).type) ? '' : output.text,
        node.text,
      ]
        .filter(Boolean)
        .join('\n\n');
      output.text += '\n\n自定义提示词：\n' + node.text;
    }
    return output;
  }
  preview(ref: CanvasResource): ArtifactPreview {
    this.validate(ref);
    if (ref.kind === 'content')
      return this.domains.content.preview(ref.id, undefined, 25 * 1024 * 1024);
    if (ref.kind === 'artifact') return this.domains.artifacts.preview(ref.id);
    return { type: 'file' };
  }
  attachments(outputs: CanvasOutput[]) {
    const refs = [
      ...new Map(outputs.flatMap((o) => o.resources).map((r) => [JSON.stringify(r), r])).values(),
    ];
    return refs.flatMap((ref) => {
      const p = this.preview(ref);
      if (p.type !== 'image' || !p.content) return [];
      const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(p.content);
      if (!match) return [];
      return [
        this.domains.attachments.save({ name: '画布参考图', mimeType: match[1], data: match[2] })
          .id,
      ];
    });
  }
}

/** Sequential dependency execution reuses TaskService, including its tools and approvals. */
export class CanvasWorkflows {
  private active = new Map<string, AbortController>();
  private pending = new Map<string, Promise<void>>();
  private tasks?: TaskService;
  private events?: ApplicationEvents;
  private notify?: CanvasNotify;
  readonly resources: CanvasResources;
  readonly comfy: ComfyWorkflows;
  constructor(
    private store: Store,
    readonly canvases: Canvases,
    private domains: Resources,
    private changed: () => void = () => {},
    private dataDir = path.dirname(store.path),
  ) {
    this.resources = new CanvasResources(store, domains);
    this.comfy = new ComfyWorkflows(store, canvases);
    new ComfyNodePlugins(this.comfy, canvases, this.resources, domains, (run) => this.persist(run));
    const register = (
      kind: CanvasNode['kind'],
      inputs: CanvasNodePlugin['definition']['inputs'],
      outputs: CanvasNodePlugin['definition']['outputs'],
      execute: CanvasNodePlugin['execute'],
      schema?: z.ZodType,
      configKey?: CanvasNodePlugin['configKey'],
    ) =>
      canvases.plugins.register({
        definition: {
          id: kind,
          name: kind === 'plugin' ? 'MCP 工具' : canvasNodeKinds[kind],
          kind,
          version: 1,
          inputs,
          outputs,
          apiVersion: 1,
          adapter: kind === 'plugin' ? 'mcp' : 'native',
        },
        execute,
        schema,
        configKey,
      });
    const referenced = async (c: CanvasNodeContext) => {
      if (!c.own) throw new Error('请先选择引用资源');
      return c.options.saveResource
        ? this.saveResource(c.node, c.run, c.own, c.permission, c.signal)
        : c.own;
    };
    const media = async (c: CanvasNodeContext) => {
      if (c.own) return referenced(c);
      if (!c.node.media) return c.task();
      await this.media(c.node, c.run, c.inputs, c.permission, c.options, c.signal);
      return c.run.nodes[c.node.id].output!;
    };
    register('text', [], ['text'], ({ node }) => textSourceOutput(node));
    registerVisualPlugins(canvases.plugins, (node) => {
      if (this.resources.preview(node.resource!).type !== 'image')
        throw new Error('全景节点需要图片素材');
      return this.resources.resolveNode(node);
    });
    register('resource', [], ['text', 'resource'], referenced);
    register('agent', ['text', 'image', 'resource'], ['text', 'resource'], (c) => c.task());
    canvases.plugins.register(splitPlugin);
    registerWorkflowPlugins(
      canvases.plugins,
      (...args) => {
        if (!this.notify) throw new Error('渠道服务尚未就绪');
        return this.notify(...args);
      },
      (sessionId, runId) => this.store.get<Session>('session', sessionId).automationJob ?? runId,
    );
    register(
      'image',
      ['text', 'image'],
      ['image'],
      media,
      nodeSchema.shape.media.unwrap(),
      'media',
    );
    register(
      'video',
      ['text', 'image'],
      ['video'],
      media,
      nodeSchema.shape.media.unwrap(),
      'media',
    );
    register('audio', ['text'], ['audio'], media, nodeSchema.shape.media.unwrap(), 'media');
    register('save', ['text', 'resource'], ['resource'], (c) => this.saveContent(c));
    this.registerMcpNode({
      id: 'plugin',
      name: 'MCP 工具',
      version: 1,
      description: '调用已连接的 MCP 工具，沿用服务认证与会话权限',
    });
  }
  registerMcpNode(options: McpNodeOptions) {
    return this.canvases.plugins.register(createMcpNodePlugin(options, (c) => this.callTool(c)));
  }
  configureNotifications(notify?: CanvasNotify) {
    this.notify = notify;
  }
  private syncPermission = (sessionId?: string) => {
    for (const id of this.active.keys()) {
      const run = this.canvases.runs.get(id);
      if (sessionId && run.sessionId !== sessionId) continue;
      const owner = this.store.get<Session>('session', run.sessionId);
      const permission = effectivePermission(
        owner,
        this.store.defaultPermission(),
        owner.agentId ? agentProfile(this.store, owner.agentId) : undefined,
      );
      for (const step of Object.values(run.nodes))
        if (step.status === 'running' && step.taskSessionId)
          this.tasks?.setSessionPermission(step.taskSessionId, permission);
    }
  };
  configure(tasks: TaskService, events: ApplicationEvents) {
    this.events?.off('permissionChanged', this.syncPermission);
    this.tasks = tasks;
    this.events = events;
    events.on('permissionChanged', this.syncPermission);
    this.changed = events.changed;
    this.canvases.plugins.changed = events.changed;
  }
  private persist(run: CanvasRun) {
    this.canvases.runs.put(run);
    this.changed();
  }
  start(raw: CanvasExecute) {
    return this.startInternal(raw);
  }
  startScheduled(raw: CanvasExecute, jobId: string) {
    const job = this.store.get<import('../../../src/shared/automation').AutomationJob>(
      'automationJob',
      jobId,
    );
    const session = this.store.get<Session>('session', raw.sessionId);
    if (
      job.status !== 'running' ||
      job.rule.kind !== 'canvas' ||
      session.automationJob !== jobId ||
      job.rule.canvas?.id !== raw.canvasId ||
      job.rule.canvas.version !== raw.version
    )
      throw new Error('定时画布执行上下文无效');
    return this.startInternal(raw, jobId);
  }
  private startInternal(raw: CanvasExecute, jobId?: string) {
    if (!this.tasks || !this.events) throw new Error('任务服务尚未就绪');
    const p = executeSchema.parse(raw),
      canvas = this.canvases.get(p.canvasId);
    if (canvas.mode === 'whiteboard')
      throw new Error('白板用于绘图，请使用 whiteboard_read 和 whiteboard_apply 编辑图形');
    if (canvas.version !== p.version) throw new Error('画布已更新，请保存或重新载入后执行');
    const session = this.store.get<Session>('session', p.sessionId);
    if (
      session.archived ||
      session.canvasContext ||
      session.knowledgeJob ||
      session.memoryJob ||
      (session.automationJob && session.automationJob !== jobId) ||
      session.parentId
    )
      throw new Error('请从普通会话执行工作流');
    const agent = session.agentId ? agentProfile(this.store, session.agentId) : undefined;
    if (effectivePermission(session, this.store.defaultPermission(), agent) === 'read-only')
      throw new Error('当前会话为只读模式');
    if (this.canvases.runs.list().some((r) => r.canvasId === canvas.id && r.status === 'running'))
      throw new Error('此画布正在执行');
    const order = p.saveResource
      ? (p.nodeIds ?? [])
      : this.canvases.plugins.plan(canvas, executionOrder(canvas, p.nodeIds));
    if (
      p.saveResource &&
      (order.length !== 1 ||
        p.regenerate ||
        !canvas.nodes.some(
          (n) =>
            n.id === order[0] &&
            (n.kind === 'resource' ||
              (['image', 'video', 'audio'].includes(n.kind) && n.media?.mode === 'existing')) &&
            n.resource &&
            ['image', 'video', 'audio'].includes(this.resources.preview(n.resource).type),
        ))
    )
      throw new Error('请选择一个可预览的图片、视频或音频资源节点');
    if (!order.length || order.length > 50) throw new Error('每次请选择 1 至 50 个执行节点');
    for (const nodeId of order) {
      const node = canvas.nodes.find((n) => n.id === nodeId)!;
      this.canvases.plugins.validate(node);
      if (
        node.media?.mode === 'existing' &&
        (!['image', 'video', 'audio'].includes(node.kind) ||
          !node.resource ||
          this.resources.preview(node.resource).type !== node.kind)
      )
        throw new Error('请为媒体节点选择对应类型的原件');
      if ((node.kind === 'resource' || node.media?.mode === 'existing') && !node.resource)
        throw new Error('请为资源节点选择内容：' + node.title);
      if (
        (node.kind === 'image' || node.kind === 'video' || node.kind === 'audio') &&
        (node.media || node.kind === 'video' || node.kind === 'audio') &&
        node.media?.mode !== 'existing'
      ) {
        const plugin = node.media?.pluginId
          ? this.store.get<import('../../../src/shared/types').PluginConfig>(
              'plugin',
              node.media.pluginId,
            )
          : undefined;
        if (!plugin?.enabled || !node.media?.tool)
          throw new Error('请先选择已启用的生成插件和工具：' + node.title);
        for (const ref of [
          ...(node.media.referenceImages ?? []),
          node.media.firstFrame,
          node.media.mode === 'frames' ? node.media.lastFrame : undefined,
        ])
          if (ref) this.resources.validate(ref);
        const destination = node.media.destination;
        if (destination?.kind === 'content') this.domains.content.library(destination.libraryId);
        if (destination?.kind === 'directory' && !path.isAbsolute(destination.path))
          throw new Error('请选择本地绝对目录');
        if (!node.text?.trim() && !canvas.edges.some((e) => e.to === node.id))
          throw new Error('请填写生成提示词：' + node.title);
      } else if (
        node.kind === 'agent' ||
        (node.kind === 'image' && node.media?.mode !== 'existing')
      ) {
        const providerId = node.providerId || p.providerId || session.providerId;
        const provider = this.store.get<Provider>('provider', providerId);
        if (provider.enabled === false || !(node.model || p.model || session.model))
          throw new Error('请配置可用的模型连接：' + node.title);
      }
    }
    if (p.regenerate) {
      const n = canvas.nodes.find((n) => n.id === p.regenerate!.nodeId);
      if (!n || !order.includes(n.id) || !['image', 'video', 'audio'].includes(n.kind))
        throw new Error('只能重新生成图片、视频或音频节点');
      if (p.regenerate.indices?.some((i) => i >= (n.media?.count ?? 1)))
        throw new Error('重新生成序号超出数量');
    }
    this.canvases.bind(session.id, canvas.id);
    const run: CanvasRun = {
      id: randomUUID(),
      canvasId: canvas.id,
      sessionId: session.id,
      definition: canvas,
      status: 'running',
      nodes: Object.fromEntries(
        order.map((id) => {
          const d = this.canvases.plugins.get(canvas.nodes.find((n) => n.id === id)!).definition;
          return [id, { status: 'pending' as const, plugin: { id: d.id, version: d.version } }];
        }),
      ),
      startedAt: Date.now(),
    };
    const abort = new AbortController();
    this.active.set(run.id, abort);
    this.persist(run);
    const pending = this.execute(run, order, p, abort.signal).finally(() => {
      this.active.delete(run.id);
      this.pending.delete(run.id);
    });
    this.pending.set(run.id, pending);
    return run;
  }
  async cancel(id: string) {
    const run = this.canvases.runs.get(id);
    if (run.status !== 'running') return;
    this.active.get(id)?.abort();
    for (const step of Object.values(run.nodes))
      if (step.status === 'running' && step.taskSessionId)
        await this.tasks?.cancel(step.taskSessionId);
  }
  async stop() {
    this.events?.off('permissionChanged', this.syncPermission);
    await Promise.all([...this.active.keys()].map((id) => this.cancel(id)));
    await Promise.allSettled([...this.pending.values()]);
  }
  private async execute(
    run: CanvasRun,
    order: string[],
    options: CanvasExecute,
    signal: AbortSignal,
  ) {
    let current: string | undefined;
    try {
      for (const id of order) {
        signal.throwIfAborted();
        if (run.nodes[id].status === 'completed') continue;
        current = id;
        const node = run.definition.nodes.find((n) => n.id === id)!,
          step = run.nodes[id];
        const registered = this.canvases.plugins.get(node).definition;
        if (
          step.plugin &&
          (registered.id !== step.plugin.id || registered.version !== step.plugin.version)
        )
          throw new Error('节点插件版本已变化，请重新启动工作流');
        step.status = 'running';
        step.startedAt = Date.now();
        this.persist(run);
        if (this.canvases.plugins.groupKey(node)) {
          await this.executeGroup(run, node, order, options, signal);
          continue;
        }
        const inputs = await this.inputsFor(run, id, options, signal);
        if (inputs.reduce((size, value) => size + value.text.length, 0) > 120000)
          throw new Error('节点输入超过 120000 字符，请缩小处理范围');
        signal.throwIfAborted();
        const own =
          (node.kind === 'resource' || node.media?.mode === 'existing') && node.resource
            ? await this.resources.resolveNode(node)
            : undefined;
        const session = this.store.get<Session>('session', run.sessionId);
        const providerId = node.providerId || options.providerId || session.providerId;
        const selectedProvider =
          node.kind === 'agent' || (node.kind === 'image' && !node.media)
            ? this.store.get<Provider>('provider', providerId)
            : undefined;
        const model =
          node.model ||
          (node.providerId && node.providerId !== session.providerId
            ? selectedProvider?.models[0]
            : options.model || session.model) ||
          '';
        // The canvas specialist orchestrates the graph; transform nodes need their own task role.
        const agentId =
          node.agentId ||
          (isCanvasAgent(builtinAgent(session.agentId) ?? {}) ? '' : session.agentId);
        const ownerPermission = effectivePermission(
          session,
          this.store.defaultPermission(),
          session.agentId ? agentProfile(this.store, session.agentId) : undefined,
        );
        if (ownerPermission === 'read-only') throw new Error('会话已切换为只读，工作流停止');
        const permission = effectivePermission(
          { ...session, permission: ownerPermission },
          this.store.defaultPermission(),
          agentId ? agentProfile(this.store, agentId) : undefined,
        );
        const { x: _x, y: _y, width: _width, height: _height, group: _group, ...config } = node;
        step.inputs = inputs;
        const provider =
          node.kind === 'agent' || (node.kind === 'image' && !node.media)
            ? this.store.get<Provider>('provider', providerId)
            : undefined;
        step.fingerprint = digest({
          config,
          ...(node.pluginId || step.plugin?.version !== 1 ? { nodePlugin: step.plugin } : {}),
          ...(options.saveResource ? { saveResource: true } : {}),
          inputs,
          own,
          provider,
          model,
          agent: agentId ? agentProfile(this.store, agentId) : undefined,
          permission,
          plugins: this.store.list('plugin'),
          skills: this.store
            .list('skill')
            .map((s: any) => ({ id: s.id, enabled: s.enabled, files: s.files })),
        });
        const cached =
          options.reuse &&
          this.canvases.plugins.get(node).definition.cache !== 'never' &&
          !options.saveResource &&
          options.regenerate?.nodeId !== id
            ? this.canvases.runs
                .list()
                .filter(
                  (r) =>
                    r.id !== run.id && r.canvasId === run.canvasId && r.sessionId === run.sessionId,
                )
                .sort((a, b) => b.startedAt - a.startedAt)
                .flatMap((r) => Object.values(r.nodes))
                .find(
                  (s) =>
                    ['completed', 'cached'].includes(s.status) &&
                    s.fingerprint === step.fingerprint &&
                    s.output,
                )
            : undefined;
        let reusable = !!cached;
        if (cached?.output)
          for (const ref of cached.output.resources)
            try {
              this.resources.validate(ref);
            } catch {
              reusable = false;
            }
        if (cached?.output && reusable) {
          step.output = cached.output;
          step.generation = cached.generation;
          step.generationFingerprint = cached.generationFingerprint;
          step.taskSessionId = cached.taskSessionId;
          step.taskRunId = cached.taskRunId;
          step.status = 'cached';
        } else {
          step.output = await this.canvases.plugins.execute({
            node,
            run,
            inputs,
            own,
            options,
            permission,
            signal,
            task: (operation, connection, prompt) =>
              this.task(
                prompt === undefined ? node : { ...node, text: prompt },
                run,
                inputs,
                connection ??
                  (operation
                    ? { providerId: 'canvas', model: '节点插件', agentId: '' }
                    : { providerId, model, agentId }),
                permission,
                signal,
                operation,
              ),
          });
          step.status = 'completed';
        }
        signal.throwIfAborted();
        step.endedAt = Date.now();
        this.persist(run);
      }
      run.status = 'completed';
    } catch (e) {
      run.status = signal.aborted ? 'cancelled' : 'failed';
      run.error = e instanceof Error ? e.message : String(e);
      if (current) {
        run.nodes[current].status = signal.aborted ? 'cancelled' : 'failed';
        run.nodes[current].error = run.error;
        run.nodes[current].endedAt = Date.now();
      }
      for (const step of Object.values(run.nodes)) {
        if (step.status === 'pending') step.status = 'cancelled';
        for (const item of step.generation ?? [])
          if (item.status === 'pending' || item.status === 'running') item.status = 'cancelled';
      }
    } finally {
      run.endedAt = Date.now();
      this.persist(run);
    }
  }
  private async executeGroup(
    run: CanvasRun,
    node: CanvasNode,
    order: string[],
    options: CanvasExecute,
    signal: AbortSignal,
  ) {
    const plugins = this.canvases.plugins;
    const key = plugins.groupKey(node);
    const nodes = run.definition.nodes.filter(
      (n) => order.includes(n.id) && plugins.groupKey(n) === key,
    );
    const ids = new Set(nodes.map((n) => n.id));
    const inputs = new Map<string, CanvasOutput[]>();
    try {
      for (const n of nodes) {
        const step = run.nodes[n.id];
        step.status = 'running';
        step.startedAt = Date.now();
        inputs.set(n.id, await this.inputsFor(run, n.id, options, signal, ids));
      }
      this.persist(run);
      const owner = this.store.get<Session>('session', run.sessionId);
      const permission = effectivePermission(
        owner,
        this.store.defaultPermission(),
        owner.agentId ? agentProfile(this.store, owner.agentId) : undefined,
      );
      if (permission === 'read-only') throw new Error('当前会话为只读模式');
      const outputs = await plugins.executeGroup({
        node,
        nodes,
        run,
        inputs,
        options,
        permission,
        signal,
        task: (operation, connection = { providerId: 'canvas', model: node.title, agentId: '' }) =>
          this.task(
            node,
            run,
            [...inputs.values()].flat(),
            connection,
            permission,
            signal,
            operation,
          ),
      });
      const leader = run.nodes[node.id];
      for (const n of nodes)
        Object.assign(run.nodes[n.id], {
          output: outputs[n.id],
          taskSessionId: leader.taskSessionId,
          taskRunId: leader.taskRunId,
          status: 'completed',
          endedAt: Date.now(),
        });
    } catch (error) {
      for (const n of nodes) {
        run.nodes[n.id].status = signal.aborted ? 'cancelled' : 'failed';
        run.nodes[n.id].error = String(error);
      }
      throw error;
    } finally {
      this.persist(run);
    }
  }
  private async inputsFor(
    run: CanvasRun,
    id: string,
    options: CanvasExecute,
    signal: AbortSignal,
    excluded = new Set<string>(),
  ) {
    const inputs: CanvasOutput[] = [];
    for (const edge of options.saveResource
      ? []
      : run.definition.edges.filter((e) => e.to === id && !excluded.has(e.from))) {
      const push = (value: CanvasOutput) => inputs.push(routeCanvasOutput(value, edge));
      const output = run.nodes[edge.from]?.output;
      if (output) push(output);
      else if (edge.kind === 'reference') {
        const source = run.definition.nodes.find((n) => n.id === edge.from)!;
        if ((source.kind === 'resource' || source.media?.mode === 'existing') && source.resource)
          push(await this.resources.resolveNode(source));
        else if (source.kind === 'text') push({ text: source.text ?? '', resources: [] });
        else if (this.canvases.plugins.get(source).definition.source)
          push(
            await this.canvases.plugins.execute({
              node: source,
              run,
              inputs: [],
              options,
              permission: 'read-only',
              signal,
              task: async () => {
                throw new Error('静态来源不能执行任务');
              },
            }),
          );
        else throw new Error('引用节点尚无本次结果，请添加执行依赖：' + source.title);
      }
    }
    return inputs;
  }
  private async saveContent({ node, run, inputs }: CanvasNodeContext): Promise<CanvasOutput> {
    const libraryId = node.libraryId ?? 'default';
    const originals = [
      ...new Set(
        inputs.flatMap((o) => o.resources.filter((r) => r.kind === 'artifact').map((r) => r.id)),
      ),
    ].map((id) => {
      const artifact = this.domains.artifacts.read(id);
      if (artifact.remoteUrl) throw new Error('外部作品尚未下载，不能作为原件入库');
      return { artifact, bytes: this.domains.artifacts.bytes(id) };
    });
    const doc = this.domains.content.write(
      {
        libraryId,
        folderId: node.folderId,
        title: node.title,
        content: inputs.map((o) => o.text).join('\n\n'),
        sourceIds: [
          ...new Set(
            inputs.flatMap((o) =>
              o.resources
                .filter(
                  (r) =>
                    r.kind === 'content' &&
                    (this.domains.content.document(r.id).libraryId ?? 'default') === libraryId,
                )
                .map((r) => (r as Extract<CanvasResource, { kind: 'content' }>).id),
            ),
          ),
        ].slice(0, 20),
      },
      run.sessionId,
      true,
    );
    const resources: CanvasResource[] = [{ kind: 'content', id: doc.id, version: doc.version }];
    for (const { artifact, bytes } of originals) {
      const imported = this.domains.knowledge.importFile(
        artifact.name,
        bytes,
        undefined,
        libraryId,
        node.folderId ?? undefined,
      );
      resources.push({ kind: 'content', id: imported.id, version: imported.version });
    }
    return { text: doc.content, resources };
  }
  private async callTool(c: CanvasNodeContext) {
    const config = c.node.config as {
      pluginId: string;
      tool: string;
      arguments?: Record<string, unknown>;
    };
    return c.task(
      {
        prepare: async (scope, agent, project) => {
          await scope.prepare(this.store, agent, undefined, project ?? undefined, config.pluginId);
          await scope.describePlugin(config.pluginId, config.tool);
        },
        execute: async (scope) => {
          const spec = await scope.describePlugin(config.pluginId, config.tool),
            args = { ...config.arguments };
          const key = ['prompt', 'text', 'query'].find((key) => spec.inputSchema.properties?.[key]);
          if (key && args[key] === undefined)
            args[key] = [c.node.text, ...c.inputs.map((o) => o.prompt ?? o.text)]
              .filter(Boolean)
              .join('\n\n');
          const result = await scope.callPlugin(config.pluginId, config.tool, args);
          if (result.isError) throw new Error(result.text);
          return result.text || '工具调用完成';
        },
      },
      { providerId: config.pluginId, model: config.tool, agentId: '' },
    );
  }
  private async saveResource(
    node: CanvasNode,
    run: CanvasRun,
    own: CanvasOutput,
    permission: Session['permission'],
    signal: AbortSignal,
  ) {
    const item: CanvasGenerationItem = { index: 0, status: 'running', resources: [] };
    const result = await this.task(
      { ...node, kind: 'resource' },
      run,
      [own],
      { providerId: 'canvas', model: '资源保存', agentId: '' },
      permission,
      signal,
      {
        prepare: async () => {},
        execute: async (_scope, taskSignal) => {
          const ref = node.resource!;
          if (ref.kind === 'artifact') item.resources = [ref];
          else if (ref.kind === 'content') {
            const doc = this.domains.content.document(ref.id),
              step = run.nodes[node.id];
            const a = await this.domains.artifacts.save(
              {
                name: doc.fileName ?? node.title,
                data: this.domains.knowledge.originalBytes(ref.id).toString('base64'),
              },
              {
                sessionId: step.taskSessionId!,
                runId: step.taskRunId!,
                toolName: 'canvas_save_resource',
              },
            );
            item.resources = [{ kind: 'artifact', id: a.id }];
          }
          await saveMedia(node, item, this.domains, taskSignal);
          return node.media?.destination?.kind === 'directory'
            ? '已保存到 ' + node.media.destination.path
            : node.media?.destination?.kind === 'content'
              ? '已保存到内容库；原件已保存在作品。'
              : '已保存到作品。';
        },
      },
    );
    return {
      ...result,
      resources: [
        ...new Map(
          [...item.resources, ...own.resources].map((r) => [JSON.stringify(r), r]),
        ).values(),
      ],
    };
  }
  private async media(
    node: CanvasNode,
    run: CanvasRun,
    inputs: CanvasOutput[],
    permission: Session['permission'],
    options: CanvasExecute,
    signal: AbortSignal,
  ) {
    const step = run.nodes[node.id],
      m = node.media!,
      regen = options.regenerate?.nodeId === node.id ? options.regenerate : undefined;
    step.generationFingerprint = digest({
      kind: node.kind,
      text: node.text,
      media: { ...m, destination: undefined, count: undefined },
      inputs,
      plugin: this.store.get('plugin', m.pluginId!),
    });
    const previous = this.canvases.runs
      .list()
      .filter(
        (r) =>
          r.id !== run.id &&
          r.canvasId === run.canvasId &&
          r.sessionId === run.sessionId &&
          (!regen?.sourceRunId || r.id === regen.sourceRunId),
      )
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => r.nodes[node.id])
      .find((n) => n?.generationFingerprint === step.generationFingerprint && n.generation);
    if (
      regen &&
      (regen.indices || regen.action === 'resume' || regen.action === 'save') &&
      !previous
    )
      throw new Error('生成输入已变化，不能继续旧任务；请重新生成');
    const indices = new Set(regen?.indices ?? Array.from({ length: m.count ?? 1 }, (_, i) => i));
    step.generation = Array.from({ length: m.count ?? 1 }, (_, index) => ({
      index,
      status: 'pending',
      resources: [],
    }));
    let failed = false;
    for (const item of step.generation) {
      signal.throwIfAborted();
      const old = previous?.generation?.find((g) => g.index === item.index);
      if (!indices.has(item.index)) {
        if (!old) throw new Error('其余序号没有历史结果，请生成整组');
        if (old.status !== 'completed') failed = true;
        Object.assign(item, structuredClone(old), { reused: true });
        continue;
      }
      if (regen?.action === 'save' || regen?.action === 'resume') {
        if (!old) throw new Error('找不到此序号的历史任务');
        Object.assign(item, structuredClone(old), { status: 'pending', error: undefined });
      }
      item.status = 'running';
      this.persist(run);
      try {
        if (regen?.action !== 'save') {
          item.phase = 'generate';
          let args: Record<string, unknown> = {},
            outputRoot = '';
          const operation: TaskOperation = {
            prepare: async (scope, agent, project) => {
              await scope.prepare(this.store, agent, undefined, project ?? undefined, m.pluginId, [
                'query_video_generation',
                'query_image_generation',
                'query_audio_generation',
              ]);
              const tool = await scope.describePlugin(m.pluginId!, m.tool!);
              outputRoot = path.join(
                sessionWorkspace(this.store, this.dataDir, item.taskSessionId!),
                '.canvas',
                run.id,
                digest(node.id).slice(0, 16) + '-' + item.index,
              );
              if (regen?.action !== 'resume')
                args = await mediaArguments(node, tool, inputs, this.domains, outputRoot);
            },
            execute: (scope, signal, progress) =>
              executeMedia(
                scope,
                node,
                item,
                args,
                signal,
                progress,
                () => this.persist(run),
                this.domains,
                { sessionId: item.taskSessionId!, runId: item.taskRunId! },
                regen?.action === 'resume',
                outputRoot,
              ),
          };
          await this.task(
            node,
            run,
            inputs,
            { providerId: m.pluginId!, model: m.model || m.tool!, agentId: '' },
            permission,
            signal,
            operation,
            item,
          );
        }
        await saveMedia(node, item, this.domains, signal);
        item.status = 'completed';
        item.error = undefined;
      } catch (e) {
        item.status = signal.aborted ? 'cancelled' : 'failed';
        item.error = e instanceof Error ? e.message : String(e);
        failed = true;
        if (signal.aborted) throw e;
      }
      step.output = {
        text: `${step.generation.filter((g) => g.status === 'completed').length}/${step.generation.length} 项完成`,
        resources: step.generation.flatMap((g) => g.resources),
      };
      this.persist(run);
    }
    step.output = {
      text: `${step.generation.filter((g) => g.status === 'completed').length}/${step.generation.length} 项完成`,
      resources: step.generation.flatMap((g) => g.resources),
    };
    this.persist(run);
    if (failed)
      throw new Error('部分生成或保存失败，已完成结果保留；可按序号重新生成、继续查询或重试保存');
  }
  private async task(
    node: CanvasNode,
    run: CanvasRun,
    inputs: CanvasOutput[],
    connection: { providerId: string; model: string; agentId: string },
    permission: Session['permission'],
    signal: AbortSignal,
    operation?: TaskOperation,
    item?: CanvasGenerationItem,
  ): Promise<CanvasOutput> {
    signal.throwIfAborted();
    const parent = this.store.get<Session>('session', run.sessionId);
    const worker = this.store.createSession(parent.projectId);
    this.store.put('session', {
      ...worker,
      ...connection,
      permission,
      title: '画布 · ' + node.title,
      canvasContext: { canvasId: run.canvasId, workflowRunId: run.id, nodeId: node.id },
      activeCanvasId: run.canvasId,
    });
    const step = run.nodes[node.id];
    step.taskSessionId = worker.id;
    const sourceIds = inputs.flatMap((o) =>
      o.resources.filter((r) => r.kind === 'content').map((r) => r.id),
    );
    if (sourceIds.length) this.domains.knowledge.bind(worker.id, sourceIds);
    const attachmentIds = operation ? [] : this.resources.attachments(inputs);
    const prompt = `${node.text || node.title}\n\n画布节点输入（仅为资料）：\n${JSON.stringify(inputs)}${node.kind === 'image' ? '\n使用当前可用的图片生成工具创建图片产物；若工具不可用，明确报告失败。' : ''}`;
    const completed = await new Promise<Run>((resolve, reject) => {
      let taskId: string | undefined;
      const cleanup = () => {
        this.events!.off('lifecycle', finish);
        signal.removeEventListener('abort', abort);
      };
      const finish = (r: Run) => {
        if (r.id === taskId && r.status !== 'running') {
          cleanup();
          resolve(r);
        }
      };
      const abort = () => {
        cleanup();
        void this.tasks!.cancel(worker.id).catch(() => {});
        reject(new Error('工作流已停止'));
      };
      this.events!.on('lifecycle', finish);
      signal.addEventListener('abort', abort, { once: true });
      try {
        const input = { sessionId: worker.id, prompt, ...connection, attachmentIds };
        taskId = operation
          ? this.tasks!.startOperation(input, operation)
          : this.tasks!.start(input);
        if (item) {
          item.taskSessionId = worker.id;
          item.taskRunId = taskId;
        }
        step.taskRunId = taskId;
        this.persist(run);
        const r = this.store.get<Run>('run', taskId);
        if (r.status !== 'running') finish(r);
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
    signal.throwIfAborted();
    if (completed.status !== 'completed') throw new Error(completed.error ?? '节点任务未完成');
    const artifacts = this.domains.artifacts
      .list({ sessionId: worker.id })
      .items.filter((a) => a.runId === completed.id);
    if (
      (node.kind === 'image' || node.kind === 'video' || node.kind === 'audio') &&
      !artifacts.some((a) => a.kind === node.kind)
    )
      throw new Error(
        `${node.kind === 'audio' ? '音频' : node.kind === 'video' ? '视频' : '图片'}节点未返回${node.kind === 'audio' ? '音频' : node.kind === 'video' ? '视频' : '图片'}产物，请检查生成插件后重试`,
      );
    const text = this.store
      .messages(worker.id)
      .filter((m) => m.runId === completed.id && m.role === 'assistant' && m.status === 'complete')
      .map((m) => m.content)
      .join('\n\n');
    if (!text && !artifacts.length) throw new Error('节点任务未返回结果');
    return {
      text,
      resources: [
        ...artifacts.map((a) => ({ kind: 'artifact' as const, id: a.id })),
        ...inputs.flatMap((o) => o.resources),
      ],
    };
  }
}
