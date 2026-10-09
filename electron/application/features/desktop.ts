import { clipboard, shell } from 'electron';
import { z } from 'zod';
import { manual, operation, workspaceOperation } from '../../core/tools/client-commands';
import { writeClipboardText } from '../../services/desktop/clipboard';
import { idSchema } from '../../services/storage/validation';
import type { Plugin } from 'cordis';
import '../context';

export const desktopPlugin: Plugin.Object<void> = {
  name: 'tongzhou-desktop',
  inject: ['tzIpc', 'tzStore', 'tzTasks', 'tzCommands', 'tzDesktop'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const services = ctx.tzTasks;
    const clientCommands = ctx.tzCommands;
    const { emit } = ctx.tzDesktop;
    register(
      'snapshot',
      operation(
        '客户端',
        'query',
        '查询所有模块的真实配置、ID、会话、机器人、渠道、运行和认证记录',
        [],
      ),
      () => services.snapshot(),
    );
    const permissionSchema = z.enum(['read-only', 'ask', 'full-access']);
    register(
      'setDefaultPermission',
      manual(
        '权限',
        '设置全局执行权限',
        'settings',
        'Agent 不能自行提升权限，请由用户在设置中修改',
        [z.enum(['read-only', 'ask', 'full-access']), z.boolean().optional()],
      ),
      (mode, all) => {
        const selected = permissionSchema.parse(mode);
        const applyToAll = z.boolean().parse(all ?? false);
        // The renderer snapshot can lag a just-saved selection. Applying the current
        // default must not restore the previous value while clearing overrides.
        services.setDefaultPermission(
          applyToAll ? store.defaultPermission() : selected,
          applyToAll,
        );
      },
    );
    register(
      'setSessionPermission',
      manual(
        '权限',
        '设置会话执行权限',
        'workspace',
        'Agent 不能自行提升权限，请由用户在会话中修改',
        [idSchema, z.enum(['read-only', 'ask', 'full-access']).nullable()],
      ),
      (id, mode) => {
        services.setSessionPermission(idSchema.parse(id), permissionSchema.nullable().parse(mode));
      },
    );
    register(
      'copyText',
      workspaceOperation(store, '客户端', 'change', '复制内容到系统剪贴板', [
        z.string().max(2000000),
      ]),
      (text) => writeClipboardText(clipboard, z.string().max(2000000).parse(text)),
    );
    register(
      'openExternalLink',
      operation('客户端', 'change', '在浏览器打开 HTTP 或 HTTPS 网页', [
        z.string().url().max(8192),
      ]),
      async (value) => {
        const url = new URL(z.string().max(8192).parse(value));
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
          throw new Error('只支持打开 HTTP 或 HTTPS 网页链接');
        await shell.openExternal(url.href);
      },
    );
    register(
      'clientMethods',
      operation('客户端', 'query', '查询完整客户端能力目录；优先用 client_catalog 按需查询', []),
      () => clientCommands.describe(),
    );
    register(
      'openModule',
      operation('客户端', 'change', '打开对应功能页面', [
        z.enum([
          'workspace',
          'providers',
          'agents',
          'activity',
          'settings',
          'connections',
          'extensions',
          'knowledge',
          'projects',
        ]),
      ]),
      (view) =>
        emit({
          type: 'navigate',
          view: z
            .enum([
              'workspace',
              'providers',
              'agents',
              'activity',
              'settings',
              'connections',
              'extensions',
              'knowledge',
              'projects',
            ])
            .transform((value) => (value === 'projects' ? ('workspace' as const) : value))
            .parse(view),
        }),
    );
  },
};
