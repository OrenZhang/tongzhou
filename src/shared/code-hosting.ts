import type { PluginConfig } from './types';

export const githubMcpUrl = 'https://api.githubcopilot.com/mcp/';
export const gitlabMcpUrl = 'https://gitlab.com/api/v4/mcp';
export type CodeHost = 'github' | 'gitlab';

/** Only recognized HTTP endpoints receive provider-specific configuration. */
export function codeHost(plugin: Pick<PluginConfig, 'transport' | 'url'>): CodeHost | undefined {
  if (plugin.transport !== 'http') return;
  try {
    const url = new URL(plugin.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return;
    if (url.origin === 'https://api.githubcopilot.com' && /^\/mcp\/?$/.test(url.pathname))
      return 'github';
    if (/\/api\/v4\/mcp\/?$/.test(url.pathname)) return 'gitlab';
  } catch {
    /* An unfinished address is not a provider endpoint. */
  }
}

export function codeHostHeaders(plugin: Pick<PluginConfig, 'transport' | 'url'>) {
  const provider = codeHost(plugin);
  return new Headers(
    provider === 'github'
      ? { 'X-MCP-Toolsets': 'all' }
      : provider === 'gitlab'
        ? { 'X-Gitlab-Enabled-Mcp-Server-Toolsets': 'all' }
        : {},
  );
}

export function codeHostDescription(provider: CodeHost) {
  return provider === 'github'
    ? 'GitHub：仓库、文件、提交、分支、Issue、PR、审查、Actions 工作流/任务/日志/产物/重跑、发布、项目与安全工具。实际能力以服务器目录和账号权限为准。'
    : 'GitLab：项目、仓库、文件、提交、分支、Issue/工作项、Merge Request、审查、CI/CD 流水线/任务/日志、Wiki 与安全工具。实际能力以实例版本、服务器目录和账号权限为准。';
}
