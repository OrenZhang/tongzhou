import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import type { AgentProfile, PluginConfig, SkillRecord, ToolOutput } from '../src/shared/types';
import type { ToolSpec } from './providers';
import { Store } from './store';
import { minimalEnv, within } from './workspace';
import { redact } from './validation';
import { pluginOAuth, secureOAuthUrl, type PluginOAuthProvider } from './mcp-auth';
import { serviceFetch } from './service-network';

export interface ComputerAdapter {
  fork?(): ComputerAdapter;
  specs(readOnly: boolean): ToolSpec[];
  execute(name: string, args: unknown, signal: AbortSignal): Promise<ToolOutput>;
}
export type AskTool = (title: string, detail: string) => Promise<boolean>;

export function normalizeOutput(result: any): ToolOutput {
  const text: string[] = [];
  const images: NonNullable<ToolOutput['images']> = [];
  let imageBytes = 0;
  for (const item of (result.content ?? []).slice(0, 100)) {
    if (item.type === 'text') text.push(String(item.text));
    else if (
      item.type === 'image' &&
      ['image/png', 'image/jpeg', 'image/webp'].includes(item.mimeType) &&
      typeof item.data === 'string'
    ) {
      imageBytes += item.data.length;
      if (imageBytes <= 4_000_000 && images.length < 2 && /^[A-Za-z0-9+/=]+$/.test(item.data))
        images.push({ data: item.data, mimeType: item.mimeType });
      else text.push('[图片超出大小限制]');
    } else text.push(JSON.stringify(item).slice(0, 8000));
  }
  if (result.structuredContent) text.push(JSON.stringify(result.structuredContent));
  return {
    text: text.join('\n').slice(0, 60000) || (images.length ? '工具返回图片' : '工具执行完成'),
    ...(images.length ? { images } : {}),
    isError: !!result.isError,
  };
}
export function mcpName(id: string, name: string) {
  return (
    'mcp_' +
    createHash('sha256')
      .update(id + '\0' + name)
      .digest('hex')
      .slice(0, 20) +
    '_' +
    name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 30)
  );
}

export class PluginConnection {
  readonly client = new Client({ name: 'tongzhou', version: '0.5.6' }, { capabilities: {} });
  private secretValues: string[] = [];
  constructor(
    readonly config: PluginConfig,
    private secret: string,
    private oauth?: PluginOAuthProvider,
  ) {}
  async connect(signal: AbortSignal) {
    signal.throwIfAborted();
    const credentials: Record<string, string> =
      !this.oauth && this.secret ? JSON.parse(this.secret) : {};
    this.secretValues = Object.values(credentials);
    const transport =
      this.config.transport === 'stdio'
        ? new StdioClientTransport({
            command: this.config.command,
            args: this.config.args,
            env: { ...minimalEnv(), ...credentials } as Record<string, string>,
            stderr: 'pipe',
          })
        : new StreamableHTTPClientTransport(new URL(this.config.url), {
            authProvider: this.oauth,
            requestInit: { headers: credentials },
            fetch: (url, init) => {
              if (this.oauth) secureOAuthUrl(url instanceof Request ? url.url : String(url));
              return serviceFetch(url, { ...init, redirect: 'error' });
            },
          });
    if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {});
    try {
      await this.client.connect(transport, { signal, timeout: 20000 });
      if (this.oauth) this.secretValues.push(...this.oauth.sensitiveValues());
    } catch (e) {
      await this.close();
      throw new Error(
        this.oauth
          ? '插件连接或授权失败，请在插件与工具中检查授权状态'
          : redact(String(e), this.secretValues),
      );
    }
  }
  async tools(signal: AbortSignal) {
    const tools: any[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.client.listTools(cursor ? { cursor } : {}, {
        signal,
        timeout: 20000,
      });
      tools.push(...result.tools);
      if (tools.length > 200) throw new Error('单个插件最多支持 200 个工具');
      cursor = result.nextCursor;
      if (!cursor) return tools;
    }
    throw new Error('插件工具目录分页异常');
  }
  async call(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    try {
      const result = normalizeOutput(
        await this.client.callTool({ name, arguments: args }, undefined, {
          signal,
          timeout: 120000,
        }),
      );
      if (this.oauth) this.secretValues.push(...this.oauth.sensitiveValues());
      return { ...result, text: redact(result.text, this.secretValues) };
    } catch (e) {
      throw new Error(
        this.oauth
          ? '插件调用或授权失败，请在插件与工具中检查授权状态'
          : redact(String(e), this.secretValues),
      );
    }
  }
  async close() {
    await this.client.close().catch(() => {});
  }
}

