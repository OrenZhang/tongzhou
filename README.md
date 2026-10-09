<p align="center"><img src="docs/assets/logo.svg" width="78" alt="同舟" /></p>
<h1 align="center">同舟 Tongzhou</h1>
<p align="center"><strong>整合模型、知识与会话，一个本地工作台。</strong><br/>Windows · macOS · 开源 · 本地优先</p>
<p align="center"><a href="https://github.com/OrenZhang/tongzhou/releases">版本发布</a> · <a href="https://github.com/OrenZhang/tongzhou/issues">问题反馈</a> · <a href="CONTRIBUTING.md">参与贡献</a></p>

同舟是一个开源、本地优先的 AI 工作台，整合模型服务与订阅、本地知识库、连续会话和远程消息入口，覆盖日常问答、资料整理、内容创作和项目开发。

你可以在同一个会话中切换模型、继续任务，把值得保留的资料和经验沉淀到自己的智库，再通过飞书、企业微信等入口查看和管理会话。

## 整合的目标

- **自己的知识，自己维护**：无需安装 Obsidian 等笔记应用，在同舟内管理资料、笔记、整理文档与会话记忆。Agent 按需检索、提炼和补充知识，保留来源与版本，供你核对、修正和复用。
- **不同模型，同一份会话**：集中接入已适配的模型 API、订阅套餐与本地模型服务，在同一个会话里选择模型和账号，接续已有上下文与任务。
- **多个入口，同一个工作台**：桌面端与飞书、企业微信等机器人连接本地会话，在授权范围内查看进度、继续任务和接收通知。

整合围绕可持续使用的会话和知识展开：模型可以更换，任务与资料继续积累；新增服务通过适配接入，沿用同舟的权限和管理流程。

## 核心能力

- **多模型接入与切换**：支持 ChatGPT、Kimi Code、MiniMax Code 账号接入，以及 OpenAI 兼容接口、Anthropic、Gemini 和本地模型服务；同一会话可切换模型，保留历史继续任务。
- **本地智库与知识沉淀**：统一管理文档、笔记、知识与记忆，支持目录、双向链接、实体关系、来源核对和修订历史；Agent 按需检索和整理，后台从已完成会话中提炼值得保留的经验。
- **远程会话管理**：飞书、企业微信和钉钉机器人适配会话列表、进度查询、会话选择、新建、继续、停止、重命名与归档；通知可通过这些平台和邮件发送。
- **连续会话**：支持中途补充、停止后继续、图片与文件附件、长文本转文件和历史上下文整理。
- **项目开发**：文件搜索、代码预览、Git 变更审阅、命令执行与项目说明维护，文件和代码位置可直接引用到会话。
- **Agent 与插件**：自定义 Agent、并行分析，接入 MCP 和 Skills；按需启用浏览器、电脑控制和客户端管理能力。
- **本地数据与管理**：会话、知识和配置保存在本地，凭据加密存储；支持备份恢复、权限设置、浅色/深色主题及字体调整。

## 当前范围

目前处于开发预览阶段。上述能力已有实现，不同平台、模型和第三方服务仍需分别验证，详见 [实施状态](docs/IMPLEMENTATION_STATUS.md) 与 [验证记录](docs/VALIDATION.md)。

- **模型与订阅**：按服务商提供的接口、授权方式和账号权益接入，不保证任意订阅套餐都可直接调用。切换模型在后续轮次生效，当前运行中的任务使用本轮已确定的模型和账号。
- **知识与模型调用**：知识保存在本地，Agent 生成的知识与记忆保留待核对状态；使用云端模型时，用于任务的消息和检索内容会发送给相应模型服务。
- **远程管理**：需要本地客户端在线、网络可用，并配置机器人身份与会话范围。当前远程命令尚不提供模型选择或工具审批入口；需要选择模型或批准操作时回到桌面端。客户端退出或电脑休眠后，不提供全天候中继。

## 快速开始

准备 Node.js **22.19+（22 LTS）**、npm 和 Git，然后运行：

```bash
git clone https://github.com/OrenZhang/tongzhou.git
cd tongzhou
npm ci
npm run dev
```

