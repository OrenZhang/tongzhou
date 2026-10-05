# 请求来源标识

同舟自身发起的 HTTP 请求统一使用 `User-Agent: Tongzhou/<应用版本>`，版本取自 `package.json`。英文产品名用于 HTTP 头，中文“同舟”用于界面显示。

- Node 请求使用 `electron/request-identity.ts` 的 `appFetch`；OAuth、远程 MCP、连接器等需要桌面网络会话的请求使用 `serviceFetch`。两者会覆盖 SDK 或调用方提供的 User-Agent，同时保留认证头、正文、取消信号和原有网络出口。
- 账号与网络配置的连通性探测使用相同的 User-Agent。网络订阅下载额外保留 `clash.meta` 标识，帮助订阅服务选择正确的配置格式。
- Codex、ACP 与 MCP 的初始化客户端信息统一使用 `tongzhou` 和同一应用版本。这是协议中的客户端信息，不等同于引擎自身的 HTTP User-Agent。

覆盖范围不包括第三方独立引擎、机器人 SDK 内部连接、外部插件进程、终端命令以及浏览器页面自身发起的请求。这些组件有各自的网络实现；不能通过同舟的 fetch 封装修改，也不全是 HTTP 协议。登录网页保留浏览器标识以维持兼容性。若网关仍显示 `OpenAI/JS`，需进一步确认请求是否来自上述组件。

User-Agent 只表示客户端声明的来源，不是身份认证凭据。认证方式及服务端要求的协议头保持原样。
