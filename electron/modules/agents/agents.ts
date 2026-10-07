import { builtinAgent, builtinAgents } from '../../../src/shared/builtin-agents';
import type { AgentProfile, Provider } from '../../../src/shared/types';
import type { Store } from '../../services/storage/store';
import { agentSchema } from '../../services/storage/validation';

const preferences = (a: AgentProfile) => ({
  name: a.name,
  description: a.description,
  instructions: a.instructions,
  soul: a.soul,
  providerId: a.providerId,
  model: a.model,
  maxSteps: a.maxSteps,
});

export function agentProfile(store: Store, id: string): AgentProfile {
  const builtin = builtinAgent(id);
  if (!builtin) return structuredClone(store.get<AgentProfile>('agent', id));
  const override = store.list<AgentProfile>('agentOverride').find((a) => a.id === id);
  return structuredClone({
    ...builtin,
    ...(override ? preferences(override) : {}),
    customized: !!override,
  });
}

export function agentProfiles(store: Store): AgentProfile[] {
  return [
    ...builtinAgents.map((a) => agentProfile(store, a.id)),
    ...store.list<AgentProfile>('agent').filter((a) => !builtinAgent(a.id)),
  ];
}

export function saveAgentProfile(store: Store, raw: unknown) {
  const a = agentSchema.parse(raw);
  if (a.providerId) store.get('provider', a.providerId);
  if (builtinAgent(a.id)) {
    // Never persist client-supplied permission, plugin, computer or workflow identity fields.
    store.put('agentOverride', { id: a.id, ...preferences(a) });
  } else {
    for (const id of a.pluginIds ?? []) store.get('plugin', id);
    for (const id of a.skillIds ?? []) store.get('skill', id);
    store.put('agent', a);
  }
  return agentProfile(store, a.id);
}

export function agentConnection(
  store: Store,
  agent: AgentProfile,
  fallback: { providerId: string; model: string },
) {
  const providerId = agent.providerId || fallback.providerId;
  const model =
    agent.model ||
    (agent.providerId ? store.get<Provider>('provider', providerId).models[0] : fallback.model);
  if (!providerId || !model)
    throw new Error('请在 Agent 中配置可用连接和模型，或先在会话中选择模型');
  return { providerId, model };
}
