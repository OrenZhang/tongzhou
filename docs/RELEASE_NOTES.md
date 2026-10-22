# CoSail v1.0.5

**同舟 CoSail · 与 AI 同行，让想法抵达。**

本版打通模型能力与画布选择，补齐内容库的手动分类和引用维护。

- **模型与画布**：分别标记文本、图片理解、图像/视频/音频生成等能力，绑定实际媒体工具；画布按节点与模式筛选。工具目录明确列出模型时可辅助匹配，多个工具同名时由用户选择。
- **执行一致性**：界面与 AI 使用同一生成模型目录；检查模型枚举、工具可用性和参考图/首尾帧模式。绑定变更时明确提示，不静默切换服务。媒体专用模型不会被自动路由到聊天接口。
- **通用内容库**：增加类型与标签筛选，支持手动维护目录、自定义类型、标签及来源引用。保留稳定文档 ID 和版本；单独调整分类不会刷新已有来源版本，并发修改时拒绝覆盖。
- **漫剧技能**：完善项目公共资产、章节引用、提示词及生成记录的维护规范，复用现有内容库，不把个人知识库固定成漫剧结构。
- **本次 main 累积更新**：包含 ComfyUI 工作流接入、漫剧制作资料及 Tauri 桌面宿主预览。ComfyUI 的真实模型出图仍需用户服务验收；正式下载继续提供 Electron 安装包。

能力标记不会凭空增加接口支持。生成使用所绑定插件的连接与认证；不包含任意 OpenAI 兼容地址的通用媒体直连、infinite-canvas 远程节点插件兼容或 WebDAV 同步。语音识别目前仅记录能力，没有新增转写节点。

## English

**CoSail · Sail with AI. Bring ideas to life.**

- **Models and canvas**: classify model capabilities separately and bind image, video or audio generation to actual tools. Canvas choices are filtered by node and mode; exact tool-catalog IDs assist configuration without guessing from names.
- **Consistent execution**: the UI and AI share the same generation catalog. Model IDs, available tools and reference/frame modes are validated. Changed bindings require reselection; media-only models are excluded from chat routing.
- **General-purpose content library**: filter by type and tags, edit folders and custom metadata, and maintain versioned source references. Classification changes preserve source versions, and concurrent edits cannot silently overwrite content.
- **Comic-production skill**: project assets, chapter references, prompt variants and generation records use the shared content library without imposing a comic-specific structure on personal knowledge.
- **Accumulated main updates** include ComfyUI workflow integration, production references and a Tauri host preview. Official installers remain Electron-based; live ComfyUI generation requires validation against your service.

Generation uses the bound plugin's connection and credentials. Capability labels do not add unsupported APIs. Generic media endpoints, remote infinite-canvas plugins and WebDAV sync are not included; transcription is a capability label only.

## 安装包 / Downloads

Windows：`win-x64.exe`。Apple Silicon：`mac-arm64.dmg`。Intel Mac：`mac-x64.dmg`。macOS ZIP 用于更新通道。Linux：`linux-x86_64.AppImage` 或 `linux-amd64.deb`。各平台校验文件为 `SHA256SUMS-*`。

Linux 电脑控制目前面向 X11 / XWayland；电源与合盖功能仅支持 Windows / macOS。未配置发布证书的安装包未签名，macOS 未签名版本及 Linux 版本通过下载新版安装包更新。

Choose the installer for your operating system and architecture. Platform-specific `SHA256SUMS-*` files are included. Linux computer control requires X11/XWayland. Unsigned macOS builds and Linux builds are updated by downloading a new installer.
