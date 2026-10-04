import type { NetworkNodeHealth, NetworkProbe, NetworkTarget } from '../src/shared/network-profile';
export const networkTargets: Record<NetworkTarget, { url: string; expected: string }[]> = {
  internet: [
    { url: 'https://www.gstatic.com/generate_204', expected: '204' },
    { url: 'https://cp.cloudflare.com/generate_204', expected: '204' },
  ],
  auth: [{ url: 'https://auth.openai.com/.well-known/openid-configuration', expected: '200' }],
  chatgpt: [{ url: 'https://chatgpt.com/backend-api/models', expected: '200/401' }],
};
export function probeFailure(error: string): NetworkProbe['status'] {
  if (/timeout|timed out|deadline|aborted/i.test(error)) return 'timeout';
  if (/dns|no such host|lookup/i.test(error)) return 'dns';
  if (/tls|certificate|x509/i.test(error)) return 'tls';
  if (/status|403|429|expected/i.test(error)) return 'blocked';
  return 'failed';
}
export function bestNetworkNode(results: NetworkNodeHealth[]) {
  return results
    .filter((r) => r.auth.status === 'ok' && r.chatgpt.status === 'ok')
    .sort((a, b) => a.auth.ms! + a.chatgpt.ms! - (b.auth.ms! + b.chatgpt.ms!))[0]?.node;
}
/** Probe each node directly through its adapter, without changing the active selector. */
export async function probeNetworkNode(
  node: string,
  probe: (node: string, url: string, expected: string) => Promise<NetworkProbe>,
): Promise<NetworkNodeHealth> {
  const result = { node, checkedAt: Date.now() } as NetworkNodeHealth;
  await Promise.all(
    (Object.keys(networkTargets) as NetworkTarget[]).map(async (target) => {
      for (const path of networkTargets[target]) {
        result[target] = {
          ...(await probe(node, path.url, path.expected)),
          target: new URL(path.url).hostname,
        };
        if (result[target].status === 'ok') break;
      }
    }),
  );
  return result;
}
