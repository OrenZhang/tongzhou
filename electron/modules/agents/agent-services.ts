import type { Store } from '../../services/storage/store';
import type { Runtime } from '../../core/runtime/runtime';
import { operation, type ClientRegistrar } from '../../core/tools/client-commands';
import { agentSchema, idSchema } from '../../services/storage/validation';
import type { Session } from '../../../src/shared/types';
import { builtinAgent } from '../../../src/shared/builtin-agents';
import { saveAgentProfile } from './agents';

export function registerAgentServices(register: ClientRegistrar, store: Store, runtime: Runtime) {
  register(
    'saveAgent',
    operation('Agent', 'change', '新增或修改 Agent 角色配置', [agentSchema]),
    (raw) => {
      const a = saveAgentProfile(store, raw);
      runtime.changed();
      return a;
    },
  );
  register(
    'deleteAgent',
    operation(
      'Agent',
      'change',
      '删除自定义 Agent；内置 Agent 恢复默认配置',
      [idSchema.describe('agentId')],
      { confirmation: 'always' },
    ),
    (raw) => {
      const id = idSchema.parse(raw);
      if (builtinAgent(id)) {
        store.remove('agentOverride', id);
        runtime.changed();
        return;
      }
      store.remove('agent', id);
      for (const s of store.list<Session>('session'))
        if (s.agentId === id) store.put('session', { ...s, agentId: '' });
      runtime.changed();
    },
  );
}
