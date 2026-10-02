<p align="center"><img src="docs/assets/logo.svg" width="78" alt="同舟" /></p>
<h1 align="center">同舟 Tongzhou</h1>
<p align="center"><strong>多模型协作，一个工作台。</strong><br/>One workspace. Many models.</p>
<p align="center">Windows · macOS · Local-first · Apache-2.0</p>

同舟是一个开源桌面 AI 编程工作台。通过 Codex 开源内核接入 ChatGPT，通过原生 API 适配器接入其他模型，在一个项目和连续会话中分析、编写、验证代码。

**当前版本：0.1.0。** 这是可运行的首个版本，功能与边界见下方。独立项目，与 OpenAI、CC Switch 无官方从属关系。

![同舟工作空间](docs/assets/workspace.png)

## 已实现

- **多模型接入**：OpenAI Chat Completions、Responses、Anthropic Messages、Gemini 流式 API；支持自定义 URL、API Key、Bearer Token 和无认证的本地服务。
- **Codex 原生执行**：内置固定版本 Codex CLI，通过 App Server 调用官方 ChatGPT 登录、文件操作、终端、沙箱和审批。使用同舟独立的配置目录。
- **连续会话**：本地 SQLite 持久化消息、工具结果、项目和运行记录；在轮次间切换模型，交接可移植历史；重启可继续。
- **普通聊天**：无需项目目录即可直接发送消息、切换模型、配置 Agent 和发起团队讨论。“开启新会话”默认创建普通聊天，点击项目或打开文件夹才创建项目会话。直接 API 普通聊天不开放本地文件和命令工具；Codex 使用独立空目录与只读执行策略。
- **直接 API 编程工具**：列目录、读文件、审批后写文件、审批后执行命令；中文路径、路径边界检查、符号链接拒绝、写入冲突检测。
- **Agent 配置**：角色指令、独立模型/连接、只读或审批权限、API 执行轮次上限。
- **并行协作**：最多 3 个只读 Agent 独立分析，将结果汇回父会话；可分别查看子会话、失败与用量。
- **CC Switch 导入**：读取 `cc-switch.db` 或 JSON 供应商配置，确认后导入地址、模型与 API 密钥。源文件只读，不接管或修改其他应用配置。
- **工作区界面**：项目文件浏览、只读预览、Git diff、会话搜索/重命名/归档/恢复、Markdown 导出、运行状态和实际返回的 Token 用量。
- **本地凭据保护**：API 密钥由 Electron safeStorage 使用系统能力加密；界面仅得到是否已配置，不得到保存的密钥。安全存储不可用时拒绝保存。

## 本地开发

需要 Node.js **22.19+**（推荐当前 Node 22 LTS）、npm、Git。Windows 使用 PowerShell；macOS 需要 Xcode Command Line Tools 用于打包。

```bash
npm ci
npm run dev
```

生产构建和运行：

```bash
npm run build
npm start
```

首次安装/启动可能下载 Electron 和当前平台的 Codex 二进制。官方软件包由 npm/GitHub 分发；若网络受限，请使用自己信任的网络或组织内镜像。

## 第一次使用

1. 在 **模型连接** 添加服务，确认接口协议、Base URL、认证方式和模型 ID。Base URL 应为协议根路径，例如 `https://api.example.com/v1`，不要填完整的 `/chat/completions`。
2. 点击“保存连接并获取模型”。会话与 Agent 的模型选择框支持搜索、点选与刷新，打开时自动读取服务模型目录，获取结果保存在本地。服务未提供模型目录时，可搜索后使用自定义 ID；连接配置中的手动列表收在“高级”选项内。**保存并测试调用会产生一次真实模型调用，可能计费。**
3. 若使用 ChatGPT，在 **设置与关于** 选择“ChatGPT 浏览器登录”或“设备码登录”。设备码方式会显示一次性代码，点击“打开授权页面”后登录并输入代码；若账号要求，请先在 ChatGPT 安全设置或工作区权限中启用设备码登录。同舟接收授权结果后自动读取账号和同步模型列表；也可取消或手动刷新状态。之后使用 **OpenAI · ChatGPT** 连接。模型权限取决于账号，模型列表不是权益检查。
4. 在输入框选择连接和模型，直接发送消息即可开始普通聊天。无需选择 Agent；需要专属角色时，在“Agent 团队”点击“用于当前会话”，输入框上方会显示可移除的角色提示卡。需要读取或修改项目文件时再打开项目。专属 Agent 的固定模型/连接配置优先于会话默认值。
5. 阅读写文件或执行命令的审批内容，再选择批准或拒绝。停止按钮终止当前运行，不回滚已完成的文件修改。
6. 需要多视角分析时，输入任务后点击输入框右侧的团队图标，选择 1–3 位 Agent。

