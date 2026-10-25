import { z } from 'zod';
import type { CanvasOutput, CanvasPort } from '../../../src/shared/canvas';
import type { CanvasNodePlugins } from './node-plugins';

const types: CanvasPort['types'] = ['text', 'json', 'number', 'boolean', 'resource'];
const port = (id: string, label: string): CanvasPort => ({ id, label, types });
export const foreachConfig = z.object({
  source: z.enum(['auto', 'json', 'resources']).default('auto'),
  endNodeId: z.string().min(1).max(120).describe('配对的遍历汇总节点 ID'),
  maxItems: z.number().int().min(1).max(100).default(100).describe('最大遍历项数'),
  onError: z.enum(['stop', 'continue']).default('stop').describe('单项失败时停止或继续后续项'),
});
const conditionConfig = z.object({
  input: z.number().int().min(1).max(50).default(1).describe('输入序号，从 1 开始'),
  field: z
    .string()
    .max(200)
    .default('text')
    .describe('字段路径，例如 text、value.score；JSON 正文可用 value 读取'),
  operator: z
    .enum([
      'equals',
      'notEquals',
      'contains',
      'gt',
      'gte',
      'lt',
      'lte',
      'empty',
      'notEmpty',
      'truthy',
    ])
    .default('contains'),
  value: z
    .string()
    .max(4000)
    .default('')
    .describe('比较值；数字、布尔值和对象按 JSON 解析，其他值按文本处理'),
});

export function combineOutputs(inputs: CanvasOutput[]): CanvasOutput {
  return {
    text: inputs.map((o) => o.text).join('\n\n'),
    value:
      inputs.length === 1
        ? (inputs[0].value ?? inputs[0].text)
        : inputs.map((o) => o.value ?? o.text),
    resources: [
      ...new Map(inputs.flatMap((o) => o.resources).map((r) => [JSON.stringify(r), r])).values(),
    ],
  };
}
function operand(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, i) => equal(value, right[i]))
    );
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
  );
}
export function conditionMatches(inputs: CanvasOutput[], raw: unknown) {
  const c = conditionConfig.parse(raw);
  const input = inputs[c.input - 1];
  if (!input) throw new Error('条件节点引用了不存在的输入');
  const root = { ...input, value: input.value ?? operand(input.text) };
  let actual: unknown = root;
  for (const key of c.field.split('.').filter(Boolean)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key))
      throw new Error('条件字段路径无效');
    actual =
      actual && typeof actual === 'object' && Object.hasOwn(actual, key)
        ? (actual as Record<string, unknown>)[key]
        : undefined;
  }
  const expected = operand(c.value);
  const empty =
    actual === undefined ||
    actual === null ||
    actual === '' ||
    (Array.isArray(actual) && actual.length === 0);
  switch (c.operator) {
    case 'empty':
      return empty;
    case 'notEmpty':
      return !empty;
    case 'truthy':
      return !!actual;
    case 'equals':
      return equal(actual, expected);
    case 'notEquals':
      return !equal(actual, expected);
    case 'contains':
      return typeof actual === 'string'
        ? actual.includes(String(expected))
        : Array.isArray(actual) && actual.some((v) => equal(v, expected));
    default: {
      if (
        typeof actual !== 'number' ||
        typeof expected !== 'number' ||
        !Number.isFinite(actual) ||
        !Number.isFinite(expected)
      )
        throw new Error('大小比较需要两个有限数字');
      return c.operator === 'gt'
        ? actual > expected
        : c.operator === 'gte'
          ? actual >= expected
          : c.operator === 'lt'
            ? actual < expected
            : actual <= expected;
    }
  }
}

export function registerControlPlugins(plugins: CanvasNodePlugins) {
  plugins.register({
    definition: {
      id: 'workflow.condition',
      name: '条件分支',
      kind: 'plugin',
      version: 1,
      control: 'condition',
      cache: 'never',
      description: '按字段和值判断，只激活满足或不满足出口；不执行表达式代码',
      inputs: types,
      outputs: types,
      ports: {
        inputs: [port('context', '判断输入')],
        outputs: [port('true', '满足'), port('false', '不满足')],
      },
      defaults: { config: { input: 1, field: 'text', operator: 'contains', value: '' } },
    },
    schema: conditionConfig,
    execute: ({ inputs, node }) => {
      const output = combineOutputs(inputs),
        selected = conditionMatches(inputs, node.config) ? 'true' : 'false';
      return { ...output, activePorts: [selected], ports: { [selected]: output } };
    },
  });
  plugins.register({
    definition: {
      id: 'workflow.foreach',
      name: '逐项遍历',
      kind: 'plugin',
      version: 1,
      control: 'foreach',
      cache: 'never',
      description: '读取 JSON 数组，逐项执行 item 到配对汇总之间的节点；支持嵌套，最多 100 项',
      inputs: types,
      outputs: types,
      ports: { inputs: [port('context', '数组输入')], outputs: [port('item', '当前项')] },
      defaults: { config: { endNodeId: '', maxItems: 100, onError: 'stop' } },
    },
    schema: foreachConfig,
    execute: ({ inputs, node }) => {
      const c = foreachConfig.parse(node.config);
      if (inputs.length !== 1) throw new Error('逐项遍历需要一个数组输入，请先合并输入');
      let values = inputs[0].value ?? operand(inputs[0].text);
      const resources =
        c.source === 'resources' ||
        (c.source === 'auto' && !Array.isArray(values) && inputs[0].resources.length > 0);
      if (resources) values = inputs[0].resources;
      if (!Array.isArray(values)) throw new Error('逐项遍历的输入必须是 JSON 数组或资源列表');
      if (values.length > c.maxItems) throw new Error('数组超过最大遍历项数');
      return {
        text: JSON.stringify(values),
        value: values,
        resources: [],
        activePorts: [],
        iterationInputs: values.map((value, index) => ({
          text: typeof value === 'string' ? value : JSON.stringify(value),
          value,
          resources: resources ? [inputs[0].resources[index]] : [],
        })),
      };
    },
  });
  plugins.register({
    definition: {
      id: 'workflow.collect',
      name: '遍历汇总',
      kind: 'plugin',
      version: 1,
      control: 'collect',
      cache: 'never',
      description: '作为遍历边界，按原数组顺序汇总每项输出，循环外节点接此节点',
      inputs: types,
      outputs: types,
      ports: { inputs: [port('context', '每项结果')], outputs: [port('result', '汇总数组')] },
    },
    execute: ({ inputs }) => {
      const values = inputs.map((o) => o.value ?? o.text);
      return { ...combineOutputs(inputs), text: JSON.stringify(values), value: values };
    },
  });
  plugins.register({
    definition: {
      id: 'workflow.join',
      name: '分支汇合',
      kind: 'plugin',
      version: 1,
      control: 'join',
      cache: 'never',
      description: '等待所有上游结束；any 接收实际激活的分支，all 要求所有分支成功',
      inputs: types,
      outputs: types,
      ports: { inputs: [port('context', '分支结果')], outputs: [port('result', '汇合结果')] },
      defaults: { config: { mode: 'any' } },
    },
    schema: z.object({ mode: z.enum(['any', 'all']).default('any') }),
    execute: ({ inputs }) => combineOutputs(inputs),
  });
}
