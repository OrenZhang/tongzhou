import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canvasWriteSchema, executionOrder } from './canvas';
import type { Canvases } from './canvas';
import type { Canvas, CanvasNode, CanvasResource } from '../../../src/shared/canvas';
import type { CanvasResources } from './workflow';
import type { ContentWorkspace } from '../content/content';
import type { Knowledge } from '../knowledge/knowledge';
import type { Artifacts } from '../artifacts/artifacts';

export const MAX_CANVAS_PACKAGE = 96 * 1024 * 1024;
const MAX_ASSETS = 64 * 1024 * 1024;
const assetSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(180),
    data: z.string().max(MAX_CANVAS_PACKAGE),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const packageSchema = z
  .object({
    format: z.literal('tongzhou-canvas'),
    version: z.literal(1),
    mode: z.enum(['template', 'project']),
    canvas: canvasWriteSchema.omit({ id: true, version: true }),
    assets: z.array(assetSchema).max(400),
  })
  .strict();
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Keep reusable settings, but do not copy credentials embedded in custom tool fields. */
function publicConfig(value: unknown, depth = 0): any {
  if (depth > 16) throw new Error('节点配置嵌套过深');
  if (Array.isArray(value)) return value.map((v) => publicConfig(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/^(api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|client[-_]?secret|authorization|cookie|headers)$/i.test(
            key,
          ),
      )
      .map(([key, v]) => [key, publicConfig(v, depth + 1)]),
  );
}
/** Connection IDs and output paths must be selected on the receiving machine. */
function portable(node: CanvasNode): CanvasNode {
  const { providerId: _p, agentId: _a, libraryId: _l, folderId: _f, ...n } = structuredClone(node);
  if (n.kind === 'save') Object.assign(n, { libraryId: 'default' });
  if (_p) n.model = undefined;
  if (n.config) {
    n.config = publicConfig(n.config);
    if (n.kind === 'plugin') delete n.config!.pluginId;
    if (n.pluginId === 'workflow.notify') delete n.config!.targetId;
  }
  if (n.media) {
    const { pluginId: _mp, destination: _d, ...media } = n.media;
    n.media = {
      ...media,
      parameters: media.parameters ? publicConfig(media.parameters) : undefined,
      destination: { kind: 'artifacts' },
    };
  }
  return n;
}
async function mapResources(
  node: CanvasNode,
  map: (r: CanvasResource) => Promise<CanvasResource | undefined>,
) {
  if (node.resource) node.resource = await map(node.resource);
  if (node.media?.firstFrame) node.media.firstFrame = await map(node.media.firstFrame);
  if (node.media?.lastFrame) node.media.lastFrame = await map(node.media.lastFrame);
  if (node.media?.referenceImages) {
    const refs: CanvasResource[] = [];
    for (const ref of node.media.referenceImages) {
      const next = await map(ref);
      if (next) refs.push(next);
    }
    node.media.referenceImages = refs;
  }
}

export class CanvasTransfer {
  constructor(
    private canvases: Canvases,
    private resources: CanvasResources,
    private content: ContentWorkspace,
    private knowledge: Knowledge,
    private artifacts: Artifacts,
  ) {}