/** A frozen tool catalog and permission scope for one Run, independent of its model. */
export class ToolScope {
  readonly specs: ToolSpec[] = [];
  private connections: PluginConnection[] = [];
  private handlers = new Map<
    string,
    {
      title: string;
      execute(args: any): Promise<ToolOutput>;
      approval: boolean;
      allowed: () => boolean;
    }
  >();
  private closed = false;
  private seen = new Map<string, Promise<ToolOutput>>();
  private remaining = 40;
  constructor(
    private signal: AbortSignal,
    private ask: AskTool,
    private record: (name: string, args: unknown, result: ToolOutput) => void,
  ) {}
  add(
    spec: ToolSpec,
    title: string,
    execute: (args: any) => Promise<ToolOutput>,
    approval = true,
    allowed = () => true,
  ) {
    if (this.handlers.has(spec.name)) throw new Error('重复工具名');
    this.specs.push(spec);
    this.handlers.set(spec.name, { title, execute, approval, allowed });
  }
  async prepare(store: Store, agent: AgentProfile, computer?: ComputerAdapter) {
    this.remaining = agent.maxSteps;
    const abort = () => {
      void this.close();
    };
    this.signal.addEventListener('abort', abort, { once: true });
    this.detach = () => this.signal.removeEventListener('abort', abort);
    try {
      for (const config of store.list<PluginConfig>('plugin').filter((p) => p.enabled)) {
        this.signal.throwIfAborted();
        const id = config.id;
        const capturedSecret = store.secret('plugin_' + id);
        const allowed = () => {
          const current = store.list<PluginConfig>('plugin').find((p) => p.id === id);
          return (
            !!current?.enabled &&
            current.command === config.command &&
            current.url === config.url &&
            current.transport === config.transport &&
            current.authMode === config.authMode &&
            current.oauthClientId === config.oauthClientId &&
            current.oauthIssuer === config.oauthIssuer &&
            JSON.stringify(current.args) === JSON.stringify(config.args) &&
            JSON.stringify(current.readOnlyTools) === JSON.stringify(config.readOnlyTools) &&
            store.secret('plugin_' + id) === capturedSecret
          );
        };
        const connection = new PluginConnection(config, capturedSecret, pluginOAuth(store, config));
        this.connections.push(connection);
        let connected: Promise<void> | undefined;
        const connect = () => (connected ??= connection.connect(this.signal));
        let catalog = config.catalog;
        if (!catalog) {
          this.add(
            {
              name: mcpName(id, 'discover'),
              description: `${config.name}：按需连接 MCP。先 action=list 获取目录，再 action=call 携带 tool 和 arguments 调用。未调用时不启动此插件。`,
              parameters: {
                type: 'object',
                properties: {
                  action: { type: 'string', enum: ['list', 'call'] },
                  tool: { type: 'string' },
                  arguments: { type: 'object', additionalProperties: true },
                },
                required: ['action'],
                additionalProperties: false,
              },
            },
            `${config.name} · 连接和调用`,
            async (args) => {
              await connect();
              catalog ??= (await connection.tools(this.signal)).map((t) => ({
                name: t.name,
                description: t.description ?? '',
                inputSchema: t.inputSchema,
              }));
              if (!allowed()) throw new Error('插件配置已变更');
              store.put('plugin', { ...config, catalog, checkedAt: Date.now() });
              const visible = catalog.filter(
                (t) => agent.permission !== 'read-only' || config.readOnlyTools.includes(t.name),
              );
              if (args.action === 'list') return { text: JSON.stringify(visible) };
              if (args.action !== 'call' || !visible.some((t) => t.name === args.tool))
                throw new Error('工具不存在或没有权限');
              return connection.call(args.tool, args.arguments ?? {}, this.signal);
            },
            true,
            allowed,
          );
          continue;
        }
        for (const tool of catalog) {
          if (agent.permission === 'read-only' && !config.readOnlyTools.includes(tool.name))
            continue;
          const name = mcpName(id, tool.name);
          this.add(
            {
              name,
              description: `${config.name} / ${tool.name}: ${tool.description ?? ''}`.slice(
                0,
                4000,
              ),
              parameters: tool.inputSchema,
            },
            `${config.name} · ${tool.name}`,
            async (args) => {
              await connect();
              return connection.call(tool.name, args, this.signal);
            },
            true,
            allowed,
          );
        }
      }
      if (store.capabilities().computer) {
        if (!computer) throw new Error('此环境没有电脑控制适配器');
        const scopedComputer = computer.fork?.() ?? computer;
        for (const spec of scopedComputer.specs(agent.permission === 'read-only'))
          this.add(
            spec,
            '电脑控制 · ' + spec.name,
            (args) => scopedComputer.execute(spec.name, args, this.signal),
            true,
            () => store.capabilities().computer,
          );
      }
      const skills = store.list<SkillRecord>('skill').filter((s) => s.enabled);
      if (skills.length)
        this.add(
          {
            name: 'read_skill_file',
            description: '按需读取启用的 Skill。先读 SKILL.md 获取使用说明，再读需要的附属文件。',
            parameters: {
              type: 'object',
              properties: {
                skillId: { type: 'string', enum: skills.map((s) => s.id) },
                path: { type: 'string' },
              },
              required: ['skillId', 'path'],
              additionalProperties: false,
            },
          },
          '读取 Skill 文件',
          async (args) => {
            const skill = skills.find((s) => s.id === args.skillId);
            if (!store.list<SkillRecord>('skill').find((s) => s.id === args.skillId)?.enabled)
              throw new Error('Skill 已停用');
            if (skill && args.path === 'SKILL.md') return { text: skill.instructions };
            if (!skill || typeof args.path !== 'string' || !Object.hasOwn(skill.files, args.path))
              throw new Error('Skill 文件不存在或未授权');
            return { text: skill.files[args.path] };
          },
          false,
        );
      if (this.specs.length > 128) throw new Error('当前 Agent 工具超过 128 个，请减少启用的插件');
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  private detach = () => {};
  has(name: string) {
    return this.handlers.has(name);
  }
  call(name: string, args: any, callId: string = randomUUID()): Promise<ToolOutput> {
    if (this.seen.has(callId)) return this.seen.get(callId)!;
    const pending = this.execute(name, args);
    this.seen.set(callId, pending);
    return pending;
  }
  private async execute(name: string, args: any): Promise<ToolOutput> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error('工具未启用或没有权限：' + name);
    if (!handler.allowed()) throw new Error('工具已停用或配置已改变，请在下一轮使用新配置');
    if (this.closed || this.signal.aborted) throw new Error('工具执行已停止');
    if (this.remaining-- <= 0) throw new Error('已达到本轮插件工具调用上限，请检查结果后再继续');
    let result: ToolOutput;
    try {
      if (!args || Array.isArray(args) || typeof args !== 'object')
        throw new Error('工具参数必须是对象');
      if (handler.approval && !(await this.ask(handler.title, JSON.stringify(args, null, 2))))
        throw new Error('用户未批准此操作，不能重试或绕过');
      this.signal.throwIfAborted();
      if (this.closed) throw new Error('工具执行已停止');
      if (!handler.allowed()) throw new Error('审批期间工具已停用或配置已改变');
      result = await handler.execute(args);
    } catch (error) {
      result = { text: redact(String(error)), isError: true };
    }
    this.record(name, args, result);
    return result;
  }
  private closing?: Promise<void>;
  close() {
    if (!this.closing) {
      this.closed = true;
      this.detach();
      this.closing = Promise.all(this.connections.map((c) => c.close())).then(() => {
        this.connections = [];
      });
    }
    return this.closing;
  }
}

export function skillInstructions(store: Store, agent: AgentProfile) {
  return store
    .list<SkillRecord>('skill')
    .filter((s) => s.enabled)
    .map(
      (s) =>
        `\n[可用 Skill：${s.name}；ID：${s.id}] ${s.description}\n任务相关时调用 read_skill_file 读取 SKILL.md，按需使用；不自动扩大工具权限。`,
    )
    .join('\n');
}
export async function importSkillDirectory(root: string): Promise<SkillRecord> {
  const instructions = await readFile(await within(root, 'SKILL.md'), 'utf8');
  if (instructions.length > 32000) throw new Error('SKILL.md 超过 32 KB 限制');
  const result: SkillRecord = {
    id: randomUUID(),
    name: path.basename(root),
    description: '',
    instructions,
    enabled: true,
    files: {},
  };
  const name = instructions.match(/^name:\s*["']?([^\r\n"']+)/m)?.[1];
  const description = instructions.match(/^description:\s*["']?([^\r\n"']+)/m)?.[1];
  if (name) result.name = name.slice(0, 100);
  if (description) result.description = description.slice(0, 500);
  let total = instructions.length;
  async function visit(relative: string, depth: number) {
    if (depth > 5) throw new Error('Skill 目录嵌套过深');
    for (const entry of await readdir(await within(root, relative), { withFileTypes: true })) {
      if (
        ['.git', 'node_modules', '.env', 'SKILL.md'].includes(entry.name) ||
        entry.name.startsWith('.env.')
      )
        continue;
      if (entry.isSymbolicLink()) throw new Error('Skill 不允许符号链接');
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(file, depth + 1);
        continue;
      }
      const full = await within(root, file);
      const info = await lstat(full);
      if (!info.isFile() || info.size > 500000) throw new Error('Skill 附属文件必须小于 500 KB');
      const text = await readFile(full, 'utf8');
      if (text.includes('\0') || text.includes('\ufffd')) continue;
      total += text.length;
      if (total > 2_000_000 || Object.keys(result.files).length >= 200)
        throw new Error('Skill 包过大');
      result.files[file.split(path.sep).join('/')] = text;
    }
  }
  await visit('', 0);
  return result;
}
