import { z } from 'zod';
import { builtinPlugins } from '../../../src/shared/builtin-plugins';
import type { PluginConfig } from '../../../src/shared/types';
import { operation } from '../../core/tools/client-commands';
import type { Plugin } from 'cordis';
import '../context';

export const capabilitiesPlugin: Plugin.Object<void> = {
  name: 'tongzhou-capabilities',
  inject: ['tzIpc', 'tzStore', 'tzRuntime'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const runtime = ctx.tzRuntime;

    register(
      'setCapability',
      operation('核心能力', 'change', '启用或停用内置能力，工具可用性从下一轮生效', [
        z.enum(['computer', 'management']),
        z.boolean(),
      ]),
      (raw, enabled) => {
        store.setCapability(
          z.enum(['computer', 'management']).parse(raw),
          z.boolean().parse(enabled),
        );
        runtime.invalidateNative();
        runtime.changed();
      },
    );
    register(
      'installBuiltinPlugin',
      operation(
        '插件',
        'change',
        '启用内置网页读取和系统环境两个插件；单独启停请使用 savePlugin',
        [],
      ),
      () => {
        for (const definition of builtinPlugins)
          store.put('plugin', {
            ...store.get<PluginConfig>('plugin', definition.id),
            enabled: true,
          });
        runtime.invalidateNative();
        runtime.changed();
      },
    );
  },
};
