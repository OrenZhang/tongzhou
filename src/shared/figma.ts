import type { PluginConfig, PluginInput } from './types';

export const figmaRemoteUrl = 'https://mcp.figma.com/mcp';
export const figmaDesktopUrl = 'http://127.0.0.1:3845/mcp';
export const figmaDocsUrl =
  'https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/';
export const figmaToolsUrl =
  'https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/';
export const figmaAccessMessage =
  'CoSail已申请全部读写工具接入，尚未获批。Figma 当前暂停新增远程 MCP 客户端；注册 REST OAuth 应用不代表获得 MCP 接入资格。可使用桌面 MCP 读取设计上下文，FigJam 图表生成需要远程服务。';

export function figmaConnection(config: Pick<PluginConfig, 'transport' | 'url'>) {
  if (config.transport !== 'http') return;
  const url = config.url.replace(/\/$/, '');
  return url === figmaRemoteUrl ? 'remote' : url === figmaDesktopUrl ? 'desktop' : undefined;
}

/** Official Figma connections use a client managed by CoSail, not a user's REST OAuth app. */
export function configureFigmaPlugin(input: PluginInput): PluginInput {
  const mode = figmaConnection(input);
  return mode
    ? {
        ...input,
        url: mode === 'remote' ? figmaRemoteUrl : figmaDesktopUrl,
        authMode: mode === 'remote' ? 'oauth' : 'headers',
        oauthClientId: undefined,
        oauthIssuer: undefined,
        oauthClientSecret: '',
        connectorId: undefined,
        secret: undefined,
      }
    : input;
}

// Official write tools must never become available in a read-only session via a local override.
export const figmaWriteTools = new Set([
  'add_code_connect_map',
  'create_generative_plugin',
  'create_new_file',
  'create_shader',
  'generate_diagram',
  'generate_figma_design',
  'generate_image',
  'send_code_connect_mappings',
  'update_generative_plugin',
  'update_shader',
  'upload_assets',
  'use_figma',
]);
