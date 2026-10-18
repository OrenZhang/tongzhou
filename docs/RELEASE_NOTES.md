# CoSail v1.0.4

**同舟 CoSail · 与 AI 同行，让想法抵达。**

本版完善创作工作台，将节点工作流、自由白板和 AI 协作接入同一入口。

- **创作入口**：打开后选择工作流画布或白板，支持继续最近的创作。节点库默认显示紧凑图标，可展开、收起和拖入节点。
- **可编辑白板**：集成 Excalidraw，支持绘图、图片、画框、素材库、原生文件导入导出及 PNG/SVG 导出。AI 可创建和修改图形、布局及绑定箭头，移动图形时连线跟随；支持撤销、保存与冲突提示。编辑器和字体随应用打包。
- **专属 Agent 与技能**：新建画布和白板自动关联对应 Agent、工具及内置技能；涵盖流程图、工作流、人物三视图、参考图及媒体生成。生成能力仍需配置可用插件，按真实工具结果判断完成。
- **节点编辑**：点击节点直接编辑配置，配置与聊天使用独立浮窗；缩小连接点，悬停再显示端口名称；调整媒体布局，移除重复标题和多余按钮。
- **素材与来源**：支持关联内容库、作品、会话消息、项目文件和导入本地文件；文本类节点支持外部地址。完善媒体结果保存、资源引用及失败重试。
- **智库整理**：内容库置于首位；新增紧凑的创作列表，支持搜索、筛选、重命名、删除和直接打开。作品日期分组可折叠，并记住状态。
- **界面与可靠性**：补充中英文文案、优化弹窗边距和模块导航，统一通知目标选择；扩展画布、白板、会话关联和智库的自动回归检查。

白板提供本地编辑与 AI 协作，不包含 excalidraw.com 在线房间或多人实时协作服务。

## English

**CoSail · Sail with AI. Bring ideas to life.**

- **Studio** brings workflow canvases and Excalidraw whiteboards together, with compact creation choices, recent files and a collapsible node palette.
- **Editable whiteboards** support drawing, images, frames, libraries, native files and PNG/SVG export. AI can edit shapes, layouts and bound arrows, with undo, local saving and conflict handling. The editor and fonts are bundled locally.
- **Dedicated agents and skills** connect each creation mode to its tools, covering diagrams, workflows, character turnarounds, reference images and media generation through configured plugins.
- **Node editing** opens on click. Configuration and chat use separate floating panels; smaller ports reveal labels on hover, and media previews use space more effectively.
- **Resources** can come from the content library, artifacts, messages, project files or local uploads. Text-based nodes can also load external URLs. Media saving, references and retry behavior are improved.
- **Knowledge Center** puts the content library first and adds a compact Studio list with search, filters, rename, delete and direct reopening. Artifact date groups remember their collapsed state.
- **Polish and validation** include Chinese/English copy, dialog spacing, module navigation, notification targets and expanded desktop regression coverage.

Whiteboards support local editing and AI assistance; hosted multiplayer rooms and Excalidraw cloud accounts are not included.

## 安装包 / Downloads

Windows：`win-x64.exe`。Apple Silicon：`mac-arm64.dmg`。Intel Mac：`mac-x64.dmg`。macOS ZIP 用于更新通道。Linux：`linux-x86_64.AppImage` 或 `linux-amd64.deb`。各平台校验文件为 `SHA256SUMS-*`。

Linux 电脑控制目前面向 X11 / XWayland；电源与合盖功能仅支持 Windows / macOS。未配置发布证书的安装包未签名，macOS 未签名版本及 Linux 版本通过下载新版安装包更新。

Choose the installer for your operating system and architecture. Platform-specific `SHA256SUMS-*` files are included. Linux computer control requires X11/XWayland. Unsigned macOS builds and Linux builds are updated by downloading a new installer.
