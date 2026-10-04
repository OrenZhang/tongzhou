import { describe, it, expect, vi } from 'vitest';
vi.mock('electron', () => ({ desktopCapturer: { getSources: vi.fn() }, systemPreferences: {} }));
import { desktopCapturer } from 'electron';
import { actionSchema, mapPoint, DesktopComputer, observedWindow } from '../electron/computer';
describe('computer tool boundaries', () => {
  it('targets only the owned modal of a disabled window, never unrelated windows', () => {
    const bounds = { x: 0, y: 0, width: 100, height: 100 };
    const parent = { id: '1', pid: 10, title: 'App', enabled: false, bounds };
    const modal = { id: '2', pid: 10, title: 'Confirm', ownerId: '1', enabled: true, bounds };
    expect(observedWindow([parent, modal], '1')).toBe(modal);
    expect(() => observedWindow([parent, { ...modal, pid: 20 }], '1')).toThrow('弹窗');
    expect(observedWindow([{ ...parent, enabled: true }, modal], '1').id).toBe('1');
  });
  it('maps screenshot coordinates to physical window coordinates including negative monitors', () => {
    const frame = {
      width: 1000,
      height: 500,
      bounds: { x: -1920, y: 80, width: 1500, height: 750 },
    };
    expect(mapPoint(500, 250, frame)).toEqual({ x: -1170, y: 455 });
    expect(() => mapPoint(1000, 1, frame)).toThrow('范围');
    expect(() => mapPoint(-1, 1, frame)).toThrow('范围');
  });
  it('limits action shapes and refuses arbitrary key scripts', () => {
    expect(actionSchema.parse({ action: 'key', key: 'CTRL+SHIFT+A' })).toBeTruthy();
    for (const key of ['$(calc)', 'CTRL+;whoami', 'ALT+', 'x'])
      expect(actionSchema.safeParse({ action: 'key', key }).success).toBe(false);
    expect(actionSchema.safeParse({ action: 'scroll', x: 0, y: 0, amount: 1000 }).success).toBe(
      false,
    );
    expect(actionSchema.safeParse({ action: 'type', text: 'a'.repeat(4001) }).success).toBe(false);
    expect(actionSchema.safeParse({ action: 'click', x: Infinity, y: 0 }).success).toBe(false);
  });
  it('provides only observation tools to read-only agents', () => {
    const computer = new DesktopComputer();
    expect(computer.specs(true).map((t) => t.name)).toEqual([
      'computer_windows',
      'computer_screenshot',
    ]);
    expect(computer.specs(false)).toHaveLength(7);
  });
  it('retries a newly shown window without using another window image', async () => {
    const computer = new DesktopComputer();
    vi.spyOn(computer, 'status').mockReturnValue({
      supported: true,
      platform: 'win32',
      screen: 'available',
      accessibility: true,
      emergencyShortcut: false,
    });
    vi.spyOn(computer as any, 'helper').mockResolvedValue([
      {
        id: '123',
        title: 'Owned fixture',
        pid: 1,
        bounds: { x: 0, y: 0, width: 600, height: 300 },
      },
    ]);
    const image = {
      isEmpty: () => false,
      getSize: () => ({ width: 600, height: 300 }),
      toJPEG: () => Buffer.from('target-window'),
    };
    const capture = vi.mocked(desktopCapturer.getSources);
    capture.mockReset();
    capture.mockResolvedValueOnce([{ id: 'window:999:1', thumbnail: image }] as any);
    capture.mockResolvedValueOnce([{ id: 'window:123:1', thumbnail: image }] as any);
    const result = await computer.execute(
      'computer_screenshot',
      { windowId: '123' },
      new AbortController().signal,
    );
    expect(capture).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.text).window).toBe('Owned fixture');
    expect(result.images?.[0].data).toBe(Buffer.from('target-window').toString('base64'));
    capture.mockReset();
    capture.mockResolvedValue([]);
    await expect(
      computer.execute('computer_screenshot', { windowId: '123' }, new AbortController().signal),
    ).rejects.toThrow('未获取目标窗口图像');
    expect(capture).toHaveBeenCalledTimes(3);
  });
});
