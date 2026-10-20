# 桌面打包与体积控制

## 依赖边界

Vite／esbuild 已将前后端库编入 `dist` 和 `dist-electron`。这些库列在 `devDependencies`，构建时仍完整安装，但安装包不再重复携带原始包及其依赖树。

需要从文件系统加载或作为独立程序启动的包保留在 `dependencies`：Codex、Kimi、MiniMax、ripgrep、Node、node-pty 和 electron-updater。它们的实际传递依赖继续由 electron-builder 收集，不能因为在根目录被标为开发依赖就手工删除仍被引擎依赖的包。

- 构建前使用完整的 `npm ci`，不能先 `--omit=dev` 再构建。
- 新增外部模块、`require.resolve` 或子进程入口时，需要检查其运行依赖是否仍随包发布。
- 原生模块、引擎资源、字体、WASM、许可证均保留；不将模型引擎改为首次运行联网下载。
- 发布过滤排除源码映射、PTY 构建源码／测试、SQLite 源码和中间产物。
- `afterPack` 在签名前清理其他平台／架构的 PTY 预编译目录，保留当前目标目录中的全部文件，包括 spawn-helper、ConPTY 及其附属文件；Linux 本机编译产物继续保留。
- 原来的 Node、模型引擎和辅助进程解包规则保留，以支持从 ASAR 外独立执行。
- Vite 与后端构建分别生成 `dist/THIRD_PARTY_LICENSES.md` 和 `dist-electron/THIRD_PARTY_LICENSES.txt`，保留已编入应用的库声明；外部包保留原有许可证。

## 本次对比（2026-10-20）

基于 `main / 587b95b` 的同一份业务代码、同一 Electron 44.5.1 和 macOS ARM64 环境，重新生成优化前后 ZIP。不是拿历史 0.1.1 包比较新版本。两次使用相同默认压缩配置，关闭本机签名自动发现，复用本地 Electron 分发；构建不上传或发布版本。

| 指标                 |      优化前 |     优化后 |                 减少 |
| -------------------- | ----------: | ---------: | -------------------: |
| ZIP 实际文件长度     |  469.98 MiB | 337.15 MiB | 132.83 MiB（28.26%） |
| ZIP 条目解压后总长度 | 1309.98 MiB | 864.60 MiB | 445.38 MiB（34.00%） |
| ZIP 条目数（含目录） |      27,570 |      3,028 |               24,542 |

使用文件实际长度／ZIP 条目长度计算，未用 APFS 的 `du` 分配空间作为下载大小。Codex、Electron、独立 Node 的压缩内容体积保持不变；减少主要来自重复库、无关 PTY 二进制、源码映射及构建文件。现有引擎和 Node 仍是体积主体。

## 验证

- 全量单元／集成测试：113 个文件，854 项通过、1 项原有跳过；类型检查及生产构建通过。
- 6 个打包规则案例覆盖 macOS／Windows／Linux 的 ARM64／x64：保留目标 PTY 完整目录、原生运行文件和引擎资源，排除指定源码／测试／映射文件，并检查 Linux 启动包装器。
- 优化前的真实成品包通过原有 `test:package`，作为功能基线。
- 优化后的真实成品包通过增强的 `test:package`：在仓库之外的工作目录启动，运行内置 MCP、Codex 二进制、独立 Node、PTY／SQLite、中文路径 ripgrep 和真实 Node 命令。
- `test:native`：Kimi 与 MiniMax 的真实 ACP 初始化和匿名状态正常；没有完成用户登录或调用付费推理。
- `test:task-workbench`：真实 PTY 中文输入、持续日志、停止与紧急停止，以及工作台评审、恢复和诊断通过。
- `test:markdown`：Markdown、数学公式与本地字体、代码高亮、8 种 Mermaid 图表、HTML 交互与隔离、流式内容和主题切换通过。
- 对比两个 ASAR：484 个应用 JS／CJS／CSS／字体／WASM／HTML 文件 SHA-256 相同；新增库声明存在；重复的 React、Mermaid、Excalidraw、Lucide 原始包目录及映射文件已排除。
- 对比 ZIP：1,348 个保留的模型引擎／Node／ripgrep 非映射文件，条目长度及 CRC 相同；优化包不含 Windows PTY 实体文件。

