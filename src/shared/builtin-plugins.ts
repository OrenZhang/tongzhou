export const builtinPlugins = [
  {
    id: 'tongzhou-web',
    mode: 'web',
    name: '网页读取 · 内置',
    description: '读取网页正文，不执行网页脚本，不使用浏览器登录信息。',
    tools: ['fetch_page'],
  },
  {
    id: 'tongzhou-system',
    mode: 'system',
    name: '系统环境 · 内置',
    description: '查询当前时间、时区、操作系统、CPU、内存和基础运行环境。',
    tools: ['current_time', 'system_info'],
  },
] as const;
