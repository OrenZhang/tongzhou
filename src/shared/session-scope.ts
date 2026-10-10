import type { Session } from './types';

/** Chats owned by the user, excluding workers and bound document tasks. */
export function isUserSession(session: Session): boolean {
  return !(
    session.knowledgeJob ||
    session.memoryJob ||
    session.automationJob ||
    session.parentId ||
    session.contentContext
  );
}
