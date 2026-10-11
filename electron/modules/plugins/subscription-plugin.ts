import path from 'node:path';
import { readFile } from 'node:fs/promises';
import TOML from '@iarna/toml';
import { kimiOAuthKey } from '../../services/accounts/kimi-credentials';
import type { PluginConfig, Provider } from '../../../src/shared/types';
import { vendorPlugin } from '../../../src/shared/vendor-plugins';
import type { Store } from '../../services/storage/store';
import { engineHome } from '../../services/accounts/account-paths';
import {
  readMiniMaxCredential,
  readKimiCredential,
  refreshSubscription,
} from '../../services/accounts/subscription-credentials';
import { kimiTools, callKimiWeb } from './kimi-web';
import { callMiniMaxPlan, minimaxPlanTools } from './minimax-plan';
import { serviceFetch } from '../../services/network/service-network';
import { redact } from '../../services/storage/validation';

export function subscriptionPluginAccount(store: Store, config: PluginConfig) {
  const expected = config.id === 'tongzhou-kimi-web' ? 'kimi' : 'minimax';
  const provider = store.list<Provider>('provider').find((p) => p.id === config.accountProviderId);
  if (
    !vendorPlugin(config.id) ||
    !provider ||
    provider.protocol !== expected ||
    provider.auth !== 'native' ||
    provider.enabled === false ||
    config.connectorId ||
    config.authMode === 'oauth'
  )
    throw new Error('插件绑定的套餐账号已移除、停用或不匹配，请在插件中重新选择账号');
  return provider;
}

export async function subscriptionPluginCredential(
  provider: Provider,
  home: string,
  service: 'search' | 'fetch' = 'search',
  refresh: () => Promise<unknown> = () => refreshSubscription(provider, home),
) {
  const read = async () => {
    if (provider.protocol === 'minimax') {
      const token = await readMiniMaxCredential(home);
      return { ...token, endpoint: token.origin };
    }
    if (provider.protocol !== 'kimi') throw new Error('不支持此套餐账号');
    const config: any = TOML.parse(await readFile(path.join(home, 'config.toml'), 'utf8'));
    const source = config.providers?.['managed:kimi-code'];
    if (!source?.oauth) throw new Error('Kimi 未登录，请在模型中登录套餐账号');
    const token = await readKimiCredential(home, source);
    const external = config.services?.[`moonshot_${service}`];
    // Do not attach a managed token to an overridden service host or different auth source.
    if (
      external &&
      ((external.base_url &&
        external.base_url.replace(/\/$/, '') !== `${token.endpoint}/${service}`) ||
        external.api_key ||
        external.api_key_env ||
        (external.oauth && kimiOAuthKey(external.oauth) !== kimiOAuthKey(source.oauth)))
    )
      throw new Error('Kimi 搜索服务配置与套餐账号不匹配，请重新登录恢复官方配置');
    return token;
  };
  try {
    let result = await read();
    if (!Number.isFinite(result.expires) || result.expires < Date.now() + 120000) {
      await refresh();
      result = await read();
      if (!Number.isFinite(result.expires) || result.expires <= Date.now())
        throw new Error('套餐令牌已过期，请在模型中重新登录');
    }
    return result;
  } catch (error) {
    // Config parsers and refresh clients may include credential text in their errors.
    if (error instanceof Error && /^(MiniMax |Kimi |套餐令牌)/.test(error.message)) throw error;
    throw new Error('套餐凭据读取或刷新失败，请在模型中重新登录');
  }
}

/** In-process adapter: account tokens never enter a renderer, command line or MCP subprocess. */
export class SubscriptionPluginConnection {
  constructor(
    private store: Store,
    readonly config: PluginConfig,
  ) {}
  private async credential(service?: 'search' | 'fetch') {
    const provider = subscriptionPluginAccount(this.store, this.config);
    if (this.store.path === ':memory:') throw new Error('套餐账号需要本地数据目录');
    return subscriptionPluginCredential(
      provider,
      engineHome(path.dirname(this.store.path), provider.protocol, provider.id),
      service,
    );
  }
  async connect(signal: AbortSignal) {
    signal.throwIfAborted();
    await this.credential();
    if (this.config.id === 'tongzhou-kimi-web') await this.credential('fetch');
    signal.throwIfAborted();
  }
  tools() {
    return this.config.id === 'tongzhou-kimi-web' ? kimiTools : minimaxPlanTools(this.config.id);
  }
  async call(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.tools().some((tool) => tool.name === name))
      throw new Error('当前套餐插件不支持此工具');
    const token = await this.credential(name === 'fetch_page' ? 'fetch' : 'search');
    signal.throwIfAborted();
    subscriptionPluginAccount(this.store, this.config);
    const current = this.store.list<PluginConfig>('plugin').find((p) => p.id === this.config.id);
    if (!current?.enabled || current.accountProviderId !== this.config.accountProviderId)
      throw new Error('插件配置已变更，请重新调用');
    try {
      const result =
        this.config.id === 'tongzhou-kimi-web'
          ? await callKimiWeb(name, args, signal, token.secret, serviceFetch, token.endpoint)
          : await callMiniMaxPlan(this.config.id, name, args, token.endpoint, token.secret, signal);
      return {
        ...result,
        content: result.content.map((item) => ({
          ...item,
          text: redact(item.text, [token.secret]),
        })),
      };
    } catch (error) {
      signal.throwIfAborted();
      // Do not repeat generation calls on failure: a lost response may still have consumed quota.
      if (
        error instanceof Error &&
        /^(MiniMax 套餐|Kimi 服务返回 HTTP|工具参数|视频模型|服务结果过大)/.test(error.message)
      )
        throw new Error(redact(error.message, [token.secret]));
      throw new Error('套餐工具调用失败，请检查账号、网络和参数；生成任务请先查询结果再重试');
    }
  }
}

export function subscriptionPlugin(store: Store, config: PluginConfig) {
  return config.accountProviderId ? new SubscriptionPluginConnection(store, config) : undefined;
}
