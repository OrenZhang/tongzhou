<p align="center"><img src="docs/assets/logo.svg" width="78" alt="同舟" /></p>
<h1 align="center">同舟 Tongzhou</h1>
<p align="center"><strong>多模型协作，一个工作台。</strong><br/>Windows · macOS · Local-first · Apache-2.0</p>
<p align="center"><a href="https://github.com/OrenZhang/tongzhou">源码</a> · <a href="https://github.com/OrenZhang/tongzhou/actions">构建</a> · <a href="https://github.com/OrenZhang/tongzhou/releases">版本发布</a> · <a href="https://github.com/OrenZhang/tongzhou/issues">问题反馈</a></p>

同舟是一个开源桌面 AI 工作台。你可以直接聊天，也可以打开项目让模型读代码、修改文件和运行测试。连接、模型、会话和工具在同一个工作空间管理，普通聊天无需选择项目或 Agent。

**0.5.5 开发预览版**：核心能力页补充使用示例、即时开关反馈、独立本机检测与失败重试；修正删除弹窗排版。聊天支持代码语法高亮、复制与换行、Mermaid 图表、数学公式及 GFM 排版，适配浅色/深色主题。GitHub 仓库工具优先保存或复用认证，自定义 OAuth 应用收进高级配置。工作树保持 Agent 内置能力，无独立配置入口。测试范围见 [验证记录](docs/VALIDATION.md)，工作台方案见 [补齐计划](docs/WORKBENCH_EXPANSION.md)。Mac 实机和第三方真人账号仍需分别验收。项目独立开发，不包含 Codex 桌面产品的专有插件。

## 功能

