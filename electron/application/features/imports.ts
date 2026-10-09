import { dialog } from 'electron';
import { manual } from '../../core/tools/client-commands';
import { importCCSwitch } from '../../services/accounts/cc-switch';
import type { Plugin } from 'cordis';
import '../context';

export const importsPlugin: Plugin.Object<void> = {
  name: 'tongzhou-imports',
  inject: ['tzIpc', 'tzDesktop'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const { getWindow, pendingImports } = ctx.tzDesktop;
    register(
      'importCCSwitch',
      manual(
        '模型连接与认证',
        '从本地配置文件导入连接',
        'providers',
        '需要用户选择并确认导入的配置，凭据不经过模型',
        [],
      ),
      async () => {
        const result = await dialog.showOpenDialog(getWindow()!, {
          title: '导入 CC Switch 配置',
          filters: [{ name: 'CC Switch', extensions: ['db', 'sqlite', 'sqlite3', 'json'] }],
          properties: ['openFile'],
        });
        if (result.canceled) return null;
        const preview = await importCCSwitch(result.filePaths[0]);
        pendingImports.clear();
        for (const provider of preview.providers) pendingImports.set(provider.id, provider);
        return {
          ...preview,
          providers: preview.providers.map(({ secret, ...p }) => ({ ...p, hasSecret: !!secret })),
        };
      },
    );
  },
};
