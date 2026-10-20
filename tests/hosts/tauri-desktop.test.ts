import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { nativeUpdateDriver, tauriDesktop } from '../../electron/hosts/tauri-desktop';
import { Updates } from '../../electron/services/desktop/updates';
import { PowerSettings, type PowerDriver } from '../../electron/services/desktop/power';
import { computerDiagnostic } from '../../electron/services/desktop/computer-diagnostic';
import { ComputerControl } from '../../electron/services/desktop/computer';

describe('native host boundaries', () => {
  it('awaits native signature verification and never installs a failed download', async () => {
    const native = vi.fn(async (method: string): Promise<any> => {
      if (method === 'updateCheck') return { version: '2.0.0' };
      if (method === 'updateDownload') throw new Error('signature mismatch');
    });
    const events = new EventEmitter();
    const source = nativeUpdateDriver(native, events);
    const updates = new Updates(
      source.driver,
      '1.0.0',
      true,
      true,
      () => false,
      () => {},
    );
    await updates.check();
    await updates.install();
    expect(updates.snapshot().phase).toBe('error');
    expect(native.mock.calls.flat()).not.toContain('updateInstall');
    native.mockImplementation(async (method: string) =>
      method === 'updateCheck' ? { version: '2.0.0' } : null,
    );
    await updates.install();
    expect(native.mock.calls.at(-1)).toEqual(['updateInstall']);
    source.dispose();
    expect(events.listenerCount('updateProgress')).toBe(0);
  });
  it('reports asynchronous native installer failures and retains work guards', async () => {
    let busy = false;
    const native = vi.fn(async (method: string): Promise<any> => {
      if (method === 'updateCheck') return { version: '2.0.0' };
      if (method === 'updateInstall') throw new Error('native failed');
    });
    const source = nativeUpdateDriver(native, new EventEmitter());
    const updates = new Updates(
      source.driver,
      '1.0.0',
      true,
      true,
      () => busy,
      () => {},
    );
    await updates.check();
    busy = true;
    expect(() => updates.install()).toThrow('请先停止');
    expect(native).toHaveBeenCalledTimes(1);
    busy = false;
    await updates.install();
    expect(updates.snapshot().phase).toBe('error');
    source.dispose();
  });
  it('releases an assertion that finishes starting after unplug and reports failed starts', async () => {
    let resolve!: (id: number) => void;
    const driver: PowerDriver = {
      supported: true,
      platform: 'darwin',
      onBatteryPower: () => false,
      startBlocker: vi.fn(
        () =>
          new Promise<number>((r) => {
            resolve = r;
          }),
      ),
      stopBlocker: vi.fn(async () => {}),
      setLidEnabled: vi.fn(async () => {}),
    };
    const power = new PowerSettings(
      driver,
      {},
      () => {},
      () => {},
    );
    const enabling = power.set({ keepAwakeOnAC: true, keepAwakeWhenLidClosed: false });
    const unplugged = power.refresh(true);
    resolve(17);
    await Promise.all([enabling, unplugged]);
    expect(power.snapshot().active).toBe(false);
    expect(driver.stopBlocker).toHaveBeenCalledWith(17);
    vi.mocked(driver.startBlocker).mockRejectedValueOnce(new Error('assertion failed'));
    await power.refresh(false);
    expect(power.snapshot()).toMatchObject({ active: false, error: 'assertion failed' });
    await power.dispose();
  });
  it('reuses frame checks across native drivers and never inputs after movement or reuse', async () => {
    const window = {
      id: '7',
      pid: 100,
      title: 'fixture',
      bounds: { x: 0, y: 0, width: 600, height: 300 },
    };
    const helper = vi.fn(async (payload: any) => (payload.action === 'windows' ? [window] : {}));
    const control = new ComputerControl({
      status: () => ({
        supported: true,
        platform: 'darwin',
        screen: 'granted',
        accessibility: true,
        emergencyShortcut: true,
      }),
      requestPermission() {},
      helper,
      capture: async () => ({ width: 600, height: 300, data: 'fixture', mimeType: 'image/png' }),
    });
    const signal = new AbortController().signal;
    let frame = JSON.parse(
      (await control.execute('computer_screenshot', { windowId: '7' }, signal)).text,
    );
    await control.execute('computer_click', { frameId: frame.frameId, x: 10, y: 10 }, signal);
    await expect(
      control.execute('computer_click', { frameId: frame.frameId, x: 10, y: 10 }, signal),
    ).rejects.toThrow('截图');
    frame = JSON.parse(
      (await control.execute('computer_screenshot', { windowId: '7' }, signal)).text,
    );
    helper.mockResolvedValueOnce([{ ...window, bounds: { ...window.bounds, x: 20 } }]);
    await expect(
      control.execute('computer_type', { frameId: frame.frameId, text: '中文' }, signal),
    ).rejects.toThrow('移动');
    expect(helper.mock.calls.filter(([p]) => p.action === 'type')).toHaveLength(0);
  });
});

it('diagnoses the native host PID, verifies Unicode delivery and closes its own test window', async () => {
  let title = '',
    value = '';
  const close = vi.fn();
  const control = new ComputerControl({
    status: () => ({
      supported: true,
      platform: 'darwin',
      screen: 'granted',
      accessibility: true,
      emergencyShortcut: false,
    }),
    requestPermission() {},
    helper: async (payload) => {
      if (payload.action === 'windows')
        return [{ id: '7', title, pid: 9999, bounds: { x: 0, y: 0, width: 600, height: 300 } }];
      if (payload.action === 'type') value = payload.text;
      return {};
    },
    capture: async () => ({ width: 600, height: 300, mimeType: 'image/png', data: 'fixture' }),
  });
  const report = await computerDiagnostic(control, async (name) => {
    title = name;
    return { pid: 9999, read: async () => value, close };
  });
  expect(report.ok).toBe(true);
  expect(value).toBe('CoSail自检成功');
  expect(close).toHaveBeenCalledTimes(1);
});

it('recovers a native assertion lost between AC power polls without faking a battery transition', async () => {
  let active = true;
  const driver: PowerDriver = {
    supported: true,
    platform: 'darwin',
    onBatteryPower: () => false,
    blockerActive: () => active,
    startBlocker: vi.fn(async () => {
      active = true;
      return 7;
    }),
    stopBlocker: vi.fn(async () => {
      active = false;
    }),
    setLidEnabled: vi.fn(async () => {}),
  };
  const power = new PowerSettings(
    driver,
    {},
    () => {},
    () => {},
  );
  await power.set({ keepAwakeOnAC: true, keepAwakeWhenLidClosed: false });
  active = false;
  await power.refresh(false);
  expect(driver.startBlocker).toHaveBeenCalledTimes(2);
  expect(power.snapshot()).toMatchObject({ active: true, onBatteryPower: false });
  await power.dispose();
});

it('does not open macOS settings for a native Windows host', async () => {
  const native = vi.fn(
    async (method: string): Promise<any> =>
      method === 'desktopInfo'
        ? { updatesConfigured: false }
        : {
            supported: true,
            platform: 'win32',
            screen: 'available',
            accessibility: true,
            emergencyShortcut: true,
          },
  );
  const desktop = tauriDesktop(native, new EventEmitter());
  await desktop.prepare();
  await desktop.computer.controller.requestPermission();
  expect(native.mock.calls.some(([method]) => method === 'computerSettings')).toBe(false);
});
