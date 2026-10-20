import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as nodeFetch, type Dispatcher } from 'undici';
import type { ProviderNetwork } from '../../src/shared/provider-network';
import { normalizeProxyUrl } from '../../src/shared/provider-network';
import { withRequestIdentity } from '../services/network/request-identity';

const exec = promisify(execFile);
/** Node transports never mutate process-wide proxy variables or a peer account's dispatcher. */
export function nodeNetwork() {
  const dispatchers = new Map<string, Dispatcher>();
  let inherited: Promise<Dispatcher> | undefined;
  async function systemDispatcher() {
    if (
      process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.http_proxy ||
      process.env.https_proxy
    )
      return new EnvHttpProxyAgent();
    if (process.platform === 'darwin') {
      const { stdout } = await exec('/usr/sbin/scutil', ['--proxy']);
      if (/ProxyAutoConfigEnable\s*:\s*1/.test(stdout))
        throw new Error('Tauri 预览暂不支持系统 PAC，请为连接配置独立 HTTP 代理或使用 Electron。');
      const proxy = (kind: string) => {
        if (!new RegExp(kind + 'Enable\\s*:\\s*1').test(stdout)) return undefined;
        const host = stdout.match(new RegExp(kind + 'Proxy\\s*:\\s*(\\S+)'))?.[1];
        const port = stdout.match(new RegExp(kind + 'Port\\s*:\\s*(\\d+)'))?.[1];
        return host && port ? `http://${host}:${port}` : undefined;
      };
      const httpProxy = proxy('HTTP'),
        httpsProxy = proxy('HTTPS');
      if (httpProxy || httpsProxy)
        return new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy: 'localhost,127.0.0.1,::1' });
    }
    return new Agent();
  }
  function agent(key: string): Dispatcher {
    if (!dispatchers.has(key))
      dispatchers.set(key, key === 'direct' ? new Agent() : new ProxyAgent(key));
    return dispatchers.get(key)!;
  }
  async function transport(network?: ProviderNetwork): Promise<typeof globalThis.fetch> {
    if (network?.mode === 'managed') throw new Error('请先解析托管网络');
    const key =
      network?.mode === 'proxy'
        ? normalizeProxyUrl(network.proxyUrl ?? '')
        : (network?.mode ?? 'inherit');
    return (async (input, init) => {
      const request = new Request(
        input,
        withRequestIdentity(input, { ...init, credentials: 'omit' }),
      );
      const url = new URL(request.url);
      let dispatcher: Dispatcher;
      // Resolve system proxies lazily: PAC must not block local models or core startup.
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || key === 'direct')
        dispatcher = agent('direct');
      else if (key !== 'inherit') dispatcher = agent(key);
      else {
        if (!inherited) {
          inherited = systemDispatcher();
          void inherited.catch(() => {
            inherited = undefined;
          });
        }
        dispatcher = await inherited;
      }
      const response = await nodeFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: request.body,
        signal: request.signal,
        redirect: request.redirect,
        integrity: request.integrity,
        cache: request.cache,
        credentials: 'omit',
        duplex: 'half',
        dispatcher,
      } as Parameters<typeof nodeFetch>[1]);
      return response as unknown as Response;
    }) as typeof globalThis.fetch;
  }
  return {
    transport,
    async dispose() {
      const agents = [...dispatchers.values()];
      if (inherited) {
        try {
          agents.push(await inherited);
        } catch {
          /* No dispatcher was created. */
        }
      }
      await Promise.all(agents.map((agent) => agent.close()));
    },
  };
}
