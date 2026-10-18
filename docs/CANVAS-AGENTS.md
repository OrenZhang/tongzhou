# 画布协作与内置专家

新建/关联/切换工作流画布时，会话自动使用“工作流编排”；白板使用“白板设计”。没有会话时创建关联会话。保留会话权限；切换类型不改变已有画布内容。

| 类型            | Agent                       | 默认技能                   | 当前模式的编辑工具               |
| --------------- | --------------------------- | -------------------------- | -------------------------------- |
| 工作流          | builtin-canvas-workflow     | tongzhou-canvas-workflow   | canvas_read/apply/execute/cancel |
| Excalidraw 白板 | builtin-whiteboard-designer | tongzhou-whiteboard-design | whiteboard_read/apply            |

canvas_list 和创建入口用于发现/切换；切换后的下一轮重新准备工具。技能主文件随对应 Agent 自动进入上下文，参考资料通过 read_skill_file 按需读取。用户停用的技能不自动重新启用。Agent 页面可调整指令和模型偏好，技能内容随版本升级维护。

工作流中的 Agent 处理节点使用节点自身角色，未指定时用通用处理助手，不递归继承“工作流编排”角色。人物生成、参考图、首尾帧、恢复与作品入库细则见 skills/canvas-workflow/references/characters-and-media.md。

## 绑定修复

`whiteboard_apply` 的 connect 创建真正绑定箭头；使用已有箭头 ID 可以原位修复或更换目标，保留标签、样式和折点。add/update 支持 startBinding/endBinding，null 解除对应端点。工具维护反向 boundElements，whiteboard_read/apply 返回 connections 供核验。add arrow 仅有坐标是自由线段，不能当作关系绑定。

## 回归入口

- `npx vitest run tests/modules/canvas tests/modules/agents tests/modules/plugins/skills.test.ts tests/core/tools/extensions.test.ts`：图形/端口/媒体/恢复/权限/技能与绑定回归。
- `node scripts/testing/whiteboard-smoke.mjs`：模拟模型真实工具分发，原生鼠标拖动与连线跟随、撤销/重做、导入导出、持久化。
- `node scripts/testing/canvas-smoke.mjs`：工作流、动态拆分端口、定时、通知审批与保存。
- `node scripts/testing/canvas-routing-smoke.mjs`：界面新建与切换后会话、Agent、技能的关联。
- `scripts/testing/canvas-live-specialists.mjs`：显式设置 TONGZHOU_LIVE_CANVAS=1 与 TONGZHOU_NATIVE_SOURCE 后，使用授权 MiniMax 账号的隔离副本测试简单图、绑定修复、复杂登录回路、人物图片→视频首帧配置。会消耗文本模型额度；不运行付费媒体生成，不发通知。结束清理测试账号副本，保留不含凭据的报告。

2026-10-18：136 项单元测试通过；以上桌面回归通过；MiniMax M3 四个真实会话用例通过。真实媒体的画面质量与任意更大图的自动排版不由这些测试保证。