启动后：

1. 在 **设置 → 模型** 中添加模型连接或登录已适配的订阅账号，在会话中选择模型开始聊天。
2. 在 **智库** 中导入资料或新建笔记，按需让 Agent 整理、检索和沉淀知识。
3. 在 **设置 → 连接中心** 中配置服务账号、通知和机器人，选择允许访问的用户与会话范围。
4. 在 **插件** 中启用所需的 MCP、Skills、浏览器或电脑控制能力；需要开发代码时打开项目。

GitHub 和 GitLab 的认证统一在 **插件 → 内置插件** 管理，选择 **Token 配置** 或 **OAuth2 授权**。连接中心只管理独立浏览器登录、渠道通知、机器人和网络，不再提供 GitHub/GitLab 账号配置入口；已有账号数据保留，可在插件的 Token 来源中复用。

- **GitHub**：Token 和 OAuth2 均使用官方远程 MCP。OAuth2 点击 **使用 GitHub 登录**，在 GitHub 官方页面输入界面显示的验证码并授权；普通用户无需配置 Client ID/Client Secret。应用身份由同舟维护者在构建时配置，支持授权保存、令牌刷新和退出；维护者配置见 [GitHub 登录](docs/GITHUB_LOGIN.md)。可点击 **检测本地账号** 识别 Git 凭据或 GitHub CLI 当前登录，再点击 **使用并启用**。同舟重新验证身份及 MCP 连接后加密保存，检测结果仅展示账号和来源；手动 Token 的 **保存并检查** 同样验证账号和工具连接。
- **GitLab**：填写 GitLab.com 或自建实例 HTTPS 根地址。Token 模式使用官方 REST API，无需开启 MCP；**保存并检查** 验证身份与项目 API，读取通常需要 `read_api`，写操作需要 `api`，并受项目权限限制。会话通过 `gitlab_api_read` / `gitlab_api_write` 调用实例上的项目、仓库、Issue、Merge Request 和 CI/CD API，写操作遵循会话权限。OAuth2 点击 **使用 GitLab 登录**，在所填实例的官方页面登录授权，授权加密保存在本机，普通用户无需填写 Client ID / Client Secret。此方式通过官方 MCP 自动注册 OAuth 应用，要求实例支持并开启 MCP 和应用自动注册；管理员关闭自动注册或实例不支持时，可改用 Token 配置。插件卡片与 Token 配置弹窗均支持本地 Git / glab 检测，**使用并配置** 保存 Token 账号；切换地址清除旧检测结果，不将普通 Token 当成 MCP OAuth 授权。

认证依据：[GitHub 官方 MCP 接入](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md) · [GitLab REST API 认证](https://docs.gitlab.com/api/rest/authentication/) · [GitLab 官方 MCP](https://docs.gitlab.com/user/model_context_protocol/mcp_server/)。仅保存凭据会显示待检查，通过连接检查后才显示已验证。

智库的使用流程、来源核对与本地数据说明见 [本地智库与每日记忆](docs/KNOWLEDGE-CENTER.md)。

## 开发架构

客户端使用 Electron + React + TypeScript，主进程通过 Cordis 组合内置服务和功能插件，统一依赖注入、接口注册与生命周期。任务执行由 Codex 核心与同舟模型适配层协作，本地资料使用 SQLite 保存。新增功能按领域注册，资源随模块释放；详细边界见 [架构设计](docs/ARCHITECTURE.md) 和 [代码目录](docs/CODE_STRUCTURE.md)。

## 了解更多

[贡献指南](CONTRIBUTING.md) · [架构设计](docs/ARCHITECTURE.md) · [代码目录](docs/CODE_STRUCTURE.md) · [发布流程](docs/RELEASING.md) · [实际开发示例](examples/miniapp-admin/README.md)

欢迎通过 [Issues](https://github.com/OrenZhang/tongzhou/issues) 提交问题和建议，也欢迎贡献代码。

采用 [Apache-2.0](LICENSE) 许可证。第三方组件说明见 [NOTICE](NOTICE)。
