/** Built-in application modules with their own workspace and lifecycle. */
export const builtinApps = [
  {
    id: 'tongzhou-bots',
    name: '机器人',
    description: '连接微信 ClawBot、飞书、企业微信和钉钉，在聊天中查看进度并管理授权范围内的会话。',
    view: 'bots',
  },
] as const;
