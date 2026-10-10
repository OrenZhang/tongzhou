import type { PluginConfig } from '../../../src/shared/types';
import { builtinPlugins } from '../../../src/shared/builtin-plugins';
import type { Store } from '../../services/storage/store';

/** Resolve bundled paths and preserve independent plugin settings. */
export function ensureBuiltinPlugins(store: Store, command: string, entry: string) {
  const existing = store.list<PluginConfig>('plugin');
  store.db.exec('BEGIN');
  try {
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
        enabled: previous?.enabled ?? false,
        readOnlyTools: [...definition.tools],
        // Invalidate cached tools whenever the server mode changes.
        catalog: previous?.args.includes('--' + definition.mode) ? previous.catalog : undefined,
      } satisfies PluginConfig);
    }
    store.db.exec('COMMIT');
  } catch (e) {
    store.db.exec('ROLLBACK');
    throw e;
  }
}
