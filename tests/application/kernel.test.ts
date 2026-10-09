import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, IpcMain } from 'electron';
import { ApplicationKernel } from '../../electron/application/kernel';
import { ClientIpc } from '../../electron/application/client-ipc';
import { ClientCommands, operation } from '../../electron/core/tools/client-commands';

function ipcFixture(kernel: ApplicationKernel) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const ipc = {
    handle: vi.fn((name, handler) => {
      if (handlers.has(name)) throw new Error('duplicate');
      handlers.set(name, handler);
    }),
    removeHandler: vi.fn((name) => handlers.delete(name)),
  } as unknown as Pick<IpcMain, 'handle' | 'removeHandler'>;
  const frame = { url: 'https://trusted.fixture/' };
  const contents = { mainFrame: frame };
  const window = { webContents: contents } as unknown as BrowserWindow;
  const event = { sender: contents, senderFrame: frame };
  const commands = new ClientCommands();
  const bridge = new ClientIpc(
    commands,
    ipc,
    () => window,
    (url) => url === frame.url,
    () => kernel.accepting,
  );
  return { bridge, commands, handlers, event, ipc };
}

describe('Cordis application lifecycle', () => {
  it('injects dependencies and quiesces before releasing consumers, network and storage', async () => {
    const kernel = new ApplicationKernel();
    const order: string[] = [];
    await kernel.mount({
      name: 'storage',
      apply(ctx) {
        ctx.provide('testStore', {});
        kernel.own(ctx, () => {
          order.push('storage');
        });
      },
    });
    await kernel.mount({
      name: 'network',
      inject: ['testStore'],
      apply(ctx) {
        expect(ctx.get('testStore')).toBeDefined();
        ctx.provide('testNetwork', {});
        kernel.own(ctx, async () => {
          await Promise.resolve();
          order.push('network');
        });
      },
    });
    await kernel.mount({
      name: 'consumer',
      inject: ['testNetwork'],
      apply(ctx) {
        kernel.own(ctx, () => {
          order.push('consumer');
        });
      },
    });
    const stopping = kernel.stop(() => {
      order.push('idle');
    });
    expect(kernel.stop()).toBe(stopping);
    await stopping;
    expect(order).toEqual(['idle', 'consumer', 'network', 'storage']);
    expect(kernel.context.get('testStore', false)).toBeUndefined();
    await expect(kernel.mount({ name: 'late', apply() {} })).rejects.toThrow('正在退出');
  });

  it('rejects missing dependencies and rolls back interfaces after a partially failed plugin', async () => {
    const kernel = new ApplicationKernel();
    const { bridge, commands, handlers } = ipcFixture(kernel);
    await expect(
      kernel.mount({ name: 'missing', inject: ['notAvailable'], apply() {} }),
    ).rejects.toThrow('缺少服务');
    await expect(
      kernel.mount({
        name: 'broken',
        apply(ctx) {
          bridge.scoped(ctx)('query', operation('fixture', 'query', 'query'), () => 'value');
          throw new Error('fixture setup failed');
        },
      }),
    ).rejects.toThrow('fixture setup failed');
    await kernel.stop();
    expect(handlers.size).toBe(0);
    expect(commands.describe().methods).toEqual([]);
  });

  it('unregisters both IPC and catalog on disposal, allowing a clean remount', async () => {
    const kernel = new ApplicationKernel();
    const { bridge, commands, handlers, event } = ipcFixture(kernel);
    const plugin = {
      name: 'feature',
      apply(ctx: import('cordis').Context) {
        bridge.scoped(ctx)('query', operation('fixture', 'query', 'query'), () => 'value');
      },
    };
    const fiber = await kernel.mount(plugin);
    expect(await handlers.get('tongzhou:query')!(event)).toBe('value');
    expect(commands.describe().methods).toHaveLength(1);
    await fiber.dispose();
    expect(handlers.size).toBe(0);
    expect(commands.describe().methods).toHaveLength(0);
    await kernel.mount(plugin);
    expect(commands.describe().methods).toHaveLength(1);
    await kernel.stop();
  });

  it('keeps IPC restricted to the trusted main frame and rejects calls during quiescence', async () => {
    const kernel = new ApplicationKernel();
    const { bridge, handlers, event } = ipcFixture(kernel);
    const execute = vi.fn(() => 'value');
    await kernel.mount({
      name: 'feature',
      apply(ctx) {
        bridge.scoped(ctx)('query', operation('fixture', 'query', 'query'), execute);
      },
    });
    const handler = handlers.get('tongzhou:query')!;
    await expect(
      handler({ ...event, senderFrame: { url: 'https://untrusted.fixture/' } }),
    ).rejects.toThrow('不可信');
    await expect(handler({ ...event, sender: {} })).rejects.toThrow('不可信');
    let finish!: () => void;
    const stopping = kernel.stop(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await expect(handler(event)).rejects.toThrow('正在退出');
    expect(execute).not.toHaveBeenCalled();
    finish();
    await stopping;
  });

  it('still releases storage and reports failures when a consumer cleanup fails', async () => {
    const kernel = new ApplicationKernel();
    const closeStore = vi.fn();
    await kernel.mount({
      name: 'storage',
      apply(ctx) {
        kernel.own(ctx, closeStore);
      },
    });
    await kernel.mount({
      name: 'broken',
      apply(ctx) {
        kernel.own(ctx, () => {
          throw new Error('cleanup');
        });
      },
    });
    await expect(kernel.stop()).rejects.toThrow('未能正常释放');
    expect(closeStore).toHaveBeenCalledOnce();
  });

  it('waits for an in-flight operation before unregistering its interfaces', async () => {
    const kernel = new ApplicationKernel();
    const { bridge, handlers, event } = ipcFixture(kernel);
    let finish!: () => void;
    const result = new Promise<string>((resolve) => {
      finish = () => resolve('saved');
    });
    await kernel.mount({
      name: 'feature',
      apply(ctx) {
        bridge.scoped(ctx)('save', operation('fixture', 'change', 'save'), () => result);
      },
    });
    const call = handlers.get('tongzhou:save')!(event);
    let closed = false;
    const stopping = kernel
      .stop(() => bridge.waitForIdle())
      .then(() => {
        closed = true;
      });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(handlers.size).toBe(1);
    finish();
    expect(await call).toBe('saved');
    await stopping;
    expect(handlers.size).toBe(0);
  });

  it('rolls back catalog registration when Electron rejects the IPC channel', async () => {
    const kernel = new ApplicationKernel();
    const { bridge, commands, ipc } = ipcFixture(kernel);
    vi.mocked(ipc.handle).mockImplementation(() => {
      throw new Error('IPC unavailable');
    });
    await expect(
      kernel.mount({
        name: 'feature',
        apply(ctx) {
          bridge.scoped(ctx)('query', operation('fixture', 'query', 'query'), () => 'value');
        },
      }),
    ).rejects.toThrow('IPC unavailable');
    expect(commands.describe().methods).toHaveLength(0);
    await kernel.stop();
  });
});
