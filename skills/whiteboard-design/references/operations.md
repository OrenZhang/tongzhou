# 操作与绑定

## 可执行最小例子

先 whiteboard_read 得到 canvasId/version，再提交下列 ops；ID 仅作新白板示例，实际修改必须用读到的 ID：

```json
[
  {
    "type": "add",
    "element": {
      "id": "start",
      "type": "ellipse",
      "x": 80,
      "y": 80,
      "width": 160,
      "height": 80,
      "text": "开始"
    }
  },
  {
    "type": "add",
    "element": {
      "id": "check",
      "type": "diamond",
      "x": 60,
      "y": 240,
      "width": 200,
      "height": 140,
      "text": "验证通过？"
    }
  },
  { "type": "connect", "id": "start-check", "from": "start", "to": "check" }
]
```

`rectangle/ellipse/diamond` 的 text 生成绑定文字；箭头的 text 生成绑定标签。文本不是图片，可以在原生编辑器修改。裸 text 元素适合标题、注释；带容器的 text 不能作为另一个箭头的独立目标，应连接其容器 ID。

## 修复、改接和解绑

已有 `edge-1` 指向错误目标：

```json
[{ "type": "connect", "id": "edge-1", "from": "check", "to": "success", "text": "是" }]
```

connect 的 id 可以指向已有箭头。省略 text/strokeColor 时保留原文字和颜色。若需要改变折线，用 update.points（相对于箭头 x/y 的坐标）；保持两端绑定，修改后核对折点和标签。

需要单端绑定或解绑时：

```json
[
  {
    "type": "update",
    "id": "edge-1",
    "patch": { "startBinding": { "elementId": "check", "focus": 0, "gap": 8 }, "endBinding": null }
  }
]
```

只有箭头支持绑定。工具维护目标图形的反向 boundElements；不要自己伪造该数组。绑定目标必须已存在且未删除。删除图形会解除相关箭头对应端点；若用户要求删除整个分支，应显式删除其无用连线，不能把半绑定箭头当作完成。

## 读取与核验

whiteboard_read 支持 elementIds、offset、limit。较大图先读概览和全图 connections，再分片读相关元素；返回 nextOffset 时继续读取需要的部分，不把第一页当全图。connections 提供 `{id,from,to,bound,text}`；bound=true 只表示双端有引用，还应核对 ID 是否为预期关系。

检查图形的 boundElements 中包含相应箭头，箭头标签的 containerId 指向该箭头，文字没有重复。对于刻意自由的标注箭头，bound=false 可以合理；不要强行绑定所有装饰线。

## 图片、分组和导出

图片元素只能使用 whiteboard_read.files 已有 fileId；没有 fileId 时请先通过界面导入，不可编造 data URL 字段或把远程网址当 fileId。生成作品到白板目前需要实际导入桥接，不能声称仅填写 artifactId 就能显示。

update 可修改 groupIds、frameId、locked、link、样式；frameId 必须指向 frame。建立分组后检查原生拖动是否符合意图；不要将业务分支误当成绘图分组。PNG/SVG/Excalidraw 导入导出由白板菜单提供；图像导出和可编辑场景导出用途不同，在线多人服务另需接入。