- **统一工作台界面**：紧凑导航和连接列表，清晰的正文、主要操作与状态层级；普通聊天使用完整阅读区，项目面板可收起。`Ctrl/⌘ K` 搜索会话与功能，`Ctrl/⌘ B` 切换导航；支持连接搜索、运行状态筛选、弹窗键盘操作与面板偏好记忆。设计依据及完整页面盘点见 [界面重构](docs/UI_REDESIGN.md)。
- **外观与输入**：石墨、雾蓝、暖砂三套内置风格，标志随风格换色；浅色、深色、跟随系统独立选择。现代黑体、系统字体、书籍宋体使用本机字体并自动回退，聊天字号可选 14 / 16 / 18，代码保持等宽。设置实时预览、重启记忆，支持恢复默认。草稿按会话保存；多项收件人、用户 ID 和启动参数可逐项添加、删除，支持多行粘贴。
- **聊天与连续会话**：空 Agent 默认状态，不自动启动规划；每轮通过“用时”展开按顺序分段的公开思考、阶段回复与工具过程；思考摘要直接展示，连续工具记录合并为紧凑折叠组，没有思考内容时显示实际工作状态，完成后收起过程并突出最终答复。运行中支持补充、排队下一轮、停止后继续，未消费消息可编辑、取消或恢复。支持历史引用、独立分支、归档、恢复和删除；侧栏会话标题悬停或键盘聚焦时显示操作图标，可直接管理其他会话，无需切换当前聊天。
- **模型与订阅**：ChatGPT 浏览器 / 设备授权、Kimi Code、MiniMax Code；OpenAI Chat Completions / Responses、Anthropic、Gemini 和无认证本地接口；OpenCode Go 订阅预设。模型从服务获取并可搜索选择，目录缺失时仍可自定义。
- **连接中心**：模型与订阅、服务与浏览器、渠道通知、机器人、认证与发送记录五个入口。认证界面只显示所选服务；同服务多账号隔离凭据和运行目录。
- **服务与浏览器**：GitHub 设备授权 / 访问令牌、GitLab OAuth PKCE / 访问令牌及自建域名；项目可绑定账号，克隆 HTTPS 仓库、快进拉取、推送当前分支提交。凭据按目标仓库在 Git 网络操作期间使用，不写入 remote 或 Git 配置；访问范围由仓库授权决定。独立浏览器 Profile 保存站点登录态，并可清理 Cookie 等数据。代码托管账号与 AI 模型订阅分别管理。
- **富文本回复**：CommonMark / GFM 标题、列表、表格、任务清单、脚注；带语言标签的代码语法高亮、复制原文、切换换行，未知语言保留源码。`mermaid` 代码块可绘制流程图、时序图、ER 图、类图、状态图、甘特图、饼图、思维导图等，支持源码、缩放和展开；`$...<p align="center"><img src="docs/assets/logo.svg" width="78" alt="同舟" /></p>
<h1 align="center">同舟 Tongzhou</h1>
<p align="center"><strong>多模型协作，一个工作台。</strong><br/>Windows · macOS · Local-first · Apache-2.0</p>
<p align="center"><a href="https://github.com/OrenZhang/tongzhou">源码</a> · <a href="https://github.com/OrenZhang/tongzhou/actions">构建</a> · <a href="https://github.com/OrenZhang/tongzhou/releases">版本发布</a> · <a href="https://github.com/OrenZhang/tongzhou/issues">问题反馈</a></p>

同舟是一个开源桌面 AI 工作台。你可以直接聊天，也可以打开项目让模型读代码、修改文件和运行测试。连接、模型、会话和工具在同一个工作空间管理，普通聊天无需选择项目或 Agent。

**0.5.4 开发预览版**：聊天支持代码语法高亮、复制与换行、Mermaid 图表、数学公式及 GFM 排版，适配浅色/深色主题。GitHub 仓库工具优先保存或复用认证，自定义 OAuth 应用收进高级配置。工作树保持 Agent 内置能力，无独立配置入口。测试范围见 [验证记录](docs/VALIDATION.md)，工作台方案见 [补齐计划](docs/WORKBENCH_EXPANSION.md)。Mac 实机和第三方真人账号仍需分别验收。项目独立开发，不包含 Codex 桌面产品的专有插件。

## 功能

- **统一工作台界面**：紧凑导航和连接列表，清晰的正文、主要操作与状态层级；普通聊天使用完整阅读区，项目面板可收起。`Ctrl/⌘ K` 搜索会话与功能，`Ctrl/⌘ B` 切换导航；支持连接搜索、运行状态筛选、弹窗键盘操作与面板偏好记忆。设计依据及完整页面盘点见 [界面重构](docs/UI_REDESIGN.md)。
- **外观与输入**：石墨、雾蓝、暖砂三套内置风格，标志随风格换色；浅色、深色、跟随系统独立选择。现代黑体、系统字体、书籍宋体使用本机字体并自动回退，聊天字号可选 14 / 16 / 18，代码保持等宽。设置实时预览、重启记忆，支持恢复默认。草稿按会话保存；多项收件人、用户 ID 和启动参数可逐项添加、删除，支持多行粘贴。
- **聊天与连续会话**：空 Agent 默认状态，不自动启动规划；每轮通过“用时”展开按顺序分段的公开思考、阶段回复与工具过程；思考摘要直接展示，连续工具记录合并为紧凑折叠组，没有思考内容时显示实际工作状态，完成后收起过程并突出最终答复。运行中支持补充、排队下一轮、停止后继续，未消费消息可编辑、取消或恢复。支持历史引用、独立分支、归档、恢复和删除；侧栏会话标题悬停或键盘聚焦时显示操作图标，可直接管理其他会话，无需切换当前聊天。
- **模型与订阅**：ChatGPT 浏览器 / 设备授权、Kimi Code、MiniMax Code；OpenAI Chat Completions / Responses、Anthropic、Gemini 和无认证本地接口；OpenCode Go 订阅预设。模型从服务获取并可搜索选择，目录缺失时仍可自定义。
- **连接中心**：模型与订阅、服务与浏览器、渠道通知、机器人、认证与发送记录五个入口。认证界面只显示所选服务；同服务多账号隔离凭据和运行目录。
- **服务与浏览器**：GitHub 设备授权 / 访问令牌、GitLab OAuth PKCE / 访问令牌及自建域名；项目可绑定账号，克隆 HTTPS 仓库、快进拉取、推送当前分支提交。凭据按目标仓库在 Git 网络操作期间使用，不写入 remote 或 Git 配置；访问范围由仓库授权决定。独立浏览器 Profile 保存站点登录态，并可清理 Cookie 等数据。代码托管账号与 AI 模型订阅分别管理。
  / `$...$` 渲染数学公式。资源随应用打包，本地渲染，外部图片显示点击链接。超大代码仅跳过高亮，不截断内容；图表渲染失败时保留源码。
- **工作插件**：GitHub、Figma、Notion、Linear 官方 MCP 目录，搜索、配置、启停和工具发现；支持令牌、请求头及浏览器 OAuth。授权使用 PKCE、state 和本机回调，令牌加密保存与刷新。GitHub 官方账号凭据可主动用于 GitHub 官方 MCP；切换插件地址或认证身份会清理旧凭据。

工作插件入口：**插件与工具 → 工作插件**。GitHub 默认提供已保存账号与访问令牌；复用会复制账号凭据，账号更新认证后需重新保存以同步。高级浏览器 OAuth 才需要开发者自己的 OAuth App Client ID 与 Client Secret。保存凭据与实际连接成功分别显示。Figma 远程 MCP 仅接受服务方认可的客户端，本地实测新客户端注册返回 HTTP 403，未声称同舟已取得远程接入资格；可配置已获准应用，或在 Figma 桌面应用启用 MCP 后选择“桌面服务”。参见 [GitHub 接入要求](https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md)、[Figma 远程接入](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/) 和 [Figma 桌面接入](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/)。

- **公共插件**：MCP stdio / Streamable HTTP、Skills、内置网页读取与时间工具、客户端管理、项目工具、电脑控制。全局启停，所有会话和 Agent 继承；按需加载目录与连接，不逐个 Agent 重复勾选。
- **会话管理客户端**：可以问“有哪些 MCP / Agent”，或要求修改角色、会话、插件开关、连接、渠道规则等。会话工具与界面使用相同的业务接口；修改展示实际操作与参数供批准，凭据只在认证界面输入。
- **项目开发**：搜索、按行读取、版本哈希、精确替换、审批后写文件和运行命令；实时命令输出、退出码、超时和取消；Git diff 与运行前工作区状态；初始化 `agent.md`，已有说明不覆盖。
- **内置 Git 能力**：Agent 可查询、创建和清理 Git 工作树，也可用已授权账号克隆、拉取和推送代码，无独立工作树页面或自定义配置。隔离工作目录中的会话归入原项目，保留实际目录绑定及标记。仅可移除同舟管理且无本地文件、未推送提交、活动任务或子模块的工作树；保留分支与归档会话。外部工作树仅查看。
- **电脑控制**：Windows / macOS 窗口发现、截图、点击、输入、快捷键、滚动、拖动；一次截图对应一次操作，逐次审批。提供系统权限检查和本机测试窗口自检。
- **渠道通知**：飞书应用 / Webhook、企业微信 / 钉钉 Webhook、SMTP 邮件。会话标题栏可开启本轮或下一轮结束提醒；规则支持轮次结束、完成、失败、停止、待批准，一次性或持续，以及会话、项目、模型、耗时条件。SMTP 支持 TLS / STARTTLS、多个收件人与不发信的连接验证。
- **会话机器人**：独立于通知目标，使用飞书长连接、企业微信智能机器人、钉钉 Stream 接收命令。允许名单内用户可查询会话和进度；按需开放新建、继续、停止、重命名和归档。用户、群和会话范围分开控制，消息去重，发送人之间的当前会话隔离。旧飞书入站配置迁入机器人模块并保留原范围。
- **本地保存**：SQLite 保存消息与配置，系统安全存储加密凭据。迁移自动备份，重启不重放工具或发送结果不明的通知。新连接默认不设本地历史上限，也可开启自动整理：保留当前请求、配对的工具调用与来源摘录，界面分页加载完整原始历史。

最多 3 个自定义 Agent 可并行只读分析；多 Agent 同时写项目、原始 Cookie 导入、全天候渠道中继和签名自动更新是后续扩展。完整范围和待验项见 [实施状态](docs/IMPLEMENTATION_STATUS.md)。

## 本地开发

需要 Node.js **22.19+ 的 22 LTS 系列**、npm、Git。macOS 构建需要 Xcode Command Line Tools。

```bash
git clone https://github.com/OrenZhang/tongzhou.git
cd tongzhou
npm ci
npm run dev
```

```bash
npm run build
npm start
```

内置引擎固定为 Codex 0.160.0、Kimi Code 2.1.1、MiniMax Code 0.4.12，携带 Node 22.23.3。首次安装依赖会下载当前系统的 Electron、CLI 和搜索工具；正式安装包无需另装这些运行时。终端中的项目依赖仍由具体项目决定。

为开发使用独立数据目录：

```powershell
$env:TONGZHOU_USER_DATA = Join-Path $PWD 'work/tongzhou-dev-profile'
npm run dev
```

```bash
TONGZHOU_USER_DATA="$PWD/work/tongzhou-dev-profile" npm run dev
```

默认数据目录由 Electron 管理。`work/`、`test-results/`、`.test-data/`、数据库、迁移备份、缓存、日志和本地配置已忽略；真实密钥、Cookie、账号导出和私人对话不应提交到 Git。

## 开始使用

1. 在 **连接中心 → 模型与订阅** 添加服务，保存连接并获取模型。自定义地址填写协议根路径，例如 `https://api.example.com/v1`。真实推理测试会调用所选模型，可能计费。
2. 使用账号订阅时，从对应卡片进入管理和认证。成功标志以引擎验证出的账号为准；模型目录不等于模型权益验证。浏览器 / 设备授权失败时，可以查看错误、取消并重新授权。
3. 选择连接与模型后直接聊天；需要操作代码时再打开项目。Agent 页面初始为空，可主动创建专用角色，也可一直不选。
4. 在 **插件与工具** 开启所需能力。电脑控制先检查权限并运行本机自检；macOS 需要屏幕录制和辅助功能权限。截图仅在模型调用相关工具并经批准后交给该模型服务。
5. 执行过程中可继续输入补充要求。Codex 使用活动轮次 steer；直接 API 在安全点应用；不支持即时注入的 ACP 会明确排到下一轮。切换模型影响下一轮，已有会话继续保留。
6. 在 **渠道通知** 配置目标和规则。聊天中可要求“本轮完成后通过飞书通知我”，或指定渠道与消息主动发送；外发操作需要明确的内容和目标。客户端退出或休眠时，本机渠道服务不能持续运行。
7. 在 **机器人** 配置应用凭据、允许用户和会话范围，保存后按需启用。私聊支持 `/sessions`、`/status`、`/use ID`；开启会话操作后可用 `/new 标题`、`/run 任务`、`/stop`、`/rename 标题`、`/archive`。群消息还需群 ID 允许名单；工具批准仍在本机处理。
8. 在 **设置与关于 → 外观与字体** 选择风格、明暗、字体和聊天字号。需要隔离代码任务时，在项目会话中让 Agent 创建 Git 工作树即可；无需配置独立模块。新工作树不会复制原项目未提交文件，也不执行项目初始化脚本。

