import { dialog, session } from 'electron';
import { z } from 'zod';
import { manual, operation, workspaceOperation } from '../../core/tools/client-commands';
import { networkProfileSchema } from '../../services/network/network-config';
import { accountProxyConfig } from '../../services/network/provider-network';
import { userAgent } from '../../services/network/request-identity';
import { idSchema } from '../../services/storage/validation';
import type { Plugin } from 'cordis';
import '../context';

export const networkPlugin: Plugin.Object<void> = {
  name: 'tongzhou-network',
  inject: ['tzIpc', 'tzStore', 'tzNetworks', 'tzEvents'],
  apply(ctx) {
    const register = ctx.tzIpc.scoped(ctx);
    const store = ctx.tzStore;
    const networks = ctx.tzNetworks;
    register(
      'checkNetworkNodes',
      operation(
        '网络配置',
        'change',
        '逐节点检测普通联网、OpenAI 登录和 ChatGPT 可达性，返回延迟；不切换当前出口',
        [idSchema.describe('profileId'), z.string().min(1).max(160).optional().describe('node')],
      ),
      (id, node) =>
        networks.check(idSchema.parse(id), z.string().min(1).max(160).optional().parse(node)),
    );
    register(
      'cancelNetworkCheck',
      operation('网络配置', 'change', '取消节点检测', [idSchema.describe('profileId')]),
      (id) => networks.cancelCheck(idSchema.parse(id)),
    );
    register(
      'setNetworkRouting',
      operation(
        '网络配置',
        'change',
        '设置手动或自动选择可用出口；自动模式在请求前检测，避免打断其他任务',
        [idSchema.describe('profileId'), z.enum(['manual', 'auto'])],
      ),
      (id, routing) =>
        networks.setRouting(idSchema.parse(id), z.enum(['manual', 'auto']).parse(routing)),
    );
    register(
      'networkProfiles',
      operation('网络配置', 'query', '列出内置网络状态与节点名称，不返回节点凭据'),
      () => networks.list(),
    );
    register(
      'saveNetworkProfile',
      manual(
        '网络配置',
        '导入或更新加密网络配置',
        'network',
        '配置及订阅包含凭据，只能由用户在设置中导入',
        [networkProfileSchema],
      ),
      (input) => networks.save(input),
    );
    register(
      'installNetworkCore',
      workspaceOperation(store, '网络配置', 'change', '安装官方网络内核', [z.boolean()]),
      async (offline) => {
        if (z.boolean().parse(offline)) {
          const chosen = await dialog.showOpenDialog({
            title: '选择官方 Mihomo 压缩包',
            properties: ['openFile'],
            filters: [{ name: '内核压缩包', extensions: ['zip', 'gz'] }],
          });
          if (chosen.canceled) return '已取消';
          await networks.core.installFile(chosen.filePaths[0]);
        } else await networks.core.install();
        ctx.tzEvents.changed();
        return '网络内核已安装';
      },
    );
    register(
      'deleteNetworkProfile',
      operation(
        '网络配置',
        'change',
        '删除未绑定账号的网络配置',
        [idSchema.describe('profileId')],
        {
          confirmation: 'always',
        },
      ),
      (id) => networks.remove(idSchema.parse(id)),
    );
    register(
      'refreshNetworkProfile',
      operation('网络配置', 'change', '更新网络订阅', [idSchema.describe('profileId')]),
      (id) => networks.refresh(idSchema.parse(id)),
    );
    register(
      'startNetworkProfile',
      operation('网络配置', 'change', '启动内置网络', [idSchema.describe('profileId')]),
      (id) => networks.start(idSchema.parse(id)),
    );
    register(
      'stopNetworkProfile',
      operation('网络配置', 'change', '停止内置网络', [idSchema.describe('profileId')]),
      (id) => networks.stop(idSchema.parse(id)),
    );
    register(
      'selectNetworkNode',
      operation('网络配置', 'change', '切换网络配置的出口节点', [
        idSchema.describe('profileId'),
        z.string().min(1).max(160).describe('node'),
      ]),
      (id, node) => networks.select(idSchema.parse(id), z.string().min(1).max(160).parse(node)),
    );
    register(
      'testNetworkProfile',
      operation('网络配置', 'change', '启动网络并测试 OpenAI 授权服务连通性，不执行登录', [
        idSchema.describe('profileId'),
      ]),
      async (raw) => {
        const id = idSchema.parse(raw);
        const network = await networks.resolve({ mode: 'managed', profileId: id });
        const s = session.fromPartition('tongzhou-network-test-' + id);
        await s.setProxy(accountProxyConfig(network));
        await s.closeAllConnections();
        const start = Date.now();
        try {
          const response = await s.fetch(
            'https://auth.openai.com/.well-known/openid-configuration',
            {
              headers: { 'User-Agent': userAgent },
              credentials: 'omit',
              redirect: 'error',
              signal: AbortSignal.timeout(15000),
            },
          );
          await response.body?.cancel();
          if (!response.ok) throw new Error();
          const ms = Date.now() - start;
          networks.recordLatency(id, ms);
          return `网络可达（${ms} ms），未执行账号登录或模型推理。`;
        } catch {
          throw new Error('出口测试失败，请检查节点可用性、套餐及网络连接');
        }
      },
    );
  },
};
