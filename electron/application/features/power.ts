import { z } from 'zod';
import type { Plugin } from 'cordis';
import { manual, operation } from '../../core/tools/client-commands';
import '../execution-context';

const preferences = z
  .object({
    keepAwakeOnAC: z.boolean(),
    keepAwakeWhenLidClosed: z.boolean(),
  })
  .strict();

export const powerPlugin: Plugin.Object<void> = {
  name: 'tongzhou-power',
  inject: ['tzClient', 'tzPower'],
  apply(ctx) {
    const register = ctx.tzClient.scoped(ctx);
    register('powerStatus', operation('电源与睡眠', 'query', '读取电源、保持唤醒与合盖状态'), () =>
      ctx.tzPower.snapshot(),
    );
    register(
      'savePowerSettings',
      manual(
        '电源与睡眠',
        '控制接通电源时保持唤醒和合盖睡眠',
        'settings',
        '电源策略须由用户在设置中修改',
        [preferences],
      ),
      (value) => ctx.tzPower.set(preferences.parse(value)),
    );
  },
};
