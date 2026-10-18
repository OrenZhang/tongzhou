import { readFile } from 'node:fs/promises';
import path from 'node:path';
import TOML from '@iarna/toml';
import YAML from 'yaml';
import type { Provider } from '../../../src/shared/types';
import {
  readMiniMaxCredential,
  readKimiCredential,
  refreshSubscription,
} from '../../services/accounts/subscription-credentials';
import type { ModelConnection } from './model-gateway';

export async function nativeModelConnection(
  provider: Provider,
  selected: string,
  home: string,
  refresh: () => Promise<unknown> = () => refreshSubscription(provider, home),
): Promise<ModelConnection> {
  async function read(): Promise<ModelConnection & { expires: number }> {
    if (provider.protocol === 'minimax') {
      const token = await readMiniMaxCredential(home);
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
          baseUrl: `${token.origin}/mavis/api/v1/llm/v1`,
        },
        model,
        secret: token.secret,
        expires: token.expires,
      };
    }
    if (provider.protocol === 'kimi') {
      const config: any = TOML.parse(await readFile(path.join(home, 'config.toml'), 'utf8'));
      const alias = config.models?.[selected];
      const source = config.providers?.[alias?.provider];
      if (!alias || source?.type !== 'kimi' || source.oauth?.storage !== 'file')
        throw new Error('Kimi 模型或订阅未配置，请重新登录并刷新模型列表');
      const token = await readKimiCredential(home, source);
      // Kimi Code 2.1.x omits protocol for its default OpenAI Chat wire format.
      // Explicit model overrides still select Anthropic or Responses.
      const protocol =
        alias.protocol === undefined
          ? 'openai-chat'
          : alias.protocol === 'anthropic'
            ? 'anthropic'
            : alias.protocol === 'openai_responses'
              ? 'openai-responses'
              : undefined;
      if (!protocol || typeof alias.model !== 'string')
        throw new Error('此 Kimi 模型协议尚未被当前CoSail版本支持，请更新CoSail后刷新模型列表');
      return {
        provider: {
          ...provider,
          protocol,
          auth: 'bearer',
          baseUrl: token.endpoint,
        },
        model: alias.model,
        secret: token.secret,
        expires: token.expires,
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
