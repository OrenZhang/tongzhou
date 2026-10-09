import { shell } from 'electron';
import { manual, operation, workspaceOperation } from '../../core/tools/client-commands';
import type { Plugin } from 'cordis';
import '../context';

export const updatesPlugin: Plugin.Object<void> = {
  name: 'tongzhou-updates',
  inject: ['tzIpc', 'tzStore', 'tzUpdates'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const updates = ctx.tzUpdates;
    register('updateStatus', operation('客户端更新', 'query', '读取当前版本与更新状态'), () =>
      updates.snapshot(),
    );
    register(
      'checkUpdates',
      workspaceOperation(store, '客户端更新', 'change', '检查正式版本更新'),
      () => updates.check(),
    );
    register(
      'installUpdate',
      manual('客户端更新', '下载更新并重启客户端', 'settings', '由用户点击安装更新'),
      () => {
        if (updates.snapshot().version && !updates.snapshot().automaticInstall)
          return shell.openExternal('https://github.com/OrenZhang/tongzhou/releases/latest');
        return updates.install();
      },
    );
  },
};
