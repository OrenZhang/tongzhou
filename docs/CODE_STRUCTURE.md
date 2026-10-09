# 代码目录与模块边界

同舟按应用装配、执行核心、业务模块、基础服务和界面功能组织源码。新增功能应放进所属模块，通过现有注册机制组合能力，不在根目录继续堆放文件，也不保留旧路径转发文件。

```text
electron/
  main.ts、preload.ts       Electron 窗口、应用入口与渲染桥接
  application/
    kernel.ts              Cordis 挂载、依赖校验和有序释放
    application.ts         桌面应用的服务与功能组合
    services.ts、context.ts 服务工厂与类型化依赖
    task-system.ts         任务服务装配、启动回滚与退出清理
    client-ipc.ts          IPC 来源校验、能力目录与注册撤销
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
- 在 `application/features/` 声明 Cordis 功能插件，使用 `inject` 获取有限服务，并通过 `ctx.tzIpc.scoped(ctx)` 注册接口。带连接、监听器或后台任务的服务在自己的 Cordis 上下文登记释放逻辑。启动失败与退出必须能清理资源。
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
