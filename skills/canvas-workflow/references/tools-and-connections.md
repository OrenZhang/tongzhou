# 工具与连接

## 选择实际能力

| 需求                      | 内置节点/工具                  | 核对点                                                                    |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------------- |
| 文字、Markdown、HTML、SVG | text、visual.markdown/html/svg | 正文 text 可手动编辑；HTML/SVG 隔离预览不执行脚本，不承诺远程网页完整运行 |
| 已有资料与作品            | resource                       | 内容库、作品、会话消息或工作区文件引用；保留 ID 和内容版本                |
| 人物/场景/道具提取        | content.split                  | dynamicOutputs 随 config.categories 变化；连线取类别 ID                   |
| 模型整理或加工            | agent                          | 模型、权限与执行会话；输入上下文和输出是否符合下游                        |
| 人物图片、视频、音频      | image/video/audio              | canvas_list.mediaTools 中实际工具及 inputSchema                           |
| 合并提示词                | workflow.template              | {{input}}、{{input.1}}、{{date}}、{{time}}；日期时间为 UTC                |
| 等待                      | workflow.wait                  | 查看 configSchema 的时间参数；不是无限轮询替代品                          |
| 定时触发                  | workflow.schedule              | 保存节点不等于已发布自动化；需实际发布入口，应用须运行                    |
| 渠道通知                  | workflow.notify                | 已配置的真实 targetId、内容和用户发送意图；不编造接收人                   |
| 保存结果                  | save                           | 选择真实内容库/文件夹；保留媒体原件与来源                                 |
| 插件节点                  | 当前 catalog 中声明的插件      | 不假定所有 MCP 工具都能直接变成节点；按可用节点定义和 schema 操作         |

本表是导航，不是固定工具列表。`canvas_read(pluginIds)` 返回定义才是本次配置依据。定时发布和目标查找若未暴露到会话工具，使用原生配置入口或当前 client 工具发现机制；不能虚构 `canvas_schedule` 等命令。

## 端口连接

每条边包括 id、from、to、kind、fromPort、toPort。例如文字节点 result → 图片 prompt：

```json
{
  "type": "put_edge",
  "edge": {
    "id": "description-to-image",
    "from": "character-description",
    "to": "character-image",
    "kind": "dependency",
    "fromPort": "result",
    "toPort": "prompt"
  }
}
```

`dependency` 将上游纳入下游执行依赖；`reference` 表示资料引用，不保证启动上游生成。上游必须运行产出时用 dependency，不能只画一条 reference 线就认为会生成。

常见媒体输入端口是 `prompt`（文字）、`reference`（图像）、视频 `firstFrame` / `lastFrame`（图像），输出为 `result`。必须核对实际定义；图片结果不能连到 prompt 来代替参考图。内容拆分使用 `characters/scenes/props` 或自定义类别 ID，从类别输出连到目标 prompt；修改类别后清理失效边。

已有图片资源展示：媒体节点使用 `resource:{kind:"artifact",id:真实ID}` 与 `media:{mode:"existing"}`，无需生成。内容库使用 `{kind:"content",id,version}`；作品只有 id；文件需要 projectId/path；会话消息需要 sessionId/id。不要把 URL 填进 id。外部地址和本地上传可以通过资源选择器导入，HTML 等节点也有内容来源入口，载入后是独立可编辑正文快照。

## 节点更新

`put_node` 是完整替换：先读原节点，再复制保留 kind/pluginId/config/resource/media/位置/尺寸等字段。只改 text 却省略 media 会丢失生成工具配置。`put_edge` 更新同 ID 连线；remove_edge 只删指定线。旧版文档、网络示例和上游工具字段不能直接覆盖本产品节点 schema。

纯工作流不支持执行依赖环。重复尝试属于运行策略或下一次定时触发；画重试业务说明用白板，不能把它作为工作流循环执行。
