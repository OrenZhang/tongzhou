<p align="center"><img src="docs/assets/logo.svg" width="78" alt="同舟" /></p>
<h1 align="center">同舟 Tongzhou</h1>
<p align="center"><strong>一个工作空间，多模型协作。</strong><br/>Windows · macOS · 开源 · 本地优先</p>
<p align="center"><a href="https://github.com/OrenZhang/tongzhou/releases">版本发布</a> · <a href="https://github.com/OrenZhang/tongzhou/issues">问题反馈</a> · <a href="CONTRIBUTING.md">参与贡献</a></p>

同舟是一个开源 AI 编程工作台，把模型、会话、项目和工具放在同一个桌面应用里。

你可以直接聊天，也可以打开项目，让 AI 阅读代码、修改文件、运行测试和处理 Git 操作。在同一个会话中切换模型，继续已有任务，减少在不同工具之间来回切换。

## 核心能力

- **多模型接入**：支持 ChatGPT、Kimi Code、MiniMax Code 账号接入，以及 OpenAI 兼容接口、Anthropic、Gemini 和本地模型服务。
- **连续会话**：保留聊天历史，支持中途补充、图片与文件附件、长文本转文件和历史上下文整理。
- **知识库**：本地资料与 Wiki、后台整理的每日记忆，支持来源核对、知识排查和会话按需引用。
- **项目开发**：文件搜索、代码预览、Git 变更审阅、命令执行与项目说明维护，文件和代码位置可直接引用到会话。
- **Agent 与插件**：自定义 Agent、并行分析，接入 MCP 和 Skills；按需启用浏览器、电脑控制和客户端管理能力。
- **通知与机器人**：连接飞书、企业微信、钉钉和邮件，接收任务通知；通过机器人查看会话进度、发起任务。
- **本地工作空间**：消息与配置保存在本地，凭据加密存储；支持权限设置、浅色/深色主题及字体调整。

目前处于开发预览阶段。不同平台、模型和第三方服务的支持情况，见 [实施状态](docs/IMPLEMENTATION_STATUS.md) 与 [验证记录](docs/VALIDATION.md)。

## 快速开始

准备 Node.js **22.19+（22 LTS）**、npm 和 Git，然后运行：

```bash
git clone https://github.com/OrenZhang/tongzhou.git
cd tongzhou
npm ci
npm run dev
```

启动后，在 **模型与订阅** 中添加连接、选择模型，即可开始聊天。需要开发代码时打开项目，在 **插件** 中启用所需能力；服务账号、通知和机器人在 **设置与优化 → 连接中心** 管理。

## 了解更多

[贡献指南](CONTRIBUTING.md) · [架构设计](docs/ARCHITECTURE.md) · [发布流程](docs/RELEASING.md) · [实际开发示例](examples/miniapp-admin/README.md)

欢迎通过 [Issues](https://github.com/OrenZhang/tongzhou/issues) 提交问题和建议，也欢迎贡献代码。

采用 [Apache-2.0](LICENSE) 许可证。第三方组件说明见 [NOTICE](NOTICE)。
