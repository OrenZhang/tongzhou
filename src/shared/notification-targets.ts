import type { NotificationTarget, Snapshot } from './types';

// Shared by conversation reminders and scheduled tasks. Preserve unavailable
// targets so existing selections remain identifiable instead of silently changing.
export function notificationTargets(
  data: Pick<Snapshot, 'channels' | 'notificationTargets'>,
): NotificationTarget[] {
  const targets = new Map<string, NotificationTarget>();
  for (const channel of data.channels ?? [])
    targets.set(channel.id, {
      id: channel.id,
      name: channel.name,
      kind: channel.kind,
      available: channel.enabled,
    });
  for (const target of data.notificationTargets ?? []) targets.set(target.id, target);
  return [...targets.values()];
}
