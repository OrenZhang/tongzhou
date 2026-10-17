import { expect, it, vi } from 'vitest';
import { Store } from '../../../electron/services/storage/store';
import { registerProviderServices } from '../../../electron/services/accounts/provider-services';
import { ClientCommands, type ClientOperation } from '../../../electron/core/tools/client-commands';
import { ToolScope } from '../../../electron/core/tools/extensions';

it('reveals a saved key only through the manual UI operation and keeps provider data free of plaintext', async () => {
  const decrypt = vi.fn((value: string) => value.slice(7));
  const store = new Store(':memory:', { encrypt: (value) => 'sealed:' + value, decrypt });
  const commands = new ClientCommands();
  const handlers = new Map<
    string,
    { operation: ClientOperation; handler: (...args: any[]) => any }
  >();
  registerProviderServices(
    (name, operation, handler) => {
      commands.register(name, operation, handler);
      handlers.set(name, { operation, handler });
    },
    store,
    { snapshot: () => ({ runs: [] }), changed: () => {} } as any,
    {} as any,
    {} as any,
    {} as any,
    new Map(),
  );
  store.saveProvider({
    id: 'fixture',
    name: 'fixture',
    protocol: 'openai-chat',
    auth: 'api-key',
    baseUrl: 'https://example.invalid/v1',
    models: ['test'],
    maxOutputTokens: 512,
    contextChars: 0,
    secret: 'dummy-test-key',
  });
  const reveal = handlers.get('revealProviderSecret')!;
  expect(reveal.operation).toMatchObject({ access: 'manual', view: 'providers' });
  expect(JSON.stringify(store.providers())).not.toContain('dummy-test-key');
  const scope = new ToolScope(
    new AbortController().signal,
    async () => true,
    () => {},
  );
  try {
    commands.attach(scope, false, () => true, 'fixture-session');
    for (const tool of ['client_query', 'client_change'])
      expect(
        (await scope.call(tool, { method: 'revealProviderSecret', args: ['fixture'] })).isError,
      ).toBe(true);
    expect(decrypt).not.toHaveBeenCalled();
    expect(reveal.handler('fixture')).toBe('dummy-test-key');
    expect(decrypt).toHaveBeenCalledTimes(1);
    store.saveProvider({ ...store.providers().find((p) => p.id === 'fixture')!, secret: '' });
    expect(reveal.handler('fixture')).toBe('dummy-test-key');
  } finally {
    await scope.close();
    store.db.close();
  }
});
