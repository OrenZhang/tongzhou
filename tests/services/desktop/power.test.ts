import { describe, expect, it, vi } from 'vitest';
import { PowerSettings } from '../../../electron/services/desktop/power';

function fixture(platform = 'win32', battery = false, saved = {}) {
  const driver = {
    platform,
    supported: platform !== 'linux',
    onBatteryPower: vi.fn(() => battery),
    startBlocker: vi.fn(() => 7),
    stopBlocker: vi.fn(),
    setLidEnabled: vi.fn(async () => {}),
  };
  const save = vi.fn(),
    changed = vi.fn();
  return { driver, save, changed, power: new PowerSettings(driver, saved, save, changed) };
}
describe.each(['win32', 'darwin'])('AC-only power settings on %s', (platform) => {
  it('defaults off, retains display sleep, pauses on battery and resumes on AC', async () => {
    const { power, driver } = fixture(platform);
    await power.refresh();
    expect(driver.startBlocker).not.toHaveBeenCalled();
    await power.set({ keepAwakeOnAC: true, keepAwakeWhenLidClosed: true });
    expect(power.snapshot()).toMatchObject({ active: true, lidActive: true });
    driver.onBatteryPower.mockReturnValue(true);
    const paused = power.refresh(true);
    expect(driver.stopBlocker).toHaveBeenCalledWith(7);
    await paused;
    expect(power.snapshot()).toMatchObject({
      active: false,
      lidActive: false,
      keepAwakeOnAC: true,
    });
    driver.onBatteryPower.mockReturnValue(false);
    await power.refresh(false);
    expect(power.snapshot()).toMatchObject({ active: true, lidActive: true });
    await power.dispose();
    expect(power.snapshot()).toMatchObject({ active: false, lidActive: false });
    expect(driver.setLidEnabled).toHaveBeenLastCalledWith(false, false);
  });
  it('rejects enabling on battery but permits turning off a remembered preference', async () => {
    const { power, save } = fixture(platform, true);
    await expect(power.set({ keepAwakeOnAC: true, keepAwakeWhenLidClosed: false })).rejects.toThrow(
      '连接电源',
    );
    expect(save).not.toHaveBeenCalled();
    const remembered = fixture(platform, true, {
      keepAwakeOnAC: true,
      keepAwakeWhenLidClosed: true,
    });
    await remembered.power.refresh();
    expect(remembered.driver.startBlocker).not.toHaveBeenCalled();
    await remembered.power.set({ keepAwakeOnAC: false, keepAwakeWhenLidClosed: false });
    expect(remembered.save).toHaveBeenCalled();
  });
  it('releases the blocker immediately when unplugged during an outstanding authorization', async () => {
    const { power, driver } = fixture(platform);
    let release!: () => void;
    driver.setLidEnabled.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const enabling = power.set({ keepAwakeOnAC: true, keepAwakeWhenLidClosed: true });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const unplugged = power.refresh(true);
    expect(driver.stopBlocker).toHaveBeenCalledWith(7);
    release();
    await Promise.all([enabling, unplugged]);
    expect(power.snapshot()).toMatchObject({ active: false, lidActive: false });
  });
  it('reports permission and restoration failures instead of claiming success', async () => {
    const { power, driver } = fixture(platform);
    driver.setLidEnabled.mockRejectedValueOnce(new Error('授权失败'));
    await power.set({ keepAwakeOnAC: true, keepAwakeWhenLidClosed: true });
    expect(power.snapshot()).toMatchObject({ active: true, lidActive: false, error: '授权失败' });
    await power.refresh();
    driver.setLidEnabled.mockRejectedValueOnce(new Error('恢复失败'));
    await expect(power.dispose()).rejects.toThrow('恢复失败');
    expect(power.snapshot().active).toBe(false);
  });
});
it('does not enable unsupported platforms', async () => {
  const { power, driver } = fixture('linux', false, { keepAwakeOnAC: true });
  await power.refresh();
  expect(driver.startBlocker).not.toHaveBeenCalled();
  await expect(power.set({ keepAwakeOnAC: true, keepAwakeWhenLidClosed: true })).rejects.toThrow(
    '仅支持',
  );
});
