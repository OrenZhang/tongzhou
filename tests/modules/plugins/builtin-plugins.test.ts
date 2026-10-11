import { describe, expect, it } from 'vitest';
import { Store } from '../../../electron/services/storage/store';
import { ensureBuiltinPlugins } from '../../../electron/modules/plugins/builtin-plugins';
import type { PluginConfig } from '../../../src/shared/types';

describe('built-in plugin configuration', () => {
  it('retires the system MCP and its agent references without touching personal plugins', () => {
    const store = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
    try {
      store.put('plugin', { id: 'tongzhou-system', enabled: true });
      store.put('plugin', { id: 'personal-clock', enabled: true });
      store.put('agent', { id: 'agent', pluginIds: ['tongzhou-system', 'personal-clock'] });
      store.saveSecret('plugin_tongzhou-system', 'old-secret');
      for (let i = 0; i < 2; i++) ensureBuiltinPlugins(store, 'node', 'builtin.cjs');
      expect(store.list<PluginConfig>('plugin').some((p) => p.id === 'tongzhou-system')).toBe(
        false,
      );
      expect(store.get('plugin', 'personal-clock')).toEqual({
        id: 'personal-clock',
        enabled: true,
      });
      expect(store.get('agent', 'agent')).toEqual({ id: 'agent', pluginIds: ['personal-clock'] });
      expect(store.hasSecret('plugin_tongzhou-system')).toBe(false);
    } finally {
      store.close();
    }
  });
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
      expect(web.enabled).toBe(enabled);
      expect(web.readOnlyTools).toEqual(['web_search', 'fetch_page']);
      expect(web.catalog).toBeUndefined(); // Discover the newly added search tool.
      expect(web.args).toEqual(['new/builtin-mcp.cjs', '--web']);
      // Later restarts repair paths without resetting independent user switches.
      ensureBuiltinPlugins(store, 'upgraded-node', 'upgrade/builtin-mcp.cjs');
      expect(store.get<PluginConfig>('plugin', 'tongzhou-web').enabled).toBe(enabled);
    } finally {
      store.close();
    }
  });
  it('enables webpage reading by default and leaves other configurations alone', () => {
    const store = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
    try {
      const thirdParty = { id: 'custom', name: 'custom', enabled: true };
      store.put('plugin', thirdParty);
      ensureBuiltinPlugins(store, 'node', 'builtin-mcp.cjs');
      expect(store.get<PluginConfig>('plugin', 'tongzhou-web').enabled).toBe(true);
      expect(store.get('plugin', 'custom')).toEqual(thirdParty);
    } finally {
      store.close();
    }
  });
  it('seeds vendor MCP presets without enabling them or overwriting credentials and custom launch paths', () => {
    const store = new Store(':memory:', { encrypt: (v) => v, decrypt: (v) => v });
    try {
      ensureBuiltinPlugins(store, 'bundled-node', 'builtin-mcp.cjs');
      const media = store.get<PluginConfig>('plugin', 'minimax-multimedia');
      expect(media.args).toEqual(['--from', 'minimax-mcp==0.0.19', 'minimax-mcp']);
      expect(media.enabled).toBe(false);
      expect(media.readOnlyTools).toEqual([]);
      expect(store.get<PluginConfig>('plugin', 'minimax-coding').readOnlyTools).toEqual([
        'web_search',
        'understand_image',
      ]);
      store.put('plugin', { ...media, enabled: true, command: '/custom/uvx' });
      store.saveSecret('plugin_' + media.id, '{"MINIMAX_API_KEY":"test-key"}');
      ensureBuiltinPlugins(store, 'new-node', 'new-builtin.cjs');
      expect(store.get<PluginConfig>('plugin', media.id).command).toBe('/custom/uvx');
      expect(store.get<PluginConfig>('plugin', media.id).enabled).toBe(true);
      expect(store.secret('plugin_' + media.id)).toContain('test-key');
      expect(store.get<PluginConfig>('plugin', 'tongzhou-kimi-web').args).toEqual([
        'new-builtin.cjs',
        '--kimi',
      ]);
      expect(store.get<PluginConfig>('plugin', 'tongzhou-kimi-web').enabled).toBe(false);
    } finally {
      store.close();
    }
  });
});
