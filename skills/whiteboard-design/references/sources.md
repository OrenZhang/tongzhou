# 来源与能力边界

2026-10-18 核对。官方资料用于理解底层语义；CoSail 工具描述和当前安装版本决定可调用能力。本产品使用 @excalidraw/excalidraw 0.18.1，线上文档可能更新。

- [Excalidraw 元素创建](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton)：程序创建可编辑图形、容器文字和绑定箭头；CoSail 将连接封装为 connect，不直接接受 Skeleton 的 start/end 字段。
- [恢复工具](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/utils/restore)：恢复场景和修复元素引用；restore 不能推断自由线原本想连接谁。
- [导出工具](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/utils/export)：图像/矢量输出的基础。CoSail 通过原生菜单提供。
- [Mermaid 转换 API](https://docs.excalidraw.com/docs/@excalidraw/mermaid-to-excalidraw/api)：可用于未来增强。当前 CoSail 未开放 Mermaid 导入工具，不能承诺粘贴 Mermaid 即可执行。

本地实现：electron/modules/canvas/whiteboard.ts、canvas-tools.ts；前端 WhiteboardBoard.tsx。connect 同 ID 修复、connections 核验、版本冲突处理是 CoSail 自己的约定，不要当作所有 Excalidraw 集成共有的 API。
