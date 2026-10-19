import path from 'node:path';
import { z } from 'zod';
import type { Canvas, CanvasNode, CanvasOutput, CanvasRun } from '../../../src/shared/canvas';
import type { TaskOperation } from '../../core/task-contracts';
import type { Artifacts } from '../artifacts/artifacts';
import type { ContentWorkspace } from '../content/content';
import type { Knowledge } from '../knowledge/knowledge';
import type { Canvases } from './canvas';
import type { CanvasGroupContext, CanvasNodeContext } from './node-plugins';
import type { CanvasResources } from './workflow';
import { ComfyWorkflows } from './comfyui';
import { comfyConfig, comfyInput, parseComfyWorkflow } from './comfyui-format';

/** Both ComfyUI entry points share the same TaskService operation and artifact owners. */
export class ComfyNodePlugins {
  constructor(
    private comfy: ComfyWorkflows,
    private canvases: Canvases,
    private resources: CanvasResources,
    private domains: { artifacts: Artifacts; content: ContentWorkspace; knowledge: Knowledge },
    private persist: (run: CanvasRun) => void,
  ) {
    this.canvases.plugins.register({
      definition: {
        id: 'comfyui.workflow',
        name: 'ComfyUI 工作流 API',
        kind: 'plugin',
        version: 1,
        apiVersion: 1,
        adapter: 'native',
        cache: 'never',
        description: '配置 API 格式工作流，通过已保存服务提交执行；可绑定提示词和参考图片',
        inputs: ['text', 'image'],
        outputs: ['resource'],
        ports: {
          inputs: [
            { id: 'prompt', label: '提示词', multiple: false, types: ['text'] },
            { id: 'reference', label: '参考图片', multiple: false, types: ['image'] },
          ],
          outputs: [{ id: 'result', label: '生成文件', types: ['resource'] }],
        },
      },
      schema: z
        .object({
          connectionId: z.string().min(1).max(120),
          workflow: z.string().min(2).max(24000).describe('ComfyUI API JSON'),
          bindings: z
            .array(
              z
                .object({
                  port: z.enum(['prompt', 'reference']),
                  nodeId: z.string().min(1).max(120),
                  field: z.string().min(1).max(100),
                })
                .strict(),
            )
            .max(16)
            .default([]),
        })
        .strict(),
      execute: (c) => this.executeComfyApi(c),
    });
    this.canvases.plugins.register({
      definition: {
        id: 'comfyui',
        name: 'ComfyUI',
        kind: 'plugin',
        version: 1,
        apiVersion: 1,
        adapter: 'comfyui',
        cache: 'never',
        inputs: [],
        outputs: [],
      },
      schema: z
        .object({
          sourceId: z.uuid(),
          nodeId: z.string().min(1).max(120),
          classType: z.string().min(1).max(200),
          connectionId: z.string().max(120).optional(),
          values: z.record(z.string(), z.json()),
          controls: z
            .record(z.string(), z.enum(['fixed', 'randomize', 'increment', 'decrement']))
            .optional(),
          issues: z.array(z.string()).optional(),
        })
        .strict(),
      group: {
        id: 'comfyui',
        key: (node) => {
          const c = comfyConfig(node)!;
          return JSON.stringify([c.sourceId, c.connectionId]);
        },
        execute: (context) => this.executeGroup(context),
      },
      execute: () => {
        throw new Error('ComfyUI 节点必须按工作流执行');
      },
    });
  }
  private async executeComfyApi(c: CanvasNodeContext): Promise<CanvasOutput> {
    const config = c.node.config as {
      connectionId: string;
      workflow: string;
      bindings?: { port: string; nodeId: string; field: string }[];
    };
    const parsed = parseComfyWorkflow(
      JSON.parse(config.workflow),
      c.node.id,
      {},
      config.connectionId,
    );
    if (parsed.format !== 'api')
      throw new Error('工作流 API 节点需要 API 格式 JSON，普通 JSON 请使用画布导入');
    const canvas = { ...c.run.definition, nodes: parsed.nodes, edges: parsed.edges };
    const inputs = new Map<string, CanvasOutput[]>();
    for (const value of c.inputs) {
      const bindings = (config.bindings ?? []).filter((b) => b.port === value.inputPort);
      if (!bindings.length && (value.text || value.resources.length))
        throw new Error('请将输入端口绑定到 API 工作流的节点 ID 和参数');
      for (const binding of bindings) {
        const node = parsed.nodes.find((n) => comfyConfig(n)?.nodeId === binding.nodeId);
        if (!node) throw new Error('绑定的 ComfyUI 节点不存在：' + binding.nodeId);
        inputs.set(node.id, [
          ...(inputs.get(node.id) ?? []),
          { ...value, inputPort: comfyInput(binding.field) },
        ]);
      }
    }
    const resume = c.options.resumeRunId
      ? this.canvases.runs.get(c.options.resumeRunId)
      : undefined;
    if (resume && (resume.canvasId !== c.run.canvasId || resume.sessionId !== c.run.sessionId))
      throw new Error('只能继续当前画布与会话的任务');
    const operation = this.comfyOperation(canvas, parsed.nodes, c.run, inputs, c.signal, resume);
    const output = await c.task(operation.operation, {
      providerId: 'canvas',
      model: 'ComfyUI',
      agentId: '',
    });
    const names = new Set(operation.result().artifacts.map((a) => a.name));
    return {
      text: operation.result().text,
      resources: output.resources.filter(
        (ref) => ref.kind === 'artifact' && names.has(this.domains.artifacts.read(ref.id).name),
      ),
    };
  }
  private comfyOperation(
    canvas: Canvas,
    nodes: CanvasNode[],
    run: CanvasRun,
    inputs: Map<string, CanvasOutput[]>,
    signal: AbortSignal,
    resume?: CanvasRun,
  ) {
    let result: Awaited<ReturnType<ComfyWorkflows['execute']>> | undefined;
    let progress: (text: string) => void = () => {};
    let operationSignal = signal;
    const operation: TaskOperation = {
      prepare: async (scope) => {
        scope.add(
          {
            name: 'canvas_comfyui_execute',
            description: '执行 ComfyUI 工作流',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
          'ComfyUI · ' + nodes.length + ' 个节点',
          async () => {
            result = await this.comfy.execute(
              canvas,
              nodes,
              run,
              operationSignal,
              inputs,
              async (ref) => {
                this.resources.validate(ref);
                if (this.resources.preview(ref).type !== 'image')
                  throw new Error('ComfyUI 图片输入需要图片原件');
                if (ref.kind === 'artifact') {
                  await this.domains.artifacts.download(ref.id, operationSignal);
                  return {
                    name: this.domains.artifacts.read(ref.id).name,
                    bytes: this.domains.artifacts.bytes(ref.id),
                  };
                }
                if (ref.kind === 'content')
                  return {
                    name: this.domains.content.document(ref.id).fileName ?? 'input.png',
                    bytes: this.domains.knowledge.originalBytes(ref.id),
                  };
                if (ref.kind === 'file')
                  return {
                    name: path.basename(ref.path),
                    bytes: await this.resources.fileBytes(ref),
                  };
                throw new Error('请选择图片原件');
              },
              progress,
              () => this.persist(run),
              resume,
            );
            return { text: result.text, artifacts: result.artifacts };
          },
          !resume,
        );
      },
      execute: async (scope, taskSignal, report) => {
        operationSignal = AbortSignal.any([signal, taskSignal]);
        progress = report;
        const output = await scope.call('canvas_comfyui_execute', {});
        taskSignal.throwIfAborted();
        if (output.isError) throw new Error(output.text);
        return output.text;
      },
    };
    return {
      operation,
      result: () => {
        if (!result) throw new Error('ComfyUI 未返回结果');
        return result;
      },
    };
  }
  private async executeGroup(c: CanvasGroupContext): Promise<Record<string, CanvasOutput>> {
    const { run, nodes, inputs, signal } = c;
    const resume = c.options.resumeRunId
      ? this.canvases.runs.get(c.options.resumeRunId)
      : undefined;
    if (resume && (resume.canvasId !== run.canvasId || resume.sessionId !== run.sessionId))
      throw new Error('只能查询当前画布与会话的远端任务');
    const operation = this.comfyOperation(run.definition, nodes, run, inputs, signal, resume);
    await c.task(operation.operation, { providerId: 'canvas', model: 'ComfyUI', agentId: '' });
    const result = operation.result();
    const leader = run.nodes[c.node.id];
    const artifacts = this.domains.artifacts
      .list({ sessionId: leader.taskSessionId })
      .items.filter((a) => a.runId === leader.taskRunId);
    return Object.fromEntries(
      nodes.map((n) => {
        const names = result.byNode.get(n.id) ?? [];
        const resources = artifacts
          .filter((a) => names.includes(a.name))
          .map((a) => ({ kind: 'artifact' as const, id: a.id }));
        if (resources.length !== names.length)
          throw new Error('ComfyUI 部分文件未保存，请查看任务作品');
        const step = run.nodes[n.id];
        step.externalStatus =
          step.externalStatus === 'running' ? 'executed' : (step.externalStatus ?? 'not-observed');
        return [
          n.id,
          {
            text: names.length
              ? `ComfyUI 已完成，${names.length} 个文件`
              : 'ComfyUI 图执行完成；内部值保留在服务端',
            resources,
            ports: { files: { text: 'ComfyUI 输出文件', resources } },
          },
        ];
      }),
    );
  }
}
