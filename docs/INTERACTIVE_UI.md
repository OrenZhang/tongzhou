# 会话图表与交互预览

Markdown 展示层统一用于会话及文档内容。Mermaid 围栏默认渲染为图表；未标语言或标为纯文本的代码块，只有以明确的 Mermaid 语法头开头才自动识别。普通箭头文字仍保持原样，不猜测或改写已有内容。

`html`、`htm`、`html-preview` 围栏默认展示 HTML 交互预览，包含内联 CSS 与 JavaScript，可用于按钮、列表切换、输入、计算、SVG、canvas 等独立界面。仅需要展示 HTML 源码时可以使用 `xml` 围栏。未闭合的流式围栏不会执行。预览支持源码切换、就地展开和重新运行；源码切换保留当前交互状态，重新运行、切换会话或重新打开文件会重置状态。

项目侧边工作区的 `.html` / `.htm` 文件、作品中的 HTML 文档复用同一个 `HtmlPreview`。当前预览只支持单文件，引用相邻文件、远程资源、外部脚本和 CDN 不会加载。作品预览仍受现有文本读取长度上限约束。

## 实现边界

- `src/components/markdown/presentation.ts`：语法识别与围栏完整性检查。
- `src/components/markdown/HtmlPreview.tsx`：消息展示、源码和局部展开。
- `public/interactive-preview.html`：静态沙箱运行页，由 Vite 复制到产物。
- `electron/services/desktop/preview-navigation.ts`：阻止子框架导航到文件、网站及其他协议。
- `prompts/visualizations.json`：单独维护的模型输出约定，随通用身份提示词注入。

HTML 运行于仅 `allow-scripts` 的不透明来源 iframe。主界面保持原有 CSP；预览页使用独立 CSP，禁用网络、嵌套框架、外部脚本、表单提交和插件，仅允许内联脚本、样式及 data/blob 图片。预览不能访问父页面、Node 或客户端 IPC，不提供执行工具的消息桥。父界面只接收当前 iframe 的就绪、尺寸和运行状态消息，并限制尺寸范围。预览不是 MCP Apps 协议实现，也不消费 Codex 专有的 visualize 标记。

## 验证

- `npx vitest run tests/ui/presentation.test.ts tests/modules/agents/assistant-identity.test.ts`
- `node scripts/testing/interactive-ui-smoke.mjs`：独立隐藏窗口验证交互、尺寸、隔离和导航限制，不依赖客户端其余页面。
- `npm run build` 后执行 `npm run test:markdown`：真实客户端验证 8 类 Mermaid、数学公式、代码、流式消息、HTML 鼠标交互与隔离回归。

设计参考：[ChatGPT 与 Codex 更新记录](https://learn.chatgpt.com/docs/changelog)、[官方 UI quickstart](https://developers.openai.com/plugins/build/app-quickstart)。本实现提供同舟自己的会话预览格式，不假设 Codex 开源执行核心自动提供桌面渲染能力。
