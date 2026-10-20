import type { Context } from 'cordis';
import {
  ClientCommands,
  type ClientOperation,
  type ClientRegistrar,
} from '../core/tools/client-commands';

/** A transport authenticates its caller before invoking the registered handler. */
export interface CommandTransport {
  register(name: string, execute: (...args: any[]) => unknown): () => void;
}

/** One business registration shared by in-process clients, transports and agent discovery. */
export class ApplicationCommands {
  private pending = new Set<Promise<unknown>>();
  constructor(
    private commands: ClientCommands,
    private accepting: () => boolean,
    private transport?: CommandTransport,
  ) {}

  scoped(ctx: Context): ClientRegistrar {
    return (name, definition, handler) => {
      ctx.effect(() => this.register(name, definition, handler));
    };
  }

  /** Trusted host entry. Agent calls still go through ClientCommands.attach and its policies. */
  invoke(name: string, ...args: unknown[]) {
    if (!this.accepting()) throw new Error('应用正在退出');
    return this.commands.invoke(name, args);
  }

  async waitForIdle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private register(name: string, definition: ClientOperation, handler: (...args: any[]) => any) {
    const execute = (...args: any[]) => {
      if (!this.accepting()) throw new Error('应用正在退出');
      const result = handler(...args);
      if (result && typeof result.then === 'function') {
        const pending = Promise.resolve(result);
        this.pending.add(pending);
        void pending.then(
          () => this.pending.delete(pending),
          () => this.pending.delete(pending),
        );
      }
      return result;
    };
    const removeCommand = this.commands.register(name, definition, execute);
    let disconnect: (() => void) | undefined;
    try {
      disconnect = this.transport?.register(name, execute);
    } catch (error) {
      removeCommand();
      throw error;
    }
    return () => {
      try {
        disconnect?.();
      } finally {
        removeCommand();
      }
    };
  }
}
