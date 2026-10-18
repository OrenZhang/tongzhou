import { builtinPlugins } from './builtin-plugins';
import { vendorPlugins } from './vendor-plugins';
import { t } from './i18n';

const definitions = [...builtinPlugins, ...vendorPlugins];
export function pluginLabel(plugin: { id: string; name: string }): string {
  return definitions.some((entry) => entry.id === plugin.id && entry.name === plugin.name)
    ? t(plugin.name)
    : plugin.name;
}
