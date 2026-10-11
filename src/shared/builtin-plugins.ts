export const builtinPlugins = [
  {
    id: 'tongzhou-web',
    mode: 'web',
    name: '网页搜索与读取 · 内置',
    description:
      '默认提供关键词搜索和网页正文读取，无需账号或 API Key。不执行网页脚本，不使用浏览器登录信息。',
    tools: ['web_search', 'fetch_page'],
  },
] as const;
