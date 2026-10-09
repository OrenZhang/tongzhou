import { managedDirectory } from '../../services/storage/local-files';
import path from 'node:path';
import type { Store } from '../../services/storage/store';
import type { Project, Session } from '../../../src/shared/types';

/** Shared by native engines and interactive terminals, including projectless sessions. */
export function sessionWorkspace(store: Store, dataDir: string, sessionId: string) {
  const session = store.get<Session>('session', sessionId);
  if (session.projectId && !session.knowledgeJob)
    return path.resolve(store.get<Project>('project', session.projectId).path);
  const root = managedDirectory(dataDir, 'chat-workspaces');
  const directory = path.resolve(root, session.id);
  const relative = path.relative(root, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('无效的会话工作目录');
  return directory;
}
