import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { Updates } from '../electron/updates';

function fixture() {
  const driver = Object.assign(new EventEmitter(), {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    checkForUpdates: vi.fn(async () => {
      driver.emit('update-available', { version: '0.6.0' });
    }),
    downloadUpdate: vi.fn(async () => {
      driver.emit('download-progress', { percent: 50 });
      driver.emit('update-downloaded');
    }),
    quitAndInstall: vi.fn(),
  });
  const busy = vi.fn(() => false);
  return { driver, busy, updates: new Updates(driver, '0.5.8', true, true, busy, () => {}) };
}
describe('application updates', () => {
  it('checks without downloading, installs only after a completed download and restarts', async () => {
    const { driver, updates } = fixture();
    await updates.check();
    expect(updates.snapshot()).toMatchObject({ phase: 'available', version: '0.6.0' });
    expect(driver.autoDownload).toBe(false);
    expect(driver.autoInstallOnAppQuit).toBe(false);
    expect(driver.downloadUpdate).not.toHaveBeenCalled();
    await updates.install();
    expect(driver.quitAndInstall).toHaveBeenCalledWith(true, true);
  });
  it('preserves active work before download and if work starts during download', async () => {
    const { driver, updates, busy } = fixture();
    await updates.check();
    busy.mockReturnValue(true);
    expect(() => updates.install()).toThrow('请先停止');
    expect(driver.downloadUpdate).not.toHaveBeenCalled();
    busy.mockReturnValueOnce(false).mockReturnValue(true);
    await updates.install();
    expect(updates.snapshot().phase).toBe('downloaded');
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    busy.mockReturnValue(false);
    await updates.install();
    expect(driver.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(driver.quitAndInstall).toHaveBeenCalledTimes(1);
  });
  it('never installs failed downloads and allows retry', async () => {
    const { driver, updates } = fixture();
    await updates.check();
    driver.downloadUpdate.mockRejectedValueOnce(new Error('checksum mismatch'));
    await updates.install();
    expect(updates.snapshot().phase).toBe('error');
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    await updates.install();
    expect(driver.quitAndInstall).toHaveBeenCalledTimes(1);
  });
  it('hides availability after no update and never installs from development or unsigned Mac mode', async () => {
    const { driver, updates } = fixture();
    await updates.check();
    driver.emit('update-not-available');
    expect(updates.snapshot().version).toBeUndefined();
    const dev = new Updates(
      driver,
      '0.5.8',
      false,
      true,
      () => false,
      () => {},
    );
    const mac = new Updates(
      driver,
      '0.5.8',
      true,
      false,
      () => false,
      () => {},
    );
    expect(() => dev.install()).toThrow('不支持');
    expect(() => mac.install()).toThrow('不支持');
  });
});
