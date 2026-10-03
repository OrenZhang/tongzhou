import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../electron/store';

const fixture = vi.hoisted(() => ({
  windows: [] as any[],
  partitions: new Map<string, any>(),
  fail: false,
}));
vi.mock('electron', () => ({
  session: {
    fromPartition: (name: string) => {
      if (!fixture.partitions.has(name))
        fixture.partitions.set(name, {
          cookies: {
            get: vi.fn(async () => [{ name: 'session', value: 'private-cookie' }]),
            flushStore: vi.fn(async () => {}),
          },
          clearStorageData: vi.fn(async () => {}),
          clearCache: vi.fn(async () => {}),
          setPermissionRequestHandler: vi.fn(),
        });
      return fixture.partitions.get(name);
    },
  },
  BrowserWindow: class {
    dead = false;
    events = new Map<string, () => void>();
    webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn() };
    focus = vi.fn();
    constructor(public options: unknown) {
      fixture.windows.push(this);
    }
    on(name: string, fn: () => void) {
      this.events.set(name, fn);
    }
    isDestroyed() {
      return this.dead;
    }
    destroy() {
      this.dead = true;
      this.events.get('closed')?.();
    }
    async loadURL() {
      if (fixture.fail) throw new Error('network failure');
    }
  },
}));
import { BrowserProfiles } from '../electron/browser-profiles';
beforeEach(() => {
  fixture.windows.length = 0;
  fixture.partitions.clear();
  fixture.fail = false;
});
function setup() {
  const connectors = new Map([
    [
      'a',
      {
        id: 'a',
        name: '服务 A',
        kind: 'browser',
        enabled: true,
        baseUrl: 'https://example.invalid',
      },
    ],
    [
      'b',
      {
        id: 'b',
        name: '服务 B',
        kind: 'browser',
        enabled: true,
        baseUrl: 'https://example.invalid',
      },
    ],
  ]);
  return {
    connectors,
    profiles: new BrowserProfiles({
      get: (_kind: string, id: string) => connectors.get(id),
    } as Store),
  };
}
describe('browser credential boundary', () => {
  it('isolates profiles, returns only state and reuses an existing window', async () => {
    const { profiles } = setup();
    expect(await profiles.open('a')).toMatchObject({ opened: true, reused: false });
    expect(await profiles.open('a')).toMatchObject({ reused: true });
    await profiles.open('b');
    expect(fixture.windows).toHaveLength(2);
    expect(fixture.partitions.size).toBe(2);
    const status = await profiles.status('a');
    expect(status).toMatchObject({ open: true, hasStoredCookies: true });
    expect(JSON.stringify(status)).not.toContain('private-cookie');
    profiles.close('a');
    expect((await profiles.status('a')).open).toBe(false);
    expect((await profiles.status('b')).open).toBe(true);
    await profiles.clear('a');
    expect(
      fixture.partitions.get('persist:tongzhou-connector-a').clearStorageData,
    ).toHaveBeenCalledOnce();
    expect(
      fixture.partitions.get('persist:tongzhou-connector-b').clearStorageData,
    ).not.toHaveBeenCalled();
    profiles.dispose();
  });
  it('cleans up failed windows so retry really loads, and rejects disabled connectors', async () => {
    const { profiles, connectors } = setup();
    fixture.fail = true;
    await expect(profiles.open('a')).rejects.toThrow('无法打开');
    expect(fixture.windows[0].dead).toBe(true);
    expect((await profiles.status('a')).open).toBe(false);
    fixture.fail = false;
    expect(await profiles.open('a')).toMatchObject({ opened: true, reused: false });
    connectors.get('a')!.enabled = false;
    await expect(profiles.open('a')).rejects.toThrow('停用');
    profiles.dispose();
  });
});
