import { z } from 'zod';
import { normalizeAppearance } from '../../../src/shared/appearance';
import { operation } from '../../core/tools/client-commands';
import type { Plugin } from 'cordis';
import '../execution-context';

export const appearancePlugin: Plugin.Object<void> = {
  name: 'tongzhou-appearance',
  inject: ['tzClient', 'tzStore', 'tzEnvironment'],
  async apply(ctx) {
    const register = ctx.tzClient.scoped(ctx);
    const store = ctx.tzStore;
    const { emit, host } = ctx.tzEnvironment;
    const appearance = store
      .list<{
        id: string;
        theme: 'system' | 'light' | 'dark';
        language?: 'zh-CN' | 'en';
      }>('preferences')
      .find((p) => p.id === 'appearance');
    await host.setTheme?.(appearance?.theme ?? 'system');
    emit({ type: 'appearance', value: normalizeAppearance(appearance) });
    register(
      'setTheme',
      operation('外观', 'change', '切换浅色、深色或跟随系统主题', [
        z.enum(['system', 'light', 'dark']),
      ]),
      async (raw) => {
        const theme = z.enum(['system', 'light', 'dark']).parse(raw);
        const current = store.list<any>('preferences').find((p) => p.id === 'appearance');
        store.put('preferences', { ...current, id: 'appearance', theme });
        await host.setTheme?.(theme);
        emit({ type: 'appearance', value: { theme } });
      },
    );
    register('getAppearance', operation('外观', 'query', '读取主题、界面风格、字体和字号'), () => {
      return store.list<any>('preferences').find((p) => p.id === 'appearance') ?? {};
    });
    const appearanceSchema = z.object({
      language: z.enum(['zh-CN', 'en']).optional(),
      theme: z.enum(['system', 'light', 'dark']),
      style: z.enum(['graphite', 'blue', 'sand']),
      font: z.enum(['modern', 'system', 'serif']),
      textSize: z.union([z.literal(14), z.literal(16), z.literal(18)]),
    });
    register(
      'setAppearance',
      operation('外观', 'change', '设置主题、界面风格、字体和字号；立即生效并保存', [
        appearanceSchema,
      ]),
      async (raw) => {
        const current = store.list<any>('preferences').find((p) => p.id === 'appearance');
        const value = normalizeAppearance({ ...current, ...appearanceSchema.parse(raw) });
        store.put('preferences', { id: 'appearance', ...value });
        await host.setTheme?.(value.theme);
        emit({ type: 'appearance', value });
      },
    );
  },
};
