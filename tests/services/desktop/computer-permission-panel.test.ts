import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: vi.fn(), ipcMain: {}, screen: {} }));
import { permissionPanelBounds } from '../../../electron/services/desktop/computer-permission-panel';

describe('macOS authorization panel placement', () => {
  it('appears beneath the settings window without covering its contents', () => {
    const settings = { x: 300, y: 60, width: 600, height: 500 };
    const panel = permissionPanelBounds(settings, { x: 0, y: 24, width: 1440, height: 876 });
    expect(panel.y).toBeGreaterThan(settings.y + settings.height);
    expect(panel.x + panel.width / 2).toBe(settings.x + settings.width / 2);
  });
  it('uses the side when a tall settings window leaves no space below', () => {
    const settings = { x: 200, y: 60, width: 600, height: 750 };
    const panel = permissionPanelBounds(settings, { x: 0, y: 24, width: 1440, height: 876 });
    expect(panel.x).toBeGreaterThan(settings.x + settings.width);
    expect(panel.y + panel.height).toBeLessThanOrEqual(900);
  });
  it('keeps fallback and offscreen positions within the chosen display', () => {
    const area = { x: -1280, y: 24, width: 1280, height: 696 };
    for (const settings of [null, { x: -2000, y: -100, width: 600, height: 950 }]) {
      const panel = permissionPanelBounds(settings, area);
      expect(panel.x).toBeGreaterThanOrEqual(area.x);
      expect(panel.y).toBeGreaterThanOrEqual(area.y);
      expect(panel.x + panel.width).toBeLessThanOrEqual(area.x + area.width);
      expect(panel.y + panel.height).toBeLessThanOrEqual(area.y + area.height);
    }
  });
});
