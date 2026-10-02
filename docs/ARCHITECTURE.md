# 同舟 0.1 设计与架构

状态：首版已实现；以实际代码与验证记录为准。日期：2026-10-02。

## 产品目标

为个人开发者提供统一的模型入口、项目工作区、连续会话和可配置 Agent 团队。用户可以在同一个任务中切换服务、让专业 Agent 给出不同视角，并保留可追溯的工具结果和模型使用记录。默认本地使用，无需注册同舟账号。

首版交付闭环：添加连接 → 打开项目 → 发送任务 → 接收流式输出 → 审批操作 → 查看文件与运行记录 → 切换模型继续 → 重启恢复。

## 关键技术决策

### ADR-001：Electron + React + TypeScript

最初讨论过 Tauri + Rust。首版选择 Electron：当前开发环境有 Node/Codex，无 Rust 编译链；将 UI、协议、调度使用同一类型系统实现，可以在本机完成生产构建和 Electron 端到端测试。这个选择不改变 Codex 内核复用的方向。

代价是安装包较大。执行、数据和供应商模块不直接依赖 React，未来迁移桌面壳时可以保留数据协议与大部分功能，但不承诺无需重写主进程。

### ADR-002：原生 Codex + 通用 API 两种执行后端

ChatGPT 登录连接使用固定版本的 `@openai/codex`，通过 stdio JSON-RPC 集成 App Server。其他连接使用统一 API Agent 循环，直接适配四种模型协议。首版不实现一个号称完全兼容 Responses 的 HTTP 转换代理。

这样可以复用 Codex 的官方登录、执行与沙箱，同时让普通 API 和无认证的本地模型可用。两条后端共享会话、消息、运行和审批展示，但原生 Codex 的权限与通用 API 的权限语义明确区分。

### ADR-003：以应用会话为事实来源

一个 Session 包含多个 Run，每个 Run 冻结模型、连接、Agent 参数和开始时间。消息带有 runId、模型、角色与工具关联。引擎 thread ID 是 Run 的关联记录，不作为产品会话的主键。

API 运行重用可移植消息；Codex 每轮开启新的线程分段并注入历史文本。新的模型能得到已发生的事实、结果和用户约束，但不能继承另一模型的隐藏推理、缓存或账号专属状态。可移植性优先于无损原生线程续接。未来可为连续同引擎轮次增加 thread/resume 优化。

### ADR-004：CC Switch 以只读兼容导入方式结合

0.1 读取公开的 providers 数据结构，支持 SQLite 与常见 JSON 导出。新建独立 Provider，密钥重新用本机系统能力加密保存。源文件不写入；用量查询脚本、OAuth 凭据、MCP 启动命令、Skills、代理接管设置均不自动执行或导入。

供应商配置导入逻辑独立实现，没有复制 CC Switch 源码。未来如果复用具体实现，应固定上游版本并保留 MIT 版权声明。

## 模块职责

| 模块     | 文件                         | 职责                                                        |
| -------- | ---------------------------- | ----------------------------------------------------------- |
| 桌面边界 | electron/main.ts, preload.ts | 主窗口、受限 IPC、原生文件选择、系统加密、外部登录 URL 校验 |
| 数据     | electron/store.ts            | SQLite WAL、Schema 版本、消息排序、凭据引用、进程中断恢复   |
| 协议     | electron/providers.ts        | 请求编译、SSE 解析、工具调用组装、完成标记、用量            |
| 原生执行 | electron/codex.ts            | 固定版本 CLI 定位、stdio 请求、超时、进程生命周期           |
| 调度     | electron/runtime.ts          | 运行快照、单会话互斥、工具循环、取消、团队与审批            |
| 工作区   | electron/workspace.ts        | 文件路径边界、冲突检查、审批后命令、输出限制                |
| 迁移     | electron/cc-switch.ts        | 只读导入、格式校验、跳过不支持配置                          |
| UI       | src/App.tsx, components.tsx  | 工作空间、连接、Agent、运行记录、设置、文件与审批界面       |

## 核心对象

- Provider：id、name、protocol、baseUrl、auth、models、输出与历史预算。已保存密钥不在对象中。
- Secret：Provider ID → 系统加密后的密文。主进程在调用模型时解密。
- AgentProfile：角色指令、可选固定模型/连接、权限、最多模型轮次。固定模型优先于会话默认值。
- Project：规范化的本地目录，由用户通过文件选择器授权。
- Session：项目、标题、最近模型选择、父会话、归档状态。
- Message：文本、角色、Run 关联、工具调用/结果、流式/完成/错误状态。
- Run：执行后端所用连接/模型、Agent 名称、状态、时间与实际返回的 Token。
- EngineSegment：Run → Codex Thread ID。
- Approval：只存在当前进程内的单次审批，绑定会话、操作内容、取消信号；10 分钟后失效。

SQLite 使用参数化语句。重启时将 running Run 和 streaming Message 标记 interrupted，不重放工具。数据库 Schema 不匹配时拒绝启动，避免老版本覆盖新格式。

## 执行与恢复

API Agent 每轮将最近完整用户轮次编译为目标协议，流式保存可见文本，组装完整工具参数并检查完成状态。只有完整的工具调用才执行。多个工具顺序执行，写入和命令需要审批，结果持久化后再请求模型。

