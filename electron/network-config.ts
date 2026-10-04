import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { idSchema } from './validation';

export const networkProfileSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(80),
  source: z.enum(['config', 'subscription']),
  config: z.string().max(2_000_000).optional(),
  subscriptionUrl: z.string().max(4096).optional(),
});
const protocols = ['ss', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'socks5', 'http'];
const fields = new Set([
  'name',
  'type',
  'server',
  'port',
  'cipher',
  'password',
  'uuid',
  'alterId',
  'udp',
  'tls',
  'servername',
  'sni',
  'alpn',
  'fingerprint',
  'client-fingerprint',
  'skip-cert-verify',
  'network',
  'flow',
  'packet-encoding',
  'ws-opts',
  'grpc-opts',
  'http-opts',
  'h2-opts',
  'reality-opts',
  'obfs',
  'obfs-password',
  'up',
  'down',
  'auth-str',
  'token',
  'username',
  'congestion-controller',
  'udp-relay-mode',
  'reduce-rtt',
  'heartbeat-interval',
  'disable-sni',
  'fast-open',
  'tfo',
]);
const nestedFields: Record<string, Set<string>> = {
  'ws-opts': new Set(['path', 'headers', 'max-early-data', 'early-data-header-name']),
  'grpc-opts': new Set(['grpc-service-name']),
  'http-opts': new Set(['method', 'path', 'headers']),
  'h2-opts': new Set(['host', 'path']),
  'reality-opts': new Set(['public-key', 'short-id']),
};
/** Import node data only. Never execute source scripts or import host routing/listeners/files. */
export function parseNetworkConfig(text: string): Record<string, any>[] {
  if (!text.trim() || Buffer.byteLength(text) > 2_000_000) throw new Error('配置为空或超过 2 MB');
  let doc: any;
  try {
    doc = parse(text, { maxAliasCount: 0, uniqueKeys: true });
  } catch {
    throw new Error('配置不是有效的 YAML / JSON，请使用 Clash / Mihomo 格式');
  }
  if (!doc || !Array.isArray(doc.proxies) || !doc.proxies.length || doc.proxies.length > 500)
    throw new Error(
      '配置需包含 1–500 个 proxies 节点。请选择 Clash / Mihomo 节点订阅；不支持仅含 proxy-providers、Base64 或分享链接的文件。',
    );
  const names = new Set<string>();
  return doc.proxies.map((p: any, index: number) => {
    const label = `第 ${index + 1} 个节点`;
    if (!p || typeof p !== 'object' || Array.isArray(p) || !protocols.includes(p.type))
      throw new Error(
        label + '协议不受支持；支持 SS、VMess、VLESS、Trojan、Hysteria2、TUIC、HTTP、SOCKS5',
      );
    if (
      typeof p.name !== 'string' ||
      !p.name.trim() ||
      p.name.length > 160 ||
      names.has(p.name) ||
      ['DIRECT', 'REJECT', 'GLOBAL', 'TZ-OUT'].includes(p.name)
    )
      throw new Error(label + '名称为空、重复或与系统名称冲突');
    names.add(p.name);
    if (
      typeof p.server !== 'string' ||
      !p.server ||
      p.server.length > 253 ||
      /[\s/@\\]/.test(p.server) ||
      !Number.isInteger(p.port) ||
      p.port < 1 ||
      p.port > 65535
    )
      throw new Error(label + '服务器或端口无效');
    if (
      ['ss', 'trojan', 'hysteria2'].includes(p.type) &&
      (typeof p.password !== 'string' || !p.password)
    )
      throw new Error(label + '缺少密码');
    if (['vmess', 'vless', 'tuic'].includes(p.type) && (typeof p.uuid !== 'string' || !p.uuid))
      throw new Error(label + '缺少 UUID');
    if (p.type === 'ss' && (typeof p.cipher !== 'string' || !p.cipher))
      throw new Error(label + '缺少加密方式');
    for (const key of Object.keys(p)) {
      if (!fields.has(key))
        throw new Error(label + '包含当前未支持的节点选项，请移除高级节点选项后重试');
      if (nestedFields[key]) {
        if (
          !p[key] ||
          typeof p[key] !== 'object' ||
          Array.isArray(p[key]) ||
          Object.keys(p[key]).some((k) => !nestedFields[key].has(k))
        )
          throw new Error(label + '传输配置无效');
      } else if (
        typeof p[key] === 'object' &&
        !(
          key === 'alpn' &&
          Array.isArray(p[key]) &&
          p[key].every((v: unknown) => typeof v === 'string')
        )
      )
        throw new Error(label + '包含无效字段类型');
    }
    return p;
  });
}
export function runtimeNetworkConfig(
  nodes: Record<string, any>[],
  selected: string,
  port: number,
  controller: number,
  secret: string,
) {
  if (!nodes.some((n) => n.name === selected)) throw new Error('选中的节点已不存在，请重新选择');
  return stringify({
    'mixed-port': port,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    mode: 'rule',
    ipv6: false,
    'log-level': 'silent',
    'find-process-mode': 'off',
    'external-controller': `127.0.0.1:${controller}`,
    secret,
    'external-controller-cors': { 'allow-origins': [], 'allow-private-network': false },
    tun: { enable: false },
    dns: { enable: false },
    profile: { 'store-selected': false, 'store-fake-ip': false },
    proxies: nodes,
    'proxy-groups': [
      {
        name: 'TZ-OUT',
        type: 'select',
        proxies: [selected, ...nodes.map((n) => n.name).filter((n) => n !== selected)],
      },
    ],
    rules: ['MATCH,TZ-OUT'],
  });
}
