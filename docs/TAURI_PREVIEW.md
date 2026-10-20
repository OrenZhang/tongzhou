# Tauri 桌面验证

当前提供独立的 **CoSail**，用于验证 Tauri 2 承载现有客户端。Electron 仍是正式入口，预览使用不同的应用标识和数据目录，不自动导入、覆盖或迁移正式客户端的账号与会话。

## 复用边界

```text
同一 React 界面 / TongzhouAPI
  ├─ Electron preload → Electron IPC
  └─ Tauri adapter → Rust commands → 私有 stdin/stdout
                                      ↓
                            内置标准 Node 22
                                      ↓
                    同一 ExecutionApplication / Cordis
                    会话、Codex、MCP、审批、PTY、领域服务
```

- `src/shared/client-api.ts` 是唯一的界面 API 映射，两种宿主只实现传输。JSON 传输用参数位置恢复可选的 `undefined`，保留有业务含义的显式 `null`。
- `electron/hosts/tauri.ts` 装配现有执行入口；`src-tauri/` 只承担窗口、文件选择、剪贴板、外链、主题和进程生命周期。没有复制模型循环、MCP 客户端或数据库。
- 账号服务通过 `accountServices` 和有限的 `AccountBrowserHost` 复用；Electron 保留 Chromium 登录分区、系统代理与旧凭据兼容。
- 电源与更新通过 `system-services.ts` 装配同一个 `PowerSettings`、`LidProcess` 和 `Updates`。Tauri 的唤醒请求由专用原生线程拥有，Windows 的线程相关请求在同一线程创建和释放；macOS 不阻止显示器休眠，拔掉电源会释放请求。
- `ComputerControl` 保留同一套审批、截图坐标映射、单次 frameId、窗口移动检查、串行操作与取消规则。Electron 使用原有 capturer，Tauri 使用 XCap 精确截取指定 PID／窗口；输入继续复用已有 macOS、Windows、X11 助手。自检算法共用，只替换测试窗口的创建和读取。
- Node 网络适配为每种网络配置使用独立 dispatcher，不改全局代理环境；OAuth 回调与本机网关保持直连。浏览器登录使用系统浏览器，指定 HTTP 代理时使用隔离授权窗口。
- Rust 仅允许本地 `main` 窗口调用核心；远程授权页没有执行权限，也收不到会话事件。IPC 不监听网络端口。退出先停止核心，超时后回收子进程；macOS 使用独立进程组防止遗留终端。

## 构建与启动

需要完整 Node 开发依赖、Rust stable 和所在平台的 Tauri 系统依赖。macOS 需要 Xcode Command Line Tools；预览使用 WebKit 的独立代理能力，最低 **macOS 14**。

```bash
npm ci
npm run tauri:build
npm run test:tauri
npm run tauri:start
```

构建先复用现有 Electron 依赖收集和 `afterPack` 裁剪，再提取相同的引擎、独立 Node、PTY 和资源。Node 宿主构建禁止引用 `electron` / `electron-updater`。前端输出到 `dist-tauri`，不会覆盖 Electron 的 `dist`。构建期间两个入口均会生成产物，不应同时运行依赖这些产物的桌面回归。

macOS 应用输出：`src-tauri/target/release/bundle/macos/CoSail.app`。`TONGZHOU_TAURI_DATA_DIR` 可指定测试专用绝对数据目录；默认使用 Tauri 应用标识对应的数据目录。执行 `npm run test:tauri -- --ui` 可创建隔离的合成模型场景并打开实际预览窗口，关闭窗口后夹具服务退出。

`--reuse-baseline` 是本地迭代用的缓存选项，仅在 Electron 业务产物未变化时使用；最终比较必须重新完整构建。当前打包验证仅覆盖 macOS ARM64，其他平台构建入口不代表已验证的发布包。

## 验证范围

| 能力 | 已验证内容                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------- |
| 会话 | 实际 WebKit 界面发送消息、中文消息、流式回复、写入审批、真实文件变更与重启持久化                              |
| MCP  | 内置 MCP 子进程启动、工具发现、实际 HTTP 工具调用及界面批准                                                   |
| 终端 | 实际 PTY、交互命令与输出、调整尺寸、停止；原生窗口展示 xterm                                                  |
| 登录 | 官方 ChatGPT 浏览器登录、回调完成、重启后授权与模型列表保留；设备码请求经过指定代理，取消与重试使用原有状态机 |

自动化会话和 MCP 测试调用真实内置 Codex，模型回复来自本地合成 Responses 服务，不等同于模型质量测试。另在原生窗口完成官方 ChatGPT 登录，重启后使用 GPT-6 Sol 收到真实回复「Tauri 会话验证通过。」。官方登录使用独立预览账号目录，不复用正式客户端的凭据文件。Kimi、MiniMax 及第三方 MCP 的真实授权尚未逐一验证。