## 认证与执行模式

| 连接                | 执行方式            | 凭据                                         |
| ------------------- | ------------------- | -------------------------------------------- |
| OpenAI · ChatGPT    | Codex App Server    | 官方 Codex OAuth，独立配置目录、系统 keyring |
| OpenAI / 兼容 API   | 同舟 API Agent 循环 | API Key 或 Bearer                            |
| Anthropic / Gemini  | 同舟原生协议适配    | 协议专属 API Key 或 Bearer                   |
| 本地模型 / 自建服务 | 同舟 API Agent 循环 | 可选择无认证                                 |

**接入一个模型不保证它能完成工具调用。** 供应商必须支持所选协议的流式与工具 API。界面里的预设仅是可编辑的起点，模型与套餐以服务商文档为准。非 OpenAI 的订阅 OAuth、通用企业 OIDC、自动刷新任意 Bearer Token 不在 0.1.0 范围；短期令牌过期后需更新。

## 安全边界和当前限制

- 项目内容和必要历史会发送给**所选模型服务**。切换服务意味着后续请求可能包含此前的项目内容。没有同舟运营的中转服务器、云同步或遥测。
- 直接 API 模式的文件工具检查项目范围并拒绝符号链接；终端命令始终需要单次批准，批准后以当前系统用户权限运行。**此模式不是操作系统沙箱**，不能限制已批准命令访问项目外文件或网络。
- Codex 模式使用原生 `read-only` / `workspace-write` 沙箱和 `untrusted` 审批策略，项目内普通写入可能按 Codex 策略直接执行；有特权的操作需审批。并非每个文件修改都会弹窗。
- 文件审批包含旧/新内容；审批期间文件变化则拒绝覆盖。非可信本地进程并发修改路径不属于应用层隔离的保证范围。
- 为跨模型兼容，Codex 每轮建立一个引擎分段并注入可移植历史，保存原始引擎 thread ID。0.1.0 不宣称无损继承隐藏推理、缓存或服务端状态。
- 历史按完整用户轮次保留到字符预算，超出的较早轮次仍在数据库中，但不会全部发送；不做自动摘要。单轮过大时明确报错。
- 并行团队只读，最多 3 个子任务；第一版没有多写入 Agent 的 worktree 合并与自动修复冲突。
- CC Switch 导入不复制 OAuth 会话、MCP、Skills、脚本和代理接管设置。执行不依赖 CC Switch，不包含其代码。
- MCP/Skills 的专门管理界面、自动路由/故障转移、附件/图片输入、自动更新、云同步和费用估算尚未实现。当前用量只展示上游实际返回的 Token，不估算账单。
- 不在已有工具副作用后自动重试模型调用。恢复运行需要明确的下一条用户消息，避免重复写文件或执行命令。

详见 [设计与架构](docs/ARCHITECTURE.md)、[验证记录](docs/VALIDATION.md) 和 [安全说明](SECURITY.md)。

## 测试与安装包

```bash
npm test                  # 协议、持久化、路径、审批、Agent 生命周期
npm run build             # 类型检查 + 前后端生产构建
npm run test:desktop      # 隔离用户目录的 Electron UI / Codex 握手测试
npm run dist:win          # Windows NSIS 安装包
npm run dist:mac          # 在 macOS 构建 DMG + ZIP
```

安装包在 `release/`。默认构建未签名；正式发行时应配置 Windows 代码签名及 Apple 签名/公证。GitHub Actions 提供 Windows、macOS 两个平台的构建检查，发布 `v*` 标签后生成草稿 Release，供维护者审阅后公开。

测试使用本机模拟模型响应，不消耗真实模型额度、不复用已有 OpenAI 登录。真实供应商的账号、配额、网络和全部模型组合，仍需在对应环境验证。

## 项目结构

```text
electron/      桌面主进程、存储、协议、Codex、工作区和 Agent 执行
src/           React 界面、共享类型
tests/         协议与核心集成测试
scripts/       构建、图标、桌面验证
docs/          架构方案、验证记录、开发路线
.github/       CI、发布流程、Issue 模板
```

欢迎通过 Issue 讨论问题，通过 Pull Request 提交兼容性修复。新增供应商优先复用已有协议，新增协议必须提供工具调用和流式异常测试。见 [贡献指南](CONTRIBUTING.md)。

## 致谢与许可证

同舟采用 [Apache License 2.0](LICENSE)。[Codex](https://github.com/openai/codex) 提供开源执行内核；[CC Switch](https://github.com/farion1231/cc-switch) 为供应商管理和迁移体验提供参考。代码归属和依赖说明见 [NOTICE](NOTICE)。
