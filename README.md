<p align="center"><img src="docs/assets/logo.svg" width="78" alt="CoSail" /></p>
<h1 align="center">同舟 CoSail</h1>
<p align="center"><strong>与 AI 同行，让想法抵达。</strong></p>
<p align="center">Windows · macOS · 开源 · 本地优先</p>
<p align="center">简体中文 · <a href="README.en.md">English</a></p>
<p align="center"><a href="https://github.com/OrenZhang/tongzhou/releases">下载与版本</a> · <a href="https://github.com/OrenZhang/tongzhou/issues">问题反馈</a> · <a href="CONTRIBUTING.md">参与贡献</a></p>

CoSail 是一个开源、本地优先的 AI 工作台。把模型、会话、知识和创作放在一起，从一个想法开始，持续推进到完成。

## 你可以做什么

- **自由选择模型**：接入 ChatGPT、Kimi、MiniMax、兼容 API 与本地模型，在同一会话中切换使用。
- **积累自己的知识**：管理资料、笔记与会话记忆，让 AI 帮你检索、整理和复用。
- **在画布上创作**：用对话搭建工作流，连接文本、图片、视频、音频和工具节点。
- **与 AI 一起画图**：内置 Excalidraw 白板，手动绘制流程图与草图，也能让 AI 创建图形、修改选区和调整布局。
- **一起完成项目**：搜索文件、编写代码、审阅变更，持续调整和完善。
- **连接常用工具**：通过 MCP、Skills、渠道通知与定时任务扩展工作方式。
- **保留本地掌控**：会话与资料本地保存，支持备份恢复和权限管理。

界面支持简体中文与 English，可在 **设置 → 外观与字体 → 界面语言** 中切换。

## 快速开始

从 [Releases](https://github.com/OrenZhang/tongzhou/releases) 获取发布版本，或使用 Node.js **22.19+（22 LTS）**、npm 和 Git 从源码启动：

```bash
git clone https://github.com/OrenZhang/tongzhou.git
cd tongzhou
npm ci
npm run dev
```

启动后，在 **模型** 中添加连接或登录支持的账号，开启会话即可使用。需要更多工具时，在 **插件** 中配置并启用。

## 了解更多

- [使用指南](docs/USAGE.md) · [本地智库](docs/KNOWLEDGE-CENTER.md) · [画布节点插件](docs/CANVAS_NODES.md)
- [贡献指南](CONTRIBUTING.md) · [架构设计](docs/ARCHITECTURE.md) · [发布流程](docs/RELEASING.md)
- [实施状态](docs/IMPLEMENTATION_STATUS.md) · [验证记录](docs/VALIDATION.md)

当前为开发预览版本。模型和插件能力取决于对应服务及账号权益；使用云端服务时，任务所需内容会发送给该服务。远程渠道与定时任务需要本地客户端在线。

采用 [Apache-2.0](LICENSE) 许可证。第三方组件说明见 [NOTICE](NOTICE)。