本轮真实打包与桌面验证仅覆盖 macOS ARM64。Windows、Linux 和 macOS x64 的规则经过隔离测试，仍需各平台发布 CI 验证实际安装包；没有进行真实账号推理或真实 ComfyUI 出图。

本地证据位于忽略目录：`work/package-size-before/`、`work/package-size-after/`、`work/package-size-report.json` 和 `work/package-size-*.log`；桌面测试的报告与截图在 `test-results/`。

## 二次核对：Kimi Web 资源（2026-10-20）

同舟仅从 Kimi CLI 进入 login／logout／ACP，认证使用官方浏览器授权页面，没有调用 Kimi 自带的 Web 服务。进一步排除了 `@moonshot-ai/kimi-code/dist-web`（网页、字体与静态资源），以及 Kimi／MiniMax／Node 安装阶段脚本；保留 CLI 本体、原生模块、认证与刷新代码和许可证，不修改第三方打包代码。

ZIP 从 337.15 MiB 降到 **323.40 MiB**，再减少 13.75 MiB；解压条目总长度从 864.60 MiB 降到 **835.00 MiB**。新包位于 `work/package-size-kimi-trim/`。6 个打包规则案例、真实成品 `test:native` 与 `test:package` 通过；没有执行真实账号登录、刷新或付费推理。保留的外部运行文件条目长度与 CRC 一致。

其他候选尚未删除，不能算进本次节省：

- macOS 剪贴板的 universal 与专用架构模块并存；需要按加载器回退行为验证只保留一份。
- MiniMax 自带 skills 约 2.71 MiB（压缩后），包含模板、文档与示例。同舟使用自己的技能，但 ACP 创建会话可能扫描这些目录，需验证认证后模型目录流程再裁剪。
- Codex voice 资源约 7.86 MiB（压缩后）。当前核心的 in_app_voice 与 realtime_conversation 默认启用；同舟未见语音会话入口，仅凭未直接引用不足以直接移除，需要显式能力边界及运行验证。
- Codex code-mode-host 约 22.70 MiB（压缩后），当前核心的 code_mode_host 为 stable／默认启用，保留。

## Electron Node 复用实验（2026-10-20）

结论：**内置后台进程可适配复用，但现阶段完整删除独立 Node 不满足“既有功能不受影响”要求，正式打包未启用该实验。** 先前已验证的文件精简继续保留。

本机独立 Node 为 22.23.3／原生 ABI 127；Electron 44.5.1 的内置 Node 为 24.21.0／Electron ABI 149。PTY 与剪贴板的 N-API 模块直接加载成功；现有 better-sqlite3 无法直接加载。将该模块适配到 Electron ABI 后，隔离复制的成品应用可用 Electron 的 Node 模式启动 MCP、完成 Kimi／MiniMax 匿名 ACP 初始化，并通过真实交互终端、Node 命令、评审与停止测试。启动脚本用相对路径和进程局部的 ELECTRON_RUN_AS_NODE，未改变用户应用环境。

然而，不能替用户项目统一重编译原生依赖。同一份合成项目使用原有 ABI 127 的 SQLite 原生模块，独立 Node 运行成功（SQL 返回 42），Electron Node 运行失败（ABI 127／149 不匹配）。这是已有成功路径的实际回归，不能仅因应用内部模块适配成功就宣称等价替换。系统已安装 Node 时可优先使用用户版本，但这不能覆盖原有独立 Node 的离线兜底场景。

