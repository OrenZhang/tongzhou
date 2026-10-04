import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import type { Store } from './store';
import type { Provider } from '../src/shared/types';
import type { ProviderNetwork } from '../src/shared/provider-network';
import type { NetworkProfile, NetworkProfileInput } from '../src/shared/network-profile';
import { networkProfileSchema, parseNetworkConfig, runtimeNetworkConfig } from './network-config';
import { NetworkCore, boundedBody } from './network-core';
import { serviceFetch } from './service-network';
import { accountEnvironment } from './provider-network';
import { minimalEnv } from './workspace';

type Saved = Pick<NetworkProfile, 'id' | 'name' | 'source' | 'nodes' | 'selected' | 'updatedAt'>;
type Running = {
  child: ChildProcess;
  proxy: number;
  controller: number;
  secret: string;
  ready: boolean;
};
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
export class NetworkProfiles {
  readonly core: NetworkCore;
  private running = new Map<string, Running>();
  private errors = new Map<string, string>();
  private latencies = new Map<string, number>();
  private locks = new Map<string, Promise<unknown>>();
  private closed = false;
  constructor(
    private store: Store,
    private dataDir: string,
    private changed: () => void,
    private guard: (id: string) => void = () => {},
    private invalidate: (id: string) => void = () => {},
    private host = path
      .join(__dirname, 'network-core-host.cjs')
      .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep),
  ) {
    this.core = new NetworkCore(dataDir);
    // Windows may terminate the whole child job on an abrupt desktop exit before
    // the supervisor can remove an already-empty directory. Recover our own temp
    // directories on next launch, after the app has acquired its single-instance lock.
    const root = path.resolve(dataDir, 'network-runtime');
    if (existsSync(root) && !lstatSync(root).isSymbolicLink()) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^run-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
        const target = path.resolve(root, entry.name);
        if (path.dirname(target) !== root) continue;
        rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  }
  private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('客户端正在退出');
    const previous = this.locks.get(id);
    const next = (previous || Promise.resolve()).catch(() => {}).then(work);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  list() {
    return {
      core: this.core.status(),
      profiles: this.store.list<Saved>('networkProfile').map(
        (p) =>
          ({
            ...p,
            status: this.running.has(p.id)
              ? this.running.get(p.id)!.ready
                ? 'running'
                : 'starting'
              : this.errors.has(p.id)
                ? 'error'
                : 'stopped',
            error: this.errors.get(p.id),
            latency: this.latencies.get(p.id),
            usedBy: this.store
              .providers()
              .filter((v) => v.network?.mode === 'managed' && v.network.profileId === p.id)
              .map((v) => v.name),
          }) as NetworkProfile,
      ),
    };
  }
  exists(id: string) {
    this.store.get('networkProfile', id);
  }
  private async subscription(raw: string) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error('请填写有效的 HTTPS 订阅地址');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new Error('订阅地址必须为 HTTPS');
    try {
      const response = await serviceFetch(url.href, {
        signal: AbortSignal.timeout(30000),
        redirect: 'error',
        headers: { 'User-Agent': 'clash.meta/Tongzhou' },
      });
      return (await boundedBody(response, 2_000_000)).toString('utf8');
    } catch {
      throw new Error('订阅下载失败，请检查网络或地址。也可先导入本地配置文件；未覆盖原配置。');
    }
  }
  async save(raw: NetworkProfileInput) {
    const input = networkProfileSchema.parse(raw);
    return this.serial(input.id, async () => {
      this.guard(input.id);
      const old = this.store.list<Saved>('networkProfile').find((p) => p.id === input.id);
      const oldSecret = old ? JSON.parse(this.store.secret('network_' + input.id)) : {};
      const url =
        input.subscriptionUrl?.trim() || (old?.source === input.source ? oldSecret.url : '');
      const config =
        input.source === 'subscription'
          ? await this.subscription(url)
          : input.config?.trim() || (old?.source === input.source ? oldSecret.config : '');
      const nodes = parseNetworkConfig(config);
      this.guard(input.id);
      const saved: Saved = {
        id: input.id,
        name: input.name,
        source: input.source,
        nodes: nodes.map((p) => p.name),
        selected: nodes.some((p) => p.name === old?.selected) ? old!.selected : nodes[0].name,
        updatedAt: Date.now(),
      };
      // Encrypt before stopping the working runtime; failures preserve the existing profile.
      this.store.saveSecret(
        'network_' + input.id,
        JSON.stringify({
          config: stringify({ proxies: nodes }),
          url: input.source === 'subscription' ? url : undefined,
        }),
      );
      await this.stopCore(input.id);
      this.store.put('networkProfile', saved);
      this.errors.delete(input.id);
      this.latencies.delete(input.id);
      this.invalidate(input.id);
      this.changed();
    });
  }
  async refresh(id: string) {
    const p = this.store.get<Saved>('networkProfile', id);
    if (p.source !== 'subscription') throw new Error('该配置不是订阅');
    return this.save({ id, name: p.name, source: p.source });
  }
  async remove(id: string) {
    return this.serial(id, async () => {
      this.guard(id);
      if (
        this.store
          .providers()
          .some((p) => p.network?.mode === 'managed' && p.network.profileId === id)
      )
        throw new Error('请先在账号中取消使用此网络配置，再删除');
      await this.stopCore(id);
      this.store.remove('networkProfile', id);
      this.store.saveSecret('network_' + id, undefined, true);
      this.errors.delete(id);
      this.latencies.delete(id);
      this.changed();
    });
  }
  private async request(r: Running, endpoint: string, init?: RequestInit) {
    const response = await fetch(`http://127.0.0.1:${r.controller}${endpoint}`, {
      ...init,
      headers: { Authorization: 'Bearer ' + r.secret, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(2000),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('内核控制接口不可达');
    }
    if (response.status === 204) return {};
    return response.json();
  }
  async start(id: string) {
    return this.serial(id, () => this.startCore(id));
  }
  private async startCore(id: string) {
    if (this.closed) throw new Error('客户端正在退出');
    if (this.running.get(id)?.ready) return;
    const p = this.store.get<Saved>('networkProfile', id);
    if (!this.core.status().installed)
      throw new Error('请先在设置 → 连接中心 → 网络配置中安装内核');
    const nodes = parseNetworkConfig(JSON.parse(this.store.secret('network_' + id)).config);
    const root = path.join(this.dataDir, 'network-runtime');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(path.join(root, 'run-'));
    let entry: Running | undefined;
    try {
      const proxy = await freePort();
      let controller = await freePort();
      while (controller === proxy) controller = await freePort();
      const secret = randomBytes(32).toString('hex');
      const config = path.join(directory, 'config.yaml');
      await writeFile(path.join(directory, 'status.json'), JSON.stringify({ proxyPort: proxy }), {
        mode: 0o600,
      });
      await writeFile(config, runtimeNetworkConfig(nodes, p.selected, proxy, controller, secret), {
        mode: 0o600,
      });
      const env = accountEnvironment(minimalEnv(), { mode: 'direct' });
      const child = fork(this.host, [], {
        execPath: process.execPath,
        execArgv: [],
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      entry = { child, proxy, controller, secret, ready: false };
      this.running.set(id, entry);
      this.errors.delete(id);
      this.changed();
      const ended = () => {
        if (this.running.get(id) !== entry) return;
        this.running.delete(id);
        this.errors.set(id, '网络内核已退出。请检查节点配置后重新启动。');
        this.latencies.delete(id);
        this.invalidate(id);
        this.changed();
      };
      child.once('exit', ended);
      child.once('error', ended);
      child.send({ type: 'start', binary: this.core.binary, directory, config, env }, () => {});
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline && this.running.get(id) === entry && !this.closed) {
        try {
          const version = await this.request(entry, '/version');
          if (!version.version) throw new Error();
          entry.ready = true;
          break;
        } catch {
          await delay(100);
        }
      }
      if (!entry.ready)
        throw new Error('内核启动失败：请检查节点协议、参数或端口占用；原始日志不会展示凭据。');
      // The core has loaded all node data; do not leave plaintext credentials on disk.
      await rm(config, { force: true });
      this.changed();
    } catch (e) {
      await this.stopCore(id);
      await rm(directory, { recursive: true, force: true });
      this.errors.set(id, e instanceof Error ? e.message : '内核启动失败');
      this.changed();
      throw e;
    }
  }
  async stop(id: string) {
    return this.serial(id, async () => {
      this.guard(id);
      await this.stopCore(id);
      this.invalidate(id);
      this.errors.delete(id);
      this.latencies.delete(id);
      this.changed();
    });
  }
  private async stopCore(id: string) {
    const r = this.running.get(id);
    if (!r) return;
    this.running.delete(id);
    if (r.child.exitCode !== null || r.child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      r.child.once('exit', () => resolve());
      if (r.child.connected) r.child.send({ type: 'stop' }, () => {});
      else resolve();
    });
  }
  async select(id: string, node: string) {
    return this.serial(id, async () => {
      this.guard(id);
      const p = this.store.get<Saved>('networkProfile', id);
      if (!p.nodes.includes(node)) throw new Error('节点不存在');
      const r = this.running.get(id);
      if (r?.ready) {
        await this.request(r, '/proxies/TZ-OUT', {
          method: 'PUT',
          body: JSON.stringify({ name: node }),
        });
        await this.request(r, '/connections', { method: 'DELETE' });
      }
      this.store.put('networkProfile', { ...p, selected: node });
      this.latencies.delete(id);
      this.invalidate(id);
      this.changed();
    });
  }
  async resolve(network?: ProviderNetwork): Promise<ProviderNetwork | undefined> {
    if (network?.mode !== 'managed') return network;
    const id = network.profileId || '';
    await this.start(id);
    const entry = this.running.get(id);
    if (!entry?.ready) throw new Error('内置网络不可用');
    return { mode: 'proxy', proxyUrl: `http://127.0.0.1:${entry.proxy}` };
  }
  recordLatency(id: string, ms: number) {
    this.latencies.set(id, ms);
    this.changed();
  }
  async dispose() {
    this.closed = true;
    await Promise.allSettled(this.locks.values());
    await Promise.all([...this.running.keys()].map((id) => this.stopCore(id)));
  }
}
