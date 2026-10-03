import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, symlink, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../electron/store';
import { providerSchema } from '../electron/validation';
import { parseCCSwitch, importCCSwitch } from '../electron/cc-switch';
import { executeTool, files, within } from '../electron/workspace';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderInput } from '../src/shared/types';
const temporary: string[] = [];
async function temp() {
  const p = await mkdtemp(path.join(os.tmpdir(), 'tongzhou-test-'));
  temporary.push(p);
  return p;
}
afterEach(async () => {
  for (const p of temporary.splice(0)) await rm(p, { recursive: true, force: true });
});
const codec = {
  encrypt: (s: string) => Buffer.from(s).toString('base64'),
  decrypt: (s: string) => Buffer.from(s, 'base64').toString(),
};
const provider: ProviderInput = {
  id: 'test',
  name: 'Test',
  protocol: 'openai-chat',
  baseUrl: 'https://example.com/v1',
  auth: 'api-key',
  models: ['test-model'],
  maxOutputTokens: 1024,
  contextChars: 10000,
};
describe('persistent data and credentials', () => {
  it('never returns a secret in snapshots and retains an existing key on edit', () => {
    const s = new Store(':memory:', codec);
    s.saveProvider({ ...provider, secret: 'unit-test-key' });
    expect(JSON.stringify(s.providers())).not.toContain('unit-test-key');
    expect(s.providers().find((p) => p.id === 'test')?.hasSecret).toBe(true);
    s.saveProvider({ ...provider, name: 'Renamed', secret: '' });
    expect(s.secret('test')).toBe('unit-test-key');
    s.saveProvider({ ...provider, clearSecret: true });
    expect(s.secret('test')).toBe('');
    s.close();
  });
  it('recovers unfinished runs after process restart without replaying', async () => {
    const p = path.join(await temp(), 'state.db');
    let s = new Store(p, codec);
    s.put('session', { ...s.createSession(), id: 's' });
    s.put('run', { id: 'r', sessionId: 's', status: 'running' });
    s.message({
      id: 'm',
      sessionId: 's',
      role: 'assistant',
      content: 'partial',
      createdAt: 1,
      status: 'streaming',
    });
    s.close();
    s = new Store(p, codec);
    expect(s.get<any>('run', 'r').status).toBe('interrupted');
    expect(s.messages('s')[0].status).toBe('interrupted');
    s.close();
  });
  it('preserves message order when an earlier streaming item is updated', () => {
    const s = new Store(':memory:', codec);
    const m = {
      id: 'first',
      sessionId: 's',
      role: 'assistant' as const,
      content: 'a',
      createdAt: 1,
    };
    s.put('session', { ...s.createSession(), id: 's' });
    s.message(m);
    s.message({ ...m, id: 'second', content: 'b' });
    s.message({ ...m, content: 'updated' });
    expect(s.messages('s').map((m) => m.content)).toEqual(['updated', 'b']);
    s.close();
  });
});
describe('endpoint and workspace boundaries', () => {
  it('allows local HTTP but rejects credentials, fragments and remote HTTP', () => {
    for (const url of [
      'http://example.com/v1',
      'https://user:password@example.com',
      'https://example.com?key=secret',
      'https://example.com/#secret',
    ])
      expect(providerSchema.safeParse({ ...provider, baseUrl: url }).success).toBe(false);
    expect(
      providerSchema.safeParse({ ...provider, baseUrl: 'http://127.0.0.1:11434/v1' }).success,
    ).toBe(true);
  });
  it('rejects directory traversal, absolute paths and .git writes', async () => {
    const root = await temp();
    for (const p of ['../outside', 'a/../../outside', 'C:\\outside'])
      await expect(within(root, p, true)).rejects.toThrow();
    await expect(within(root, '.git/config', true)).rejects.toThrow();
    expect(await within(root, 'src/new.ts', true)).toBe(
      path.join(await realpath(root), 'src/new.ts'),
    );
  });
  it('does not follow symlinks or Windows junctions', async () => {
    const root = await temp();
    const outside = await temp();
    await symlink(
      outside,
      path.join(root, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(within(root, 'link/private.txt', true)).rejects.toThrow('符号链接');
    expect(await files(root)).toEqual([]);
  });
  it('requires approval, enforces read-only, and detects changes during approval', async () => {
    const root = await temp();
    const signal = new AbortController().signal;
    const args = JSON.stringify({ path: 'hello.txt', content: 'hello' });
    expect(await executeTool('write_file', args, root, 'ask', signal, async () => false)).toContain(
      '拒绝',
    );
    await expect(readFile(path.join(root, 'hello.txt'))).rejects.toThrow();
    await expect(
      executeTool('write_file', args, root, 'read-only', signal, async () => true),
    ).rejects.toThrow('只读');
    await expect(
      executeTool('write_file', args, root, 'ask', signal, async () => {
        await writeFile(path.join(root, 'hello.txt'), 'concurrent edit');
        return true;
      }),
    ).rejects.toThrow('变化');
    expect(await readFile(path.join(root, 'hello.txt'), 'utf8')).toBe('concurrent edit');
  });
  it('writes nested files after approval and reads them back', async () => {
    const root = await temp();
    const signal = new AbortController().signal;
    await executeTool(
      'write_file',
      JSON.stringify({ path: 'src/你好.txt', content: '同舟' }),
      root,
      'ask',
      signal,
      async () => true,
    );
    expect(
      await executeTool(
        'read_file',
        '{"path":"src/你好.txt"}',
        root,
        'read-only',
        signal,
        async () => false,
      ),
    ).toBe('同舟');
  });
});
describe('CC Switch read-only import', () => {
  it('maps Anthropic env and Codex TOML without importing scripts', () => {
    const result = parseCCSwitch([
      {
        name: 'Claude',
        app_type: 'claude',
        settings_config: JSON.stringify({
          env: {
            ANTHROPIC_BASE_URL: 'https://a.example',
            ANTHROPIC_AUTH_TOKEN: 'fake-key',
            ANTHROPIC_MODEL: 'model-a',
          },
          usageScript: 'DO NOT RUN',
        }),
      },
      {
        name: 'Codex',
        app_type: 'codex',
        settings_config: {
          auth: { OPENAI_API_KEY: 'key-b' },
          config:
            'model = "model-b"\nmodel_provider = "custom"\n[model_providers.custom]\nbase_url = "https://b.example/v1"\nwire_api = "responses"',
        },
      },
    ]);
    expect(result.providers).toHaveLength(2);
    expect(result.providers[0]).toMatchObject({
      baseUrl: 'https://a.example/v1',
      secret: 'fake-key',
      protocol: 'anthropic',
    });
    expect(result.providers[1]).toMatchObject({
      baseUrl: 'https://b.example/v1',
      secret: 'key-b',
      models: ['model-b'],
    });
    expect(JSON.stringify(result)).not.toContain('DO NOT RUN');
  });
  it('reads an actual CC Switch SQLite providers table without modifying it', async () => {
    const file = path.join(await temp(), 'cc-switch.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE providers(name TEXT,app_type TEXT,settings_config TEXT)');
    db.prepare('INSERT INTO providers VALUES(?,?,?)').run(
      'Test',
      'claude',
      JSON.stringify({ env: { ANTHROPIC_API_KEY: 'unit-key' } }),
    );
    db.close();
    const before = await readFile(file);
    expect((await importCCSwitch(file)).providers).toHaveLength(1);
    expect(await readFile(file)).toEqual(before);
  });
  it('rejects unsupported endpoint schemes and removes proxy placeholder credentials', () => {
    const result = parseCCSwitch([
      { name: 'bad', settingsConfig: { baseUrl: 'file:///etc/passwd' } },
      {
        name: 'proxy',
        settingsConfig: { baseUrl: 'http://127.0.0.1:15721/v1', apiKey: 'PROXY_MANAGED' },
      },
    ]);
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].secret).toBe('');
    expect(result.warnings.length).toBeGreaterThan(1);
  });
});
