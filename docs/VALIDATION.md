# 0.1.0 验证记录

验证日期：2026-10-02。执行环境：Windows x64、Node.js 22.19.0、Electron 44.5.1、Codex 0.160.0。此记录区分本机已验证行为与尚未执行的跨平台、真实服务验证。

## 自动化验证

| 项目                                | 结果         | 覆盖范围                                                                                                                                  |
| ----------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                          | 30 项通过    | SQLite 恢复、凭据接口、文件越界与联接、审批与写入冲突、CC Switch 只读导入、四种协议、SSE 分片、用量、工具循环、取消、跨模型历史、团队协作 |
| `npm run build`                     | 通过         | TypeScript 检查、Vite 前端和 esbuild 主进程生产构建                                                                                       |
| `npm run test:desktop`              | 通过         | Electron UI、新建连接、编辑 Agent、打开项目、审批写文件、流式输出、实际落盘、用量与重启恢复                                               |
| 打包程序桌面测试                    | 通过         | 从独立目录启动 `release/win-unpacked/Tongzhou.exe`，重复桌面测试；不依赖开发项目作为当前目录                                              |
| Codex App Server                    | 握手通过     | 使用随应用分发的引擎完成 initialize、account/read；隔离用户配置，账号为空                                                                 |
| `npm run dist:win`                  | 通过         | 生成 Windows x64 NSIS 安装包                                                                                                              |
| `npm audit --audit-level=low`       | 0 个已知漏洞 | 验证当日 npm 审计结果，不代表不存在未知漏洞                                                                                               |
| `npm ci --ignore-scripts --dry-run` | 通过         | package-lock 与安装计划一致；首次开发安装使用正常 `npm ci`                                                                                |

桌面测试使用新建临时项目和独立 `TONGZHOU_USER_DATA`，不读取既有模型账号。测试的实际文件修改仅写入测试项目。测试报告输出到被 Git 忽略的 `test-results/`，不会将个人运行数据纳入仓库。

额外覆盖：跨供应商切换时将账号相关工具状态转换为历史证据；Gemini 同模型工具签名保留；进程异常退出导致工具结果缺失时不发送孤立调用，不自动重放操作。

## 复现打包程序测试

在 PowerShell 中：

```powershell
npm ci
npm test
npm run dist:win
$env:TONGZHOU_SMOKE_EXECUTABLE = (Resolve-Path 'release/win-unpacked/Tongzhou.exe').Path
npm run test:desktop
Remove-Item Env:TONGZHOU_SMOKE_EXECUTABLE
```

测试会自动启动、关闭、重启自己的桌面进程。它使用本机 HTTP fixture 返回协议数据，无真实模型费用。内置 Codex 路径缺失会报错，不会静默调用系统 PATH 中的另一个版本。

## 尚未验证与发布边界

- 没有执行真实 ChatGPT OAuth 登录和付费模型推理；真实工具执行的供应商兼容性需要账号和网络条件验证。协议测试使用真实 HTTP/SSE 传输与本机模拟响应。
- 未在 macOS 实机执行或签名、公证。仓库已配置 macOS 构建与桌面测试工作流，但配置存在不等于测试已通过。
- Windows 已构建并运行打包应用，未自动安装到用户系统，也未执行卸载流程。安装包未配置维护者代码签名证书。
- GitHub 远端仓库与工作流尚未发布、触发。本次会话的仓库创建页面被浏览器权限审查拒绝，现有 GitHub 连接器没有创建仓库接口，本地没有可用的 Git 推送凭据。没有绕过访问限制。
- 独立测试不等于安全审计。直接 API 的命令执行有审批，但不是操作系统沙箱。首版其他范围限制见 README。

## 后续本地迭代：普通聊天与可选 Agent

本地源码新增了不关联项目的会话，已通过 33 项自动化测试和更新后的桌面测试。覆盖首页直接发送、不弹出文件夹选择器、连续聊天与切换模型、重启后保留普通会话、无项目团队讨论、拒绝 API 返回的未授权文件工具，以及专属 Agent 提示卡的启用与移除。生产构建和类型检查通过，现有项目会话的写文件审批流程仍通过。

此次验证运行源码生产构建；之前导出的 0.1.0 安装包和源码压缩包不包含这些后续改动。

## 后续本地迭代：ChatGPT 授权

修复登录地址校验、缺失登录完成通知、无法感知失败的问题；补充设备码入口、取消、重开授权页、复制一次性代码、账号自动更新和模型同步。42 项测试通过，包含成功通知后读取账号确认、错误与取消、超时、提前到达的完成通知、官方域名校验及浏览器打不开时的恢复。普通聊天和项目操作桌面回归通过。

2026-10-02 使用内置 Codex 0.160.0 和全新独立目录实测 `chatgpt` 与 `chatgptDeviceCode` 两种授权请求：均成功返回官方地址，设备码非空，两种流程均可取消。桌面在线验证确认了等待状态、设备码展示、导航后状态保留和取消后清除。没有完成用户账号确认，没有读取或复制既有 OAuth 凭据，没有进行真实模型推理。

