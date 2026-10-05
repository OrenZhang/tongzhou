# 模型思考

在「模型与订阅 → 编辑连接 → 高级：模型思考」配置。新连接和旧连接默认开启；同一连接的会话共用设置，保存后从下一轮生效。思考摘要是否返回由模型服务决定，与运行过程的展开、折叠无关。

- ChatGPT 订阅：读取引擎公布的模型能力，开启时优先使用中等强度，关闭时使用 `none` 或模型支持的最低强度。
- Kimi / MiniMax 订阅：读取引擎提供的思考选项。引擎未提供选项时保留服务默认，并在运行记录说明。
- 直接 API：为已识别的 OpenAI、DeepSeek、Kimi、Claude、Gemini 模型发送对应协议的思考参数。未识别的兼容模型沿用服务默认，避免向网关发送不支持的参数。
- 始终思考的模型不能彻底关闭；界面和运行记录会说明。Claude 手动预算模式要求单次最大输出至少 2048 Tokens。

工具续跑会保留同一连接、同一模型所需的思考状态；切换连接、模型或整理未完成的工具调用时，不复用这些协议状态。它们计入上下文整理预算。

验证覆盖设置持久化、请求参数、订阅引擎配置、流式工具续跑和桌面设置交互。自动化测试使用本地模拟服务，不代表所有第三方账户均已完成真实推理验证。

协议依据：[OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning)、[DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)、[Claude extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)、[Gemini thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking)。订阅引擎使用安装版本实际公开的能力字段。
