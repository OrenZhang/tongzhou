<p align="center"><img src="docs/assets/logo.svg" width="78" alt="同舟" /></p>
<h1 align="center">同舟 Tongzhou</h1>
<p align="center"><strong>多模型协作，一个工作台。</strong><br/>Windows · macOS · Local-first · Apache-2.0</p>
<p align="center"><a href="https://github.com/OrenZhang/tongzhou">源码</a> · <a href="https://github.com/OrenZhang/tongzhou/actions">构建</a> · <a href="https://github.com/OrenZhang/tongzhou/releases">版本发布</a> · <a href="https://github.com/OrenZhang/tongzhou/issues">问题反馈</a></p>

同舟是一个开源桌面 AI 工作台。你可以直接聊天，也可以打开项目让模型读代码、修改文件和运行测试。连接、模型、会话和工具在同一个工作空间管理，普通聊天无需选择项目或 Agent。

**0.4.0 开发预览版**：本轮集中实现自然聊天、运行中补充、统一插件、连接中心、渠道通知与项目工具。Windows 本地验证和真实 Kimi 项目测试见 [验证记录](docs/VALIDATION.md)。macOS、其他账号和渠道真实授权有独立待验项，不能从模拟测试推断全部服务已通过。项目独立开发，不包含 Codex 桌面产品的专有插件。

## 功能

- **聊天与连续会话**：空 Agent 默认状态，不自动启动规划；显示等待、公开思考摘要、工具过程和停止状态。运行中支持补充、排队下一轮、停止后继续，未消费消息可编辑、取消或恢复。支持历史引用、独立分支、归档、恢复和删除。
- **模型与订阅**：ChatGPT 浏览器 / 设备授权、Kimi Code、MiniMax Code；OpenAI Chat Completions / Responses、Anthropic、Gemini 和无认证本地接口；OpenCode Go 订阅预设。模型从服务获取并可搜索选择，目录缺失时仍可自定义。
- **连接中心**：模型与订阅、服务与浏览器、渠道通知、认证与发送记录四个入口。认证界面只显示所选服务；同服务多账号隔离凭据和运行目录。
- **服务与浏览器**：GitHub 设备授权 / 访问令牌、GitLab OAuth PKCE / 访问令牌及自建域名；独立浏览器 Profile 保存站点登录态，并可清理 Cookie 等数据。服务授权不代表自动获得 AI 订阅权益或本地 Git 推送权限。
- **公共插件**：MCP stdio / Streamable HTTP、Skills、内置网页读取与时间工具、客户端管理、项目工具、电脑控制。全局启停，所有会话和 Agent 继承；按需加载目录与连接，不逐个 Agent 重复勾选。
- **会话管理客户端**：可以问“有哪些 MCP / Agent”，或要求修改角色、会话、插件开关、连接、渠道规则等。会话工具与界面使用相同的业务接口；修改展示实际操作与参数供批准，凭据只在认证界面输入。
- **项目开发**：搜索、按行读取、版本哈希、精确替换、审批后写文件和运行命令；实时命令输出、退出码、超时和取消；Git diff 与运行前工作区状态；初始化 `agent.md`，已有说明不覆盖。
- **电脑控制**：Windows / macOS 窗口发现、截图、点击、输入、快捷键、滚动、拖动；一次截图对应一次操作，逐次审批。提供系统权限检查和本机测试窗口自检。
- **渠道**：飞书扫码创建应用连接、应用凭据和长连接入站；飞书 / 企业微信 / 钉钉 Webhook 通知。支持全局或指定会话规则、成功 / 失败 / 待审批事件、一次性或持续通知、主动发送及启停。飞书入站要求明确绑定会话和发送人。
- **本地保存**：SQLite 保存消息与配置，系统安全存储加密凭据。迁移自动备份，重启不重放工具或发送结果不明的通知。长对话保留来源摘录与最近完整轮次，界面分页加载原始历史。

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

GitHub 设备授权需要自己的 OAuth App Client ID 并启用设备流程。GitLab OAuth 使用公共应用 Client ID，注册回调为 `http://127.0.0.1:17437/connector/callback`。不嵌入共享应用密钥。GitLab 刷新令牌只在主进程加密保存。

**扫码范围**：飞书实现官方注册流程；企业微信和钉钉当前提供正式 Webhook 接入。扫码企业登录并不自动创建可发消息的机器人，同舟没有把它们标成通用“一扫即连”。平台侧账号、管理员策略及消息权限仍需实际验证。

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
