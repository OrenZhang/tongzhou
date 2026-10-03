import { describe, it, expect, afterEach, vi } from 'vitest';
import { Store } from '../electron/store';
import {
  ToolScope,
  PluginConnection,
  importSkillDirectory,
  mcpName,
  normalizeOutput,
} from '../electron/extensions';
import { pluginSchema } from '../electron/validation';
import { toolBridge } from '../electron/tool-bridge';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AgentProfile, PluginConfig } from '../src/shared/types';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
const agent: AgentProfile = {
  id: 'a',
  name: 'a',
  description: '',
  instructions: '',
  providerId: '',
  model: '',
  permission: 'ask',
  maxSteps: 16,
};
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tongzhou-mcp-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'fixture.cjs');
  await writeFile(
    file,
    `const readline=require('node:readline'); const fs=require('node:fs');
readline.createInterface({input:process.stdin}).on('line',async line=>{const r=JSON.parse(line);if(r.id===undefined)return;let result={};
if(r.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
if(r.method==='tools/list')result={tools:[{name:'read_item',description:'read fixture',inputSchema:{type:'object',properties:{}}},{name:'write_item',inputSchema:{type:'object',properties:{}}}]};
if(r.method==='tools/call')result={content:[{type:'text',text:'RESULT:'+r.params.name+':'+(process.env.TEST_SECRET||'')}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});`,
  );
  const store = new Store(':memory:', {
    encrypt: (v) => 'encrypted:' + v,
    decrypt: (v) => v.slice(10),
  });
  cleanups.push(() => store.close());
  const config: PluginConfig = {
    id: 'fixture',
    name: 'Fixture MCP',
    transport: 'stdio',
    command: process.execPath,
    args: [file],
    url: '',
    enabled: true,
    readOnlyTools: ['read_item'],
    catalog: [
      {
        name: 'read_item',
        description: 'read fixture',
        inputSchema: { type: 'object', properties: {} },
      },
      { name: 'write_item', description: '', inputSchema: { type: 'object', properties: {} } },
    ],
  };
  store.put('plugin', config);
  store.saveSecret('plugin_fixture', JSON.stringify({ TEST_SECRET: 'sensitive-fixture-value' }));
  return { root, store, config };
}
describe('shared plugin scope', () => {
  it('binds the native bridge to one run, checks its token and refuses browser-origin calls', async () => {
    const controller = new AbortController();
    const scope = new ToolScope(
      controller.signal,
      async () => true,
      () => {},
    );
    scope.add(
      { name: 'fixture', description: '', parameters: { type: 'object' } },
      'fixture',
      async () => ({ text: 'OK' }),
    );
    const bridge = await toolBridge(scope, controller.signal);
    cleanups.push(() => bridge.close());
    cleanups.push(() => scope.close());
    const url = bridge.config.env[0].value,
      token = bridge.config.env[1].value;
    expect((await fetch(url, { method: 'POST', body: '{}' })).status).toBe(403);
    expect(
      (
        await fetch(url, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, Origin: 'https://untrusted.example' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: JSON.stringify({ method: 'call', name: 'fixture', arguments: {}, callId: 'one' }),
    });
    expect((await response.json()).content[0].text).toBe('OK');
    controller.abort();
    await expect(
      fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: '{}' }),
    ).rejects.toThrow();
  });
  it('discovers a real stdio server, gates calls, redacts credentials and deduplicates a call id', async () => {
    const { store } = await fixture();
    const ask = vi.fn(async () => true);
    const record = vi.fn();
    const scope = new ToolScope(new AbortController().signal, ask, record);
    cleanups.push(() => scope.close());
    await scope.prepare(store, { ...agent, pluginIds: ['fixture'] });
    expect(scope.specs).toHaveLength(2);
    const name = mcpName('fixture', 'write_item');
    const first = await scope.call(name, {}, 'call-one');
    await scope.call(name, {}, 'call-one');
    expect(first.text).toContain('RESULT:write_item');
    expect(first.text).not.toContain('sensitive-fixture-value');
    expect(first.text).toContain('REDACTED');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(store.db.prepare('SELECT value FROM secrets').get()!.value).toContain('encrypted:');
  });
  it('limits read-only agents to user-allowlisted tools and never exposes disabled plugins', async () => {
    const { store, config } = await fixture();
    const scope = new ToolScope(
      new AbortController().signal,
      async () => true,
      () => {},
    );
    cleanups.push(() => scope.close());
    await scope.prepare(store, { ...agent, permission: 'read-only', pluginIds: ['fixture'] });
    expect(scope.specs.map((t) => t.name)).toEqual([mcpName('fixture', 'read_item')]);
    await expect(scope.call(mcpName('fixture', 'write_item'), {})).rejects.toThrow('没有权限');
    store.put('plugin', { ...config, enabled: false });
    const disabled = new ToolScope(
      new AbortController().signal,
      async () => true,
      () => {},
    );
    cleanups.push(() => disabled.close());
    await disabled.prepare(store, { ...agent, pluginIds: ['fixture'] });
    expect(disabled.specs).toHaveLength(0);
  });
  it('never executes a denied or cancelled action, and refuses calls after close', async () => {
    const fn = vi.fn(async () => ({ text: 'executed' }));
    const controller = new AbortController();
    const scope = new ToolScope(
      controller.signal,
      async () => false,
      () => {},
    );
    scope.add({ name: 'click', description: '', parameters: {} }, 'Click', fn);
    expect((await scope.call('click', {})).isError).toBe(true);
    expect(fn).not.toHaveBeenCalled();
    await scope.close();
    await expect(scope.call('click', {})).rejects.toThrow('停止');
    const second = new ToolScope(
      controller.signal,
      async () => {
        controller.abort();
        return true;
      },
      () => {},
    );
    second.add({ name: 'click', description: '', parameters: {} }, 'Click', fn);
    await second.call('click', {});
    expect(fn).not.toHaveBeenCalled();
  });
  it('imports a portable Skill package and allows only its selected text resources', async () => {
    const { root, store } = await fixture();
    await mkdir(path.join(root, 'references'));
    await writeFile(
      path.join(root, 'SKILL.md'),
      '---\nname: example\ndescription: Example skill\n---\nRead references/guide.md',
    );
    await writeFile(path.join(root, 'references/guide.md'), 'guide content');
    const skill = await importSkillDirectory(root);
    expect(skill.name).toBe('example');
    expect(skill.files['references/guide.md']).toBe('guide content');
    store.put('skill', skill);
    const scope = new ToolScope(
      new AbortController().signal,
      async () => true,
      () => {},
    );
    cleanups.push(() => scope.close());
    await scope.prepare(store, { ...agent, skillIds: [skill.id] });
    expect(
      (await scope.call('read_skill_file', { skillId: skill.id, path: 'references/guide.md' }))
        .text,
    ).toBe('guide content');
    expect(
      (await scope.call('read_skill_file', { skillId: skill.id, path: '../../secret' })).isError,
    ).toBe(true);
  });
  it('validates MCP URLs and credentials without exposing arbitrary transports', () => {
    const base = {
      id: 'a',
      name: 'A',
      transport: 'http',
      command: '',
      args: [],
      url: 'http://127.0.0.1/mcp',
      enabled: true,
      readOnlyTools: [],
    };
    expect(pluginSchema.safeParse(base).success).toBe(true);
    for (const url of [
      'http://example.com/mcp',
      'https://user:pass@example.com/mcp',
      'https://example.com/mcp?token=x',
    ])
      expect(pluginSchema.safeParse({ ...base, url }).success).toBe(false);
    expect(pluginSchema.safeParse({ ...base, secret: '{"Authorization":123}' }).success).toBe(
      false,
    );
  });
  it('bounds image output and does not expose arbitrary resource URLs as images', () => {
    const output = normalizeOutput({
      content: [
        { type: 'image', mimeType: 'image/svg+xml', data: '<svg/>' },
        { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        { type: 'text', text: 'hello' },
      ],
    });
    expect(output.images).toEqual([{ mimeType: 'image/png', data: 'AAAA' }]);
    expect(output.text).toContain('hello');
  });
});
