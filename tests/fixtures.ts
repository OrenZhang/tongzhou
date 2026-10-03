import type { Store } from '../electron/store';
export function seedAgents(store: Store) {
  for (const id of ['builder', 'reviewer', 'architect'])
    store.put('agent', {
      id,
      name: id,
      description: 'Explicit test role',
      instructions: 'Use tools when needed.',
      providerId: '',
      model: '',
      permission: id === 'builder' ? 'ask' : 'read-only',
      maxSteps: 16,
    });
}