直接 API 报告输出上限时，可在 **连接中心 → 编辑该连接 → 单次最大输出 Tokens** 查看本次请求预算。部分服务将思考计入预算，服务或网关也可能另设上限。已收到的正文和此前完成的操作保留；本次被截断的工具调用不会执行。调整需符合服务实际支持的范围，不会自动无限增加预算或重放工具。

**历史上下文** 可选择“不设本地上限”（`contextChars: 0`）或“自动整理历史”。前者发送完整文字历史，后者按字符阈值整理较早消息及长工具记录；不会因当前轮次超过阈值而直接终止，也不会删除本地原文。模型服务的真实上下文容量、单次输出限制仍然适用。已有连接保留原设置，可在连接编辑页切换；客户端查询工具 `readMessage` 可按来源 ID 分段读取原文。

GitHub 设备授权需要自己的 OAuth App Client ID 并启用设备流程。GitLab OAuth 使用公共应用 Client ID，注册回调为 `http://127.0.0.1:17437/connector/callback`。不嵌入共享应用密钥。GitLab 刷新令牌只在主进程加密保存。

**授权范围**：飞书实现官方扫码注册流程；企业微信机器人需 Bot ID / Secret，钉钉需启用 Stream 的应用凭据。MCP 服务支持动态注册时可直接浏览器授权；否则需要该服务的公共 OAuth Client ID、Issuer 和回调 `http://127.0.0.1:17438/mcp/callback`，或使用访问令牌。扫码企业登录不会自动赋予机器人权限，平台账号、管理员策略和模型订阅权益分别生效。

