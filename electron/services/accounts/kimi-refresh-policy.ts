/** A background refresh must never start a device authorization or open a login browser. */
export function assertKimiRefreshRequest(input: Parameters<typeof fetch>[0], refreshOnly: boolean) {
  if (!refreshOnly) return;
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (
    ['auth.kimi.com', 'auth.kimi.ai'].includes(url.hostname) &&
    url.pathname.replace(/\/$/, '') === '/api/oauth/device_authorization'
  )
    throw new Error('Kimi 授权已失效，请在模型中重新登录');
}
