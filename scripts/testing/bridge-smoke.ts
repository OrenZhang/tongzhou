import { CodexClient } from '../../electron/core/codex/codex';
import { ToolScope } from '../../electron/core/tools/extensions';
import { toolBridge } from '../../electron/core/tools/tool-bridge';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { NativeClient, modelCatalog } from '../../electron/services/accounts/native-engine';
import { ClientCommands, operation } from '../../electron/core/tools/client-commands';
import { z } from 'zod';
async function main() {
  const root = await mkdtemp(path.resolve('test-results/bridge-'));
  const controller = new AbortController();
  const scope = new ToolScope(
    controller.signal,
    async () => true,
    () => {},
  );
  scope.add(
    {
      name: 'read_fixture',
      description: 'Read test fixture',
      parameters: { type: 'object', properties: {} },
    },
    'fixture',
    async () => ({ text: 'Bridge result' }),
  );
  const commands = new ClientCommands();
  commands.attach(scope, false, () => true, 'fixture');
  const bridge = await toolBridge(scope, controller.signal);
  const proxy = new Client({ name: 'fixture', version: '1' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: bridge.config.command,
    args: bridge.config.args,
    env: Object.fromEntries(bridge.config.env.map((e) => [e.name, e.value])),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  const codex = new CodexClient(path.join(root, 'codex'));
  try {
    await proxy.connect(transport);
    assert.equal((await proxy.listTools()).tools[0].name, 'read_fixture');
    const output: any = await proxy.callTool({ name: 'read_fixture', arguments: {} });
    assert.equal(output.content[0].text, 'Bridge result');
    // A new module is registered after the MCP bridge was created: no tool adapter or
    // bridge restart is necessary because discovery and dispatch use the live registry.
    commands.register(
      'bridgeGreeting',
      operation('新模块', 'query', '查询桥接测试', [z.string()]),
      (name) => ({ greeting: '你好 ' + name }),
    );
    const catalog: any = await proxy.callTool({
      name: 'client_catalog',
      arguments: { method: 'bridgeGreeting' },
    });
    assert.equal(JSON.parse(catalog.content[0].text).methods[0].name, 'bridgeGreeting');
    const managed: any = await proxy.callTool({
      name: 'client_query',
      arguments: { method: 'bridgeGreeting', args: ['同舟'] },
    });
    assert.equal(JSON.parse(managed.content[0].text).greeting, '你好 同舟');
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
    if (process.env.TONGZHOU_KIMI_TOOL_SMOKE === '1') {
      const home = process.env.TONGZHOU_KIMI_HOME;
      if (!home)
        throw new Error('Set TONGZHOU_KIMI_HOME to the user-authorized isolated Kimi directory');
      const kimi = new NativeClient('kimi', home);
      let called = 0,
        reply = '';
      scope.add(
        {
          name: 'read_kimi_fixture',
          description: 'Read the test phrase',
          parameters: { type: 'object', properties: {} },
        },
        'Kimi fixture',
        async () => {
          called++;
          return { text: '同舟工具桥接成功' };
        },
      );
      kimi.on('request', (r) => {
        const option = r.params.options?.find((o: any) => o.kind === 'allow_once');
        const allowed =
          r.method === 'session/request_permission' &&
          JSON.stringify(r.params.toolCall).includes('read_kimi_fixture') &&
          option;
        kimi.reply(r.id, {
          outcome: allowed
            ? { outcome: 'selected', optionId: option.optionId }
            : { outcome: 'cancelled' },
        });
      });
      kimi.on('notification', (n) => {
        if (n.params?.update?.sessionUpdate === 'agent_message_chunk')
          reply += n.params.update.content?.text ?? '';
      });
      try {
        await kimi.start();
        await kimi.authenticate();
        const session = await kimi.request('session/new', {
          cwd: root,
          mcpServers: [bridge.config],
        });
        const catalog = modelCatalog(session);
        assert.ok(catalog.models.length);
        await kimi.request('session/set_mode', { sessionId: session.sessionId, modeId: 'default' });
        await kimi.request(
          'session/prompt',
          {
            sessionId: session.sessionId,
            prompt: [
              {
                type: 'text',
                text: '只调用 MCP tongzhou-tools 中的 read_kimi_fixture 工具一次，并回复工具返回的文字。不要调用其他工具。',
              },
            ],
          },
          120000,
        );
        assert.equal(called, 1);
        assert.ok(reply.includes('同舟工具桥接成功'));
        console.log('Kimi authenticated live MCP tool call and response passed.');
      } finally {
        kimi.stop();
      }
    }
    console.log(
      'Native bridge passed: real stdio MCP proxy + private per-run channel; bundled Codex accepted dynamic-tool thread creation. No Codex inference or login.',
    );
  } finally {
    await proxy.close();
    codex.stop();
    bridge.close();
    await scope.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
