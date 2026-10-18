export const vendorPlugins = [
  {
    id: 'minimax-multimedia',
    name: 'MiniMax 多媒体',
    description:
      '支持复用 MiniMax 套餐账号生成图片、语音和视频，也可使用 API Key 连接官方多媒体 MCP。工具与额度取决于认证方式和套餐。',
    package: 'minimax-mcp',
    version: '0.0.19',
    docs: 'https://github.com/MiniMax-AI/MiniMax-MCP',
    tools: [],
  },
  {
    id: 'minimax-coding',
    name: 'MiniMax 搜索与图片理解',
    description:
      '联网搜索和图片理解。优先复用CoSail已登录的 MiniMax 套餐账号，也可配置 Coding Plan API Key 使用官方 MCP。',
    package: 'minimax-coding-plan-mcp',
    version: '0.0.5',
    docs: 'https://github.com/MiniMax-AI/MiniMax-Coding-Plan-MCP',
    tools: ['web_search', 'understand_image'],
  },
  {
    id: 'tongzhou-kimi-web',
    name: 'Kimi 搜索与网页读取',
    description:
      'CoSail适配器：接入 Kimi Code 搜索和网页读取。优先复用CoSail已登录的 Kimi 套餐账号，也支持 API Key。',
    docs: 'https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html',
    tools: ['web_search', 'fetch_page'],
  },
] as const;
export type VendorPlugin = (typeof vendorPlugins)[number];
export const vendorPlugin = (id: string) => vendorPlugins.find((p) => p.id === id);
export const pluginStartupTimeout = (id: string) => {
  const preset = vendorPlugin(id);
  return preset && 'package' in preset ? 180000 : 20000;
};
