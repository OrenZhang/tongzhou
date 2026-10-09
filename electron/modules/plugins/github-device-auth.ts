import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { serviceFetch } from '../../services/network/service-network';

// Public application identity supplied by the release maintainer, never a user secret.
declare const __TONGZHOU_GITHUB_CLIENT_ID__: string;
export function githubClientId() {
  const value =
    process.env.TONGZHOU_GITHUB_CLIENT_ID ??
    (typeof __TONGZHOU_GITHUB_CLIENT_ID__ !== 'undefined' ? __TONGZHOU_GITHUB_CLIENT_ID__ : '');
  return /^[A-Za-z0-9_.-]{1,200}$/.test(value) ? value : '';
}
const grantSchema = z.object({
  device_code: z.string().min(1).max(2000),
  user_code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  verification_uri: z.literal('https://github.com/login/device'),
  expires_in: z.number().int().positive().max(1800),
  interval: z.number().int().positive().max(1800).optional(),
});
const tokenSchema = z.object({
  access_token: z.string().min(1).max(2000).regex(/^\S+$/),
  token_type: z.string().refine((v) => v.toLowerCase() === 'bearer'),
  refresh_token: z.string().min(1).max(2000).regex(/^\S+$/).optional(),
  expires_in: z.number().int().positive().optional(),
  refresh_token_expires_in: z.number().int().positive().optional(),
  scope: z.string().optional(),
});
export type GithubDeviceTokens = z.infer<typeof tokenSchema>;
export function githubAuthError(code: unknown) {
  return code === 'access_denied'
    ? '你已取消或拒绝 GitHub 授权，可以重新登录。'
    : code === 'expired_token' || code === 'token_expired'
      ? 'GitHub 验证码已过期，请重新登录。'
      : code === 'device_flow_disabled' || code === 'incorrect_client_credentials'
        ? '同舟的 GitHub 登录应用配置不可用，请联系维护者更新。'
        : 'GitHub 授权未完成，请重新登录。';
}
async function post(path: string, params: Record<string, string>, signal: AbortSignal) {
  signal.throwIfAborted();
  try {
    const response = await serviceFetch('https://github.com/login/' + path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    const body = await response.json();
    signal.throwIfAborted();
    return body as Record<string, unknown>;
  } catch {
    signal.throwIfAborted();
    throw new Error('无法连接 GitHub 授权服务，请检查网络和代理后重试。');
  }
}
export async function beginGithubDeviceLogin(clientId: string, signal: AbortSignal) {
  const body = await post('device/code', { client_id: clientId, scope: 'repo read:user' }, signal);
  if (body.error) throw new Error(githubAuthError(body.error));
  const result = grantSchema.safeParse(body);
  if (!result.success) throw new Error('GitHub 未返回有效的设备授权信息，请重试。');
  return { ...result.data, expiresAt: Date.now() + result.data.expires_in * 1000 };
}
export async function waitForGithubDeviceToken(
  clientId: string,
  grant: Awaited<ReturnType<typeof beginGithubDeviceLogin>>,
  signal: AbortSignal,
) {
  let interval = Math.max(5, grant.interval ?? 5);
  while (Date.now() < grant.expiresAt) {
    await delay(Math.min(interval * 1000, grant.expiresAt - Date.now()), undefined, { signal });
    if (Date.now() >= grant.expiresAt) break;
    const body = await post(
      'oauth/access_token',
      {
        client_id: clientId,
        device_code: grant.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      },
      signal,
    );
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      interval = Math.max(interval + 5, Number(body.interval) || 0);
      continue;
    }
    if (body.error) throw new Error(githubAuthError(body.error));
    const tokens = tokenSchema.safeParse(body);
    if (!tokens.success) throw new Error('GitHub 未返回有效的授权令牌，请重新登录。');
    return tokens.data;
  }
  throw new Error('GitHub 验证码已过期，请重新登录。');
}
export async function refreshGithubDeviceToken(
  clientId: string,
  refresh: string,
  signal: AbortSignal,
) {
  const body = await post(
    'oauth/access_token',
    { client_id: clientId, refresh_token: refresh, grant_type: 'refresh_token' },
    signal,
  );
  const tokens = tokenSchema.safeParse(body);
  if (!tokens.success || body.error) throw new Error('GitHub 授权已过期，请重新登录。');
  return tokens.data;
}