## 测试与打包

```bash
npm test
npm run typecheck
npm run build
npm run test:desktop
npm run test:auth
npm run test:extensions
npm run test:bridge
npm run test:workflows
npm run test:turns
npm run test:ui
npm run test:workbench
npm run test:native
npm run dist:win
# 在 macOS 上执行
npm run dist:mac
```

测试使用独立应用目录与合成数据。真实模型和本机电脑操作另有显式测试开关，运行条件见 [验证记录](docs/VALIDATION.md)。安装产物在 `release/`；GitHub CI 构建结果与公开 Release 是不同状态，以实际页面为准。默认产物未配置维护者签名 / macOS 公证。

## 数据与权限

每次运行固定账号、模型和权限。模型切换交接公开历史与工具结果，不转移其他账号凭据、浏览器登录态或供应商专有推理签名。Codex 使用自身沙箱；同舟文件工具检查项目路径、文件版本和审批，已批准的终端命令仍具有当前系统用户权限。

旧版升级到 schema 2 前生成一致 SQLite 备份，只移除未修改的内置角色，保留自定义角色及历史。回退应恢复匹配版本的备份；旧程序拒绝写入新 schema。删除会话清理消息、运行、队列、内部子会话和同舟私有工作目录，不删除项目源文件或共享账号。

## 维护

[架构](docs/ARCHITECTURE.md) · [开发计划](docs/DEVELOPMENT_PLAN.md) · [实施状态](docs/IMPLEMENTATION_STATUS.md) · [验证记录](docs/VALIDATION.md) · [贡献指南](CONTRIBUTING.md) · [发布流程](docs/RELEASING.md) · [安全反馈](SECURITY.md)

源码采用 [Apache-2.0](LICENSE)。第三方组件保留各自许可证，见 [NOTICE](NOTICE)。