因此已撤回实验性的打包接入，保留原发布运行时和原生模块。复用实验没有作为新的优化包发布，也没有将失败项目改为禁止执行。未来如采用标准 Node 按需安装，需要明确首次联网、下载校验、版本管理与离线完整包策略；这属于分发方式调整。

复现：`npm run probe:electron-node`。探针复制合成项目的依赖，不重编译或更改仓库安装的原生模块；报告中明确区分“诊断完成”和“项目兼容”，不能把命令正常退出理解为兼容通过。本次报告：`test-results/electron-node-3gjcet/report.json`。后台正向验证日志：`work/electron-node-probe-{package,native,terminal}.log`；项目对照：`work/electron-project-probe/report.json`。

## Tauri 宿主验证（2026-10-20）

新增独立的 CoSail，复用现有 Node 执行核心、React 界面和业务接口；正式 Electron 入口继续保留。构建从同一个依赖收集器取得运行资源，不删除 Codex／Kimi／MiniMax、独立 Node、ripgrep 或 PTY。具体构建方式及未适配能力见 [Tauri 预览](TAURI_PREVIEW.md)。

在 `main / 34fcf85` 基础上的同一份工作区改动、同一 macOS ARM64 环境中，完整重建两个宿主，使用 electron-builder 相同的 `normal` ZIP 配置比较未公证的本地应用包：

| 指标                 |   Electron | Tauri Preview |                 减少 |
| -------------------- | ---------: | ------------: | -------------------: |
| ZIP 实际文件长度     | 323.41 MiB |    203.94 MiB | 119.47 MiB（36.94%） |
| ZIP 条目解压后总长度 | 835.05 MiB |    545.75 MiB |           289.30 MiB |

下载字节数分别为 339,115,358 和 213,843,309，不采用 APFS 分配空间。835 个保留的引擎、Node、ripgrep、PTY 文件逐一 SHA-256 相同。体积减少主要来自 Tauri 使用系统 WebKit，避免携带 Electron／Chromium；执行资源仍是大头，不能据此承诺几 MB 的完整客户端。

验证包括实际 WebKit 窗口中的中文会话、MCP 审批和调用、文件写入、交互 PTY、官方 ChatGPT 授权、重启保留及一轮 GPT-6 Sol 真实回复；Electron 的会话、账号代理隔离与管理回归通过。自动化协议测试使用本地合成模型，不作为质量对照。

对比报告 `work/tauri-size-report.json`，比较包 `work/CoSail-{Electron-comparison,Tauri-Preview}-mac-arm64.zip`。此结果仅适用于 macOS ARM64；Windows 的 WebView2 安装方式、Linux 的系统库和移动端执行方式需要分别评估，尚未生成或验证对应发布安装包。本次不切换正式发布入口。

### 补齐桌面能力后的当前体积（2026-10-20）

托盘、电源管理、电脑控制、权限辅助窗口和更新验证接入后，重新生成 macOS ARM64 对照 ZIP，仍使用相同的 `normal` 压缩配置。Tauri 包已完成本地临时签名，正式分发仍需平台签名和公证。

| 指标                 |   Electron |      Tauri |                 减少 |
| -------------------- | ---------: | ---------: | -------------------: |
| ZIP 实际文件长度     | 323.43 MiB | 205.36 MiB | 118.06 MiB（36.50%） |
| ZIP 条目解压后总长度 | 835.10 MiB | 549.14 MiB |           285.95 MiB |

下载字节数分别为 339,139,230 和 215,339,968。报告为 `work/tauri-current-size-report.json`，比较包为 `work/CoSail-{Electron,Tauri}-1.0.4-mac-arm64-current.zip`。上表为当前本地比较包，前节保留首次宿主验证的数据；正式 Electron 发布入口未切换。

当前全量测试为 118 个文件、872 项通过、1 项原有跳过，类型检查通过。macOS 实际窗口发现、截图和中文输入自检通过；正式更新安装、Windows 和 Linux 实机验证仍待完成。
