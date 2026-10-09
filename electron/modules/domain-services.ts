import { Attachments } from './artifacts/attachments';
import { Artifacts } from './artifacts/artifacts';
import { TaskMemories } from './sessions/task-memory';
import { Knowledge } from './knowledge/knowledge';
import { ContentWorkspace } from './content/content';
import { ChangeCheckpoints } from './projects/run-changes';
import type { Store } from '../services/storage/store';

/** Persistence services shared by execution and management features. They own no task loops. */
export function createDomainServices(store: Store, dataDir: string) {
  const attachments = new Attachments(store, dataDir);
  const artifacts = new Artifacts(store, dataDir);
  const memories = new TaskMemories(store);
  const knowledge = new Knowledge(store, dataDir);
  const content = new ContentWorkspace(store, knowledge);
  const checkpoints = new ChangeCheckpoints(store, dataDir);
  return { attachments, artifacts, memories, knowledge, content, checkpoints };
}
export type DomainServices = ReturnType<typeof createDomainServices>;
