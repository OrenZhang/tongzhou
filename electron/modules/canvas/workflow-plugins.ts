import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { scheduleSchema } from '../automation/automations';
import type { CanvasNodePlugin, CanvasNodePlugins } from './node-plugins';
import type { CanvasOutput } from '../../../src/shared/canvas';

export const scheduleConfig = z.object({
  schedule: scheduleSchema,
  missed: z.enum(['once', 'skip']).default('once'),
});
export type CanvasNotify = (
  targetId: string,
  text: string,
  sessionId: string,
  key: string,
  signal: AbortSignal,
) => Promise<{ id: string; status: string; error?: string }>;

/** Simple substitution only: upstream text can never execute code or select a recipient. */
export function renderWorkflowText(template: string, inputs: CanvasOutput[], at: number) {
  return template.replace(/\{\{\s*(input|input\.[1-9]\d*|date|time)\s*\}\}/g, (_, key: string) => {
    if (key === 'date') return new Date(at).toISOString().slice(0, 10);
    if (key === 'time') return new Date(at).toISOString();
    if (key === 'input') return inputs.map((v) => v.text).join('\n\n');
    const value = inputs[Number(key.slice(6)) - 1];
    if (!value) throw new Error('模板引用了不存在的输入：' + key);
    return value.text;
  });
}
const port = (id: string, label: string) => ({ id, label, types: ['text'] as ['text'] });
export function registerWorkflowPlugins(
  plugins: CanvasNodePlugins,
  notify: CanvasNotify,
  notificationKey: (sessionId: string, runId: string) => string,
) {
  const add = (plugin: CanvasNodePlugin) => plugins.register(plugin);
  add({
    definition: {
      id: 'workflow.schedule',
      name: '定时触发',
      kind: 'plugin',
      version: 1,
      cache: 'never',
      description: '发布后由自动化中心定时执行此节点连接的下游流程；需要同舟保持运行',
      inputs: [],
      outputs: ['text'],
      ports: { inputs: [], outputs: [port('result', '触发信息')] },
      defaults: {
        text: '开始执行本次工作流',
        config: { schedule: { kind: 'interval', minutes: 60 }, missed: 'once' },
      },
    },
    schema: scheduleConfig,
    execute: ({ node, run }) => ({
      text: `${node.text || '工作流触发'}\n${new Date(run.startedAt).toISOString()}`,
      resources: [],
    }),
  });
  add({
    definition: {
      id: 'workflow.template',
      name: '文本模板 / 合并',
      kind: 'plugin',
      version: 1,
      cache: 'never',
      description: '合并上游正文并替换 {{input}}、{{input.1}}、{{date}}、{{time}}（UTC）',
      inputs: ['text'],
      outputs: ['text'],
      ports: { inputs: [port('context', '输入正文')], outputs: [port('result', '模板正文')] },
      defaults: { text: '{{input}}' },
    },
    execute: ({ node, inputs, run }) => ({
      text: renderWorkflowText(node.text ?? '{{input}}', inputs, run.startedAt),
      resources: [],
    }),
  });
  add({
    definition: {
      id: 'workflow.delay',
      name: '等待',
      kind: 'plugin',
      version: 1,
      cache: 'never',
      description: '等待 1–300 秒再传递上游结果；停止工作流会立即取消等待',
      inputs: ['text', 'resource'],
      outputs: ['text', 'resource'],
      defaults: { config: { seconds: 5 } },
    },
    schema: z.object({ seconds: z.number().int().min(1).max(300).default(5).describe('等待秒数') }),
    execute: async ({ node, inputs, signal }) => {
      await delay(Number(node.config?.seconds), undefined, { signal });
      return {
        text: inputs.map((o) => o.text).join('\n\n'),
        resources: inputs.flatMap((o) => o.resources),
      };
    },
  });
  add({
    definition: {
      id: 'workflow.notify',
      name: '渠道通知',
      kind: 'plugin',
      version: 1,
      cache: 'never',
      description: '向已配置的渠道发送正文，沿用会话审批；输出发送回执。单次最多 4000 字',
      inputs: ['text'],
      outputs: ['text'],
      ports: { inputs: [port('context', '消息正文')], outputs: [port('result', '发送回执')] },
      defaults: { text: '{{input}}', config: { targetId: '' } },
    },
    schema: z.object({ targetId: z.string().min(1).max(200) }),
    execute: async (c) => {
      const targetId = String(c.node.config?.targetId);
      const text = renderWorkflowText(c.node.text || '{{input}}', c.inputs, c.run.startedAt).trim();
      if (!text || text.length > 4000)
        throw new Error('通知正文必须为 1–4000 字，请先使用 Agent 摘要或文本模板整理');
      return c.task({
        prepare: async (scope) =>
          scope.add(
            {
              name: 'canvas_send_notification',
              description: '发送画布通知',
              parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
            `发送通知到 ${targetId}：${text}`,
            async () => {
              c.signal.throwIfAborted();
              const receipt = await notify(
                targetId,
                text,
                c.run.sessionId,
                `canvas:${notificationKey(c.run.sessionId, c.run.id)}:${c.node.id}`,
                c.signal,
              );
              if (receipt.status !== 'sent')
                throw new Error(
                  receipt.error || '通知未确认发送成功，请检查渠道发送记录；不会自动重复发送',
                );
              return { text: `通知已发送 · ${receipt.id}` };
            },
            true,
          ),
        execute: async (scope) => {
          const result = await scope.call('canvas_send_notification', {});
          if (result.isError) throw new Error(result.text);
          return result.text;
        },
      });
    },
  });
}
