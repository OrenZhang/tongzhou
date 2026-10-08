import { beforeEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({
  getPath: vi.fn(),
  openExternal: vi.fn(),
  showItemInFolder: vi.fn(),
  realpath: vi.fn(),
  stat: vi.fn(),
  createFromPath: vi.fn(),
  icon: {
    isEmpty: () => false,
    toDataURL: () => 'data:image/png;base64,fixture',
    resize: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: { getPath: fake.getPath, isPackaged: false },
  nativeImage: { createFromPath: fake.createFromPath },
  shell: { openExternal: fake.openExternal, showItemInFolder: fake.showItemInFolder },
}));
vi.mock('node:fs/promises', () => ({ realpath: fake.realpath, stat: fake.stat }));
import {
  ComputerPermissions,
  macApplicationPath,
} from '../../../electron/services/desktop/computer-permissions';
beforeEach(() => {
  vi.clearAllMocks();
  fake.getPath.mockReturnValue(
    '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  );
  fake.realpath.mockImplementation(async (value) => value);
  fake.stat.mockResolvedValue({ isDirectory: () => true });
  fake.createFromPath.mockReturnValue(fake.icon);
  fake.icon.resize.mockReturnValue(fake.icon);
});
describe('macOS computer permission application', () => {
  it('resolves development and packaged bundles without assuming the display name', () => {
    expect(
      macApplicationPath('/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    ).toBe('/repo/node_modules/electron/dist/Electron.app');
    expect(macApplicationPath('/Applications/同舟工作台.app/Contents/MacOS/Tongzhou')).toBe(
      '/Applications/同舟工作台.app',
    );
    expect(() => macApplicationPath('/repo/node_modules/.bin/electron')).toThrow('应用');
  });
  it('drags the verified running application with its native icon and reveals the same path', async () => {
    const permissions = new ComputerPermissions('darwin');
    const sender = { startDrag: vi.fn() };
    expect(() => permissions.startDrag(sender as any)).toThrow('尚未加载');
    const guide = await permissions.guide();
    expect(fake.createFromPath.mock.calls[0][0]).toMatch(/build[\\/]icon\.png$/);
    expect(guide).toMatchObject({
      name: 'Electron.app',
      development: true,
      icon: 'data:image/png;base64,fixture',
    });
    permissions.startDrag(sender as any);
    expect(sender.startDrag).toHaveBeenCalledWith({ file: guide!.path, icon: fake.icon });
    await permissions.revealApplication();
    expect(fake.showItemInFolder).toHaveBeenCalledWith(guide!.path);
    await permissions.guide();
    expect(fake.createFromPath).toHaveBeenCalledTimes(1);
  });
  it('only opens the two declared settings panes and refuses unknown destinations', async () => {
    const permissions = new ComputerPermissions('darwin');
    await permissions.openSettings('accessibility');
    await permissions.openSettings('screen');
    expect(fake.openExternal.mock.calls.map((call) => call[0])).toEqual([
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    ]);
    await expect(permissions.openSettings('https://example.com' as any)).rejects.toThrow('未知');
    expect(fake.openExternal).toHaveBeenCalledTimes(2);
  });
  it('does not expose a drag payload for a missing application and allows a retry', async () => {
    const permissions = new ComputerPermissions('darwin');
    fake.stat.mockRejectedValueOnce(new Error('missing'));
    await expect(permissions.guide()).rejects.toThrow('missing');
    expect(() => permissions.startDrag({ startDrag: vi.fn() } as any)).toThrow('尚未加载');
    expect(await permissions.guide()).toMatchObject({ name: 'Electron.app' });
  });
  it('does not invoke macOS APIs on other platforms', async () => {
    const permissions = new ComputerPermissions('win32');
    expect(await permissions.guide()).toBeNull();
    await expect(permissions.openSettings('screen')).rejects.toThrow('macOS');
    await expect(permissions.revealApplication()).rejects.toThrow('macOS');
    expect(() => permissions.startDrag({ startDrag: vi.fn() } as any)).toThrow('macOS');
    expect(fake.getPath).not.toHaveBeenCalled();
  });
});
