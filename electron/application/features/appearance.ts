import { nativeTheme } from 'electron';
import { z } from 'zod';
import { normalizeAppearance } from '../../../src/shared/appearance';
import { operation } from '../../core/tools/client-commands';
import type { Plugin } from 'cordis';
import '../context';

export const appearancePlugin: Plugin.Object<void> = {
  name: 'tongzhou-appearance',
  inject: ['tzIpc', 'tzStore', 'tzDesktop'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const { emit, getWindow } = ctx.tzDesktop;
    const appearance = store
      .list<{ id: string; theme: 'system' | 'light' | 'dark' }>('preferences')
      .find((p) => p.id === 'appearance');
    nativeTheme.themeSource = appearance?.theme ?? 'system';
    const updateWindowTheme = () =>
      getWindow()?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#17191e' : '#fafbfc');
    nativeTheme.on('updated', updateWindowTheme);
    register(
      'setTheme',
      operation('外观', 'change', '切换浅色、深色或跟随系统主题', [
        z.enum(['system', 'light', 'dark']),
      ]),
      (raw) => {
        const theme = z.enum(['system', 'light', 'dark']).parse(raw);
        const current = store.list<any>('preferences').find((p) => p.id === 'appearance');
        store.put('preferences', { ...current, id: 'appearance', theme });
        nativeTheme.themeSource = theme;
        updateWindowTheme();
        emit({ type: 'appearance', value: { theme } });
      },
    );
    register('getAppearance', operation('外观', 'query', '读取主题、界面风格、字体和字号'), () => {
      return store.list<any>('preferences').find((p) => p.id === 'appearance') ?? {};
    });
    const appearanceSchema = z.object({
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
      (raw) => {
        const value = normalizeAppearance(appearanceSchema.parse(raw));
        store.put('preferences', { id: 'appearance', ...value });
        nativeTheme.themeSource = value.theme;
        updateWindowTheme();
        emit({ type: 'appearance', value });
      },
    );
    ctx.effect(() => () => nativeTheme.removeListener('updated', updateWindowTheme));
  },
};
