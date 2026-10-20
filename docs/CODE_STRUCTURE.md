# 代码目录与模块边界

CoSail按应用装配、执行核心、业务模块、基础服务和界面功能组织源码。新增功能应放进所属模块，通过现有注册机制组合能力，不在根目录继续堆放文件，也不保留旧路径转发文件。

```text
electron/
  main.ts、preload.ts       Electron 窗口、应用入口与渲染桥接
  application/
    kernel.ts              Cordis 挂载、依赖校验和有序释放
    execution-application.ts 通用执行入口（普通 Node／桌面共用）
    execution-services.ts、execution-context.ts 通用服务与类型化依赖
    execution-features.ts  通用业务命令，沿用领域处理器
    application.ts         Electron 宿主装配，继承同一个执行入口
    desktop-host.ts、host.ts 平台适配与不依赖 Electron 的宿主契约
    services.ts、context.ts Electron 服务与依赖（电源、更新、账号窗口）
    task-system.ts         任务服务装配、启动回滚与退出清理
    commands.ts            通用命令注册、调用跟踪与退出等待
    client-ipc.ts          Electron IPC 来源校验与传输适配
    features/              按领域划分的客户端接口注册
  core/
    task-contracts.ts      独立任务、执行与网络接口
    application-events.ts  类型化的生命周期与账号事件
    runtime/               调度、消息进度记录、审批、状态投影和历史
    codex/                 Codex 执行适配器、App Server、线程与传输
    models/                模型协议、流式适配、订阅模型网关
    tools/                 工具目录、调用权限、MCP 桥接、项目文件能力
  modules/
    domain-services.ts     共享领域持久化服务装配
    agents/                Agent、身份提示词、个性与偏好
    content/               内容库、文档对话、内容写入
    knowledge/             知识、来源、知识图谱、记忆
    artifacts/             会话作品、附件、导入导出
    automation/            定时任务、工作流、记忆整理任务
    projects/              项目、Git、工作树、变更记录
    sessions/              会话工作目录、任务记录与工作台服务
    plugins/               插件、技能、代码托管与 MCP 认证
  services/
    accounts/              模型连接、账号授权与订阅客户端
    network/               网络配置、代理核心、请求来源标识
    storage/               数据库、备份、文件传输、参数校验
    desktop/               终端、剪贴板、电脑操作、更新
    browser/               浏览器页面与独立登录分区
    channels/              消息渠道、机器人与飞书接入
src/
  main.tsx                 渲染入口
  app/                     应用装配、全局布局与基础样式
  features/                chat、agents、knowledge、artifacts、automation、plugins、
                           settings、connections、workspace
  components/              通用组件、controls、markdown、files
  hooks/、lib/             通用交互钩子与辅助函数
  shared/                  主进程和渲染层共用的数据类型与纯函数
tests/                     application、core、modules、services、ui、integration、release、support
scripts/testing/           Electron 回归、协议集成测试及夹具
prompts/                   独立维护的公共提示词
```

## 新功能放在哪里

- 业务模型、校验及持久化逻辑放在对应 `electron/modules/<功能>/`；`*-services.ts` 在同一目录声明客户端操作并注册处理器。界面与会话复用处理器。
- 在 `application/features/` 声明 Cordis 功能插件，使用 `inject` 获取有限服务，并通过 `ctx.tzClient.scoped(ctx)` 注册接口。带连接、监听器或后台任务的服务在自己的 Cordis 上下文登记释放逻辑。启动失败与退出必须能清理资源。
- 系统或外部服务接入放在 `electron/services/`，通过参数传入需要的依赖。插件、Agent 和模型连接的业务注册已从主进程入口拆出，不把注册表再复制到聊天层。
- 模块通过 `TaskService` 的有限接口提交任务；账号客户端由 Accounts 管理，执行客户端与线程缓存由 CodexExecution 管理。跨服务状态通知使用 `ApplicationEvents`，事件订阅必须登记释放；不向调度器回写可变的网络、项目或生命周期回调。
- 执行循环由 Codex 管理；`core/models/` 只做协议适配，业务模块不能另起模型工具循环。
- 页面状态由所属功能拥有。应用快照使用 `useApplicationState`，账号状态使用 `useAccountState`，会话消息使用 `useSessionMessages`；页面组件不向 App 回传编辑器状态。
- 页面及专用样式放在 `src/features/<功能>/`；跨页面复用的文件链接、Markdown、选择控件放在 `src/components/`。
- 跨进程的数据结构放在 `src/shared/`。主进程和共享类型不得引用 React 页面类型；连接诊断结构已移入共享契约。
- 测试按相同领域归类，通用测试夹具放在 `tests/support/`。桌面回归脚本统一在 `scripts/testing/`，通过 `package.json` 的命令运行。

