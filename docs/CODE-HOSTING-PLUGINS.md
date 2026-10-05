# GitHub 与 GitLab 工作插件

同舟通过 MCP 提供代码托管工具，并通过同一个 ToolScope 将工具交给 API 模型、Codex 动态工具和 Kimi / MiniMax 的 ACP 工具桥。没有复制 Codex 桌面应用的专有连接器，也不读取其账号凭据。

## 配置

在「插件 → 工作插件」中配置 GitHub 或 GitLab，完成认证，点击「保存并检查」查看服务器实际返回的工具目录，并勾选「在会话中启用此插件」。同一服务可添加多个连接；自建 GitLab 可填写实例 HTTPS 地址。仅保存配置不代表已完成账号授权或实际连接验证。

- GitHub 使用官方远程端点 `https://api.githubcopilot.com/mcp/`，请求 `X-MCP-Toolsets: all`，包含官方可用的仓库、Issue、PR、Actions、发布、项目与安全等工具集。支持连接中心账号绑定、独立访问令牌、自行注册的 OAuth 应用。绑定账号在主进程中按需读取当前凭据；更新凭据、停用或移除账号会使已有运行的工具作用域失效，下轮使用新配置。旧版复制令牌的连接继续可用，重新选择「已保存的 GitHub 账号」后转为持续绑定。
- GitLab 使用实例的 `/api/v4/mcp` 端点，浏览器 OAuth 和 `mcp` scope，支持动态注册或预注册 OAuth Client ID。请求 `X-Gitlab-Enabled-Mcp-Server-Toolsets: all`；旧版实例可能忽略该头，仅提供该版本实现的目录。已有 GitLab Git/API 账号只可用于选择站点，不复制其令牌到 MCP。群组或实例必须允许 MCP 访问。

「完整」指发现并允许调用该官方服务器向当前账号提供的全部工具，不代表覆盖平台的每个 REST API、获得额外权限，或与 Codex 桌面专有 GitHub 连接器逐项相同。GitLab 各版本的工具和开启条件不同；Actions/CI、组织策略、订阅和账号权限由服务端执行限制。

## Agent 使用

1. 调用 `code_hosting_context` 查看当前项目的远程仓库、分支、账号绑定和启用的连接。支持 GitHub 路径、GitLab 子群组路径和 HTTPS / SSH remote；不返回凭据。
2. 调用对应插件的发现工具：`action=list`，可用 `query` 搜索名称与描述，使用 `offset`、`limit` 分页。英文关键词如 `workflow`、`pipeline`、`logs` 更容易匹配上游描述。
3. 用 `action=describe`、`tool` 获取完整参数 schema，再用 `action=call`、`tool`、`arguments` 执行。

目录在本轮首次使用时连接服务器并刷新，配置中缓存的目录只用于展示，不是执行授权。两家的完整目录及其他大型插件不会全部作为函数塞入模型上下文。服务器分页最多 200 页、2000 个工具；重复游标、重复工具名或超限明确报错，不静默丢弃。模型目录每页最多 20 条，工具参数单独读取。

调用沿用会话审批策略，并显示实际服务与工具名；发现和读取工具 schema 不触发写操作审批。只读 Agent 仅可使用用户显式允许的工具，或已识别的 GitHub / GitLab 官方端点标记为只读且非破坏性的工具。其他插件不自动信任只读标记。配置、认证或启用状态发生变化后，已运行的工具作用域拒绝继续调用。

## 验证范围

本地协议测试覆盖两家各 246 个工具、真实 MCP HTTP 分页、OAuth token 传递、完整工具集请求头、同舟 User-Agent、搜索和 schema 获取、通过原生工具桥调用、审批拒绝、只读过滤、账号更新与注销、凭据脱敏、重复游标及当前仓库上下文。GitLab 的 OAuth discovery / DCR / PKCE / 回调 scope 另由本地合成服务验证。

这些测试不代表已经完成用户的真实 GitLab 授权，也不运行真实 Actions、流水线、发布或仓库写入。实际连接验证以用户授权后的「检查工具」结果为准。

官方依据：

- [GitHub MCP 远程服务与完整工具集](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md)
- [GitHub MCP Host 接入与授权](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)
- [GitLab MCP、授权及工具集](https://docs.gitlab.com/user/model_context_protocol/mcp_server/)
- [GitLab 工具目录](https://docs.gitlab.com/user/model_context_protocol/mcp_server_tools/)
