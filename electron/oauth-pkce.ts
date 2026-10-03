import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { serviceFetch } from './service-network';

export const gitlabRedirect = 'http://127.0.0.1:17437/connector/callback';
/** Public OAuth client: no shared app secret is embedded in the desktop binary. */
export async function gitlabLogin(
  origin: string,
  clientId: string,
  signal: AbortSignal,
  accept: (token: string, refresh?: string, expiresIn?: number) => Promise<unknown>,
  failed: () => void,
  finished: () => void = () => {},
) {
  const state = randomBytes(32).toString('base64url'),
    verifier = randomBytes(32).toString('base64url');
  let consumed = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', gitlabRedirect);
    if (
      req.method !== 'GET' ||
      req.headers.host !== '127.0.0.1:17437' ||
      url.pathname !== '/connector/callback' ||
      url.searchParams.get('state') !== state ||
      consumed
    ) {
      res.writeHead(400);
      res.end('Invalid authorization callback');
      return;
    }
    consumed = true;
    try {
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.has('error')) throw new Error('Authorization cancelled');
      const response = await serviceFetch(origin + '/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          code,
          grant_type: 'authorization_code',
          redirect_uri: gitlabRedirect,
          code_verifier: verifier,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        redirect: 'error',
      });
      const result = (await response.json()) as any;
      if (!response.ok || !result.access_token) throw new Error('Token exchange failed');
      await accept(result.access_token, result.refresh_token, result.expires_in);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end('同舟：账号授权已验证，可以关闭此页面。');
    } catch {
      if (!signal.aborted) failed();
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('授权未完成，请回到同舟重新连接。');
    } finally {
      // Flush the callback response before closing keep-alive sockets.
      if (res.writableFinished) close();
      else res.once('finish', close);
    }
  });
  const expiresAt = Date.now() + 5 * 60 * 1000;
  const timeout = setTimeout(
    () => {
      if (!consumed && !signal.aborted) failed();
      close();
    },
    5 * 60 * 1000,
  );
  timeout.unref();
  const close = () => {
    clearTimeout(timeout);
    signal.removeEventListener('abort', close);
    server.closeAllConnections();
    server.close();
    finished();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(17437, '127.0.0.1', resolve);
    });
  } catch {
    close();
    throw new Error('登录回调端口 17437 被占用，请结束其他 GitLab 授权后再试');
  }
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) {
    close();
    signal.throwIfAborted();
  }
  const url = new URL(origin + '/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: gitlabRedirect,
    response_type: 'code',
    state,
    scope: 'read_user read_api',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  return { url: url.href, code: '', expiresAt };
}
