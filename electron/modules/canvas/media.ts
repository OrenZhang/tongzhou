import path from 'node:path';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { PluginTool, ToolOutput } from '../../../src/shared/types';
import type {
  CanvasNode,
  CanvasOutput,
  CanvasResource,
  CanvasGenerationItem,
} from '../../../src/shared/canvas';
import type { ToolScope } from '../../core/tools/extensions';
import type { Artifacts } from '../artifacts/artifacts';
import type { ContentWorkspace } from '../content/content';
import type { Knowledge } from '../knowledge/knowledge';
import { writeLocalFile, absolutePathSchema } from '../../services/storage/file-transfer';

export type MediaOwners = { artifacts: Artifacts; content: ContentWorkspace; knowledge: Knowledge };
export function mediaResponse(result: ToolOutput) {
  if (result.isError) throw new Error(result.text);
  let data: any;
  try {
    const start = result.text.indexOf('{'),
      end = result.text.lastIndexOf('}');
    data = JSON.parse(result.text.slice(start, end + 1));
  } catch {
    data = {};
  }
  const urls: string[] = [];
  let taskId: string | undefined,
    status = '';
  const visit = (value: any, depth = 0) => {
    if (!value || depth > 8) return;
    if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, v] of Object.entries(value)) {
      if (/^(task_id|taskId)$/.test(key) && typeof v === 'string' && !taskId) taskId = v;
      if (/^(status|state|task_status)$/.test(key) && typeof v === 'string')
        status = v.toLowerCase();
      if (
        /^(url|image_url|video_url|download_url|file_download_url|image_urls|video_urls)$/.test(key)
      ) {
        for (const item of Array.isArray(v) ? v : [v])
          if (typeof item === 'string' && item.startsWith('https://')) {
            const u = new URL(item);
            if (!u.username && !u.password) urls.push(u.href);
          }
      } else visit(v, depth + 1);
    }
  };
  visit(data);
  if (/^(failed|failure|error|cancelled|canceled)$/.test(status))
    throw new Error('媒体服务返回任务失败：' + status);
  return { urls: [...new Set(urls)], taskId, status };
}