显式在线复现：先 `npm run build`，再在 PowerShell 设置 `$env:TONGZHOU_LIVE_AUTH_SMOKE='1'` 后执行 `node scripts/auth-smoke.mjs`。该测试会请求真实授权流程并取消，用测试替身阻止打开系统浏览器。普通 CI 测试不需要此环境变量。

协议依据：[OpenAI App Server 认证文档](https://learn.chatgpt.com/docs/app-server)、[设备码授权说明](https://learn.chatgpt.com/docs/auth)。另核对了内置二进制生成的 LoginAccountParams / LoginAccountResponse schema。

## 0.2.0：Kimi / MiniMax 认证

2026-10-02，Windows x64。固定引擎：Kimi Code 2.1.1、MiniMax Code 0.4.12、内置 Node 22.23.3。55 项自动化测试通过、类型检查与生产构建通过。新增测试覆盖官方域名/设备码提取、原生认证参数、隔离目录、环境密钥不继承、完成后的 ACP 账号验证及模型同步、取消/过期/晚到回调、退出登录、普通聊天和历史交接、单次审批、未知模型拒绝，以及 MiniMax thinking 内容块与签名的同模型回传。

实际供应商验证：Kimi 国内与 MiniMax 国内设备码请求均返回官方授权页面和一次性代码，取消后状态/代码清除。真实 Electron UI 在线测试通过：两个登录入口、未登录检查、设备码展示、重开页面、导航后保留、取消和清除。Kimi 官方 CLI 自行打开系统浏览器；测试没有提交用户账号确认，也没有复制既有凭据或调用付费模型。国际账号参数已接入，国际服务本次未实测。

Windows 0.2.0 已生成 NSIS 安装包，打包后的原生引擎与普通聊天/项目操作桌面回归通过。MiniMax 的原生 SQLite 使用 Node 22 ABI；CLI 通过随包 Node 运行，不使用 Electron 的 Node ABI。Node 及完整生产依赖从 asar 解包，避免外部 Node 无法读取虚拟 asar 模块。开发安装/CI 要求 Node 22，不应直接用 Electron 重建 better-sqlite3。

复现：`node scripts/native-smoke.mjs` 验证真实引擎与未登录状态；设置 `TONGZHOU_LIVE_NATIVE_SMOKE=1` 后会向两家请求真实设备授权并取消，Kimi 可能打开浏览器。可设置 `TONGZHOU_SMOKE_EXECUTABLE` 指向打包程序验证。测试报告/截图保存在忽略目录 test-results。

仍未完成：用户账号授权后的真实模型推理、真实套餐额度/续期验证、macOS 实机和远端 GitHub 工作流。ACP 会话/权限执行测试使用协议替身；不得描述为两家真实付费模型已全链路验收。原 0.1.0 安装包/归档保留为历史产物，新安装包位于 release/Tongzhou Setup 0.2.0.exe。

依据：[Kimi ACP 文档](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html)、[Kimi 会员接入说明](https://www.kimi.com/en/help/kimi-code/membership-guide)、[MiniMax Code](https://github.com/MiniMax-AI/minimax-code)、[MiniMax Anthropic 兼容接口](https://platform.minimax.cn/docs/api-reference/text-anthropic-api)。同舟使用官方终端认证入口，不复用厂商 OAuth client ID 编写自己的 OAuth 客户端。

## 0.2.1：认证入口与普通聊天

59 项自动化测试通过，类型检查与生产构建通过。覆盖浏览器授权切换设备码前取消旧流程、取消后的晚到通知/账号读取隔离，以及原生会话复用、账号操作后失效和跨模型历史交接。

独立 Electron 界面测试 `node scripts/account-ui-smoke.mjs` 验证 Kimi、MiniMax、OpenAI 管理入口各自只显示一个账号模块，关闭后返回模型连接页；成功标志来自已验证账号状态，离开页面再进入后仍显示。此测试使用账号状态替身，不代表完成真实登录。

在线 OpenAI 测试通过：创建浏览器登录请求，点击“改用设备码登录”，收到真实设备码，导航后保留状态，取消后清除。未完成真实 ChatGPT 账号授权；用户截图的上游 Route Error 根因尚未确定，不能将恢复入口描述为该网页错误已被修复。

使用用户已登录的同舟 Kimi 隔离配置完成两轮简短真实推理，耗时约 11.2 秒和 7.5 秒，第二轮保留上一轮内容，两轮均无内部工具消息。没有改写用户聊天记录。这不是同条件前后性能基准，不据此声称固定提速比例。MiniMax 真实推理、ChatGPT 登录完成与推理、macOS 实机仍待验证。

普通聊天隐藏历史内部工具条，并提示原生引擎直接在正文提问；同模型连续轮次复用引擎进程/会话，减少启动与历史重传开销。

Windows 0.2.1 NSIS 安装包已生成。打包程序从独立目录启动，通过单供应商认证弹窗/成功标志测试和完整桌面回归（普通聊天、项目写入审批、流式输出及重启恢复）。
