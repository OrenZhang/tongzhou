import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../electron/store';
import { ClientCommands, manual } from '../electron/client-commands';
import { effectivePermission } from '../src/shared/permissions';

describe('session and global execution permissions', () => {
  it('persists overrides, inherits global defaults, and can reset every session to inheritance', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tongzhou-permissions-'));
    const codec = { encrypt: (v: string) => v, decrypt: (v: string) => v };
    let store = new Store(path.join(root, 'state.db'), codec);
    try {
      const session = store.createSession();
      expect(store.defaultPermission()).toBe('ask');
      store.setSessionPermission(session.id, 'read-only');
      store.setDefaultPermission('full-access');
      store.close();
      store = new Store(path.join(root, 'state.db'), codec);
      expect(effectivePermission(store.get('session', session.id), store.defaultPermission())).toBe(
        'read-only',
      );
      expect(effectivePermission(store.createSession(), store.defaultPermission())).toBe(
        'full-access',
      );
      store.setDefaultPermission('full-access', true);
      expect(effectivePermission(store.get('session', session.id), store.defaultPermission())).toBe(
        'full-access',
      );
      expect(
        effectivePermission({ permission: 'full-access' }, 'ask', { permission: 'read-only' }),
      ).toBe('read-only');
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('does not expose privilege settings or the clipboard as model-callable management commands', () => {
    const commands = new ClientCommands();
    for (const name of ['setDefaultPermission', 'setSessionPermission', 'copyText'])
      commands.register(name, manual('权限', name, 'settings', '需要用户操作'), () => {});
    expect(commands.describe().change).toEqual([]);
    expect(commands.describe().read).toEqual([]);
    expect(commands.describe().methods).toHaveLength(3);
  });
});