超出历史预算时删除请求中的较早完整轮次，数据库保留全部历史。单轮本身超预算则明确失败。不拆开工具调用与工具结果。原生 Codex 无 call ID 的日志转换为历史证据文本，避免向其他 API 发送孤立工具响应。

上游失败、连接截断、输出到达上限、取消都会终止当前 Run。不在操作之后盲目进行网络重试。新的用户消息可以接着当前可移植历史继续。取消不保证回滚已产生的外部副作用。

Codex 请求流程：initialize → initialized → thread/start → turn/start → item / delta / approval → turn/completed。只将 completed 视为成功；failed/interrupted 留在历史。未知服务端交互返回错误，不静默批准。

## 协作与并发

每个 Session 同时只有一个运行；应用最多四个活跃槽位。团队运行使用一个父协调槽位和最多三个子槽位。子 Agent 获得受限的父上下文与自己的角色指令，可以使用不同服务和模型；并行协作强制只读。结果逐一留在子会话，并在父会话汇总。

团队取消会传播到子任务；部分失败会在父记录显示失败，不伪装成全员成功。主助手可基于汇总继续编码。自动模型总结、多写入 Agent、worktree 与补丁整合列入后续版本。

## 安全边界

Renderer 启用 contextIsolation、sandbox、关闭 Node 集成；preload 仅暴露明确的业务方法。主进程验证 IPC sender 与主 frame；禁止新窗口、导航和 WebView，默认拒绝浏览器权限。

模型文本使用 Markdown 渲染，禁用原始 HTML执行、外部图片加载和自动外链打开。OAuth 仅允许打开 Codex 返回的 HTTPS `auth.openai.com` 或 `chatgpt.com` 地址，拒绝非标准端口、URL 内凭据和相似域名。浏览器授权和设备码授权由 `electron/codex-auth.ts` 管理，监听完成通知后重新读取账号，以实际账号结果确认成功；一次性代码不落盘，取消、失败、成功时清除。API 地址允许 HTTPS 或 loopback HTTP；拒绝 URL 内账号、密码和查询密钥，拒绝 HTTP 重定向以避免凭据跨域。

文件工具拒绝绝对路径、越界、符号链接/目录联接；不允许直接写 .git。写入前展示旧/新内容，批准后再次验证路径及原内容。命令工具每次审批，使用最小环境变量集合，设置超时并终止进程树，限制输出大小。应用层检查不等于内核沙箱，已批准命令具有当前用户权限。

系统密钥库不可用时拒绝持久化 API 密钥。Codex 使用自己的独立 home 和系统 keyring，不借用用户的现有 `.codex/auth.json`。供测试使用的明文 codec 只存在测试代码中，生产入口不启用。

## 交付与演进

版本 0.1 的范围和未实现能力在 README 中明确列出。下一步优先增加真实模型兼容性矩阵、同引擎 thread/resume、携带来源的上下文摘要，以及协作时 worktree 隔离。之后再考虑 MCP/Skills 管理、认证插件、自动路由和签名自动更新。

参考：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Codex 开源仓库](https://github.com/openai/codex)、[CC Switch providers schema](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/database/schema.rs)、[Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)。

## 0.2.0 原生账号引擎

新增 `kimi` / `minimax` 协议和 `native` 认证模式。主进程通过固定版本官方 CLI 的 login 命令创建授权，通过 ACP `authenticate` 确认状态后 `session/new` 获取模型；URL 与设备码仅存在内存，取消/超时/完成后清除。通过 epoch 忽略过期进程的回调。授权链接仅开放审核过的供应商 HTTPS 域名，不支持界面传入任意 URL。登录目录独立，不读取或迁移系统已有 CLI 凭据。

普通聊天在同一供应商、模型、提示词与权限下复用 ACP session，连续轮次仅发送新消息；切换模型、账号操作、历史被其他引擎续写或连接断开后重新建立 session 并注入可移植文本历史。最多保留 4 个空闲进程，5 分钟后释放。项目任务每轮创建新 ACP session。普通聊天不展示内部工具记录，流式消息按 60ms 间隔写入；模型使用引擎返回的不透明 ID，界面显示名称。无项目和只读 Agent 必须有 plan 模式，否则执行失败；项目任务使用 default/Ask。ACP 权限请求只允许 allow_once，其他交互拒绝。取消结束专属进程树，不重放任务。当前 ACP 用量未映射，界面显示未报告，不能据此推断免费。直接 API 的最大输出和轮次上限不控制原生引擎。

三个官方引擎均随应用分发。Kimi/MiniMax 使用内置 Node 22.23.3，避免 Electron Node ABI 与 MiniMax better-sqlite3 不兼容。打包关闭 npmRebuild，保留 Node 22 构建的 SQLite；开发/CI 安装固定 Node 22 系列。CLI、Node 与其原生依赖解包到 app.asar.unpacked，Mac 安装在目标平台生成对应二进制。

MiniMax API 复用 Anthropic SSE 适配器，完整保存 thinking/text/tool_use 内容块、thinking 签名与顺序。同连接同模型继续时回传；跨连接/模型交接只传文本和工具结果证据。API Key 预设切换到不同端点会清除旧密钥，避免将旧供应商凭据发送到新地址。
