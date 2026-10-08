import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import TOML from '@iarna/toml';
import YAML from 'yaml';
import type { Provider } from '../../../src/shared/types';
import { NativeAccount } from '../../services/accounts/native-engine';
import type { ModelConnection } from './model-gateway';

const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const refreshes = new Map<string, Promise<unknown>>();

/** The official clients own login/token rotation only. No session/prompt or agent loop. */
async function refreshAccount(provider: Provider, home: string) {
  let pending = refreshes.get(home);
  if (!pending) {
    const account = new NativeAccount(
      provider.protocol as 'kimi' | 'minimax',
      home,
      () => {},
      () => {},
    );
    pending = account.catalog().finally(() => {
      account.dispose();
      refreshes.delete(home);
    });
    refreshes.set(home, pending);
  }
  await pending;
}

export async function nativeModelConnection(
  provider: Provider,
  selected: string,
  home: string,
  refresh: () => Promise<unknown> = () => refreshAccount(provider, home),
): Promise<ModelConnection> {
  async function read(): Promise<ModelConnection & { expires: number }> {
    if (provider.protocol === 'minimax') {
      const preference = await json(path.join(home, 'preferences', 'mcode-region.json'));
      const region = preference.regions?.prod;
      if (region !== 'cn' && region !== 'en') throw new Error('MiniMax 登录地区无效，请重新登录');
      const authHome = path.join(path.resolve(home), 'auth');
      const namespace = path.join(authHome, 'prod', region, 'mcode-public');
      const state = await json(path.join(namespace, 'auth-state.json'));
      if (!['authenticated', 'refreshing', 'expired'].includes(state.status))
        throw new Error('MiniMax 未登录');
      const records = await json(path.join(namespace, 'auth.json'));
      const account = createHash('sha256')
        .update(authHome + '\0mcode-public')
        .digest('base64url');
      const token = records.records?.[`com.minimax.mcode.oauth.prod.${region}\0${account}`];
      if (
        !token?.accessToken ||
        token.audience !== 'agent-backend' ||
        !token.scopes?.includes('agent.default')
      )
        throw new Error('MiniMax 登录凭据不可用，请重新登录');
      const config: any = YAML.parse(await readFile(path.join(home, 'config.yaml'), 'utf8'));
      const match = /^m:minimax:([^:]+):v:$/.exec(selected);
      const model = match?.[1] ?? selected;
      if (!config.provider?.minimax?.models?.[model])
        throw new Error('此 MiniMax 模型尚未支持，请刷新模型列表后选择');
      return {
        provider: {
          ...provider,
          protocol: 'anthropic',
          auth: 'bearer',
          baseUrl: `https://agent.minimax.${region === 'cn' ? 'cn' : 'io'}/mavis/api/v1/llm/v1`,
        },
        model,
        secret: token.accessToken,
        expires: token.expiresAtMs,
      };
    }
    if (provider.protocol === 'kimi') {
      const config: any = TOML.parse(await readFile(path.join(home, 'config.toml'), 'utf8'));
      const alias = config.models?.[selected];
      const source = config.providers?.[alias?.provider];
      if (!alias || source?.type !== 'kimi' || source.oauth?.storage !== 'file')
        throw new Error('Kimi 模型或订阅未配置，请重新登录并刷新模型列表');
      const endpoint = new URL(source.base_url ?? source.baseUrl);
      if (
        !['api.kimi.com', 'api.kimi.ai'].includes(endpoint.hostname) ||
        endpoint.protocol !== 'https:' ||
        endpoint.port ||
        endpoint.username ||
        endpoint.password ||
        endpoint.pathname.replace(/\/$/, '') !== '/coding/v1' ||
        endpoint.search ||
        endpoint.hash
      )
        throw new Error('Kimi 订阅必须使用官方模型接口');
      const key = String(source.oauth.key ?? '').replace(/^oauth\//, '');
      if (!/^kimi-code(?:-env-[a-zA-Z0-9_-]+)?$/.test(key))
        throw new Error('Kimi 登录凭据引用无效');
      const token = await json(path.join(home, 'credentials', key + '.json'));
      if (!token.access_token) throw new Error('Kimi 未登录');
      const protocol =
        alias.protocol === 'anthropic'
          ? 'anthropic'
          : alias.protocol === 'openai_responses'
            ? 'openai-responses'
            : undefined;
      if (!protocol || typeof alias.model !== 'string')
        throw new Error('此 Kimi 模型协议尚未支持，请刷新模型列表');
      return {
        provider: {
          ...provider,
          protocol,
          auth: 'bearer',
          baseUrl: endpoint.href.replace(/\/$/, ''),
        },
        model: alias.model,
        secret: token.access_token,
        expires: token.expires_at * 1000,
      };
    }
    throw new Error('不是订阅模型连接');
  }
  try {
    let result = await read();
    if (!Number.isFinite(result.expires) || result.expires < Date.now() + 120000) {
      await refresh();
      result = await read();
      if (!Number.isFinite(result.expires) || result.expires <= Date.now())
        throw new Error('订阅令牌已过期，请重新登录');
    }
    return { provider: result.provider, model: result.model, secret: result.secret };
  } catch (error: any) {
    // Parser and SDK errors can contain the credential text. Never propagate them.
    if (/^(MiniMax|Kimi|此 |不是订阅|订阅令牌)/.test(error.message ?? '')) throw error;
    throw new Error('订阅模型凭据读取或刷新失败，请在模型中重新登录。');
  }
}
