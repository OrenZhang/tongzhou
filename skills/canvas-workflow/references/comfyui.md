# ComfyUI 工作流

## 选择接入方式

- 用户希望查看、修改内部节点或复用已有 JSON：`canvas_import_comfy {workflow,connectionId?}`。workflow 是 JSON 字符串，支持 API 格式和 UI 0.4 / 1.0；导入不会启动生成。
- 用户希望将一整段 API 流程作为一个步骤：使用 `comfyui.workflow` 节点。先用 `canvas_read {pluginIds:["comfyui.workflow"]}` 获取配置与端口；配置 connectionId、workflow 和 bindings。
- ComfyUI 专用会话工具只在已启用服务或当前画布含 ComfyUI 节点时提供，避免普通会话加载无关工具。先用 canvas_list 的 comfyuiConnections 检查；没有连接时可先从界面导入并配置服务，不假造不存在的工具。

服务在插件页配置为 ComfyUI；复用已启用连接的 ID，不创建假的 MCP 工具名，不把 token 放入节点。

## 展开的导入图

`canvas_comfy_configure {canvasId,version,connectionId}` 获取服务实际节点定义、解析控件并更新参数表单。读取返回的新版本和 warnings；未绑定服务、缺少节点／模型或未映射自定义控件时先解决问题。普通 UI 中的旁路、禁用、子图及无法映射的自定义控件不能假定兼容；可以请用户从 ComfyUI 导出 API 格式。

节点的 `config.values` 是可编辑参数；外部输入用插件声明的 `in:<参数名>` 端口。内部边使用 `out:<输出槽>`。`definition` 是导入的声明快照；修改节点时保留，不自行编造类型或删掉元数据。布局和节点 ID 可保持不变。

`comfyui:MODEL`、`comfyui:LATENT`、`comfyui:IMAGE` 等是服务内类型，不能接到 Agent 或普通资源端口。输出节点的 `files` 才是已保存原件；连接它到保存／Agent 等后续节点。文本上游可连接 `in:text` 等文本参数，参考图片可连接 LoadImage 的 `in:image`。不能把本地路径直接当作远程服务文件名。

运行仍使用 `canvas_execute`，ComfyUI 图内部整体提交一次，不逐节点重复提交。检查具体 run 的状态与 output.resources，真实图片只能来自成功下载保存的作品。

## 单节点 API 流程

`comfyui.workflow` 输入端口为 `prompt`（文本）、`reference`（图片），输出为 `result`（生成文件）。示例配置：

```json
{
  "connectionId": "实际服务ID",
  "workflow": "用户提供的 API 格式 JSON 字符串",
  "bindings": [
    { "port": "prompt", "nodeId": "6", "field": "text" },
    { "port": "reference", "nodeId": "10", "field": "image" }
  ]
}
```

绑定中的 nodeId 是 ComfyUI 流程内 ID，不是外层画布节点 ID。字段名必须来自对应节点定义；不要根据示例猜用户流程里的 ID。无上游输入时使用流程已有参数；连接了输入却未绑定会明确失败。

## 继续查询与导出

历史 run 的 external 保存远端任务 ID。查询中断后，使用 `canvas_execute {canvasId,version,sessionId,resumeRunId:"原运行ID"}` 查询同一任务；参数或服务改变后不允许以“继续查询”重新生成。没有远端 ID 的提交结果未知，不能自动重发。

停止会中止本地跟踪，远端任务可能仍在运行；不要声称已停止 GPU 执行。重新查询失败后先核对服务历史，避免重复生成。

`canvas_comfy_export` 返回当前图的 API JSON。画布项目／模板导出另走原有导出能力，会保留导入原件，并移除服务绑定；接收端重新选择服务并检查。混合原生节点不能直接导出为 ComfyUI API 工作流。
