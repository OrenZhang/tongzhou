import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Provider } from '../../../src/shared/types';
import { NativeAccount } from './native-engine';
import { kimiOAuthKey, kimiSubscriptionEndpoint } from './kimi-credentials';

const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const refreshes = new Map<string, Promise<unknown>>();

/** Model and plugin calls share one token rotation per account. */
export async function refreshSubscription(provider: Provider, home: string) {
  let pending = refreshes.get(home);
  if (!pending) {
    const account = new NativeAccount(
      provider.protocol as 'kimi' | 'minimax',
      home,
      () => {},
      () => {},
    );
    pending = account.refresh().finally(() => {
      account.dispose();
      refreshes.delete(home);
    });
    refreshes.set(home, pending);
  }
  await pending;
}

export async function readMiniMaxCredential(home: string) {
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
    typeof token?.accessToken !== 'string' ||
    !token.accessToken ||
    token.audience !== 'agent-backend' ||
    !token.scopes?.includes('agent.default')
  )
    throw new Error('MiniMax 登录凭据不可用，请重新登录');
  return {
    secret: token.accessToken as string,
    expires: token.expiresAtMs as number,
    origin: `https://agent.minimax.${region === 'cn' ? 'cn' : 'io'}`,
  };
}

export async function readKimiCredential(home: string, source: any) {
  const endpoint = kimiSubscriptionEndpoint(source);
  const key = kimiOAuthKey(source.oauth);
  const token = await json(path.join(home, 'credentials', key + '.json'));
  if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('Kimi 未登录');
  return {
    secret: token.access_token as string,
    expires: token.expires_at * 1000,
    endpoint: endpoint.href.replace(/\/$/, ''),
  };
}
