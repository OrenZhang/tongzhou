import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Store } from '../storage/store';
import type { TaskService, ChangePublisher } from '../../core/task-contracts';
import type { Accounts } from './accounts';
import type { AccountBrowser } from './account-browser';
import type { NetworkProfiles } from '../network/network-profiles';
import type { Provider, ProviderInput } from '../../../src/shared/types';
import type { ConnectionCheck } from '../../../src/shared/connection-diagnostics';
import { operation, type ClientRegistrar } from '../../core/tools/client-commands';
import { idSchema, providerSchema, redact } from '../storage/validation';
import { nativeEngine } from './native-engine';
import { networkKey } from '../../../src/shared/provider-network';
import { complete, listModels } from '../../core/models/providers';

export function registerProviderServices(
  register: ClientRegistrar,
  store: Store,
  services: Pick<TaskService, 'snapshot'> & ChangePublisher,
  accounts: Accounts,
  accountBrowser: AccountBrowser,
  networks: NetworkProfiles,
  pendingImports: Map<string, ProviderInput>,
) {
  register(
    'saveProvider',
    operation('模型连接与认证', 'change', '保存模型连接配置，使用完整对象，密钥在界面保存', [
      providerSchema,
    ]),
    (raw) => {
      const input = providerSchema.parse(raw);
      if (input.network?.mode === 'managed') networks.exists(input.network.profileId!);
      const before = store.providers().find((p) => p.id === input.id);
      if (
        input.enabled === false &&
        services.snapshot().runs.some((r) => r.providerId === input.id && r.status === 'running')
      )
        throw new Error('此连接正在执行任务，请结束或停止任务后再停用。');
      const networkChanged = networkKey(before?.network) !== networkKey(input.network);
      if (
        networkChanged &&
        services.snapshot().runs.some((r) => r.providerId === input.id && r.status === 'running')
      )
        throw new Error('此 ChatGPT 连接正在执行任务，请结束或停止任务后再修改代理。');
      const pending = pendingImports.get(input.id);
      const result = store.saveProvider({ ...input, secret: input.secret || pending?.secret });
      if (networkChanged) {
        accountBrowser.close(input.id);
        accounts.resetCodex(input.id);
      }
      pendingImports.delete(input.id);
      services.changed();
      return result;
    },
  );
  register(
    'deleteProvider',
    operation('模型连接与认证', 'change', '删除模型连接及认证', [idSchema.describe('providerId')], {
      confirmation: 'always',
    }),
    (raw) => {
      const id = idSchema.parse(raw);
      if (services.snapshot().runs.some((r) => r.providerId === id && r.status === 'running'))
        throw new Error('此连接正在执行任务');
      store.deleteProvider(id);
      accounts.forget(id);
      accountBrowser.close(id);
      services.changed();
    },
  );
  register(
    'testProvider',
    operation('模型连接与认证', 'change', '测试连接和指定模型，API 连接会发起一次实际请求', [
      idSchema.describe('providerId'),
      z.string().min(1).max(200).describe('model'),
    ]),
    async (raw, model) => {
      const p = store.get<Provider>('provider', idSchema.parse(raw));
      const selected = z.string().min(1).max(200).parse(model);
      if (nativeEngine(p.protocol)) {
        const catalog = await accounts.native(p.protocol, p.id).catalog();
        store.put('provider', { ...p, models: catalog.models, modelLabels: catalog.modelLabels });
        services.changed();
        return '账号已通过官方引擎验证，模型列表已同步；实际调用权限以账号套餐为准。';
      }
      if (p.protocol === 'codex') {
        await accounts.client(p.id).start();
        const a = await accounts.client(p.id).request('account/read', {});
        if (!a.account) throw new Error('尚未登录 ChatGPT');
        return 'Codex 已连接，账号已登录。模型访问权限以实际执行为准。';
      }
      const result = await complete({
        provider: { ...p, maxOutputTokens: 256 },
        secret: store.secret(p.id),
        model: selected,
        instructions: 'Reply briefly.',
        messages: [
          {
            id: 'test',
            sessionId: 'test',
            role: 'user',
            content: 'Reply with OK.',
            createdAt: Date.now(),
          },
        ],
        tools: [],
        signal: AbortSignal.timeout(30000),
        onDelta: () => {},
      });
      return `连接成功：${result.text.slice(0, 120)}`;
    },
  );
  register(
    'diagnoseProvider',
    operation(
      '模型连接与认证',
      'change',
      '分项检测连接、账号和模型；includeInference 为 true 时直接 API 发起一次真实推理和无副作用工具测试，可能计费',
      [idSchema, z.string().max(200), z.boolean()],
    ),
    async (raw, rawModel, rawInference) => {
      const p = store.get<Provider>('provider', idSchema.parse(raw));
      const model = z.string().max(200).parse(rawModel),
        inference = z.boolean().parse(rawInference);
      const checks: ConnectionCheck[] = [];
      const check = async (name: string, fn: () => Promise<string>) => {
        const start = Date.now();
        try {
          checks.push({ name, status: 'passed', detail: await fn(), ms: Date.now() - start });
          return true;
        } catch (e: any) {
          checks.push({
            name,
            status: 'failed',
            detail: redact(String(e.message), [store.secret(p.id)]),
            ms: Date.now() - start,
          });
          return false;
        }
      };
      checks.push({
        name: '会话入口',
        status: p.enabled === false ? 'unknown' : 'passed',
        detail: p.enabled === false ? '连接已停用，可检测但不会出现在模型选择中' : '已启用',
        ms: 0,
      });
      if (p.protocol === 'codex') {
        await check('账号网络', () => accountBrowser.test(p.id));
        await check('账号认证', async () => {
          const c = accounts.client(p.id);
          await c.start();
          const r = await c.request('account/read', { refreshToken: false });
          if (!r.account) throw new Error('尚未授权');
          return '官方引擎确认已登录';
        });
        await check('模型目录', async () => {
          const c = accounts.client(p.id);
          await c.start();
          const r = await c.request('model/list', { includeHidden: false });
          if (model && !r.data.some((m: any) => (m.model ?? m.id) === model))
            throw new Error('所选模型不在当前目录');
          return `${r.data.length} 个模型`;
        });
      } else if (nativeEngine(p.protocol)) {
        await check('账号与模型目录', async () => {
          const c = await accounts.native(p.protocol as 'kimi' | 'minimax', p.id).catalog();
          if (model && !c.models.includes(model)) throw new Error('所选模型不在当前目录');
          return `官方引擎返回 ${c.models.length} 个模型`;
        });
      } else {
        await check('配置', async () => {
          if (!p.baseUrl) throw new Error('缺少服务地址');
          if (p.auth !== 'none' && !store.hasSecret(p.id)) throw new Error('缺少密钥');
          return '地址与认证配置已保存，实际权限需请求验证';
        });
        await check('模型目录接口', async () => {
          const models = await listModels(p, store.secret(p.id));
          return `${models.length} 个模型；不支持目录接口的服务可手动配置模型后测试推理`;
        });
        if (inference && model) {
          const stamp = randomUUID();
          let first: number | undefined;
          const start = Date.now();
          await check('推理与工具协议', async () => {
            const r = await complete({
              provider: { ...p, maxOutputTokens: 512 },
              secret: store.secret(p.id),
              model,
              instructions:
                'Connection diagnostic. Call diagnostic_echo exactly once using the provided value. No other task.',
              messages: [
                {
                  id: stamp,
                  sessionId: stamp,
                  role: 'user',
                  content: 'Call diagnostic_echo with value ' + stamp,
                  createdAt: Date.now(),
                },
              ],
              tools: [
                {
                  name: 'diagnostic_echo',
                  description:
                    'Harmless local diagnostic; echoes a supplied string without external actions.',
                  parameters: {
                    type: 'object',
                    properties: { value: { type: 'string' } },
                    required: ['value'],
                    additionalProperties: false,
                  },
                },
              ],
              signal: AbortSignal.timeout(90000),
              onDelta: () => {
                first ??= Date.now() - start;
              },
              onReasoning: () => {
                first ??= Date.now() - start;
              },
            });
            const call = r.toolCalls.find((c) => c.name === 'diagnostic_echo');
            if (!call || JSON.parse(call.arguments).value !== stamp)
              throw new Error('模型有响应，但未通过工具调用协议测试');
            return `模型响应与工具参数通过；${first === undefined ? '工具响应已返回' : '首条内容 ' + first + ' ms'}`;
          });
        }
      }
      if (p.protocol === 'codex' || nativeEngine(p.protocol) || !inference || !model)
        checks.push({
          name: '真实推理与工具执行',
          status: 'unknown',
          detail:
            p.protocol === 'codex' || nativeEngine(p.protocol)
              ? '订阅账号请在会话中完成真实任务验收；此处只验证认证和目录'
              : '勾选真实推理并选择模型后检测',
          ms: 0,
        });
      store.put('providerDiagnostic', { id: p.id, checkedAt: Date.now(), checks });
      return checks;
    },
  );
  register(
    'testProviderNetwork',
    operation(
      '模型连接与认证',
      'query',
      '检查 ChatGPT 账号独立网络是否可达授权服务，不执行登录或模型推理',
      [idSchema.describe('providerId')],
    ),
    (id) => accountBrowser.test(idSchema.parse(id)),
  );
  register(
    'models',
    operation('模型连接与认证', 'change', '获取并更新连接的模型列表', [
      idSchema.describe('providerId'),
    ]),
    async (raw) => {
      const p = store.get<Provider>('provider', idSchema.parse(raw));
      let models: string[];
      if (nativeEngine(p.protocol)) {
        const catalog = await accounts.native(p.protocol, p.id).catalog();
        store.put('provider', { ...p, models: catalog.models, modelLabels: catalog.modelLabels });
        services.changed();
        return catalog.models;
      }
      if (p.protocol === 'codex') {
        await accounts.client(p.id).start();
        const result = await accounts.client(p.id).request('model/list', { includeHidden: false });
        models = result.data.map((m: any) => m.model ?? m.id);
      } else {
        models = await listModels(p, store.secret(p.id));
      }
      const current = store.get<Provider>('provider', p.id);
      if (current.baseUrl !== p.baseUrl || current.protocol !== p.protocol)
        throw new Error('连接已变更，请重新获取模型');
      models = [...new Set(models.filter((m) => typeof m === 'string' && m.trim()))];
      store.put('provider', { ...current, models: [...new Set([...current.models, ...models])] });
      services.changed();
      return models;
    },
  );
}
