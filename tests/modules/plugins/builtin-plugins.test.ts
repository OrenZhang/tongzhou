import { describe, expect, it } from 'vitest';
import { Store } from '../../../electron/services/storage/store';
import { ensureBuiltinPlugins } from '../../../electron/modules/plugins/builtin-plugins';
import type { PluginConfig } from '../../../src/shared/types';

describe('built-in plugin configuration', () => {
  it.each([true, false])('refreshes bundled paths and preserves enabled=%s', (enabled) => {
    const store = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
    try {
      store.put('plugin', {
        id: 'tongzhou-web',
        name: '网页读取 · 内置',
        transport: 'stdio',
        command: 'old-node',
        args: ['old/builtin-mcp.cjs', '--web'],
        url: '',
        enabled,
        readOnlyTools: ['fetch_page'],
        catalog: [{ name: 'fetch_page', inputSchema: { type: 'object' } }],
      });
      ensureBuiltinPlugins(store, 'bundled-node', 'new/builtin-mcp.cjs');
      const web = store.get<PluginConfig>('plugin', 'tongzhou-web');
      const system = store.get<PluginConfig>('plugin', 'tongzhou-system');
      expect(web.enabled).toBe(enabled);
      expect(system.enabled).toBe(false);
      expect(web.readOnlyTools).toEqual(['fetch_page']);
      expect(web.catalog?.[0].name).toBe('fetch_page');
      expect(system.readOnlyTools).toEqual(['current_time', 'system_info']);
      expect(web.args).toEqual(['new/builtin-mcp.cjs', '--web']);
      expect(system.args).toEqual(['new/builtin-mcp.cjs', '--system']);
      // Later restarts repair paths without resetting independent user switches.
      store.put('plugin', { ...system, enabled: !enabled });
      ensureBuiltinPlugins(store, 'upgraded-node', 'upgrade/builtin-mcp.cjs');
      expect(store.get<PluginConfig>('plugin', 'tongzhou-web').enabled).toBe(enabled);
      expect(store.get<PluginConfig>('plugin', 'tongzhou-system').enabled).toBe(!enabled);
    } finally {
      store.close();
    }
  });
  it('seeds two disabled plugins and leaves third-party configurations alone', () => {
    const store = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
    try {
      const thirdParty = { id: 'custom', name: 'custom', enabled: true };
      store.put('plugin', thirdParty);
      ensureBuiltinPlugins(store, 'node', 'builtin-mcp.cjs');
      expect(store.get<PluginConfig>('plugin', 'tongzhou-web').enabled).toBe(false);
      expect(store.get<PluginConfig>('plugin', 'tongzhou-system').enabled).toBe(false);
      expect(store.get('plugin', 'custom')).toEqual(thirdParty);
    } finally {
      store.close();
    }
  });
});
