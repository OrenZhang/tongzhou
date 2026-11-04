# CoSail v1.0.6

**同舟 CoSail：从编码、验证到交付，让 AI 与工作模块一起完成任务。**

本版加强任务交付与模块联动，为画布补齐复杂编排，并修复图片预览、缓存、备份和记忆列表问题。

## 中文

- **编码与交付**：AI 项目任务可以通过业务工具暂存已完成检查点的改动、审阅暂存区并提交，不再被自身运行状态阻塞。同项目其他任务和原生子任务仍会阻止冲突操作；审批及内容指纹检查保留。暂存、恢复和提交按项目串行，防止并发操作把未审阅文件带入提交。
- **任务验证**：等待子任务不再占用实际完成检查的重试次数。检查失败后可在同一任务中继续修复，连续无进展会明确停止。新增验收覆盖保留用户改动、修复代码、真实检查失败后重试、交付说明入库与读回、保存记忆及下一轮恢复。
- **AI 与模块联动**：客户端能力目录支持按名称、模块和说明搜索，分页发现能力，查询准确参数，并定位当前会话。编码任务能够调用现有内容库和任务记忆完成交接。
- **复杂画布**：支持条件分支、逐项遍历、嵌套循环、独立分支并行、汇合与失败分支；可配置并发和执行步数，查看逐项运行记录。遍历按项顺序推进，每项内部可并行执行独立节点。
- **图片与缓存**：修复图片预览及资源解析；循环重新执行不可缓存节点，同时保留仍有效且允许缓存的成功媒体输出。模型、角色、权限或插件配置变化会影响缓存；原件缺失不再误报可复用。带有未完成远端任务的失败轮次不会自动重复提交。
- **资料与可靠性**：每日记忆按类型筛选后分页，普通资料不会再挤掉旧记忆；符号查询可检索。备份恢复包含画布、白板、导入工作流和运行历史。机器人任务范围排除内部及后台会话。
- **文档与桌面**：重写独立的[中文 README](https://github.com/OrenZhang/tongzhou/blob/main/README.md) 与 [English README](https://github.com/OrenZhang/tongzhou/blob/main/README.en.md)，补充能力、任务示例、安装和开发指引；桌面客户端统一使用 Electron。

## English

**CoSail connects coding, verification and delivery with the modules where your work lives.**

- **Code delivery**: AI project tasks can stage completed checkpoint changes, review the Git index and commit without being blocked by their own running state. Approval and content checks remain in place; other active project tasks and native subtasks still block conflicting operations. Staging, restoring and committing share a project lock so concurrent operations cannot add unreviewed files to a commit.
- **Task verification**: waiting for subtasks no longer consumes command verification attempts. Failed checks can continue in the same task for repair; repeated lack of progress stops explicitly. Integration coverage follows user changes through code repair, real command failures, delivery documents, task memory and the next conversation turn.
- **AI and module integration**: search the client capability catalog by name, module or description, page through results, inspect exact arguments and identify the current session. Coding tasks can use the existing content library and task memory to save and recover their handoff.
- **Canvas orchestration**: conditional branches, iteration, nested loops, parallel independent branches, joins and failure branches, with concurrency and step limits plus per-item history. Items run sequentially; independent nodes within an item can run in parallel.
- **Images and caching**: fixes image previews and resource resolution. Loops rerun non-cacheable nodes while retaining valid successful media from cacheable nodes. Effective model, role, permission and plugin settings affect cache reuse, missing originals invalidate cached output, and failed iterations with unresolved remote jobs are not silently resubmitted.
- **Knowledge and reliability**: daily memories are filtered before pagination, so newer ordinary documents no longer hide older memories. Symbol-only searches work. Backups include canvases, whiteboards, imported workflows and run history. Bot task access excludes internal and background sessions.
- **Documentation and desktop**: separate Chinese and English READMEs explain capabilities, task examples, installation and development. Desktop builds use Electron.

## 安装包 / Downloads

| 平台 / Platform     | 文件 / File                                                            |
| ------------------- | ---------------------------------------------------------------------- |
| Windows x64         | `CoSail-1.0.6-win-x64.exe`                                             |
| macOS Apple Silicon | `CoSail-1.0.6-mac-arm64.dmg`                                           |
| macOS Intel         | `CoSail-1.0.6-mac-x64.dmg`                                             |
| Linux x64           | `CoSail-1.0.6-linux-x86_64.AppImage` or `CoSail-1.0.6-linux-amd64.deb` |

macOS ZIP、更新清单与各平台 `SHA256SUMS-*` 校验文件随安装包提供。Linux 电脑控制面向 X11 / XWayland；电源与合盖功能限 Windows / macOS。未配置签名证书时提供未签名包；未签名 macOS 和 Linux 客户端通过下载新版安装包更新。

macOS ZIP files, update manifests and platform-specific `SHA256SUMS-*` files are included. Linux computer control requires X11/XWayland. Power and lid controls are available on Windows/macOS. Packages are unsigned when signing credentials are not configured; unsigned macOS and Linux builds update through a new installer download.

## 升级说明 / Upgrade notes

升级后请重新导出备份：旧版备份未包含的画布数据无法由旧备份恢复，需要从仍保留数据的客户端重新导出。模型和媒体生成使用你配置的服务及认证，能力与费用由对应服务决定；本地存储不代表云端模型调用离线运行。

Export a fresh backup after upgrading. Older archives cannot restore canvas data they never contained; re-export from a client that still has the data. Models and media generation use your configured services and credentials. Their capabilities and costs depend on the provider; local storage does not make cloud inference offline.

本版调整了缓存指纹。升级后首次重跑旧流程时，旧成功结果可能无法复用并产生新的生成费用；已有产物和运行记录仍保留。未完成远端任务仍需先检查，关闭结果复用表示明确重新提交。

Cache fingerprints have changed. The first rerun of an older workflow may regenerate previously successful results and incur new provider charges; existing outputs and history are retained. Check unresolved remote jobs first. Turning off result reuse explicitly allows a new submission.