自动化证据在 `test-results/tauri-core-*/report.json`；原生窗口检查在 `test-results/tauri-core-*/ui-report.json`。测试报告不包含令牌。Electron 的原有回归入口继续保留。

初始宿主验证的类型检查、两种宿主生产构建通过；115 个测试文件中 860 项通过、1 项原有跳过。Electron `test:desktop`（会话、审批、写入、流式与恢复）、`test:account-proxy`（账号代理隔离与本地回调）及 `test:management`（231 项能力、会话管理、外观与持久化）通过。

## 桌面能力

补齐桌面驱动后的全量验证：117 个测试文件、868 项通过、1 项原有跳过，包含 Windows 权限入口回归。签名下载及版本绑定的两项原生 Rust 测试通过；Electron 电源、更新界面、会话、管理回归通过。真实桌面授权与安装器验证范围另列，不能用合成测试替代。

- 托盘菜单提供打开和退出，左键恢复窗口；关闭主窗口时保留后台任务与界面状态。Dock 激活和重复启动会恢复已有窗口，退出通过执行核心的统一清理流程。
- 电源配置沿用接通电源保持唤醒、拔电暂停和合盖恢复助手。macOS 合盖设置仍需要用户主动操作及系统管理员授权，不在启动时弹授权框；不会为了验证而自动修改系统合盖策略。
- 电脑控制提供原生权限状态、当前应用路径、系统设置入口、悬浮拖动授权助手、Finder 定位、自检和紧急停止。授权助手复用 Electron 的视图和位置计算，以不激活应用的 macOS NSPanel 显示，加入所有应用集合以适配台前调度；按系统设置 Bundle ID 识别窗口，优先显示在其下方，空间不足时放在旁边。只能拖出当前运行的应用、移动浮窗、在 Finder 中定位或关闭，没有执行核心权限。系统报告拖放成功后自动隐藏浮窗，取消拖放时保留入口；拖放完成不代表权限已打开。`CommandOrControl+Alt+Escape` 注册失败时如实显示；与 Electron 同时运行可能占用同一快捷键。系统权限必须由用户授予，未授权不能宣称真实截图与输入通过。
- 自动更新复用现有状态机：只检查不自动下载，用户点击后下载并校验，存在会话、终端或排队任务时不安装。安装请求先回复调用方，再停止执行核心、恢复电源策略，最后调用原生安装器并重启；失败会显示错误并重新启动客户端。

### 更新发布配置

Tauri 使用独立的 `tauri-latest.json` 清单和签名安装包，不读取 Electron 的 `latest*.yml`。TLS、签名校验和签名版本绑定均开启，拒绝降级／预发布版本、被篡改内容及清单版本与签名版本不一致的包。

发布者需配置：

- 仓库变量 `TONGZHOU_TAURI_UPDATER_PUBLIC_KEY`：公开验签公钥，构建时编入原生宿主，普通用户无需配置。
- 仓库密钥 `TAURI_SIGNING_PRIVATE_KEY` 和可选的 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：只用于构建签名，不提交源码。
- 可选的构建环境变量 `TONGZHOU_TAURI_UPDATE_URL`：默认是同仓库 release 的 `tauri-latest.json`，只允许 HTTPS。

```bash
# 维护者首次在安全位置生成发布密钥；私钥自行备份，不能复用测试夹具密钥
node node_modules/@tauri-apps/cli/tauri.js signer generate --ci -w /安全目录/tauri-update.key

# 设置上述发布环境变量后
npm run tauri:build -- --updater
node scripts/tauri-release.mjs collect
node scripts/tauri-release.mjs merge
```

手动工作流 `.github/workflows/tauri-preview.yml` 在 macOS ARM64／x64、Windows x64 和 Linux x64 构建签名包并汇总清单，输出 `tauri-signed-release` artifact；不会修改现有 Electron 发布工作流，也不会自动上传到公开 release。维护者发布对应版本时，将清单与该 artifact 中的安装包／签名一起上传。未配置发布公钥的预览明确显示未配置状态，不生成假签名或误装 Electron 安装包。

`npm run test:tauri-desktop` 使用临时签名密钥和环回服务验证真实 Tauri updater 的正常下载、篡改拒绝和版本重放拒绝，并验证异步电源竞态、更新忙碌检查、电脑窗口及截图边界；不运行安装器、不修改操作系统权限或合盖策略。证据在 `test-results/tauri-desktop-*/report.json`。

### 本机原生验证记录

