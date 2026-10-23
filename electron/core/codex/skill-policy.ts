import { setTimeout as delay } from 'node:timers/promises';

/** Idempotent policy setup only; never retry a model turn or business-tool execution. */
export async function disableNativeSkill(
  client: { request(method: string, params: any): Promise<any> },
  path: string,
  signal: AbortSignal,
) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      await client.request('skills/config/write', { path, enabled: false });
      return;
    } catch (error) {
      // Config persistence can fail transiently during initialization. Keep policy
      // fail-closed after bounded retries; never continue with an enabled native skill.
      if (attempt >= 3 || !/failed to persist config at/i.test(String(error))) throw error;
      await delay(100 * (attempt + 1), undefined, { signal });
    }
  }
}
