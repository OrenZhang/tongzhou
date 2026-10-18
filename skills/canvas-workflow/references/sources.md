# 来源与实际能力

核对日期：2026-10-18。以下是第一方资料，具体可用参数始终以 CoSail 当前 canvas_list/mediaTools 和插件 schema 为准。

- [MiniMax 官方 MCP](https://github.com/MiniMax-AI/MiniMax-MCP)：提供图像、视频、语音等工具，工具组合与本地安装版本有关。
- [MiniMax 文档索引](https://platform.minimax.io/docs/llms.txt)：定位图生图、主体参考、图生视频、首尾帧和下载文档；不把文档列出的能力当作当前账号均可用。
- [图生视频接口](https://platform.minimax.io/docs/api-reference/video-generation-i2v)：以图像和可选文本提交异步视频任务。任务创建与最终文件下载分别核验。
- [Excalidraw 元素创建](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton)：用于区分绘图绑定与可执行工作流端口，不能混用两者 JSON。

角色六格布局、默认验收清单和节点编排是 CoSail 的制作约定，不是供应商保证。当前标准媒体映射见 electron/modules/canvas/media.ts；端口定义见 src/shared/canvas-ports.ts；分阶段恢复见 canvas_execute 的 regenerate schema。官方模型更新时无需修改技能中的固定型号，因为本技能不固定型号。

相关本地技能：tongzhou-manju-production 用于小说改编、导演规划、人物/场景/道具资产文稿和分镜连续性。画布技能负责把它的实际产物与资源接入可执行流程，不替代原文和采用稿审查。