macOS ARM64 实际窗口已验证：开关保持唤醒时，系统 `pmset` 断言出现／消失；关闭并恢复窗口后页面保留；重复启动保留同一进程。授权助手已验证连续打开复用、原生拖动、切回系统设置仍可访问，以及拖放结束后自动隐藏；测试拖放限定在助手自身区域，没有代替用户授予系统权限。台前调度的完整交互仍待实际验收。

应用显示名称统一为 CoSail；保留独立的预览 Bundle ID 和数据目录。清理了本机构建目录里共享同一 Bundle ID 的旧 CoSail Preview.app，避免 LaunchServices 恢复旧构建。macOS 图标改用系统 iconutil 生成完整的小尺寸与 Retina 表示，已在 Finder 和系统设置中确认帆船图标。

本机构建在未配置发布证书时对完整应用包使用临时签名，并通过 LaunchServices 启动，以便系统将权限归属到应用。临时签名的身份由代码摘要决定，重建会导致已有权限失效；已实测系统开关显示打开时，当前构建仍可能被拒绝，移除旧权限条目并重新添加当前应用后，两项原生权限恢复正常。正式分发需要稳定的发布证书及公证，不能用临时签名替代。

Tauri 的 macOS 文字输入由已获授权的原生宿主通过 CGEventPostToPid 定向发送，脚本仅复用原有目标窗口聚焦能力；Electron 原有输入路径保留。共享控制器继续校验截图、窗口与 PID，原生驱动再次校验目标身份和前台应用，按 Unicode 码点分批处理，批次间响应取消，不改剪贴板。输入驱动的 Unicode／emoji 分批、聚焦失败及取消停止回归通过。2026-10-20 在实际 macOS 应用中重新添加两项权限并重启后，原生自检完整输入“CoSail自检成功”，窗口发现、XCap 截图和中文输入均通过；结果保存在 `work/tauri-desktop-validation.json`，界面证据为 `work/cosail-native-input-passed.png`。本轮相关 4 个测试文件、19 项通过，生产构建类型检查及完整应用签名校验通过。

`npm run test:tauri-native -- test-results/tauri-core-<夹具目录>` 用 `test:tauri` 生成的合成数据库启动隔离原生应用，确认真实 AC 唤醒断言、重复退出信号的正常退出、断言释放和 Node 核心退出。运行前需退出其他 CoSail 并接通电源；不修改合盖策略，不复制真实账号凭据。最终报告为 `test-results/tauri-native-oDN8TB/report.json`。协议测试同时验证原生父进程输入管道断开后核心能够退出，不等待已经消失的原生回调；报告为 `test-results/tauri-core-1AcvOJ/report.json`。

真正安装新版需要发布公钥、对应私钥签名的版本包和更新清单；本次使用临时密钥测试验签，没有执行安装器或发布更新。更新签名与 Apple 平台签名／公证不同，正式 macOS 分发仍需维护者配置平台签名。

## 体积比较

同一份代码、同一 macOS ARM64 机器、相同 ZIP 压缩配置；两边均保留 Codex、Kimi、MiniMax、Node、ripgrep 与 PTY，不使用首次运行下载替代内置资源。补齐桌面能力后的当前结果记录于 `work/tauri-current-size-report.json`：Tauri ZIP 205.36 MiB，Electron ZIP 323.43 MiB，减少 36.50%。首次宿主验证报告 `work/tauri-size-report.json` 保留为历史对照，完整数据见 [打包文档](PACKAGING.md#tauri-宿主验证2026-10-20)。

## 平台与发布验证边界

- 托盘、电源、电脑控制和更新代码已接入；真实系统授权、管理员合盖操作及正式签名安装包升级需要在具备对应权限／发布配置的环境验收。更新测试不会直接替换用户正在使用的客户端。macOS 签名与公证仍由正式发布流程提供。
- 外部拖入文件的原生路径尚未接入 Tauri；预览使用文件选择器。WebKit 对交互 HTML、媒体和画布的完整兼容仍需专项回归。
- 系统 PAC、浏览器强制直连隔离和 HTTPS 代理授权窗口尚未验证。预览对这些路径明确报错，提示改用显式 HTTP 代理、设备码或 Electron，不静默忽略网络选择。Windows／Linux 当前只支持环境代理及显式代理，尚未适配系统代理发现。
- Windows／Linux 安装包、进程树清理、原生模块与 WebView 差异仍需平台 CI 和实际设备验证。macOS 的体积不能直接代表 Windows（WebView2 分发方式）或 Linux（系统 WebKit 依赖）的下载体积。
- 标准 Node 执行核心可继续用于桌面和后续服务宿主；iOS／Android 不能直接照搬桌面 Node 子进程方案，需要经过认证和权限校验的远程执行通道。本次未增加公开 HTTP 服务或移动端安装包。

完成上述适配与回归前，不切换正式发布入口，也不删除 Electron 依赖。
