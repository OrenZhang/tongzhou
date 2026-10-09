import { CodexClient } from '../../electron/core/codex/codex';
import { ToolScope } from '../../electron/core/tools/extensions';
import { ClientCommands, operation } from '../../electron/core/tools/client-commands';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { z } from 'zod';

async function main() {
  const root = await mkdtemp(path.resolve('test-results/dynamic-tools-'));
  const scope = new ToolScope(
    new AbortController().signal,
    async () => true,
    () => {},
  );
  const commands = new ClientCommands();
  commands.attach(scope, false, () => true, 'fixture');
  const codex = new CodexClient(path.join(root, 'codex'));
  try {
    // Discovery and dispatch use the live registry after the tool scope is attached.
    commands.register(
      'fixtureGreeting',
      operation('新模块', 'query', '查询测试问候', [z.string()]),
      (name) => ({ greeting: '你好 ' + name }),
    );
    const catalog = await scope.call('client_catalog', { method: 'fixtureGreeting' });
    assert.equal(JSON.parse(catalog.text).methods[0].name, 'fixtureGreeting');
    const managed = await scope.call('client_query', {
      method: 'fixtureGreeting',
      args: ['同舟'],
    });
    assert.equal(JSON.parse(managed.text).greeting, '你好 同舟');
    const invalid = await scope.call('client_query', {
      method: 'fixtureGreeting',
      args: [123],
    });
    assert.equal(invalid.isError, true);
    await codex.start();
    const thread = await codex.request('thread/start', {
      cwd: root,
      model: 'gpt-5.4',
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      ephemeral: true,
      config: { 'features.multi_agent': false },
      dynamicTools: scope.specs.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        inputSchema: t.parameters,
      })),
    });
    assert.ok(thread.thread.id);
    const unrestricted = await codex.request('thread/start', {
      cwd: root,
      model: 'gpt-5.4',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: true,
      config: { 'features.multi_agent': false },
    });
    assert.ok(unrestricted.thread.id, 'bundled Codex must accept the full-access policy');
    console.log(
      'Dynamic tools passed: live registry discovery, dispatch and validation; bundled Codex accepted dynamic tools and permission policies. No inference or login.',
    );
  } finally {
    codex.stop();
    await scope.close();
    await rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
