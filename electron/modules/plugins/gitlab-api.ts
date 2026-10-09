import { z } from 'zod';
import type { PluginConfig, PluginTool, ToolOutput } from '../../../src/shared/types';
import { serviceFetch } from '../../services/network/service-network';
import { redact } from '../../services/storage/validation';
import { codeHost } from '../../../src/shared/code-hosting';

const pathSchema = z.string().min(1).max(2000);
const querySchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional();
const readSchema = z.object({ path: pathSchema, query: querySchema }).strict();
const writeSchema = readSchema.extend({
  method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
  body: z.record(z.string(), z.unknown()).optional(),
});
const paths =
  'projects, groups, issues, merge_requests, user, users, search, snippets, todos, version, metadata';
const properties = {
  path: {
    type: 'string',
    description: `GitLab API v4 relative path, for example projects or projects/123/issues. Allowed roots: ${paths}. Encode project/file paths with URL encoding. No URL or query string.`,
  },
  query: {
    type: 'object',
    description: 'Query parameters such as search, page, per_page, ref. Never supply credentials.',
    additionalProperties: { type: ['string', 'number', 'boolean'] },
  },
};
export const gitlabApiTools: PluginTool[] = [
  {
    name: 'gitlab_api_read',
    description:
      'Read the configured GitLab official REST API: projects, repositories, files, branches, commits, issues, merge requests, CI/CD pipelines/jobs/logs, wiki, releases and search. GET only; pagination returns nextPage. See https://docs.gitlab.com/api/.',
    inputSchema: { type: 'object', properties, required: ['path'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'gitlab_api_write',
    description:
      'Modify the configured GitLab official REST API: repository files/commits/branches, issues, merge requests/reviews, CI/CD pipelines/jobs, wiki and releases. Subject to session approval and token permissions. See https://docs.gitlab.com/api/.',
    inputSchema: {
      type: 'object',
      properties: {
        ...properties,
        method: { type: 'string', enum: ['POST', 'PUT', 'PATCH', 'DELETE'] },
        body: { type: 'object', additionalProperties: true },
      },
      required: ['path', 'method'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

/** Token mode uses GitLab's API authentication, not the MCP-only OAuth grant. */
export class GitlabApiConnection {
  private base: URL;
  private token: string;
  constructor(config: PluginConfig, secret: string) {
    if (codeHost(config) !== 'gitlab' || config.authMode !== 'headers')
      throw new Error('GitLab Token 连接配置无效');
    this.base = new URL(config.url.replace(/\/mcp\/?$/, '/'));
    const headers = new Headers(secret ? JSON.parse(secret) : {});
    this.token =
      headers.get('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] ??
      headers.get('PRIVATE-TOKEN') ??
      '';
    if (!this.token || /\s/.test(this.token)) throw new Error('请在插件中配置有效的 GitLab Token');
  }
  private target(path: string, query: Record<string, string | number | boolean> = {}) {
    let decoded = path;
    for (let i = 0; i < 3; i++) {
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        throw new Error('无效的 GitLab API 路径');
      }
    }
    if (
      /[\\\x00-\x1f?#]/.test(path) ||
      /[\\\x00-\x1f]/.test(decoded) ||
      decoded.split('/').some((s) => s === '.' || s === '..')
    )
      throw new Error('GitLab API 路径不能包含跳转或查询字符串');
    const relative = path.replace(/^\/(?!\/)/, '');
    if (!new Set(paths.split(', ')).has(relative.split('/')[0]))
      throw new Error('请使用 GitLab 仓库 API 的相对路径');
    if (
      /(?:^|\/)(?:access_tokens|personal_access_tokens|deploy_tokens|oauth)(?:\/|$)/i.test(decoded)
    )
      throw new Error('仓库工具不能读取或管理认证令牌');
    const url = new URL(relative, this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname))
      throw new Error('GitLab API 地址不匹配');
    for (const [key, value] of Object.entries(query)) {
      if (/(token|password|authorization|secret|sudo)/i.test(key))
        throw new Error('查询参数不能包含认证信息');
      url.searchParams.set(key, String(value));
    }
    return url;
  }
  private async request(
    path: string,
    query: Record<string, string | number | boolean> | undefined,
    method: string,
    body: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ) {
    const url = this.target(path, query);
    const payload = body ? JSON.stringify(body) : undefined;
    if (payload && payload.length > 256_000) throw new Error('GitLab 请求内容过大，请分批提交');
    let response: Response;
    try {
      response = await serviceFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
        },
        body: payload,
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      });
    } catch {
      signal.throwIfAborted();
      throw new Error('无法连接 GitLab，请检查实例地址、网络和代理');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        response.status === 401
          ? 'GitLab Token 已失效或无效，请更新认证'
          : response.status === 403
            ? 'GitLab Token 无权执行此操作，请检查 api/read_api 范围和项目权限'
            : `GitLab API 请求失败（HTTP ${response.status}）`,
      );
    }
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = '',
      bytes = 0;
    try {
      while (reader) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 2_000_000) throw new Error('GitLab 返回内容过大，请缩小查询或分页读取');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader?.cancel().catch(() => {});
    }
    return {
      text: redact(text, [this.token]),
      status: response.status,
      nextPage: response.headers.get('x-next-page') || undefined,
    };
  }
  async connect(signal: AbortSignal) {
    const result = await this.request('user', undefined, 'GET', undefined, signal);
    let identity;
    try {
      identity = JSON.parse(result.text);
    } catch {
      throw new Error('GitLab 账号身份校验失败');
    }
    if (
      !identity ||
      typeof identity !== 'object' ||
      !Number.isSafeInteger(identity.id) ||
      identity.id <= 0 ||
      typeof identity.username !== 'string' ||
      !/^[\w.-]{1,100}$/.test(identity.username)
    )
      throw new Error('GitLab 账号身份校验失败');
    const projects = await this.request(
      'projects',
      { membership: true, per_page: 1 },
      'GET',
      undefined,
      signal,
    );
    try {
      if (!Array.isArray(JSON.parse(projects.text))) throw new Error();
    } catch {
      throw new Error('GitLab 项目 API 校验失败，请检查实例地址');
    }
  }
  async call(name: string, args: unknown, signal: AbortSignal): Promise<ToolOutput> {
    if (!gitlabApiTools.some((t) => t.name === name)) throw new Error('未启用此 GitLab 工具');
    const parsed =
      name === 'gitlab_api_read'
        ? { ...readSchema.parse(args), method: 'GET' as const, body: undefined }
        : writeSchema.parse(args);
    const result = await this.request(
      parsed.path,
      parsed.query,
      parsed.method,
      parsed.body,
      signal,
    );
    return {
      text: `HTTP ${result.status}${result.nextPage ? ` · nextPage=${result.nextPage}` : ''}\n${result.text.slice(0, 59000)}${result.text.length > 59000 ? '\n[内容已截断，请分页读取]' : ''}`,
    };
  }
}
