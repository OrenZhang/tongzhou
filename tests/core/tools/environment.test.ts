import { expect, it, vi } from 'vitest';
import { attachEnvironmentTools } from '../../../electron/core/tools/environment';
import { ToolScope } from '../../../electron/core/tools/extensions';

it('provides current time and host diagnostics without a plugin or approval', async () => {
  const ask = vi.fn();
  const scope = new ToolScope(new AbortController().signal, ask, () => {});
  attachEnvironmentTools(scope);
  try {
    const time = JSON.parse((await scope.call('current_time', {})).text);
    expect(Math.abs(Date.parse(time.utc) - Date.now())).toBeLessThan(10000);
    expect(time.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    const info = JSON.parse((await scope.call('system_info', {})).text);
    expect(info.platform).toBe(process.platform);
    expect(info.memory.totalBytes).toBeGreaterThan(0);
    expect(info.cpu.logicalCores).toBeGreaterThan(0);
    expect(info.env).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
  } finally {
    await scope.close();
  }
});
