import { describe, expect, it } from 'vitest';
import { Store } from '../electron/store';
import { agentConnection, agentProfile, agentProfiles, saveAgentProfile } from '../electron/agents';
import { KNOWLEDGE_ORGANIZER_ID, MEMORY_ORGANIZER_ID } from '../src/shared/builtin-agents';

describe('built-in Agent preferences', () => {
  it('keeps workflow identities and permissions fixed while saving editable preferences', () => {
    const store = new Store(':memory:', { encrypt: (s) => s, decrypt: (s) => s });
    try {
      const defaults = agentProfile(store, MEMORY_ORGANIZER_ID);
      const saved = saveAgentProfile(store, {
        ...defaults,
        name: '我的记忆整理',
        instructions: '优先整理开发决策',
        maxSteps: 5,
        permission: 'ask',
        computerEnabled: true,
        pluginIds: ['not-installed'],
        builtin: 'knowledge-organizer',
      });
      expect(saved).toMatchObject({
        name: '我的记忆整理',
        instructions: '优先整理开发决策',
        maxSteps: 5,
        permission: 'read-only',
        builtin: 'memory-organizer',
        customized: true,
      });
      expect(saved.computerEnabled).toBeUndefined();
      expect(saved.pluginIds).toBeUndefined();
      expect(agentProfiles(store)).toHaveLength(2);
      expect(store.list('agent')).toHaveLength(0);
      store.remove('agentOverride', MEMORY_ORGANIZER_ID);
      expect(agentProfile(store, MEMORY_ORGANIZER_ID)).toEqual(defaults);
    } finally {
      store.close();
    }
  });
  it('resolves custom connections without sending a source model to a different provider', () => {
    const store = new Store(':memory:', { encrypt: (s) => s, decrypt: (s) => s });
    try {
      store.saveProvider({
        id: 'separate',
        name: 'Separate',
        protocol: 'openai-chat',
        baseUrl: 'http://localhost:3219/v1',
        auth: 'none',
        models: ['separate-default'],
        maxOutputTokens: 1024,
        contextChars: 50000,
      });
      const agent = agentProfile(store, KNOWLEDGE_ORGANIZER_ID);
      const fallback = { providerId: 'source', model: 'source-model' };
      expect(agentConnection(store, agent, fallback)).toEqual(fallback);
      expect(agentConnection(store, { ...agent, providerId: 'separate' }, fallback)).toEqual({
        providerId: 'separate',
        model: 'separate-default',
      });
      expect(agentConnection(store, { ...agent, model: 'custom-model' }, fallback)).toEqual({
        providerId: 'source',
        model: 'custom-model',
      });
      expect(() => agentConnection(store, agent, { providerId: '', model: '' })).toThrow(
        '可用连接和模型',
      );
    } finally {
      store.close();
    }
  });
});
