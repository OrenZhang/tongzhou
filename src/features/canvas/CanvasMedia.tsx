import { useEffect, useId, useState } from 'react';
import { RotateCw, Download, Play } from 'lucide-react';
import type {
  CanvasMedia,
  CanvasNode,
  CanvasNodeRun,
  CanvasExecute,
  CanvasGenerationItem,
} from '../../shared/canvas';
import { canvasMediaTools } from '../../shared/canvas';
import type { Snapshot, TongzhouAPI } from '../../shared/types';
import type { ContentState } from '../../shared/content';
import { CanvasPreview, resourceKey } from './CanvasPreview';
import { ResourceThumbnail } from './CanvasBoard';
import { CanvasSourcePicker } from './CanvasSourcePicker';
import { CanvasConfigFields } from './CanvasPluginFields';

export function CanvasOutputLocation({
  api,
  destination,
  onChange,
  onError,
}: {
  api: TongzhouAPI;
  destination?: CanvasMedia['destination'];
  onChange(value: CanvasMedia['destination']): void;
  onError(error: unknown): void;
}) {
  const [content, setContent] = useState<ContentState>();
  const update = (p: Pick<CanvasMedia, 'destination'>) => onChange(p.destination);
  useEffect(() => {
    if (destination?.kind !== 'content') return;
    let live = true;
    void api
      .contentState(destination.libraryId)
      .then((s) => {
        if (live) setContent(s);
      })
      .catch(onError);
    return () => {
      live = false;
    };
  }, [api, destination?.kind, destination?.kind === 'content' ? destination.libraryId : '']);
  return (
    <div className="canvas-output-location">
      <label>
        保存位置
        <select
          aria-label="生成保存位置"
          value={destination?.kind ?? 'artifacts'}
          onChange={(e) => {
            if (e.target.value === 'directory')
              void api
                .canvasChooseOutputDirectory()
                .then((path) => {
                  if (path) update({ destination: { kind: 'directory', path } });
                })
                .catch(onError);
            else
              update({
                destination:
                  e.target.value === 'content'
                    ? { kind: 'content', libraryId: 'default' }
                    : { kind: 'artifacts' },
              });
          }}
        >
          <option value="artifacts">作品（默认）</option>
          <option value="content">内容库</option>
          <option value="directory">本地目录…</option>
        </select>
      </label>
      {destination?.kind === 'content' && (
        <>
          <label>
            内容库
            <select
              value={destination.libraryId}
              onChange={(e) =>
                update({ destination: { kind: 'content', libraryId: e.target.value } })
              }
            >
              {content?.libraries.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            目录
            <select
              value={destination.folderId ?? ''}
              onChange={(e) => {
                if (destination?.kind === 'content')
                  update({ destination: { ...destination, folderId: e.target.value || null } });
              }}
            >
              <option value="">根目录</option>
              {content?.folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {destination?.kind === 'directory' && (
        <button
          className="canvas-output-path"
          title={destination.path}
          onClick={() =>
            void api
              .canvasChooseOutputDirectory()
              .then((path) => {
                if (path) update({ destination: { kind: 'directory', path } });
              })
              .catch(onError)
          }
        >
          {destination.path}
        </button>
      )}
    </div>
  );
}

export function CanvasResourceOutput({
  api,
  node,
  patch,
  onSave,
  showLocation = true,
  busy,
  onError,
}: {
  api: TongzhouAPI;
  node: CanvasNode;
  patch(p: Partial<CanvasNode>): void;
  onSave(): void;
  showLocation?: boolean;
  busy: boolean;
  onError(error: unknown): void;
}) {
  const [media, setMedia] = useState(false);
  useEffect(() => {
    let live = true;
    setMedia(false);
    if (node.resource)
      void api
        .canvasResourcePreview(node.resource)
        .then((p) => {
          if (live) setMedia(p.type === 'image' || p.type === 'video');
        })
        .catch(onError);
    return () => {
      live = false;
    };
  }, [api, JSON.stringify(node.resource)]);
  if (!media) return null;
  return (
    <>
      {showLocation && (
        <CanvasOutputLocation
          api={api}
          destination={node.media?.destination}
          onChange={(destination) => patch({ media: { ...node.media, destination } })}
          onError={onError}
        />
      )}
      <button disabled={busy} onClick={onSave}>
        <Download size={13} />
        {busy
          ? '保存中…'
          : node.media?.destination?.kind === 'directory'
            ? '保存到本地目录'
            : node.media?.destination?.kind === 'content'
              ? '保存到内容库'
              : '保存到作品'}
      </button>
    </>
  );
}

export function CanvasMediaFields({
  api,
  data,
  node,
  patch,
  onError,
}: {
  api: TongzhouAPI;
  data: Snapshot;
  node: CanvasNode;
  patch(p: Partial<CanvasNode>): void;
  onError(e: unknown): void;
}) {
  const m = node.media ?? {},
    kind = node.kind === 'video' ? 'video' : 'image',
    modelId = useId();
  const [checking, setChecking] = useState(false),
    [frame, setFrame] = useState<'firstFrame' | 'lastFrame' | 'references' | 'existing'>();
  const plugin = data.plugins?.find((p) => p.id === m.pluginId),
    tools = plugin ? canvasMediaTools(plugin, kind) : [],
    tool = tools.find((t) => t.name === m.tool),
    props = tool?.inputSchema.properties ?? {};
  const update = (p: Partial<CanvasMedia>) => patch({ media: { ...m, ...p } });
  const options = (names: string[]) => {
    const key = names.find((k) => props[k]);
    return key ? (props[key].enum as string[] | undefined) : undefined;
  };
  const models = options(['model', 'model_name']) ?? [],
    ratios = options(['aspect_ratio', 'ratio']) ?? [
      '1:1',
      '16:9',
      '9:16',
      '4:3',
      '3:4',
      '3:2',
      '2:3',
      '21:9',
      '9:21',
    ],
    resolutions =
      options(['resolution']) ??
      (kind === 'image' ? ['1K', '2K', '4K'] : ['480P', '720P', '768P', '1080P', '2K', '4K']);
  const chooseTool = (name: string) => {
    const t = tools.find((t) => t.name === name),
      p = t?.inputSchema.properties ?? {},
      key = ['model', 'model_name'].find((k) => p[k]);
    update({
      tool: name || undefined,
      mode: 'text',
      aspectRatio: undefined,
      resolution: undefined,
      duration: undefined,
      model: key ? (p[key].default ?? p[key].enum?.[0]) : undefined,
    });
  };
  return (
    <div className="canvas-media-fields">
      <label>
        生成模式
        <select
          value={m.mode ?? 'text'}
          onChange={(e) => update({ mode: e.target.value as CanvasMedia['mode'] })}
        >
          <option value="text">{kind === 'image' ? '文生图' : '文生视频'}</option>
          <option value="reference">参考图生成</option>
          {kind === 'image' && <option value="existing">选择已有图片</option>}
          {kind === 'video' && (
            <>
              <option
                value="first-frame"
                disabled={
                  !!tool &&
                  ![
                    'first_frame_image',
                    'first_frame_image_url',
                    'input_image_url',
                    'image_url',
                  ].some((k) => props[k])
                }
              >
                首帧生成
              </option>
              <option
                value="frames"
                disabled={
                  !!tool &&
                  !['last_frame_image', 'last_frame_image_url', 'end_image_url'].some(
                    (k) => props[k],
                  )
                }
              >
                首尾帧生成
              </option>
            </>
          )}
        </select>
      </label>
      {m.mode === 'existing' ? (
        <>
          <ResourceThumbnail api={api} resource={node.resource} />
          <button onClick={() => setFrame('existing')}>
            {node.resource ? '更换已有图片' : '选择已有图片'}
          </button>
        </>
      ) : (
        <>
          <label>
            生成插件
            <select
              aria-label="生成插件"
              value={m.pluginId ?? ''}
              onChange={(e) => {
                const p = data.plugins?.find((p) => p.id === e.target.value),
                  t = p ? canvasMediaTools(p, kind)[0] : undefined,
                  fields = t?.inputSchema.properties ?? {};
                update({
                  pluginId: p?.id,
                  tool: t?.name,
                  mode: 'text',
                  aspectRatio: undefined,
                  resolution: undefined,
                  duration: undefined,
                  model: fields.model?.default ?? fields.model?.enum?.[0],
                });
              }}
            >
              <option value="">选择已启用的插件</option>
              {data.plugins
                ?.filter(
                  (p) =>
                    p.enabled &&
                    (canvasMediaTools(p, kind).length || p.id === 'minimax-multimedia'),
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="canvas-media-tool">
            <label>
              生成工具
              <select
                aria-label="生成工具"
                value={m.tool ?? ''}
                onChange={(e) => chooseTool(e.target.value)}
              >
                <option value="">选择工具</option>
                {tools.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.description?.slice(0, 24) || t.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={!plugin || checking}
              onClick={() => {
                setChecking(true);
                void api
                  .testPlugin(plugin!.id)
                  .catch(onError)
                  .finally(() => setChecking(false));
              }}
            >
              {checking ? '检查中…' : '刷新工具'}
            </button>
          </div>
          {!tools.length && <small>先在插件页面启用并检查图片／视频生成工具。</small>}
          <div className="canvas-media-grid">
            <label>
              {kind === 'image' ? '图片数量' : '视频数量'}
              <select
                aria-label="生成数量"
                value={m.count ?? 1}
                onChange={(e) => update({ count: Number(e.target.value) })}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>
                    {n} {kind === 'image' ? '张' : '条'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {m.mode && m.mode !== 'text' && (
            <small>
              {m.mode === 'frames'
                ? '选择首帧和尾帧，或按连线顺序连接两张图片。'
                : '连接图片节点作为参考。'}
              是否支持本地原件由插件决定，不会自动上传素材。
            </small>
          )}
          {m.mode === 'reference' && (
            <div className="canvas-reference-inputs">
              <button onClick={() => setFrame('references')}>选择参考图片</button>
              <div className="canvas-frame-inputs">
                {m.referenceImages?.map((resource, i) => (
                  <div key={resourceKey(resource)}>
                    <ResourceThumbnail api={api} resource={resource} />
                    <button
                      onClick={() =>
                        update({
                          referenceImages: m.referenceImages?.filter((_, index) => index !== i),
                        })
                      }
                    >
                      移除第 {i + 1} 张
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {(m.mode === 'first-frame' || m.mode === 'frames') && (
            <div className="canvas-frame-inputs">
              {(
                ['firstFrame', ...(m.mode === 'frames' ? ['lastFrame'] : [])] as (
                  | 'firstFrame'
                  | 'lastFrame'
                )[]
              ).map((key) => (
                <div key={key}>
                  <strong>{key === 'firstFrame' ? '首帧' : '尾帧'}</strong>
                  {m[key] && <ResourceThumbnail api={api} resource={m[key]} />}
                  <button onClick={() => setFrame(key)}>{m[key] ? '更换图片' : '选择图片'}</button>
                  {m[key] && <button onClick={() => update({ [key]: undefined })}>移除</button>}
                </div>
              ))}
              <small>未单独选择时使用相连的图片节点。首尾帧功能取决于所选插件。</small>
            </div>
          )}
          <label>
            生成模型
            <input
              aria-label="生成模型"
              disabled={!!tool && !props.model && !props.model_name}
              list={modelId}
              value={m.model ?? ''}
              placeholder="使用工具默认模型"
              onChange={(e) => update({ model: e.target.value || undefined })}
            />
            <datalist id={modelId}>
              {models.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          </label>
          <div className="canvas-media-grid">
            <label>
              画面比例
              <input
                aria-label="画面比例"
                disabled={!!tool && !props.aspect_ratio && !props.ratio}
                list={modelId + '-ratio'}
                value={m.aspectRatio ?? ''}
                placeholder="工具默认，如 16:9"
                onChange={(e) => update({ aspectRatio: e.target.value || undefined })}
              />
              <datalist id={modelId + '-ratio'}>
                {ratios.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </label>
            <label>
              分辨率
              <input
                aria-label="分辨率"
                disabled={!!tool && !props.resolution}
                list={modelId + '-resolution'}
                value={m.resolution ?? ''}
                placeholder="工具默认"
                onChange={(e) => update({ resolution: e.target.value || undefined })}
              />
              <datalist id={modelId + '-resolution'}>
                {resolutions.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </label>
          </div>
          {kind === 'video' && (
            <label>
              时长（秒）
              <input
                aria-label="视频时长"
                disabled={!!tool && !props.duration && !props.seconds}
                type="number"
                min={(props.duration ?? props.seconds)?.minimum ?? 1}
                max={(props.duration ?? props.seconds)?.maximum ?? 120}
                step={1}
                value={m.duration ?? 6}
                onChange={(e) => update({ duration: Number(e.target.value) })}
              />
            </label>
          )}
          {tool && (
            <details>
              <summary>插件扩展参数</summary>
              <CanvasConfigFields
                schema={{
                  ...tool.inputSchema,
                  properties: Object.fromEntries(
                    Object.entries(props).filter(
                      ([key]) =>
                        ![
                          'prompt',
                          'text',
                          'description',
                          'model',
                          'model_name',
                          'aspect_ratio',
                          'ratio',
                          'resolution',
                          'duration',
                          'seconds',
                          'n',
                          'count',
                          'num_images',
                          'number_of_images',
                          'input_urls',
                          'image_urls',
                          'reference_images',
                          'image_path',
                          'subject_reference',
                          'image_url',
                          'input_image_url',
                          'first_frame_image',
                          'first_frame_image_url',
                          'last_frame_image',
                          'last_frame_image_url',
                          'end_image_url',
                          'output_directory',
                          'output_dir',
                          'output_file',
                          'save_path',
                        ].includes(key),
                    ),
                  ),
                }}
                value={m.parameters ?? {}}
                onChange={(parameters) => update({ parameters })}
              />
            </details>
          )}
          <small>每次重新生成都会保留旧结果。结果先进入作品，选择其他位置时再保存副本。</small>
        </>
      )}
      {frame && (
        <CanvasSourcePicker
          api={api}
          data={data}
          imageOnly
          onClose={() => setFrame(undefined)}
          onSelect={(_title, resource) => {
            void api
              .canvasResourcePreview(resource)
              .then((p) => {
                if (p.type !== 'image') throw new Error('请选择可用的图片原件');
                if (frame === 'existing') patch({ resource });
                else if (frame === 'references') {
                  const refs = [
                    ...new Map(
                      [...(m.referenceImages ?? []), resource].map((r) => [resourceKey(r), r]),
                    ).values(),
                  ];
                  if (refs.length > 8) throw new Error('最多选择 8 张参考图');
                  update({ referenceImages: refs });
                } else update({ [frame]: resource });
                setFrame(undefined);
              })
              .catch(onError);
          }}
        />
      )}
    </div>
  );
}

export function CanvasMediaResults({
  api,
  step,
  disabled,
  onRegenerate,
  onError,
  previewKey,
}: {
  api: TongzhouAPI;
  previewKey: string;
  step?: CanvasNodeRun;
  disabled: boolean;
  onRegenerate(index?: number, action?: NonNullable<CanvasExecute['regenerate']>['action']): void;
  onError(e: unknown): void;
}) {
  const [preview, setPreview] = useState<string>(),
    items = step?.generation ?? [];
  const labels: Record<CanvasGenerationItem['status'], string> = {
    pending: '等待',
    running: '生成中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已停止',
  };
  return (
    <section className="canvas-media-results" aria-label="生成结果">
      <div className="canvas-media-results-heading">
        <strong>
          生成结果 {items.filter((i) => i.status === 'completed').length}/{items.length}
        </strong>
        <button disabled={disabled} onClick={() => onRegenerate()}>
          <RotateCw size={12} />
          重新生成整组
        </button>
      </div>
      <div className="canvas-media-results-grid">
        {items.map((item) => {
          const resource = item.resources.find((r) => r.kind === 'artifact') ?? item.resources[0];
          return (
            <article key={item.index}>
              <header>
                <span>第 {item.index + 1} 项</span>
                <small>{item.reused ? '已复用' : labels[item.status]}</small>
              </header>
              {resource && (
                <button
                  className="canvas-media-preview"
                  onClick={() => setPreview(resourceKey(resource))}
                >
                  <ResourceThumbnail
                    api={api}
                    resource={resource}
                    revision={item.status + item.phase}
                  />
                  <span>
                    <Play size={12} />
                    预览
                  </span>
                </button>
              )}
              {item.error && <p role="alert">{item.error}</p>}
              {item.savedPaths?.map((p) => (
                <small key={p} title={p}>
                  已保存到 {p.split(/[\\/]/).at(-1)}
                </small>
              ))}
              <div className="canvas-media-result-actions">
                <button disabled={disabled} onClick={() => onRegenerate(item.index)}>
                  <RotateCw size={12} />
                  重生成
                </button>
                {item.remoteTaskId && item.status !== 'completed' && (
                  <button disabled={disabled} onClick={() => onRegenerate(item.index, 'resume')}>
                    继续查询
                  </button>
                )}
                {item.phase === 'save' && item.status === 'failed' && (
                  <button disabled={disabled} onClick={() => onRegenerate(item.index, 'save')}>
                    重试保存
                  </button>
                )}
                {resource?.kind === 'artifact' && (
                  <button
                    aria-label={`下载第 ${item.index + 1} 项`}
                    onClick={() => void api.artifactExport(resource.id).catch(onError)}
                  >
                    <Download size={12} />
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {!items.length && <p>填写提示词后生成，结果会逐项显示。</p>}
      {preview !== undefined && (
        <CanvasPreview
          api={api}
          storageKey={previewKey}
          initial={preview}
          items={items.flatMap((item) =>
            item.resources
              .filter((r) => r.kind === 'artifact')
              .map((resource) => ({ resource, title: `第 ${item.index + 1} 项` })),
          )}
          onClose={() => setPreview(undefined)}
        />
      )}
    </section>
  );
}
