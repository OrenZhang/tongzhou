import type { AgentProfile, PermissionMode, Session } from './types';

export const permissionLabels: Record<PermissionMode, string> = {
  'read-only': '只读',
  ask: '按需审批',
  'full-access': '完全开放',
};

export function effectivePermission(
  session: Pick<Session, 'permission'> | undefined,
  global: PermissionMode = 'ask',
  agent?: Pick<AgentProfile, 'permission'>,
): PermissionMode {
  // A read-only specialist (including a collaboration child) remains read-only.
  if (agent?.permission === 'read-only') return 'read-only';
  return session?.permission ?? global;
}
