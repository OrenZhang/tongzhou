import { readFile } from 'node:fs/promises';
import path from 'node:path';
import TOML from '@iarna/toml';

export function kimiOAuthKey(oauth: any): string {
  const key = String(oauth?.key ?? '').replace(/^oauth\//, '');
  if (oauth?.storage !== 'file' || !/^kimi-code(?:-env-[a-zA-Z0-9_-]+)?$/.test(key))
    throw new Error('Kimi 登录凭据引用无效');
  if (
    oauth.oauthHost !== undefined &&
    !['https://auth.kimi.com', 'https://auth.kimi.ai'].includes(oauth.oauthHost.replace(/\/$/, ''))
  )
    throw new Error('Kimi 订阅必须使用官方授权接口');
  return key;
}

export function kimiSubscriptionEndpoint(source: any): URL {
  const endpoint = new URL(source.base_url ?? source.baseUrl);
  if (
    source.type !== 'kimi' ||
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
  return endpoint;
}

/** Same account slot used by the official CLI's bare login; never scans other clients. */
export async function kimiCredentialStatus(home: string): Promise<'missing' | 'fresh' | 'expired'> {
  try {
    const config: any = TOML.parse(await readFile(path.join(home, 'config.toml'), 'utf8'));
    const source = config.providers?.['managed:kimi-code'];
    if (!source?.oauth) return 'missing';
    kimiSubscriptionEndpoint(source);
    const key = kimiOAuthKey(source.oauth);
    const token = JSON.parse(await readFile(path.join(home, 'credentials', key + '.json'), 'utf8'));
    if (!token.access_token) return 'missing';
    return Number.isFinite(token.expires_at) && token.expires_at * 1000 > Date.now() + 120000
      ? 'fresh'
      : 'expired';
  } catch (error: any) {
    if (error.code === 'ENOENT') return 'missing';
    if (String(error.message).startsWith('Kimi ')) throw error;
    throw new Error('Kimi 授权状态读取失败，请在模型中检查账号');
  }
}
