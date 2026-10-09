import { EventEmitter } from 'node:events';
import type { AppEvent, Run } from '../../src/shared/types';
export type Lifecycle = 'completed' | 'failed' | 'interrupted' | 'approval';
export type EngineInvalidation = { providerId?: string; protocol?: string };
export class ApplicationEvents extends EventEmitter<{
  lifecycle: [run: Run, event: Lifecycle, approvalId?: string];
  engineInvalidated: [scope: EngineInvalidation];
  accountReset: [providerId: string];
  shutdown: [];
}> {
  constructor(readonly publish: (event: AppEvent) => void) {
    super();
  }
  changed = () => this.publish({ type: 'changed' });
  invalidateNative = (protocol?: string) => {
    this.emit('engineInvalidated', { protocol });
  };
}
