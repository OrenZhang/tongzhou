import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { encodeArguments } from '../shared/rpc';
import { createClientAPI } from '../shared/client-api';
import type { AppEvent } from '../shared/types';

export async function connectTauri() {
  const listeners = new Set<(event: AppEvent) => void>();
  await listen<AppEvent>('tongzhou:event', (event) => {
    for (const listener of listeners) listener(event.payload);
  });
  await invoke('core_ready');
  return createClientAPI(
    (method, ...args) => invoke('core_call', { method, ...encodeArguments(args) }),
    (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    () => '', // Browser File objects do not disclose native paths; use the native chooser.
  );
}
