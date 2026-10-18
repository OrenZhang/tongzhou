import type { Provider, Session } from '../../../src/shared/types';
import { modelProvider } from '../../../src/shared/model-protocol';

export const BUSINESS_TOOL_NAMESPACE = 'tongzhou';

export function executionFeatures(
  provider: Provider,
  model: string,
  session: Session,
  remote: boolean,
  workbench: boolean,
) {
  const nativeFiles = !session.knowledgeJob && !session.memoryJob && (!remote || workbench);
  const questionsEnabled = nativeFiles && !remote && !session.automationJob;
  return {
    nativeFiles,
    questionsEnabled,
    interactions: nativeAgentTools(provider, model) && questionsEnabled,
  };
}

export function nativeAgentTools(provider: Provider, model: string) {
  const protocol = modelProvider(provider, model).protocol;
  return (
    protocol === 'codex' ||
    (protocol === 'openai-responses' && /^(?:.*\/)?gpt-6(?:[.-]|$)/i.test(model))
  );
}

export function deferredBusinessTools(provider: Provider, model: string, count: number) {
  const protocol = modelProvider(provider, model).protocol;
  // Conversion adapters need eager schemas. GPT-6's native wire preserves code-mode discovery.
  return (
    count >= 24 &&
    /^(?:.*\/)?gpt-6(?:[.-]|$)/i.test(model) &&
    (protocol === 'codex' || protocol === 'openai-responses')
  );
}

export function dynamicToolSpecs(
  specs: readonly { name: string; description: string; parameters: unknown }[],
  deferred: boolean,
) {
  const tools = specs.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
    ...(deferred ? { deferLoading: true } : {}),
  }));
  return deferred
    ? [
        {
          type: 'namespace',
          name: BUSINESS_TOOL_NAMESPACE,
          description: 'CoSail业务与插件工具',
          tools,
        },
      ]
    : tools;
}
