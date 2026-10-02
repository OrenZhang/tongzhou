import { describe, it, expect, vi } from 'vitest';
vi.mock('electron', () => ({ desktopCapturer: {}, systemPreferences: {} }));
import { actionSchema, mapPoint, DesktopComputer } from '../electron/computer';
describe('computer tool boundaries', () => {
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
});
