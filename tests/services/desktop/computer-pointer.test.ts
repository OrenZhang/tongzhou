import { afterEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ windows: [] as any[], load: async () => {} }));
vi.mock('electron', () => ({
  screen: { getCursorScreenPoint: () => ({ x: -120, y: 80 }) },
  BrowserWindow: class {
    destroyed = false;
    visible = false;
    position: number[] = [];
    webContents = { executeJavaScript: vi.fn(async () => {}) };
    constructor() {
      fake.windows.push(this);
    }
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    loadURL() {
      return fake.load();
    }
    isDestroyed() {
      return this.destroyed;
    }
    setPosition(x: number, y: number) {
      this.position = [x, y];
    }
    showInactive() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    destroy() {
      this.destroyed = true;
      this.visible = false;
    }
  },
}));
import { ComputerPointer } from '../../../electron/services/desktop/computer-pointer';

afterEach(() => {
  vi.useRealTimers();
  fake.windows = [];
  fake.load = async () => {};
});
describe('computer pointer run lifecycle', () => {
  it('stays visible between actions, temporarily hides for captures and clears on run end', async () => {
    vi.useFakeTimers();
    const pointer = new ComputerPointer();
    const run = new AbortController();
    await pointer.show('click', run.signal);
    await pointer.finish(run.signal);
    await vi.advanceTimersByTimeAsync(10000);
    const window = fake.windows[0];
    expect(window.visible).toBe(true);
    expect(window.position).toEqual([-138, 62]);
    pointer.pause();
    expect(window.visible).toBe(false);
    await pointer.finish(run.signal);
    expect(window.visible).toBe(true);
    await pointer.show('type', run.signal);
    expect(fake.windows).toHaveLength(1);
    run.abort();
    expect(window.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('ending an older run cannot hide the current run pointer', async () => {
    vi.useFakeTimers();
    const pointer = new ComputerPointer();
    const old = new AbortController(),
      current = new AbortController();
    await pointer.show('click', old.signal);
    await pointer.show('type', current.signal);
    old.abort();
    pointer.hide(old.signal);
    expect(fake.windows[1].visible).toBe(true);
    current.abort();
    expect(fake.windows.every((w) => w.destroyed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancellation during window loading cannot resurrect the pointer', async () => {
    vi.useFakeTimers();
    let loaded!: () => void;
    fake.load = () =>
      new Promise<void>((resolve) => {
        loaded = resolve;
      });
    const pointer = new ComputerPointer(),
      run = new AbortController();
    const showing = pointer.show('click', run.signal);
    run.abort();
    loaded();
    await showing;
    expect(fake.windows[0].destroyed).toBe(true);
    expect(fake.windows[0].visible).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
