import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../../../electron/services/storage/store';
import { registerPluginServices } from '../../../electron/modules/plugins/plugin-services';
import { McpAuth } from '../../../electron/modules/plugins/mcp-auth';
import { PluginConnection, pluginTool } from '../../../electron/core/tools/extensions';
import { configureFigmaPlugin, figmaDesktopUrl, figmaRemoteUrl } from '../../../src/shared/figma';
import {
  isReadOnlyTool,
  pluginPermissionState,
  validateReadOnlyTools,
} from '../../../src/shared/plugin-permissions';
import type { PluginConfig, PluginTool } from '../../../src/shared/types';

vi.mock('electron', () => ({ dialog: {} }));
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.restoreAllMocks();
});
const config: PluginConfig = {
  id: 'fixture',
  name: 'Fixture',
  transport: 'http',
  url: figmaRemoteUrl,
  command: '',
  args: [],
  enabled: false,
  readOnlyTools: [],
  authMode: 'oauth',
};
const tool = (name: string, annotations?: PluginTool['annotations']): PluginTool => ({
  name,
  description: '',
  inputSchema: { type: 'object' },
  annotations,
});

function fixture() {
  const store = new Store(':memory:', { encrypt: (s) => 'enc:' + s, decrypt: (s) => s.slice(4) });
  cleanup.push(() => store.close());
  const auth = new McpAuth(
    store,
    () => {},
    async () => {},
  );
  cleanup.push(() => auth.dispose());
  const handlers = new Map<string, (...args: any[]) => any>();
  registerPluginServices(
    (name, _definition, handler) => {
      handlers.set(name, handler);
    },
    store,
    { changed: () => {}, invalidateNative: () => {} },
    auth,
    {} as any,
    () => undefined,
  );
  return { store, handlers };
}

it('does not turn absent tool annotations into a declaration that the tool writes', () => {
  expect(pluginTool(tool('unknown', {})).annotations).toEqual({});
  expect(pluginTool(tool('read', { readOnlyHint: true })).annotations).toEqual({
    readOnlyHint: true,
  });
});

it('recognizes official read hints while keeping custom server hints untrusted', () => {
  const read = tool('get_design_context', { readOnlyHint: true });
  expect(isReadOnlyTool(config, read)).toBe(true);
  const custom = { ...config, url: 'https://custom.example/mcp' };
  expect(isReadOnlyTool(custom, read)).toBe(false);
  expect(isReadOnlyTool({ ...custom, readOnlyTools: [read.name] }, read)).toBe(true);
  expect(
    isReadOnlyTool({ ...custom, readOnlyTools: ['write'] }, tool('write', { readOnlyHint: false })),
  ).toBe(false);
});

it.each(['generate_diagram', 'generate_figma_design', 'use_figma', 'create_new_file'])(
  'does not let a local override or misleading hint make %s read-only',
  (name) => {
    const p = { ...config, readOnlyTools: [name] };
    const t = tool(name, { readOnlyHint: true });
    expect(isReadOnlyTool(p, t)).toBe(false);
    expect(() => validateReadOnlyTools(p, [t])).toThrow('不能标记为只读');
  },
);

it('rejects nonexistent allowlist names and destructive tools', () => {
  expect(() => validateReadOnlyTools({ ...config, readOnlyTools: ['missing'] }, [])).toThrow(
    '不存在',
  );
  const destructive = tool('delete', { destructiveHint: true });
  const p = { ...config, readOnlyTools: ['delete'] };
  expect(isReadOnlyTool(p, destructive)).toBe(false);
  expect(() => validateReadOnlyTools(p, [destructive])).toThrow('不能标记为只读');
});
it('does not show old connection evidence after the endpoint or credential changes', () => {
  const saved = {
    ...config,
    catalog: [tool('get_metadata', { readOnlyHint: true })],
    checkedAt: 123,
    oauthStatus: 'authorized' as const,
    oauthScopes: ['mcp'],
  };
  expect(pluginPermissionState(config, saved).checkedAt).toBe(123);
  for (const edit of [
    { ...config, url: figmaDesktopUrl },
    { ...config, clearSecret: true },
    { ...config, oauthClientSecret: 'changed' },
  ]) {
    expect(pluginPermissionState(edit, saved).checkedAt).toBeUndefined();
    expect(pluginPermissionState(edit, saved).oauthScopes).toBeUndefined();
  }
});

it('saves managed Figma authentication and clears old REST app secrets and headers', () => {
  const { store, handlers } = fixture();
  store.put('plugin', {
    ...config,
    oauthClientId: 'old-rest-app',
    oauthIssuer: 'https://api.figma.com',
  });
  store.saveSecret('plugin_oauth_client_fixture', 'old-rest-secret');
  store.saveSecret('plugin_fixture', '{"Authorization":"Bearer old-token"}');
  handlers.get('savePlugin')!({
    ...config,
    oauthClientId: 'rest-app',
    oauthIssuer: 'https://api.figma.com',
    oauthClientSecret: 'rest-secret',
  });
  expect(store.get<PluginConfig>('plugin', config.id)).toMatchObject({
    authMode: 'oauth',
    url: figmaRemoteUrl,
  });
  expect(store.get<PluginConfig>('plugin', config.id).oauthClientId).toBeUndefined();
  expect(store.secret('plugin_oauth_client_fixture')).toBe('');
  expect(store.secret('plugin_fixture')).toBe('');
  expect(configureFigmaPlugin({ ...config, url: figmaDesktopUrl }).authMode).toBe('headers');
});

it('rejects a conflicting saved allowlist before changing the verified configuration', () => {
  const { store, handlers } = fixture();
  const p = { ...config, catalog: [tool('generate_diagram')], checkedAt: Date.now() };
  store.put('plugin', p);
  expect(() =>
    handlers.get('savePlugin')!({ ...config, readOnlyTools: ['generate_diagram'] }),
  ).toThrow('只读工具配置');
  expect(store.get<PluginConfig>('plugin', config.id)).toEqual(p);
  store.put('plugin', { ...p, enabled: true, readOnlyTools: ['generate_diagram'] });
  handlers.get('savePlugin')!({ ...config, enabled: false, readOnlyTools: ['generate_diagram'] });
  expect(store.get<PluginConfig>('plugin', config.id).enabled).toBe(false);
});

it('checks the real catalog without calling a write tool and clears stale check evidence on failure', async () => {
  const { store, handlers } = fixture();
  const p = {
    ...config,
    url: 'https://custom.example/mcp',
    authMode: 'headers' as const,
    readOnlyTools: ['write'],
  };
  store.put('plugin', p);
  vi.spyOn(PluginConnection.prototype, 'connect').mockResolvedValue();
  vi.spyOn(PluginConnection.prototype, 'tools').mockResolvedValue([
    tool('write', { readOnlyHint: false }),
  ]);
  vi.spyOn(PluginConnection.prototype, 'close').mockResolvedValue();
  const call = vi.spyOn(PluginConnection.prototype, 'call');
  await expect(handlers.get('testPlugin')!(p.id)).rejects.toThrow('不能标记为只读');
  expect(store.get<PluginConfig>('plugin', p.id).checkedAt).toBeUndefined();
  expect(call).not.toHaveBeenCalled();
  store.put('plugin', { ...p, readOnlyTools: [] });
  await handlers.get('testPlugin')!(p.id);
  expect(store.get<PluginConfig>('plugin', p.id).checkedAt).toBeGreaterThan(0);
  expect(call).not.toHaveBeenCalled();
});