## 构建与验证

源码目录改变不改变打包后的入口约定。`scripts/build.mjs` 显式指定新源码路径，仍输出 `dist-electron/main.cjs`、`preload.cjs` 及独立进程文件；应用数据位置不随源码移动。

`npm test` 递归发现分目录测试；`npm run build` 执行类型检查和构建；`npm run test:regression -- --only=client-management,content-workspace,artifacts` 可运行指定桌面流程。完整桌面回归包含安装包测试，需先准备对应平台安装包。客户端能力回归递归检查各模块注册文件，确保界面与会话发现的是同一份真实能力。

依赖边界测试在 `tests/application/dependencies.test.ts`，阻止领域和渠道引用具体调度器或 Codex 执行实现，并约束任务接口和服务注册类型。新代码不得通过路径转发文件绕过这些边界。

## 多端准备：执行核心与宿主

`ExecutionApplication` 使用现有 Cordis 内核、领域服务、任务系统和命令目录。`DesktopApplication` 只补充 Electron 适配与桌面服务，不再实现另一套启动／退出流程。源码仍保留在现有 `electron/` 目录，避免为目录改名引入大量路径改动；运行依赖由入口决定。

- 通用入口的传递依赖不允许引用 `electron` 或 `electron-updater`，包括类型契约。`tests/application/dependencies.test.ts` 检查完整源码引用图；`test:execution` 的构建阶段也拒绝这两个依赖。
- `ExecutionEnvironment` 注入数据／资源目录、事件出口、密钥编解码、模型请求传输和可选电脑工具。独立 Node 继续保留，数据格式和默认工作目录不变。
- `ApplicationHost` 提供文档操作、文件选择、剪贴板、版本和重启。通用命令不直接弹 Electron 窗口；没有相应能力的宿主应明确处理这些入口，不能伪造成功或静默回退。
- `ApplicationCommands` 将业务注册同时接到原有 `ClientCommands` 能力目录与可选传输适配器。普通 Node 可用 `app.client.invoke(name, ...args)` 从可信宿主调用；Agent 继续使用 `client_catalog/query/change`，原有只读、审批、凭据过滤和 manual 限制不变。
- `ClientIpc` 只负责可信主窗口／主 frame 来源校验与错误脱敏。通用层负责在途调用追踪、停止接收新操作及随 Cordis 上下文撤销注册。未来 HTTP／WebSocket 适配器必须先认证调用方并执行访问范围校验，不能将可信进程内入口直接公开到网络。
- Electron 继续提供 Chromium 系统代理、账号隔离窗口、旧密钥格式适配、电源、更新、外观及电脑权限界面。账号管理与连接诊断的桌面装配仍位于宿主，现有授权行为不变；通用核心不会为启动而创建认证窗口或读取系统钥匙串。
- Node 核心已复用会话、审批／追问、模型执行、MCP、智库、内容、作品、画布工作流、自动化和消息渠道。终端与托管网络子进程的资源路径从装配目录传入，不再假定入口一定是 Electron 主进程。

这一步提供可复用执行入口与适配边界，没有增加公开服务器、移动端安装包或远程登录体系。后续 Web／移动端连接同一个执行核心时复用数据契约和命令处理器，桌面宿主是否替换为 Tauri 可单独验证；无需重写业务执行循环。

### 验证入口

先 `npm run build`，再 `npm run test:execution`。该测试通过普通 Node 启动同一个执行入口，调用真实内置 Codex，使用本地合成 Responses 返回，验证追问、写入审批、真实文件写入、画布工作流、加密密钥／消息持久化和重启；没有用户账号登录或付费推理。夹具使用独立数据目录，证据保存在 `test-results/execution-*/report.json`。测试入口只临时构建在 `dist-electron/`，结束即删除，不额外发布一份重复执行核心。
