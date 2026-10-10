import { shell } from 'electron';
import { operation, workspaceOperation } from '../../core/tools/client-commands';
import { connectorSchema } from '../../services/accounts/connectors';
import { idSchema } from '../../services/storage/validation';
import type { Plugin } from 'cordis';
import '../context';

export const connectionsPlugin: Plugin.Object<void> = {
  name: 'tongzhou-connections',
  inject: ['tzIpc', 'tzStore', 'tzConnectors'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const connectors = ctx.tzConnectors;
    register(
      'saveConnector',
      operation('服务账号', 'change', '新增或修改服务连接，密钥和令牌在界面保存', [
        connectorSchema,
      ]),
      (raw) => connectors.save(raw),
    );
    register(
      'deleteConnector',
      operation('服务账号', 'change', '删除服务连接及其凭据', [idSchema.describe('connectorId')], {
        confirmation: 'always',
      }),
      (raw) => connectors.remove(idSchema.parse(raw)),
    );
    register(
      'testConnector',
      operation('服务账号', 'change', '检查已有账号的连接与认证状态', [
        idSchema.describe('connectorId'),
      ]),
      (id) => connectors.test(idSchema.parse(id)),
    );
    register(
      'loginConnector',
      workspaceOperation(store, '服务账号', 'change', '浏览器登录代码托管服务', [
        idSchema.describe('connectorId'),
      ]),
      async (id) => {
        const result = await connectors.login(idSchema.parse(id));
        await shell.openExternal(result.url);
        return result;
      },
    );
    register(
      'cancelConnectorLogin',
      operation('服务账号', 'change', '取消服务账号授权', [idSchema.describe('connectorId')]),
      (id) => connectors.cancel(idSchema.parse(id)),
    );
  },
};
