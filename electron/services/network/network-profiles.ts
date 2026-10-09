import { appFetch } from './request-identity';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import type { Store } from '../storage/store';
import type { ProviderNetwork } from '../../../src/shared/provider-network';
import type { NetworkProfile, NetworkProfileInput } from '../../../src/shared/network-profile';
import { networkProfileSchema, parseNetworkConfig, runtimeNetworkConfig } from './network-config';
import { NetworkCore, boundedBody } from './network-core';
import { serviceFetch } from './service-network';
import { accountEnvironment } from './provider-network';
import { minimalEnv } from '../../core/tools/workspace';
import { bestNetworkNode, probeFailure, probeNetworkNode } from './network-health';
import type { NetworkNodeHealth } from '../../../src/shared/network-profile';

type Saved = Pick<
  NetworkProfile,
  'id' | 'name' | 'source' | 'nodes' | 'selected' | 'updatedAt' | 'routing'
>;
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
  private scans = new Map<
    string,
    { promise: Promise<string>; controller: AbortController; completed: number; total: number }
  >();
  private health = new Map<string, NonNullable<NetworkProfile['health']>>();
  constructor(
    private store: Store,
    private dataDir: string,
    private changed: () => void,
    private guard: (id: string, exceptRunId?: string) => void = () => {},
    private invalidate: (id: string) => void = () => {},
    private host = path
      .join(__dirname, 'network-core-host.cjs')
      .replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep),
    private invalidateIdle: (id: string) => void = () => {},
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
            health: this.health.get(p.id),
            checking: this.scans.has(p.id)
              ? { completed: this.scans.get(p.id)!.completed, total: this.scans.get(p.id)!.total }
              : undefined,
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
      const response = await serviceFetch(
        url.href,
        { signal: AbortSignal.timeout(30000), redirect: 'error' },
        'clash.meta',
      );
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
        routing: old?.routing || 'manual',
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
      this.cancelCheck(input.id);
      this.health.delete(input.id);
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
      this.health.delete(id);
      this.changed();
    });
  }
  private async request(r: Running, endpoint: string, init?: RequestInit) {
    const response = await appFetch(`http://127.0.0.1:${r.controller}${endpoint}`, {
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
    this.cancelCheck(id);
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
      this.store.put('networkProfile', { ...p, selected: node, routing: 'manual' });
      this.latencies.delete(id);
      this.invalidate(id);
      this.changed();
    });
  }
  async resolve(network?: ProviderNetwork, runId?: string): Promise<ProviderNetwork | undefined> {
    if (network?.mode !== 'managed') return network;
    const id = network.profileId || '';
    await this.start(id);
    if (this.store.get<Saved>('networkProfile', id).routing === 'auto') {
      if (!this.health.get(id) || Date.now() - this.health.get(id)!.checkedAt > 5 * 60_000)
        await this.check(id);
      const recommended = this.health.get(id)?.checkedAt
        ? this.health.get(id)?.recommended
        : undefined;
      if (!recommended)
        throw new Error(
          '未找到 OpenAI 登录与 ChatGPT 检测均通过的节点，请在网络配置中查看检测结果',
        );
      await this.serial(id, async () => {
        const p = this.store.get<Saved>('networkProfile', id);
        // The task scheduler already owns a running turn during this preflight: never switch
        // an existing shared core under another account. The routing guard handles this below.
        if (p.selected !== recommended) {
          try {
            this.guard(id, runId);
          } catch {
            const current = this.health.get(id)?.results.find((n) => n.node === p.selected);
            if (current?.auth.status === 'ok' && current.chatgpt.status === 'ok') return;
            throw new Error('此网络还有任务运行，暂不能切换出口；请待任务结束后再试');
          }
          const r = this.running.get(id);
          if (!r) throw new Error('网络已停止');
          await this.request(r, '/proxies/TZ-OUT', {
            method: 'PUT',
            body: JSON.stringify({ name: recommended }),
          });
          await this.request(r, '/connections', { method: 'DELETE' });
          this.store.put('networkProfile', { ...p, selected: recommended });
          // Auth may be awaiting resolve() itself: don't stop its starting client.
          this.invalidateIdle(id);
          this.changed();
        }
      });
    }
    const entry = this.running.get(id);
    if (!entry?.ready) throw new Error('内置网络不可用');
    return {
      mode: 'proxy',
      proxyUrl: `http://127.0.0.1:${entry.proxy}`,
      ...(network.transport ? { transport: network.transport } : {}),
    };
  }
  cancelCheck(id: string) {
    this.scans.get(id)?.controller.abort();
  }
  async setRouting(id: string, routing: 'manual' | 'auto') {
    this.guard(id);
    if (routing === 'auto') await this.check(id);
    return this.serial(id, async () => {
      this.guard(id);
      const p = this.store.get<Saved>('networkProfile', id);
      const selected =
        routing === 'auto'
          ? this.health.get(id)?.checkedAt
            ? this.health.get(id)?.recommended
            : undefined
          : p.selected;
      if (!selected) throw new Error('没有通过 OpenAI 与 ChatGPT 检测的节点，保持原来的手动模式');
      const r = this.running.get(id);
      if (r && selected !== p.selected) {
        await this.request(r, '/proxies/TZ-OUT', {
          method: 'PUT',
          body: JSON.stringify({ name: selected }),
        });
        await this.request(r, '/connections', { method: 'DELETE' });
      }
      this.store.put('networkProfile', { ...p, selected, routing });
      this.invalidate(id);
      this.changed();
    });
  }
  async check(id: string, onlyNode?: string): Promise<string> {
    if (this.scans.has(id)) return this.scans.get(id)!.promise;
    const p = this.store.get<Saved>('networkProfile', id);
    if (onlyNode && !p.nodes.includes(onlyNode)) throw new Error('节点不存在');
    const controller = new AbortController();
    const scan = {
      controller,
      completed: 0,
      total: onlyNode ? 1 : p.nodes.length,
      promise: Promise.resolve(''),
    };
    this.scans.set(id, scan);
    this.changed();
    scan.promise = (async () => {
      await this.start(id);
      const r = this.running.get(id)!;
      if (!onlyNode) this.health.set(id, { checkedAt: 0, results: [] });
      const nodes = onlyNode ? [onlyNode] : p.nodes;
      const results: NetworkNodeHealth[] = onlyNode
        ? (this.health.get(id)?.results || []).filter((n) => n.node !== onlyNode)
        : [];
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, nodes.length) }, async () => {
          while (cursor < nodes.length && !controller.signal.aborted) {
            const node = nodes[cursor++];
            const result = await probeNetworkNode(node, async (name, url, expected) => {
              if (controller.signal.aborted) return { status: 'failed' };
              try {
                const query = new URLSearchParams({ url, timeout: '6000', expected });
                const response = await appFetch(
                  `http://127.0.0.1:${r.controller}/proxies/${encodeURIComponent(name)}/delay?${query}`,
                  {
                    headers: { Authorization: 'Bearer ' + r.secret },
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
                    redirect: 'error',
                  },
                );
                const body = await response.json();
                if (!response.ok) return { status: probeFailure(String(body.message || '')) };
                if (!Number.isFinite(body.delay) || body.delay < 0) return { status: 'failed' };
                return { status: 'ok', ms: body.delay };
              } catch (e) {
                return { status: probeFailure(String(e)) };
              }
            });
            if (controller.signal.aborted || this.running.get(id) !== r) break;
            results.push(result);
            scan.completed++;
            this.health.set(id, {
              checkedAt: onlyNode ? this.health.get(id)?.checkedAt || 0 : 0,
              results: [...results],
              recommended: bestNetworkNode(results),
            });
            this.changed();
          }
        }),
      );
      if (controller.signal.aborted || this.running.get(id) !== r)
        return '检测已取消，已完成的结果保留';
      this.health.set(id, {
        checkedAt: onlyNode ? this.health.get(id)?.checkedAt || 0 : Date.now(),
        results,
        recommended: bestNetworkNode(results),
      });
      const available = results.filter(
        (n) => n.auth.status === 'ok' && n.chatgpt.status === 'ok',
      ).length;
      return `已检测 ${scan.completed} 个节点，${available} 个通过 OpenAI 与 ChatGPT 检测。延迟是请求往返时间，不代表下载带宽或模型输出速度。`;
    })().finally(() => {
      if (this.scans.get(id) === scan) this.scans.delete(id);
      this.changed();
    });
    return scan.promise;
  }
  recordLatency(id: string, ms: number) {
    this.latencies.set(id, ms);
    this.changed();
  }
  async dispose() {
    this.closed = true;
    for (const scan of this.scans.values()) scan.controller.abort();
    await Promise.allSettled(this.locks.values());
    await Promise.all([...this.running.keys()].map((id) => this.stopCore(id)));
  }
}
