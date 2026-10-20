import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { tauriDesktop } from '../../electron/hosts/tauri-desktop';
import { computerHelper } from '../../electron/services/desktop/computer-helper';

vi.mock('../../electron/services/desktop/computer-helper', () => ({ computerHelper: vi.fn() }));

describe.skipIf(process.platform !== 'darwin')('Tauri native text input', () => {
  async function fixture() {
    const window = {
      id: '7',
      pid: 9999,
      title: 'fixture',
      bounds: { x: 0, y: 0, width: 600, height: 300 },
    };
    const helper = vi.mocked(computerHelper);
    helper
      .mockReset()
      .mockImplementation(async (payload: any) => (payload.action === 'windows' ? [window] : {}));
    const native = vi.fn(async (method: string, ..._args: unknown[]): Promise<any> => {
      if (method === 'computerStatus')
        return { supported: true, platform: 'darwin', screen: 'granted', accessibility: true };
      if (method === 'computerCapture')
        return { width: 600, height: 300, mimeType: 'image/png', data: 'fixture' };
      return {};
    });
    const controller = tauriDesktop(native, new EventEmitter()).computer.controller;
    const abort = new AbortController();
    const frame = JSON.parse(
      (await controller.execute('computer_screenshot', { windowId: '7' }, abort.signal)).text,
    );
    return { controller, native, helper, abort, frame };
  }

  it('focuses the observed window and sends Unicode batches through the native host', async () => {
    const { controller, native, helper, abort, frame } = await fixture();
    const text = 'a'.repeat(31) + '🛶中';
    await controller.execute('computer_type', { frameId: frame.frameId, text }, abort.signal);
    expect(helper.mock.calls.filter(([p]: any) => p.action === 'focus')).toHaveLength(1);
    expect(helper.mock.calls.some(([p]: any) => p.action === 'type')).toBe(false);
    expect(native.mock.calls.filter(([m]) => m === 'computerType')).toEqual([
      ['computerType', '7', 9999, 'fixture', 'a'.repeat(31) + '🛶'],
      ['computerType', '7', 9999, 'fixture', '中'],
    ]);
  });

  it('never posts text when the target cannot be focused', async () => {
    const { controller, native, helper, abort, frame } = await fixture();
    helper.mockImplementation(async (payload: any) => {
      if (payload.action === 'windows')
        return [
          { id: '7', pid: 9999, title: 'fixture', bounds: { x: 0, y: 0, width: 600, height: 300 } },
        ];
      throw new Error('Could not focus');
    });
    await expect(
      controller.execute('computer_type', { frameId: frame.frameId, text: '中文' }, abort.signal),
    ).rejects.toThrow('Could not focus');
    expect(native.mock.calls.some(([m]) => m === 'computerType')).toBe(false);
  });

  it('stops between native batches when the operation is canceled', async () => {
    const { controller, native, abort, frame } = await fixture();
    const original = native.getMockImplementation()!;
    native.mockImplementation(async (method: string, ...args: unknown[]) => {
      if (method === 'computerType') abort.abort();
      return original(method, ...args);
    });
    await expect(
      controller.execute(
        'computer_type',
        { frameId: frame.frameId, text: '中'.repeat(64) },
        abort.signal,
      ),
    ).rejects.toThrow();
    expect(native.mock.calls.filter(([m]) => m === 'computerType')).toHaveLength(1);
  });
});
