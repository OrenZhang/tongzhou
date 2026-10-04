import type { PluginConfig } from '../src/shared/types';
import { builtinPlugins } from '../src/shared/builtin-plugins';
import type { Store } from './store';

/** Repair bundled paths on upgrade and split the old combined plugin once. */
export function ensureBuiltinPlugins(store: Store, command: string, entry: string) {
  const existing = store.list<PluginConfig>('plugin');
  const legacy = existing.find((p) => p.id === 'tongzhou-web' && !p.args.includes('--web'));
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
        enabled: previous?.enabled ?? legacy?.enabled ?? false,
        readOnlyTools: [...definition.tools],
        // A cached combined catalog must not expose time tools on the web server.
        catalog: previous?.args.includes('--' + definition.mode) ? previous.catalog : undefined,
      } satisfies PluginConfig);
    }
    store.db.exec('COMMIT');
  } catch (e) {
    store.db.exec('ROLLBACK');
    throw e;
  }
}
