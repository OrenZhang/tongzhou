import type { CanvasNodePluginDefinition } from './canvas';

/** Public v1 presentation contract. Executable code stays in the owning extension. */
export const canvasVisualPlugins: Omit<CanvasNodePluginDefinition, 'configSchema'>[] = [
  {
    id: 'visual.markdown',
    name: 'Markdown',
    description: '格式化文档，可连接到下游作为文本输入',
    view: { renderer: 'markdown', textLabel: 'Markdown 正文' },
    defaults: { text: '# 标题\n\n在这里记录你的想法。', width: 320, height: 260 },
  },
  {
    id: 'visual.svg',
    name: 'SVG',
    description: '矢量图预览，输出 SVG 源码',
    view: { renderer: 'svg', textLabel: 'SVG 源码' },
    defaults: {
      text: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" rx="20" fill="#dce8ff"/><circle cx="160" cy="90" r="48" fill="#6688cc"/></svg>',
      width: 320,
      height: 250,
    },
  },
  {
    id: 'visual.html',
    name: 'HTML',
    description: '隔离预览 HTML 与 CSS，输出 HTML 源码',
    view: { renderer: 'html', textLabel: 'HTML 源码' },
    defaults: {
      text: '<style>body { font-family: sans-serif; padding: 20px; color: #334155; }</style><h1>你好，CoSail</h1><p>在节点中预览 HTML。</p>',
      width: 360,
      height: 280,
    },
  },
  {
    id: 'visual.panorama',
    name: '3D 全景',
    description: '选择等距柱状全景图，拖动环视；向下游传递原始图片',
    view: { renderer: 'panorama', textLabel: '图片说明', resource: 'image' },
    defaults: { width: 400, height: 280, config: { yaw: 0, pitch: 0, fov: 75 } },
  },
  {
    id: 'visual.sticky-note',
    name: '便利贴',
    description: '画布便签与标注，也可作为文本输入',
    view: { renderer: 'sticky-note', textLabel: '便签内容' },
    defaults: { text: '记下一个想法…', width: 240, height: 220, config: { color: 'yellow' } },
  },
].map((p) => ({
  ...p,
  kind: 'plugin',
  version: 1,
  apiVersion: 1,
  adapter: 'visual',
  source: true,
  inputs: [],
  outputs: p.id === 'visual.panorama' ? ['text', 'image'] : ['text'],
})) as Omit<CanvasNodePluginDefinition, 'configSchema'>[];
