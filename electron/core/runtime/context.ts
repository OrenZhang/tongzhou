import type { AgentProfile } from '../../../src/shared/types';
import type { Store } from '../../services/storage/store';
import { agentProfile } from '../../modules/agents/agents';

/** Execution defaults are not a persisted Agent or a prescribed workflow. */
export function resolveAgent(store: Store, id?: string): AgentProfile {
  if (id) return agentProfile(store, id);
  return {
    id: '',
    name: '同舟',
    description: '',
    providerId: '',
    model: '',
    instructions:
      '根据用户的请求直接回答或完成任务。以实际工具结果为依据，不声称执行了未完成的操作。',
    permission: 'ask',
    maxSteps: 0,
  };
}
