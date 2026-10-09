import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { Store } from '../../../electron/services/storage/store';
import { sessionWorkspace } from '../../../electron/modules/sessions/session-workspace';
import { Terminals } from '../../../electron/services/desktop/terminals';

describe('session workspace routing', () => {
  it('shares project paths and gives ordinary sessions distinct stable directories', () => {
    const store = new Store(':memory:', { encrypt: (s) => s, decrypt: (s) => s });
    try {
      const root = path.resolve('workspace-fixture');
      store.put('project', { id: 'p', path: path.join(root, 'project'), name: 'p' });
      const project = store.createSession('p'),
        a = store.createSession(),
        b = store.createSession();
      expect(sessionWorkspace(store, root, project.id)).toBe(path.join(root, 'project'));
      expect(sessionWorkspace(store, root, a.id)).toBe(
        path.join(root, '.tzhou', 'chat-workspaces', a.id),
      );
      expect(sessionWorkspace(store, root, a.id)).not.toBe(sessionWorkspace(store, root, b.id));
      store.put('session', { ...project, knowledgeJob: true });
      expect(sessionWorkspace(store, root, project.id)).toBe(
        path.join(root, '.tzhou', 'chat-workspaces', project.id),
      );
      store.put('session', { ...a, id: '../../escape' });
      expect(() => sessionWorkspace(store, root, '../../escape')).toThrow('无效');
    } finally {
      store.close();
    }
  });
  it('refuses new terminals for archived sessions, removed projects, and knowledge jobs', async () => {
    const store = new Store(':memory:', { encrypt: (s) => s, decrypt: (s) => s });
    const terminals = new Terminals(store, () => {}, path.resolve('workspace-fixture'));
    try {
      const session = store.createSession();
      store.put('session', { ...session, archived: true });
      await expect(terminals.start(session.id)).rejects.toThrow('归档');
      store.put('session', { ...session, knowledgeJob: true });
      await expect(terminals.start(session.id)).rejects.toThrow('知识整理');
      store.put('project', { id: 'p', path: process.cwd(), name: 'p', removed: true });
      store.put('session', { ...session, projectId: 'p' });
      await expect(terminals.start(session.id)).rejects.toThrow('项目已移除');
    } finally {
      terminals.dispose();
      store.close();
    }
  });
});
