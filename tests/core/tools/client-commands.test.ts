import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ClientCommands, operation, manual } from '../../../electron/core/tools/client-commands';
import { ToolScope } from '../../../electron/core/tools/extensions';

const scopes: ToolScope[] = [];
afterEach(async () => {
  await Promise.all(scopes.splice(0).map((s) => s.close()));
});
function attach(
  commands: ClientCommands,
  options: { readonly?: boolean; enabled?: () => boolean; ask?: () => Promise<boolean> } = {},
) {
  const ask = vi.fn(options.ask ?? (async () => true));
  const scope = new ToolScope(new AbortController().signal, ask, () => {});
  commands.attach(scope, !!options.readonly, options.enabled ?? (() => true), 'current');
  scopes.push(scope);
  return { scope, ask };
}
describe('self-registering client capabilities', () => {
  it('returns the actual registry with an explicit lookup error for invented names instead of an empty capability list', async () => {
    const commands = new ClientCommands();
    commands.register(
      'knowledgeDelete',
      operation('智库', 'change', '删除文档', [z.string()]),
      () => {},
    );
    const { scope } = attach(commands);
    const result = await scope.call('client_catalog', {
      module: 'Knowledge',
      method: 'deleteDocument',
    });
    expect(result.isError).toBe(true);
    const catalog = JSON.parse(result.text!);
    expect(catalog.lookupError).toContain('准确 name');
    expect(catalog.methods[0]).toMatchObject({ name: 'knowledgeDelete', available: true });
    expect(catalog.methods[0]).not.toHaveProperty('arguments');
    expect((await scope.call('client_change', { method: 'deleteDocument' })).text).toContain(
      'client_catalog({})',
    );
  });
  it('recovers method discovery and defaults omitted arguments only when the operation accepts them', async () => {
    const commands = new ClientCommands();
    commands.register('snapshot', operation('客户端', 'query', '状态'), () => ({ items: [] }));
    const change = vi.fn();
    commands.register('save', operation('配置', 'change', '保存', [z.string()]), change);
    const { scope } = attach(commands);
    const catalog = JSON.parse((await scope.call('client_catalog', { module: 'snapshot' })).text!);
    expect(catalog.methods[0]).toMatchObject({ name: 'snapshot', arguments: { maxItems: 0 } });
    expect(JSON.parse((await scope.call('client_query', { method: 'snapshot' })).text!)).toEqual({
      items: [],
    });
    expect(
      (await scope.call('client_query', { method: 'snapshot', args: [], argsJson: '[]' })).isError,
    ).toBe(true);
    expect((await scope.call('client_change', { method: 'save' })).isError).toBe(true);
    expect(change).not.toHaveBeenCalled();
  });
  it('publishes input schemas for normalized configuration fields', () => {
    const commands = new ClientCommands();
    commands.register(
      'normalize',
      operation('配置', 'change', '保存', [
        z.object({ value: z.string().transform((s) => s.trim()) }),
      ]),
      () => {},
    );
    const catalog = commands.describe({ method: 'normalize' });
    expect(JSON.stringify(catalog)).toContain('"type":"string"');
  });
  it('accepts JSON positional arguments from native engines without weakening validation', async () => {
    const commands = new ClientCommands();
    const save = vi.fn(() => ({ success: true }));
    commands.register(
      'save',
      operation('测试', 'change', '保存', [z.object({ name: z.string(), enabled: z.boolean() })]),
      save,
    );
    const { scope } = attach(commands);
    await scope.call('client_change', {
      method: 'save',
      argsJson: '[{"name":"demo","enabled":true}]',
    });
    expect(save).toHaveBeenCalledWith({ name: 'demo', enabled: true });
    for (const input of [
      { argsJson: '{' },
      { argsJson: '{}' },
      { argsJson: '[{"name":"demo","enabled":"true"}]' },
      { args: [], argsJson: '[]' },
      { argsJson: '[{"name":"demo","enabled":true,"secret":"sensitive"}]' },
    ])
      expect((await scope.call('client_change', { method: 'save', ...input })).isError).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('returns useful auth state without passwords, tokens, device codes or authorization URLs', async () => {
    const commands = new ClientCommands();
    commands.register('auth', operation('认证', 'query', '读取认证状态'), () => ({
      account: 'fixture',
      hasSecret: true,
      secret: 'never-return',
      accessToken: 'never-return',
      login: {
        phase: 'waiting',
        userCode: 'never-return',
        url: 'https://example.invalid/authorize?code=never-return',
      },
    }));
    const { scope } = attach(commands);
    const result = await scope.call('client_query', { method: 'auth', args: [] });
    expect(result.text).not.toContain('never-return');
    expect(JSON.parse(result.text!)).toEqual({
      account: 'fixture',
      hasSecret: true,
      login: { phase: 'waiting' },
    });
  });
  it('discovers and executes a new module registered after tools attach, without changing the dispatcher', async () => {
    const commands = new ClientCommands();
    const { scope, ask } = attach(commands);
    const save = vi.fn(async (id, value) => ({ id, value }));
    commands.register(
      'saveCalendar',
      operation('日历', 'change', '保存日程', [
        z.string().min(1).describe('calendarId'),
        z.object({ title: z.string().min(1), enabled: z.boolean() }),
      ]),
      save,
    );
    const summary = JSON.parse((await scope.call('client_catalog', {})).text!);
    expect(summary.modules).toContain('日历');
    expect(summary.methods[0]).toMatchObject({
      name: 'saveCalendar',
      access: 'change',
      available: true,
    });
    expect(summary.methods[0]).not.toHaveProperty('arguments');
    const detail = JSON.parse(
      (await scope.call('client_catalog', { method: 'saveCalendar' })).text!,
    );
    expect(detail.methods[0].arguments.prefixItems[0]).toMatchObject({
      type: 'string',
      description: 'calendarId',
    });
    expect(detail.methods[0].arguments.prefixItems[1].required).toEqual(['title', 'enabled']);
    const result = await scope.call('client_change', {
      method: 'saveCalendar',
      args: ['id', { title: '会议', enabled: true }],
    });
    expect(JSON.parse(result.text!)).toEqual({ id: 'id', value: { title: '会议', enabled: true } });
    expect(save).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledOnce();
  });
  it('validates argument count, shape and access before calling business code', async () => {
    const commands = new ClientCommands(),
      handler = vi.fn();
    commands.register(
      'saveTask',
      operation('任务', 'change', '保存任务', [z.object({ title: z.string().min(1) })]),
      handler,
    );
    const { scope } = attach(commands);
    for (const [tool, args] of [
      ['client_query', [{ title: 'no write through reads' }]],
      ['client_change', []],
      ['client_change', [{ title: 3 }]],
      ['client_change', [{ title: 'ok' }, 'extra']],
      ['client_change', [{ title: 'ok', credentials: { refresh_token: 'hidden' } }]],
    ] as const)
      expect((await scope.call(tool, { method: 'saveTask', args })).isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
  it('preserves read-only mode while cataloguing manual controls with their actual UI entry', async () => {
    const commands = new ClientCommands(),
      handler = vi.fn();
    commands.register('items', operation('任务', 'query', '读取任务'), () => [1]);
    commands.register('saveTask', operation('任务', 'change', '修改任务'), handler);
    commands.register('approve', manual('权限', '批准操作', 'workspace', '需要本人审批'), handler);
    const { scope, ask } = attach(commands, { readonly: true });
    expect(scope.specs.map((s) => s.name)).not.toContain('client_change');
    const catalog = JSON.parse((await scope.call('client_catalog', {})).text!);
    expect(catalog.methods.find((m: any) => m.name === 'saveTask').available).toBe(false);
    expect(catalog.methods.find((m: any) => m.name === 'approve')).toMatchObject({
      access: 'manual',
      available: false,
      view: 'workspace',
      reason: '需要本人审批',
    });
    expect((await scope.call('client_query', { method: 'approve', args: [] })).isError).toBe(true);
    expect(
      JSON.parse((await scope.call('client_query', { method: 'items', args: [] })).text!),
    ).toEqual([1]);
    expect(handler).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    const editable = attach(commands);
    expect(
      (await editable.scope.call('client_change', { method: 'approve', args: [] })).isError,
    ).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
  it('honors denial and revocation during an approval and revokes catalog access immediately', async () => {
    const commands = new ClientCommands(),
      handler = vi.fn();
    commands.register('saveTask', operation('任务', 'change', '保存任务'), handler);
    let enabled = true;
    const { scope } = attach(commands, {
      enabled: () => enabled,
      ask: async () => {
        enabled = false;
        return true;
      },
    });
    expect((await scope.call('client_change', { method: 'saveTask', args: [] })).isError).toBe(
      true,
    );
    expect(handler).not.toHaveBeenCalled();
    await expect(scope.call('client_catalog', {})).rejects.toThrow('停用');
    const denied = attach(commands, { ask: async () => false });
    expect(
      (await denied.scope.call('client_change', { method: 'saveTask', args: [] })).isError,
    ).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
  it('applies per-operation current-session guards and rejects duplicate registrations', async () => {
    const commands = new ClientCommands(),
      handler = vi.fn();
    const definition = operation('会话', 'change', '删除会话', [z.string()], {
      guard: (args, current) => {
        if (args[0] === current) throw new Error('不能删除当前会话');
      },
    });
    commands.register('deleteSession', definition, handler);
    expect(() => commands.register('deleteSession', definition, handler)).toThrow('重复');
    const { scope } = attach(commands);
    expect(
      (await scope.call('client_change', { method: 'deleteSession', args: ['current'] })).isError,
    ).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    await scope.call('client_change', { method: 'deleteSession', args: ['other'] });
    expect(handler).toHaveBeenCalledWith('other');
  });
});
