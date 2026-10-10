import { randomBytes } from 'node:crypto';
import { appFetch, userAgent } from '../../network/request-identity';

export const weixinBaseUrl = 'https://ilinkai.weixin.qq.com';
// Wire compatibility follows Tencent/openclaw-weixin 2.4.9; application identity is Tongzhou.
const channelVersion = '2.4.9';
const clientVersion = String((2 << 16) | (4 << 8) | 9);
export function weixinApiUrl(value = weixinBaseUrl) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.weixin.qq.com') ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('微信返回了不受信任的服务地址');
  return url.origin;
}
export class WeixinApiError extends Error {
  constructor(readonly expired = false) {
    super(expired ? '微信登录已失效，请重新扫码连接' : '微信接口暂不可用，请稍后重试');
  }
}
export class WeixinApi {
  constructor(private fetcher: typeof fetch = appFetch) {}
  async request(
    baseUrl: string,
    endpoint: string,
    signal: AbortSignal,
    options: { body?: Record<string, unknown>; token?: string; timeout?: number } = {},
  ): Promise<any> {
    const headers: Record<string, string> = {
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': clientVersion,
    };
    if (options.body) {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString(
        'base64',
      );
    }
    if (options.token) headers.Authorization = 'Bearer ' + options.token;
    const response = await this.fetcher(weixinApiUrl(baseUrl) + '/ilink/bot/' + endpoint, {
      method: options.body ? 'POST' : 'GET',
      headers,
      body: options.body
        ? JSON.stringify({
            ...options.body,
            ...(options.token
              ? { base_info: { channel_version: channelVersion, bot_agent: userAgent } }
              : {}),
          })
        : undefined,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeout ?? 15_000)]),
    });
    if (!response.ok) throw new WeixinApiError(response.status === 401);
    // Preserve uint64 message ids; never deduplicate using rounded JS numbers.
    const result = JSON.parse(await response.text(), (key, value, context?: { source: string }) => {
      if (key === 'message_id' && typeof value === 'number') {
        if (context?.source && /^\d+$/.test(context.source)) return context.source;
        if (!Number.isSafeInteger(value)) throw new WeixinApiError();
        return String(value);
      }
      return value;
    });
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new WeixinApiError();
    if (
      (result.ret !== undefined && result.ret !== 0) ||
      (result.errcode !== undefined && result.errcode !== 0)
    )
      throw new WeixinApiError(result.ret === -14 || result.errcode === -14);
    return result;
  }
}

export function waitForWeixin(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
