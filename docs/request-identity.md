# 请求来源标识

`electron/services/network/request-identity.ts` 是唯一的应用请求身份定义：客户端名称 `tongzhou`，显示名称“同舟 Tongzhou”，HTTP 标识 `Tongzhou/<应用版本>`。版本自动取自 `package.json`，各模块不再各自定义品牌或版本。

## 接入位置

- 普通模型 API、模型列表、OAuth、远程 MCP、连接器和内置工具使用 `appFetch` 或 `serviceFetch`。
- 主进程在加载 SDK 前安装 `node-request-identity.ts`，统一 Node `fetch`、`http.request/get`、`https.request/get` 的请求头，包括机器人 SDK 内部的 HTTP 请求与 WebSocket 握手。
- Kimi 和 MiniMax 使用同一个启动模块，通过 Node 的 `--require` 在引擎加载前安装。它会覆盖引擎内 OpenAI 等 SDK 默认的 User-Agent，保留认证头、正文、取消信号和代理设置。不修改引擎包或用户的服务商配置，也不通过 `NODE_OPTIONS` 污染项目子进程。
- Codex 通过 `model_providers.<id>.http_headers` 设置同一 User-Agent，同时使用统一的初始化 `clientInfo`。该配置同时应用于 HTTP 和 WebSocket 模型通道。[OpenAI 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)；[app-server 客户端身份说明](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)。
- 内置浏览器及授权窗口保留 Chromium 的兼容性字段，并附加同一 `Tongzhou/<应用版本>` 产品标识。应用服务请求仍使用简洁的 `Tongzhou/<应用版本>`。
- 网络订阅下载额外保留 `clash.meta` 标识，帮助订阅服务选择正确的配置格式。

范围是同舟及其受管网络入口。用户项目的终端命令、任意第三方插件进程、系统默认浏览器仍属于独立程序，不强制改写它们的网络行为。邮件 SMTP 和 WebSocket 消息帧等非 HTTP 数据没有 User-Agent 字段。

## 验证与生效

`request-identity-smoke.mjs` 检查 Electron 服务请求，`node-identity-smoke.mjs` 检查真实 Node 进程的 fetch/HTTP 请求及子进程隔离，`kimi-identity-smoke.mjs` 和 `codex-identity-smoke.mjs` 启动真实内置引擎，将模型请求发送到本地测试服务检查请求头。测试不使用用户凭据，也不执行付费模型推理。

修改后必须重新构建并重启同舟，使主进程和内置引擎加载新入口。历史请求记录不会改变。User-Agent 是客户端声明的来源，不是身份认证凭据。