/** Map only fields advertised by the selected MCP tool, never guess extra wire parameters. */
export async function mediaArguments(
  node: CanvasNode,
  tool: PluginTool,
  inputs: CanvasOutput[],
  owners: MediaOwners,
  root: string,
) {
  const properties = tool.inputSchema.properties ?? {},
    args: Record<string, unknown> = { ...node.media?.parameters },
    m = node.media ?? {};
  for (const key of Object.keys(args))
    if (!properties[key]) throw new Error('插件不支持扩展参数：' + key);
  await mkdir(root, { recursive: true });
  const field = (names: string[]) => names.find((n) => properties[n]);
  const promptKey = field(['prompt', 'text', 'description']);
  if (!promptKey) throw new Error('所选工具未提供提示词参数，请选择生成工具');
  const textInputs = inputs
    .filter(
      (o) =>
        o.prompt ||
        o.resources.every((ref) => {
          if (ref.kind === 'artifact')
            return !['image', 'video', 'audio'].includes(owners.artifacts.read(ref.id).kind);
          if (ref.kind === 'content')
            return !/\.(png|jpe?g|webp|gif|mp4|webm|mp3|wav|m4a)$/i.test(
              owners.content.document(ref.id).fileName ?? '',
            );
          return true;
        }),
    )
    .map((o) => o.prompt ?? o.text)
    .filter(Boolean);
  args[promptKey] = [node.text, ...textInputs].filter(Boolean).join('\n\n');
  if (!args[promptKey]) throw new Error('请填写生成提示词，或连接文本节点');
  for (const [value, names] of [
    [m.model, ['model', 'model_name']],
    [m.aspectRatio, ['aspect_ratio', 'ratio']],
    [m.resolution, ['resolution']],
    [node.kind === 'video' ? (m.duration ?? 6) : undefined, ['duration', 'seconds']],
    [1, ['n', 'count', 'num_images', 'number_of_images']],
  ] as const) {
    if (value === undefined || value === '') continue;
    const key = field([...names]);
    if (!key) {
      if (names[0] !== 'n' && !(names[0] === 'duration' && m.duration === undefined))
        throw new Error('所选工具不支持参数：' + names[0]);
      continue;
    }
    const mapped = properties[key].type === 'string' ? String(value) : value;
    if (properties[key].enum && !properties[key].enum.includes(mapped))
      throw new Error('插件不支持此参数：' + key + ' = ' + value);
    if (
      typeof mapped === 'number' &&
      ((properties[key].minimum !== undefined && mapped < properties[key].minimum) ||
        (properties[key].maximum !== undefined && mapped > properties[key].maximum))
    )
      throw new Error('参数超出插件范围：' + key);
    if (
      properties[key].type === 'integer' &&
      typeof mapped === 'number' &&
      !Number.isInteger(mapped)
    )
      throw new Error('参数需要整数：' + key);
    if (
      names[0] === 'aspect_ratio' &&
      !properties[key].enum &&
      typeof mapped === 'string' &&
      mapped !== 'adaptive' &&
      !/^[1-9]\d{0,3}:[1-9]\d{0,3}$/.test(mapped)
    )
      throw new Error('比例格式无效，请使用 16:9、1:1 等格式');
    args[key] = mapped;
  }
  if (m.mode && m.mode !== 'text') {
    const key = field(
      m.mode === 'frames' || m.mode === 'first-frame'
        ? ['first_frame_image', 'first_frame_image_url', 'input_image_url', 'image_url']
        : [
            'input_urls',
            'image_urls',
            'reference_images',
            'image_path',
            'subject_reference',
            'image_url',
            'input_image_url',
          ],
    );
    if (!key) throw new Error('所选工具不支持参考图模式');
    const explicit =
      m.mode === 'frames'
        ? [m.firstFrame, m.lastFrame]
        : m.mode === 'first-frame'
          ? [m.firstFrame]
          : (m.referenceImages ?? []);
    if (m.mode === 'frames' && m.lastFrame && !m.firstFrame) throw new Error('请先选择首帧图片');
    const refs = explicit.some(Boolean)
      ? explicit.filter((r): r is CanvasResource => !!r)
      : [
          ...new Map(
            inputs.flatMap((o) => o.resources).map((r) => [JSON.stringify(r), r]),
          ).values(),
        ];
    const images: { ref: CanvasResource; url?: string; bytes?: Buffer; name: string }[] = [];
    for (const ref of refs) {
      if (ref.kind === 'artifact') {
        const a = owners.artifacts.read(ref.id);
        if (a.kind !== 'image') continue;
        images.push({
          ref,
          url: a.remoteUrl ?? a.sourceUrl,
          bytes: !a.remoteUrl ? owners.artifacts.bytes(ref.id) : undefined,
          name: a.name,
        });
      } else if (ref.kind === 'content') {
        const d = owners.content.document(ref.id);
        if (!/\.(png|jpe?g|webp)$/i.test(d.fileName ?? '')) continue;
        images.push({ ref, bytes: owners.knowledge.originalBytes(ref.id), name: d.fileName! });
      }
    }
    if (!images.length) throw new Error('请连接参考图片节点');
    const values: string[] = [];
    const local = /path|subject_reference|first_frame_image$/.test(key);
    if (m.mode === 'frames' && images.length !== 2)
      throw new Error('首尾帧模式需要两张图片，请选择首帧和尾帧，或按顺序连接两个图片节点');
    for (const [i, image] of images.entries()) {
      if (local) {
        if (!image.bytes) throw new Error('参考图原件尚未下载，请先保存原件');
        await mkdir(root, { recursive: true });
        const file = path.join(root, `reference-${i + 1}${path.extname(image.name)}`);
        await writeFile(file, image.bytes, { flag: 'wx' });
        values.push(file);
      } else {
        if (!image.url)
          throw new Error(
            '此插件的参考图参数需要公开 HTTPS 地址；本地原件不会自动上传，请选择支持本地参考图的插件或文生模式',
          );
        values.push(image.url);
      }
    }
    const schema = properties[key];
    if (key === 'subject_reference') {
      args[key] = values.map((image_file) => ({ type: 'character', image_file }));
    } else if (schema.type === 'array') {
      if (schema.maxItems && values.length > schema.maxItems)
        throw new Error('参考图数量超过插件上限');
      args[key] = values;
    } else {
      if (values.length > 1 && m.mode !== 'frames')
        throw new Error('所选工具只接受一张参考图，不能忽略其他图片');
      args[key] = values[0];
    }
    if (m.mode === 'frames' && images.length > 1) {
      const last = field(['last_frame_image', 'last_frame_image_url', 'end_image_url']);
      if (!last) throw new Error('所选工具不支持尾帧，不能忽略第二张参考图');
      args[last] = values[1];
    }
  }
  for (const name of ['output_directory', 'output_dir', 'output_file', 'save_path'])
    if (properties[name])
      args[name] = /directory|dir$/.test(name)
        ? root
        : path.join(root, node.kind === 'video' ? 'generated.mp4' : 'generated.png');
  for (const key of tool.inputSchema.required ?? [])
    if (args[key] === undefined && properties[key]?.default !== undefined)
      args[key] = properties[key].default;
  for (const key of tool.inputSchema.required ?? [])
    if (args[key] === undefined)
      throw new Error('生成工具还需要参数：' + key + '；请检查插件与模型配置');
  return args;
}

