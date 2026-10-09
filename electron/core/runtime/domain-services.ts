import { Attachments } from '../../modules/artifacts/attachments';
import { Artifacts } from '../../modules/artifacts/artifacts';
import { TaskMemories } from '../../modules/sessions/task-memory';
import { Knowledge } from '../../modules/knowledge/knowledge';
import { ContentWorkspace } from '../../modules/content/content';
import { ChangeCheckpoints } from '../../modules/projects/run-changes';
import type { Store } from '../../services/storage/store';

/** Persistence services shared by execution and management features. They own no task loops. */
export function createRuntimeDomainServices(store: Store, dataDir: string) {
  const attachments = new Attachments(store, dataDir);
  const artifacts = new Artifacts(store, dataDir);
  const memories = new TaskMemories(store);
  const knowledge = new Knowledge(store, dataDir);
  const content = new ContentWorkspace(store, knowledge);
  const checkpoints = new ChangeCheckpoints(store, dataDir);
  return { attachments, artifacts, memories, knowledge, content, checkpoints };
}
export type RuntimeDomainServices = ReturnType<typeof createRuntimeDomainServices>;
