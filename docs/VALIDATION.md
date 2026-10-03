# 验证记录：0.4.0 开发预览

日期：2026-10-03。环境：Windows x64、Node 22.23.3、Electron 44.5.1。所有项目修改与测试均在独立测试目录内执行；测试账号使用同舟自身已有的 Kimi 授权副本，不读取其他客户端凭据。原始数据库、认证材料和截图保存在忽略的本地目录，仓库仅保存合成夹具和脱敏结论。

## 自动化与桌面

| 项目                                  | 结果                   | 覆盖范围                                                                                          |
| ------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| `npm test`                            | 101 项 / 11 个文件通过 | 协议、迁移、路径与审批、账号隔离、上下文、队列、删除、批量写入、通知、PKCE / 刷新等               |
| `npm run typecheck` / `npm run build` | 通过                   | TypeScript 与生产 UI / 主进程 / MCP 构建                                                          |
| `npm run test:desktop`                | 通过                   | 空 Agent、模型选择、普通聊天、项目写入审批、流式、用量、Codex 初始化、重启恢复                    |
| `npm run test:auth`                   | 通过                   | 单服务认证弹窗、成功标志、返回导航；账号状态为协议夹具                                            |
| `npm run test:extensions`             | 通过                   | MCP 发现、Skill 导入、公共开关、审批、无项目工具、跨供应商历史与重启                              |
| `npm run test:bridge`                 | 通过                   | 真实 stdio MCP / loopback 桥；内置 Codex 接受动态工具线程；不含真实 Codex 推理                    |
| `npm run test:workflows`              | 通过                   | 公开思考、排队仅一次、历史引用 / 分支、归档删除、连接 / 通知配置回显、Cookie 清理、项目说明初始化 |
| `npm run test:native`                 | 通过                   | 实际 Kimi / MiniMax CLI 的 ACP 初始化、匿名未登录判定，无用户登录和推理                           |
| Windows 电脑测试                      | 通过                   | 自有窗口发现、截图、中文输入、Ctrl+A、截图坐标点击，未调用外部模型                                |
| Windows 打包与 `test:package`         | 通过                   | NSIS 产物、仓库外启动、内置 MCP、中文路径搜索、本机窗口自检、Cookie 重启保存 / 清理               |
| GitHub Windows / macOS CI             | 等待本次推送结果       | 云构建与无密钥回归；Mac GUI 权限和真人登录仍不能由 CI 替代                                        |

新增关键回归包含：一致迁移备份并保留用户角色、排队编辑与未知 steer 不重发、Codex thread 恢复 / 模型变更重建 / Token 增量、并发文件写入冲突、批量预检及中断后的部分提交说明、分页不重不漏、删除子会话和私有目录、解除入站绑定、更换连接器站点清除旧令牌、GitLab PKCE state / 回调与刷新。

桌面测试曾在“正文已出现、运行尚在收尾”的时间点立即断言完成而失败。修正为等待 Run 终态；不再用正文出现替代运行完成。第一次 MiniMax 匿名测试暴露了空配置导致假授权，修正初次配置引导后已复测通过。

## 真实模型

已经通过一次真实 Kimi Coding 闭环：无项目问候 → 同会话记忆 → 读项目说明 → 修复 clamp → 执行测试。隐藏边界断言由测试驱动在项目外运行，用户笔记和原测试预期保持不变。该次冷聊天 8910ms、热聊天 2125ms、项目修复 35612ms；这是单次样本，不能当成稳定延迟或 P95。当前正在执行扩展的三轮任务矩阵，最终结果会追加到本节。

测试工具为 `scripts/live-coding-smoke.mjs`，使用 `TONGZHOU_CODING_MATRIX=1` 扩展为每组独立 3 次：D01 多文件调用链定位、D02/D06/D07 边界修复与用户内容 / 项目说明保护、D03 服务与渲染模块新增功能、D04 先复现类型错误再构建、D05 先复现测试失败再修复。合成项目范围有限，不代表大型真实仓库的普遍能力。

```powershell
$env:TONGZHOU_LIVE_CODING = '1'
$env:TONGZHOU_NATIVE_SOURCE = '已授权的同舟测试配置目录'
$env:TONGZHOU_TEST_ENGINE = 'kimi'
$env:TONGZHOU_CODING_MATRIX = '1'
npm run test:live
```

Kimi 的 `inputTokens` / `outputTokens` 未上报时记录为 null；不使用零伪造用量。MiniMax 真实推理尝试明确返回未登录，未记为通过。ChatGPT、OpenCode Go、其他直接 API / 本地真实模型没有本轮完整真实项目测评。D08–D10 的队列、取消、权限和冲突有确定性测试；跨真实模型任务与 Codex 同模型对照尚未完成，**不能据此宣称开发能力已与 Codex 等同**。

## 第三方与平台待验

- GitHub device flow、GitLab PKCE / 刷新：实现与本地契约验证已完成；真人账号授权、企业策略与仓库权限待对应环境验证。本地 Git 推送凭据独立于这些连接器。
- 飞书扫码 / 应用 / 长连接：按官方流程实现；白名单、回调去重、发送业务码、一次性规则、失败与未知结果已有替身测试。没有扫描用户二维码、创建真实机器人或发送真实渠道消息，因此真人授权 / 消息权限待验。
- 企业微信 / 钉钉：Webhook 出站适配；不把企业扫码登录等同于机器人创建。未开放通用扫码机器人配置。
- macOS：有代码适配和 CI；本轮 Windows 结果不能证明 Mac 屏幕录制、辅助功能、签名 / 公证及实机交互通过。

## 依赖检查

`npm audit --omit=dev` 无生产依赖漏洞。完整开发依赖审计有 8 项 high，来自打包链的 `http-cache-semantics` / `cacheable-request` / `got` / `@electron/get` 传递影响；当前公告无修复版本，`npm audit fix --ignore-scripts` 未消除。没有将完整审计写成零漏洞。详见 [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)。该依赖用于开发打包链，不作为同舟的账号共享缓存服务。

## 安装包测试复现

```powershell
$env:TONGZHOU_SMOKE_EXECUTABLE = Join-Path $PWD 'release/win-unpacked/Tongzhou.exe'
$env:TONGZHOU_COMPUTER_SMOKE = '1'
npm run test:package
```

电脑开关只用于显式验证新建的测试窗口。普通 CI 不操作桌面输入。`test:package` 同时覆盖系统打包路径和浏览器 Cookie 重启持久化；`TONGZHOU_PACKAGE_AUTO=1` 可自动选择当前平台的默认产物。

完整代码状态与产品边界见 [实施状态](IMPLEMENTATION_STATUS.md)。当前维持开发预览版，外部账号和平台项目未验收前不贴“全部测试完成”标签。