export async function executeMedia(
  scope: ToolScope,
  node: CanvasNode,
  item: CanvasGenerationItem,
  args: Record<string, unknown>,
  signal: AbortSignal,
  progress: (text: string) => void,
  changed: () => void,
  owners: MediaOwners,
  origin: { sessionId: string; runId: string },
  resume = false,
  outputRoot?: string,
) {
  const pluginId = node.media!.pluginId!,
    tool = node.media!.tool!,
    kind = node.kind === 'video' ? 'video' : 'image';
  const collect = async (result: ToolOutput) => {
    const response = mediaResponse(result),
      ids = [...(result.artifactIds ?? [])];
    for (const [i, url] of (ids.length ? [] : response.urls).entries()) {
      const a = await owners.artifacts.save(
        {
          name: `${node.title}-${item.index + 1}-${i + 1}.${kind === 'image' ? 'png' : 'mp4'}`,
          mimeType: kind === 'image' ? 'image/png' : 'video/mp4',
          url,
        },
        origin,
      );
      ids.push(a.id);
    }
    if (!ids.length && !response.taskId && outputRoot) {
      const files = (await readdir(outputRoot).catch(() => []))
        .filter((name) =>
          (kind === 'image' ? /\.(png|jpe?g|webp|gif)$/i : /\.(mp4|webm)$/i).test(name),
        )
        .slice(0, 8);
      for (const name of files) {
        const a = await owners.artifacts.save({ name, path: path.join(outputRoot, name) }, origin);
        ids.push(a.id);
      }
    }
    const media = ids.filter((id) => owners.artifacts.read(id).kind === kind);
    if (media.length) item.resources = [...new Set(media)].map((id) => ({ kind: 'artifact', id }));
    if (response.taskId) {
      item.remoteTaskId = response.taskId;
      changed();
    }
    return response;
  };
  if (resume && !item.remoteTaskId) throw new Error('此项没有可继续查询的任务 ID');
  let response = resume
    ? { taskId: item.remoteTaskId, urls: [], status: '' }
    : await collect(await scope.callPlugin(pluginId, tool, args));
  if (!item.resources.length && response.taskId) {
    const pollName = kind === 'video' ? 'query_video_generation' : 'query_image_generation';
    const poll = await scope.describePlugin(pluginId, pollName),
      p = poll.inputSchema.properties ?? {};
    const taskKey = ['task_id', 'taskId', 'id'].find((k) => p[k]);
    if (!taskKey) throw new Error('插件查询工具没有任务 ID 参数');
    const pollArgs: Record<string, unknown> = { [taskKey]: response.taskId };
    if (p.model && node.media?.model) pollArgs.model = node.media.model;
    for (let attempt = 0; attempt < 120 && !item.resources.length; attempt++) {
      progress(`第 ${item.index + 1} 项：等待${kind === 'video' ? '视频' : '图片'}生成`);
      if (attempt) await delay(5000, undefined, { signal });
      response = await collect(await scope.callPlugin(pluginId, pollName, pollArgs));
      signal.throwIfAborted();
    }
  }
  if (!item.resources.length)
    throw new Error(
      kind === 'video'
        ? '视频尚未返回可用产物；已有任务 ID 可继续查询'
        : '插件没有返回真实图片产物',
    );
  return `${kind === 'video' ? '视频' : '图片'}生成完成`;
}

export async function saveMedia(
  node: CanvasNode,
  item: CanvasGenerationItem,
  owners: MediaOwners,
  signal: AbortSignal,
) {
  item.phase = 'save';
  const generated = item.resources.filter(
    (r): r is Extract<CanvasResource, { kind: 'artifact' }> => r.kind === 'artifact',
  );
  for (const ref of generated) await owners.artifacts.download(ref.id, signal);
  const destination = node.media?.destination;
  if (!destination || destination.kind === 'artifacts') return;
  for (const ref of generated) {
    signal.throwIfAborted();
    const a = owners.artifacts.read(ref.id),
      bytes = owners.artifacts.bytes(ref.id);
    if (destination.kind === 'content') {
      owners.content.library(destination.libraryId);
      if (
        destination.folderId &&
        !owners.knowledge
          .folders()
          .some(
            (f) =>
              f.id === destination.folderId && (f.libraryId ?? 'default') === destination.libraryId,
          )
      )
        throw new Error('保存目录不属于所选内容库');
      if (
        item.savedContent?.[ref.id] &&
        (() => {
          const doc = owners.content.document(item.savedContent![ref.id]);
          return (
            (doc.libraryId ?? 'default') === destination.libraryId &&
            (doc.folderId ?? null) === (destination.folderId ?? null)
          );
        })()
      )
        continue;
      const d = owners.knowledge.importFile(
        a.name,
        bytes,
        undefined,
        destination.libraryId,
        destination.folderId ?? undefined,
      );
      item.resources.push({ kind: 'content', id: d.id, version: d.version });
      item.savedContent = { ...item.savedContent, [ref.id]: d.id };
    } else {
      const directory = absolutePathSchema.parse(destination.path),
        name = path.basename(a.name);
      const target = path.join(directory, `${a.id}-${name}`);
      if (item.savedPaths?.includes(target)) continue;
      const result = await writeLocalFile(target, bytes);
      item.savedPaths = [...(item.savedPaths ?? []), result.path];
    }
  }
}
