import { Context, FiberState, type Fiber, type Plugin } from 'cordis';

/** Owns trusted, built-in plugins. External executable plugins still use MCP transports. */
export class ApplicationKernel {
  readonly context = new Context();
  private fibers: Fiber[] = [];
  private closing?: Promise<void>;
  private disposing = false;
  private cleanupErrors: unknown[] = [];

  get accepting() {
    return !this.disposing;
  }

  async mount(plugin: Plugin.Object<void>) {
    if (this.disposing) throw new Error('应用正在退出');
    const dependencies = Array.isArray(plugin.inject)
      ? plugin.inject
      : Object.keys(plugin.inject ?? {});
    for (const key of dependencies)
      if (this.context.get(key, false) === undefined)
        throw new Error(`${plugin.name ?? '插件'} 缺少服务：${key}`);
    const fiber = this.context.plugin(plugin);
    this.fibers.push(fiber);
    await fiber.await();
    if (fiber.state !== FiberState.ACTIVE) throw new Error(`${plugin.name} 未成功启动`);
    return fiber;
  }

  /** Register cleanup in the owning Cordis context and retain failures for shutdown reporting. */
  own(ctx: Context, dispose: () => void | Promise<unknown>) {
    return ctx.effect(() => async () => {
      try {
        await dispose();
      } catch (error) {
        this.cleanupErrors.push(error);
      }
    });
  }

  get<T>(key: string): T {
    const value = this.context.get(key, false);
    if (value === undefined) throw new Error(`服务尚未启动：${key}`);
    return value;
  }

  stop(quiesce: () => void | Promise<unknown> = () => {}) {
    if (this.closing) return this.closing;
    this.disposing = true;
    return (this.closing = (async () => {
      try {
        await quiesce();
      } catch (error) {
        this.cleanupErrors.push(error);
      }
      // Plugins are mounted after their dependencies. Await each consumer before its provider.
      for (const fiber of this.fibers.splice(0).reverse()) {
        try {
          await fiber.dispose();
        } catch (error) {
          this.cleanupErrors.push(error);
        }
      }
      await this.context.fiber.dispose();
      if (this.cleanupErrors.length)
        throw new AggregateError(this.cleanupErrors, '部分应用资源未能正常释放');
    })());
  }
}
