import type { AgentProfile, PluginConfig } from '../../../src/shared/types';
import { builtinPlugins } from '../../../src/shared/builtin-plugins';
import { vendorPlugins } from '../../../src/shared/vendor-plugins';
import type { Store } from '../../services/storage/store';

/** Resolve bundled paths and preserve independent plugin settings. */
export function ensureBuiltinPlugins(store: Store, command: string, entry: string) {
  const existing = store.list<PluginConfig>('plugin');
  store.db.exec('BEGIN');
  try {
    // These queries now run as core tools. Retire only the reserved built-in ID.
    store.remove('plugin', 'tongzhou-system');
    store.remove('mcpAuthEpoch', 'tongzhou-system');
    store.saveSecret('plugin_tongzhou-system', undefined, true);
    store.saveSecret('plugin_oauth_client_tongzhou-system', undefined, true);
    for (const agent of store.list<AgentProfile>('agent')) {
      if (agent.pluginIds?.includes('tongzhou-system'))
        store.put('agent', {
          ...agent,
          pluginIds: agent.pluginIds.filter((id) => id !== 'tongzhou-system'),
        });
    }
    for (const definition of builtinPlugins) {
      const previous = existing.find((p) => p.id === definition.id);
      store.put('plugin', {
        ...previous,
        id: definition.id,
        name: definition.name,
        transport: 'stdio',
        command,
        args: [entry, '--' + definition.mode],
        url: '',
        enabled: previous?.enabled ?? definition.id === 'tongzhou-web',
        readOnlyTools: [...definition.tools],
        // Invalidate cached tools whenever the server mode changes.
        catalog:
          previous?.args.includes('--' + definition.mode) &&
          definition.tools.every((name) => previous.catalog?.some((tool) => tool.name === name))
            ? previous.catalog
            : undefined,
      } satisfies PluginConfig);
    }
    for (const definition of vendorPlugins) {
      const previous = existing.find((p) => p.id === definition.id);
      const bundled = !('package' in definition);
      store.put('plugin', {
        ...previous,
        id: definition.id,
        name: definition.name,
        transport: 'stdio',
        command: bundled ? command : (previous?.command ?? 'uvx'),
        args: bundled
          ? [entry, '--kimi']
          : (previous?.args ?? [
              '--from',
              `${definition.package}==${definition.version}`,
              definition.package,
            ]),
        url: '',
        enabled: previous?.enabled ?? false,
        readOnlyTools: previous?.readOnlyTools ?? [...definition.tools],
      } satisfies PluginConfig);
    }
    store.db.exec('COMMIT');
  } catch (e) {
    store.db.exec('ROLLBACK');
    throw e;
  }
}