  async encode(id: string, version: number, mode: 'template' | 'project') {
    const source = this.canvases.get(id);
    if (source.mode === 'whiteboard') throw new Error('请在白板菜单导出 Excalidraw、PNG 或 SVG');
    if (source.version !== version) throw new Error('画布已更新，请重新保存后导出');
    const { id: _id, version: _v, updatedAt: _time, ...definition } = source;
    const canvas = { ...definition, selection: [], nodes: source.nodes.map(portable) };
    const assets: z.infer<typeof assetSchema>[] = [],
      seen = new Map<string, CanvasResource>();
    let size = 0;
    const map = async (ref: CanvasResource): Promise<CanvasResource | undefined> => {
      if (mode === 'template') return undefined;
      const key = JSON.stringify(ref);
      if (seen.has(key)) return seen.get(key)!;
      this.resources.validate(ref);
      let bytes: Buffer, name: string;
      if (ref.kind === 'content') {
        const doc = this.content.document(ref.id);
        bytes = doc.blob ? this.knowledge.originalBytes(ref.id) : Buffer.from(doc.content);
        name = doc.fileName ?? doc.title + '.md';
      } else if (ref.kind === 'artifact') {
        await this.artifacts.download(ref.id, AbortSignal.timeout(60000));
        bytes = this.artifacts.bytes(ref.id);
        name = this.artifacts.read(ref.id).name;
      } else if (ref.kind === 'file') {
        bytes = await this.resources.fileBytes(ref);
        name = ref.path.split(/[\\/]/).pop()!;
      } else {
        const result = await this.resources.resolve(ref);
        bytes = Buffer.from(result.text);
        name = '会话消息.md';
      }
      size += bytes.length;
      if (size > MAX_ASSETS) throw new Error('项目素材超过 64 MB，请拆分画布或导出工作流模板');
      const id = randomUUID(),
        result: CanvasResource = { kind: 'artifact', id };
      assets.push({
        id,
        name: name.replace(/[\\/]/g, '_').slice(-180),
        data: bytes.toString('base64'),
        sha256: hash(bytes),
      });
      seen.set(key, result);
      return result;
    };
    if (mode === 'project') {
      const latest = this.canvases.state(id).runs[0];
      for (const node of source.nodes) {
        const output = latest?.nodes[node.id]?.output;
        if (!output) continue;
        const refs = [...new Map(output.resources.map((r) => [JSON.stringify(r), r])).values()];
        for (const [i, resource] of refs.entries())
          canvas.nodes.push({
            id: randomUUID(),
            kind: 'resource',
            title: `${node.title.slice(0, 150)} · 结果 ${i + 1}`,
            resource,
            x: Math.min(99000, node.x + 300 + i * 280),
            y: Math.min(99000, node.y + 240),
            group: node.group,
          });
        if (!refs.length && output.text) {
          if (output.text.length > 32000)
            throw new Error('结果文本过长，请先保存到内容库并引用后导出');
          canvas.nodes.push({
            id: randomUUID(),
            kind: 'text',
            title: node.title.slice(0, 160) + ' · 结果',
            text: output.text,
            x: Math.min(99000, node.x + 300),
            y: Math.min(99000, node.y + 240),
          });
        }
      }
      if (canvas.nodes.length > 200)
        throw new Error('连同生成结果超过 200 个节点，请拆分项目后导出');
    }
    for (const node of canvas.nodes) await mapResources(node, map);
    const text = JSON.stringify(
      { format: 'tongzhou-canvas', version: 1, mode, canvas, assets },
      null,
      2,
    );
    if (Buffer.byteLength(text) > MAX_CANVAS_PACKAGE) throw new Error('画布项目包过大');
    return text;
  }

  async decode(text: string): Promise<Canvas> {
    if (Buffer.byteLength(text) > MAX_CANVAS_PACKAGE) throw new Error('画布项目包超过 96 MB');
    const pack = packageSchema.parse(JSON.parse(text));
    executionOrder(pack.canvas);
    const ids = new Set(pack.assets.map((a) => a.id));
    if (ids.size !== pack.assets.length) throw new Error('素材 ID 重复');
    if (pack.mode === 'template' && pack.assets.length) throw new Error('模板不能包含素材');
    let size = 0;
    const decoded = pack.assets.map((a) => {
      const bytes = Buffer.from(a.data, 'base64');
      size += bytes.length;
      if (size > MAX_ASSETS || bytes.toString('base64') !== a.data || hash(bytes) !== a.sha256)
        throw new Error('素材大小或完整性校验失败');
      if (/[\\/]/.test(a.name) || a.name === '.' || a.name === '..')
        throw new Error('素材文件名无效');
      return { ...a, bytes };
    });
    const nodes = pack.canvas.nodes.map(portable);
    // Validate every reference before writing any content. Never resolve foreign machine IDs.
    for (const node of nodes)
      await mapResources(structuredClone(node), async (ref) => {
        if (pack.mode !== 'project' || ref.kind !== 'artifact' || !ids.has(ref.id))
          throw new Error('项目包含未打包的外部素材引用');
        return ref;
      });
    const before = new Set(this.knowledge.all().map((d) => d.id)),
      created: string[] = [];
    try {
      const mapped = new Map<string, CanvasResource>();
      for (const asset of decoded) {
        const d = this.knowledge.importFile(asset.name, asset.bytes, undefined, 'default');
        if (!before.has(d.id)) {
          created.push(d.id);
          before.add(d.id);
        }
        mapped.set(asset.id, { kind: 'content', id: d.id, version: d.version });
      }
      for (const node of nodes)
        await mapResources(node, async (r) => mapped.get('id' in r ? r.id : '')!);
      return this.canvases.save({ ...pack.canvas, nodes, selection: [] });
    } catch (error) {
      for (const id of created.reverse()) this.knowledge.delete(id, this.knowledge.get(id).version);
      throw error;
    }
  }
}
