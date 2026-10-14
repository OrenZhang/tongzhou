import type { Provider } from './types';
import type { ReasoningEffort } from './model-reasoning';

export const automaticModel = 'tongzhou-auto';
export const modelScenes = {
  general: '通用',
  coding: '编程',
  writing: '文档',
  vision: '图片',
} as const;
export const modelStages = {
  respond: '问答',
  plan: '规划',
  execute: '执行',
  review: '检查',
  summarize: '总结',
} as const;
export type ModelScene = keyof typeof modelScenes;
export type ModelStage = keyof typeof modelStages;
export interface ModelPoolEntry {
  providerId: string;
  model: string;
  scene: ModelScene | 'any';
  stage: ModelStage | 'any';
  reasoningEffort?: ReasoningEffort;
  images?: boolean;
}
export interface ModelRouting {
  requestedProviderId: string;
  scene: ModelScene;
  stage: ModelStage;
  rule: number;
  fallback: boolean;
  thinkingEnabled: boolean;
  reasoningEffort?: ReasoningEffort;
}

/** Resolve once per user turn. Specific rules precede defaults; ties retain pool order. */
export function routeModel(
  owner: Provider,
  providers: Provider[],
  context: {
    prompt: string;
    images: boolean;
    stage?: ModelStage;
    previous?: ModelRouting;
  },
  usable: (provider: Provider) => boolean = () => true,
): {
  provider: Provider;
  model: string;
  routing: ModelRouting;
} {
  const text = context.prompt.trim();
  const continuing =
    /^(?:那)?(?:继续(?:执行|实现|修复|检查|总结|规划)?(?:吧|下)?|接着|continue|go on)[。.!！\s]*$/i.test(
      text,
    );
  const prior =
    continuing && context.previous?.requestedProviderId === owner.id ? context.previous : undefined;
  const scene: ModelScene = context.images
    ? 'vision'
    : /(?:代码|编程|开发|调试|修复|程序|测试|\b(?:code|coding|debug|bug|implement|refactor|test)\b)/i.test(
          text,
        )
      ? 'coding'
      : /(?:文档|文章|资料|知识库|写作|润色|\b(?:document|writing|essay)\b)/i.test(text)
        ? 'writing'
        : (prior?.scene ?? 'general');
  const stage: ModelStage =
    context.stage ??
    (/(?:检查|评审|审查|审核|\b(?:review|audit)\b)/i.test(text)
      ? 'review'
      : /(?:总结|摘要|归纳|\b(?:summarize|summary)\b)/i.test(text)
        ? 'summarize'
        : /(?:实现|修复|重构|修改|执行|\b(?:implement|fix|refactor|execute)\b)/i.test(text)
          ? 'execute'
          : /(?:规划|计划|方案|设计|\b(?:plan|design)\b)/i.test(text)
            ? 'plan'
            : (prior?.stage ?? (scene === 'coding' ? 'execute' : 'respond')));
  const matches = (owner.modelPool ?? [])
    .map((entry, rule) => ({ entry, rule }))
    .filter(
      ({ entry }) =>
        (entry.scene === 'any' || entry.scene === scene) &&
        (entry.stage === 'any' || entry.stage === stage) &&
        (!context.images || entry.images),
    )
    .sort(
      (a, b) =>
        Number(b.entry.scene !== 'any') +
        Number(b.entry.stage !== 'any') -
        Number(a.entry.scene !== 'any') -
        Number(a.entry.stage !== 'any'),
    );
  for (const [index, { entry, rule }] of matches.entries()) {
    const provider = providers.find((p) => p.id === entry.providerId);
    if (
      !provider ||
      provider.enabled === false ||
      !provider.models.includes(entry.model) ||
      !usable(provider)
    )
      continue;
    return {
      provider,
      model: entry.model,
      routing: {
        requestedProviderId: owner.id,
        scene,
        stage,
        rule,
        fallback: index > 0,
        thinkingEnabled: entry.reasoningEffort ? true : provider.thinkingEnabled !== false,
        reasoningEffort: entry.reasoningEffort ?? provider.reasoningEffort,
      },
    };
  }
  throw new Error(
    context.images
      ? '模型池中没有可用的图片模型，请配置支持图片的默认模型或手动选择。'
      : '模型池中没有可用模型，请检查连接、模型列表和默认规则，或手动选择模型。',
  );
}

export function routedProvider(provider: Provider, routing?: ModelRouting): Provider {
  return routing
    ? {
        ...provider,
        thinkingEnabled: routing.thinkingEnabled,
        reasoningEffort: routing.reasoningEffort,
      }
    : provider;
}

export const apiProtocols = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'] as const;
export type ApiProtocol = (typeof apiProtocols)[number];
export function modelProvider(provider: Provider, model: string): Provider {
  const protocol =
    provider.modelProtocols && Object.hasOwn(provider.modelProtocols, model)
      ? provider.modelProtocols[model]
      : undefined;
  return protocol &&
    apiProtocols.includes(protocol) &&
    apiProtocols.includes(provider.protocol as ApiProtocol)
    ? { ...provider, protocol }
    : provider;
}
