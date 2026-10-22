import { mediaFieldNames } from '../../shared/canvas-media-settings';
import { CanvasModelPicker } from './CanvasModelPicker';
import { validateMediaModel } from '../../shared/model-capabilities';
import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Download,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  Play,
  RotateCw,
  Settings2,
  X,
  Video,
  History,
} from 'lucide-react';
import { t as tr } from '../../shared/i18n';
import { switchCanvasMediaTool } from '../../shared/canvas-media-settings';
import { pluginLabel } from '../../shared/plugin-label';
import {
  canvasMediaTools,
  type Canvas,
  type CanvasExecute,
  type CanvasMedia,
  type CanvasNode,
  type CanvasNodeRun,
  type CanvasResource,
} from '../../shared/canvas';
import type { Snapshot, TongzhouAPI } from '../../shared/types';
import { ResourceThumbnail } from './CanvasBoard';
import { resourceKey } from './CanvasPreview';
import { CanvasSourcePicker } from './CanvasSourcePicker';

type RetryAction = NonNullable<CanvasExecute['regenerate']>['action'];

/** Media stays on the node; generation controls belong to the selected node only. */
export function CanvasMediaNode({
  api,
  data,
  canvas,
  node,
  step,
  sourceNode,
  previousStep,
  steps,
  selected,
  composerTarget,
  disabled,
  executionIssue,
  patch,
  onSelect,
  onDismiss,
  onVideo,
  onConfigure,
  onHistory,
  onGenerate,
  onRetry,
  onPreview,
  onError,
}: {
  api: TongzhouAPI;
  data: Snapshot;
  canvas: Canvas;
  node: CanvasNode;
  step?: CanvasNodeRun;
  sourceNode?: CanvasNode;
  previousStep?: CanvasNodeRun;
  steps: Record<string, CanvasNodeRun>;
  selected: boolean;
  composerTarget: HTMLElement | null;
  disabled: boolean;
  executionIssue?: string;
  patch(value: Partial<CanvasNode>, removeEdges?: string[]): void;
  onSelect(): void;
  onDismiss(): void;
  onVideo(): void;
  onConfigure(): void;
  onHistory(): void;
  onGenerate(): void;
  onRetry(index?: number, action?: RetryAction): void;
  onPreview(resource?: CanvasResource): void;
  onError(error: unknown): void;
}) {
  const id = useId();
  const [toolNotice, setToolNotice] = useState('');
  const content = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  const [picker, setPicker] = useState<
    'referenceImages' | 'firstFrame' | 'lastFrame' | 'existing'
  >();
  const kind = node.kind === 'video' ? 'video' : 'image';
  const media = node.media ?? {};
  const generationConfig = (value?: CanvasNode) =>
    JSON.stringify({ text: value?.text ?? '', media: { ...value?.media, destination: undefined } });
  const inputsEdited = !!sourceNode && generationConfig(sourceNode) !== generationConfig(node);
  const plugin = data.plugins?.find((p) => p.id === media.pluginId && p.enabled);
  const tools = plugin ? canvasMediaTools(plugin, kind) : [];
  const tool = tools.find((t) => t.name === media.tool);
  const props = tool?.inputSchema.properties ?? {};
  const canReference = !tool || mediaFieldNames.reference.some((key) => props[key]);
  const existing = media.mode === 'existing';
  const running = step?.status === 'running' || step?.status === 'pending';
  const items = step?.generation ?? [];
  const resources = items.length
    ? items.flatMap((item) => item.resources)
    : (step?.output?.resources ?? []);
  const previousResources =
    previousStep?.generation?.flatMap((item) => item.resources) ??
    previousStep?.output?.resources ??
    [];
  const showingPrevious =
    !existing && !resources.length && !node.resource && previousResources.length > 0;
  const previews = node.resource
    ? [node.resource]
    : showingPrevious
      ? previousResources
      : resources;
  const hasPreview = previews.length > 0;
  const incoming = canvas.edges
    .filter((e) => e.to === node.id)
    .map((edge) => {
      const source = canvas.nodes.find((n) => n.id === edge.from);
      const output = steps[edge.from]?.output;
      const port = edge.fromPort ? output?.ports?.[edge.fromPort] : undefined;
      return { edge, source, resource: source?.resource ?? (port ?? output)?.resources[0] };
    });
  const hasPrompt =
    !!node.text?.trim() ||
    incoming.some(
      ({ source }) => source?.kind === 'text' || source?.kind === 'agent' || !!source?.text,
    );
  const connectedFirst = incoming.some(({ edge }) => edge.toPort === 'firstFrame');
  const connectedLast = incoming.some(({ edge }) => edge.toPort === 'lastFrame');
  const connectedReferences = incoming.some(({ edge }) => edge.toPort === 'reference');
  const connectedMode = !existing && (connectedFirst || connectedLast || connectedReferences);
  const effectiveMode = existing
    ? 'existing'
    : connectedFirst || connectedLast
      ? connectedLast || media.lastFrame
        ? 'frames'
        : 'first-frame'
      : connectedReferences
        ? 'reference'
        : (media.mode ?? 'text');
  let modelIssue = '';
  if (!existing)
    try {
      validateMediaModel(
        { ...media, mode: effectiveMode },
        kind,
        data.providers,
        data.plugins ?? [],
      );
    } catch (error) {
      modelIssue = tr((error as Error).message);
    }
  const issue =
    executionIssue ||
    modelIssue ||
    (existing
      ? !node.resource
        ? tr('请选择已有素材')
        : ''
      : !tool
        ? tr('请选择可用的生成插件和工具')
        : !hasPrompt
          ? tr('输入提示词，或连接上游文本节点')
          : '');
  const update = (value: Partial<CanvasMedia>) => patch({ media: { ...media, ...value } });
  const chooseTool = (pluginId: string, name?: string) => {
    const provider = data.plugins?.find((p) => p.id === pluginId);
    const nextTool =
      provider && canvasMediaTools(provider, kind).find((t) => !name || t.name === name);
    const next = switchCanvasMediaTool(media, pluginId || undefined, nextTool);
    patch({ media: next.media });
    setToolNotice(
      next.reset.length ? tr('已保留兼容设置；不支持的参数已恢复默认，请检查后生成。') : '',
    );
  };

  const prompt = (
    <textarea
      aria-label={tr('生成提示词')}
      placeholder={
        kind === 'video' ? tr('描述主体动作、场景和镜头运动…') : tr('描述你想生成的画面…')
      }
      value={node.text ?? ''}
      disabled={disabled}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (!selected) onSelect();
      }}
      onChange={(e) => patch({ text: e.target.value })}
    />
  );
  const run = () => {
    if (composer.current && !composer.current.reportValidity()) return;
    if (items.length && !existing) onRetry();
    else onGenerate();
  };
  const failedItems = items.filter(
    (item) => item.status === 'failed' || item.status === 'cancelled',
  );
  const parameter = (
    label: string,
    keys: string[],
    value: string | undefined,
    change: (value?: string) => void,
    suggestions: string[] = [],
  ) => {
    const key = keys.find((key) => props[key]);
    if (!key) return null;
    const schema = props[key];
    const options = schema.enum as string[] | undefined;
    return (
      <label key={keys[0]}>
        {label}
        {options ? (
          <select
            aria-label={label}
            value={value ?? ''}
            onChange={(e) => change(e.target.value || undefined)}
          >
            <option value="">{tr('工具默认')}</option>
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              aria-label={label}
              list={id + keys[0]}
              value={value ?? ''}
              placeholder={tr('工具默认')}
              onChange={(e) => change(e.target.value || undefined)}
            />
            <datalist id={id + keys[0]}>
              {suggestions.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
          </>
        )}
      </label>
    );
  };
  return (
    <>
      <div
        ref={content}
        className={`canvas-media-content ${hasPreview ? 'has-preview' : 'is-empty'}`}
      >
        {hasPreview ? (
          <div className="canvas-media-previews">
            {previews.slice(0, 4).map((resource, index) => (
              <ResourceThumbnail
                key={resourceKey(resource) + index}
                api={api}
                resource={resource}
                onPreview={() => onPreview(resource)}
              />
            ))}
          </div>
        ) : existing ? (
          <button
            className="canvas-media-empty-source"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              onSelect();
              setPicker('existing');
            }}
          >
            <ImagePlus size={24} />
            {tr('选择已有素材')}
          </button>
        ) : (
          <p className="canvas-media-prompt-summary">
            {node.text ||
              (kind === 'video' ? tr('描述主体动作、场景和镜头运动…') : tr('描述你想生成的画面…'))}
          </p>
        )}
        <div
          className={`canvas-media-state ${step?.status === 'failed' ? 'is-error' : ''}`}
          aria-live="polite"
        >
          {running ? (
            <>
              <LoaderCircle className="canvas-media-spinner" size={13} />
              {tr('生成中')}
              {items.length
                ? ` · ${items.filter((i) => i.status === 'completed').length}/${items.length}`
                : ''}
            </>
          ) : step?.error ? (
            <span title={step.error}>{step.error}</span>
          ) : hasPreview ? (
            <span>
              {showingPrevious ? tr('上次结果') : tr('已完成')} · {previews.length}
            </span>
          ) : (
            <span>{tool ? tr('准备生成') : tr('选择生成工具开始创作')}</span>
          )}
        </div>
      </div>
      {selected && (
        <>
          <div
            className="canvas-media-toolbar"
            role="toolbar"
            aria-label={tr('媒体节点工具')}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button title={tr('生成历史')} aria-label={tr('生成历史')} onClick={onHistory}>
              <History size={15} />
            </button>
            {hasPreview && (
              <button
                title={tr('预览')}
                aria-label={tr('预览')}
                onClick={() => onPreview(previews[0])}
              >
                <Maximize2 size={15} />
              </button>
            )}
            {previews[0]?.kind === 'artifact' && (
              <button
                title={tr('下载')}
                aria-label={tr('下载')}
                onClick={() => {
                  const r = previews[0];
                  if (r.kind === 'artifact') void api.artifactExport(r.id).catch(onError);
                }}
              >
                <Download size={15} />
              </button>
            )}
            {hasPreview && !existing && (
              <button
                title={tr('重新生成')}
                aria-label={tr('重新生成')}
                disabled={disabled || !!issue}
                onClick={run}
              >
                <RotateCw size={15} />
              </button>
            )}
            {hasPreview && kind === 'image' && (
              <button
                title={tr('生成视频')}
                aria-label={tr('生成视频')}
                disabled={disabled}
                onClick={onVideo}
              >
                <Video size={15} />
              </button>
            )}
          </div>
          {composerTarget &&
            createPortal(
              <form
                ref={composer}
                className="canvas-media-composer canvas-media-docked"
                aria-label={tr('生成配置')}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Escape') onDismiss();
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onContextMenu={(e) => e.stopPropagation()}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!disabled && !issue) run();
                }}
              >
                <div className="canvas-composer-heading">
                  <strong>{node.title}</strong>
                  <button type="button" aria-label={tr('收起生成配置')} onClick={onDismiss}>
                    <X size={14} />
                  </button>
                </div>
                {showingPrevious && (
                  <small className="canvas-composer-hint">
                    {tr('画布保留上次结果，新结果完成后更新预览')}
                  </small>
                )}
                <fieldset disabled={disabled}>
                  {!existing && prompt}
                  {!existing && (
                    <CanvasModelPicker
                      data={data}
                      media={media}
                      kind={kind}
                      mode={effectiveMode}
                      onChange={(media) => patch({ media })}
                    />
                  )}
                  <div className="canvas-composer-settings">
                    <label>
                      {tr('生成插件')}
                      <select
                        aria-label={tr('生成插件')}
                        disabled={!!media.modelProviderId}
                        value={media.pluginId ?? ''}
                        onChange={(e) => chooseTool(e.target.value)}
                      >
                        <option value="">{tr('选择已启用的插件')}</option>
                        {data.plugins
                          ?.filter((p) => p.enabled && canvasMediaTools(p, kind).length)
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {pluginLabel(p)}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      {tr('生成工具')}
                      <select
                        aria-label={tr('生成工具')}
                        disabled={!!media.modelProviderId}
                        value={media.tool ?? ''}
                        onChange={(e) => chooseTool(media.pluginId ?? '', e.target.value)}
                      >
                        <option value="">{tr('选择工具')}</option>
                        {tools.map((t) => (
                          <option key={t.name} value={t.name}>
                            {t.description?.slice(0, 24) || t.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {tr('生成模式')}
                      <select
                        aria-label={tr('生成模式')}
                        value={effectiveMode}
                        disabled={!!connectedMode}
                        title={
                          connectedMode ? tr('生成模式由输入连线决定，断开连线后可更改') : undefined
                        }
                        onChange={(e) => update({ mode: e.target.value as CanvasMedia['mode'] })}
                      >
                        <option value="text">
                          {kind === 'video' ? tr('文生视频') : tr('文生图')}
                        </option>
                        <option value="reference" disabled={!canReference}>
                          {tr('参考图生成')}
                        </option>
                        {kind === 'video' && (
                          <>
                            <option
                              value="first-frame"
                              disabled={!!tool && !mediaFieldNames.firstFrame.some((k) => props[k])}
                            >
                              {tr('首帧生成')}
                            </option>
                            <option
                              value="frames"
                              disabled={!!tool && !mediaFieldNames.lastFrame.some((k) => props[k])}
                            >
                              {tr('首尾帧生成')}
                            </option>
                          </>
                        )}
                        <option value="existing">{tr('选择已有素材')}</option>
                      </select>
                    </label>
                    {!existing && (
                      <>
                        {!media.modelProviderId &&
                          parameter(tr('生成模型'), mediaFieldNames.model, media.model, (model) =>
                            update({
                              model,
                              modelProviderId: undefined,
                              registeredModel: undefined,
                            }),
                          )}
                        {parameter(
                          tr('画面比例'),
                          mediaFieldNames.aspectRatio,
                          media.aspectRatio,
                          (aspectRatio) => update({ aspectRatio }),
                          ['1:1', '16:9', '9:16', '4:3'],
                        )}
                        {parameter(
                          tr('分辨率'),
                          mediaFieldNames.resolution,
                          media.resolution,
                          (resolution) => update({ resolution }),
                        )}
                        <label>
                          {tr('生成数量')}
                          <select
                            aria-label={tr('生成数量')}
                            value={media.count ?? 1}
                            onChange={(e) => update({ count: Number(e.target.value) })}
                          >
                            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                              <option key={n} value={n}>
                                {n}
                              </option>
                            ))}
                          </select>
                        </label>
                        {kind === 'video' && (props.duration || props.seconds) && (
                          <label>
                            {tr('时长（秒）')}
                            <input
                              aria-label={tr('视频时长')}
                              type="number"
                              min={(props.duration ?? props.seconds).minimum ?? 1}
                              max={(props.duration ?? props.seconds).maximum ?? 120}
                              step="1"
                              placeholder={tr('工具默认')}
                              value={media.duration ?? ''}
                              onChange={(e) =>
                                update({
                                  duration: e.target.value ? Number(e.target.value) : undefined,
                                })
                              }
                            />
                          </label>
                        )}
                      </>
                    )}
                  </div>
                  <section className="canvas-input-materials" aria-label={tr('输入素材')}>
                    <strong>{tr('输入素材')}</strong>
                    <div className="canvas-input-actions">
                      {existing ? (
                        <button type="button" onClick={() => setPicker('existing')}>
                          <ImagePlus size={14} />
                          {tr('更换已有素材')}
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={!canReference}
                            onClick={() => setPicker('referenceImages')}
                          >
                            <ImagePlus size={14} />
                            {tr('参考图片')}
                          </button>
                          {kind === 'video' && (
                            <>
                              <button
                                type="button"
                                disabled={
                                  !!tool && !mediaFieldNames.firstFrame.some((k) => props[k])
                                }
                                onClick={() => setPicker('firstFrame')}
                              >
                                {tr('首帧')}
                              </button>
                              <button
                                type="button"
                                disabled={
                                  !!tool && !mediaFieldNames.lastFrame.some((k) => props[k])
                                }
                                onClick={() => setPicker('lastFrame')}
                              >
                                {tr('尾帧')}
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                    {!existing && (
                      <div className="canvas-input-list">
                        {media.referenceImages?.map((resource, index) => (
                          <div className="canvas-input-item" key={resourceKey(resource)}>
                            <ResourceThumbnail api={api} resource={resource} />
                            <span>
                              {tr('参考图片')} {index + 1}
                              <small>
                                {tr('手动选择')}
                                {effectiveMode !== 'reference' ? ' · ' + tr('当前模式未使用') : ''}
                              </small>
                            </span>
                            <button
                              type="button"
                              aria-label={tr('移除参考图 {0}', [index + 1])}
                              onClick={() =>
                                update({
                                  referenceImages: media.referenceImages?.filter(
                                    (_, i) => i !== index,
                                  ),
                                })
                              }
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ))}
                        {(['firstFrame', 'lastFrame'] as const).map(
                          (key) =>
                            media[key] && (
                              <div className="canvas-input-item" key={key}>
                                <ResourceThumbnail api={api} resource={media[key]} />
                                <span>
                                  {key === 'firstFrame' ? tr('首帧') : tr('尾帧')}
                                  <small>
                                    {tr('手动选择')}
                                    {!['first-frame', 'frames'].includes(effectiveMode) ||
                                    (key === 'firstFrame' ? connectedFirst : connectedLast)
                                      ? ' · ' + tr('当前模式未使用')
                                      : ''}
                                  </small>
                                </span>
                                <button
                                  type="button"
                                  aria-label={
                                    key === 'firstFrame' ? tr('移除首帧') : tr('移除尾帧')
                                  }
                                  onClick={() => update({ [key]: undefined })}
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            ),
                        )}
                        {incoming.map(({ edge, source, resource }) => (
                          <div className="canvas-input-item" key={edge.id}>
                            {resource && <ResourceThumbnail api={api} resource={resource} />}
                            <span>
                              {edge.toPort === 'firstFrame'
                                ? tr('首帧')
                                : edge.toPort === 'lastFrame'
                                  ? tr('尾帧')
                                  : edge.toPort === 'prompt' || source?.kind === 'text'
                                    ? tr('提示词')
                                    : tr('参考图片')}{' '}
                              · {source?.title}
                              <small>
                                {tr('来自连线')}
                                {(edge.toPort === 'firstFrame' && media.firstFrame) ||
                                (edge.toPort === 'lastFrame' && media.lastFrame)
                                  ? ' · ' + tr('连线素材优先')
                                  : ''}
                              </small>
                            </span>
                            <button
                              type="button"
                              aria-label={tr('断开输入：{0}', [source?.title ?? ''])}
                              onClick={() => patch({}, [edge.id])}
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ))}
                        {!incoming.length &&
                          !media.referenceImages?.length &&
                          !media.firstFrame &&
                          !media.lastFrame && (
                            <small>{tr('可添加参考素材，或从其他节点拖线连接')}</small>
                          )}
                      </div>
                    )}
                  </section>
                  {toolNotice && (
                    <small role="status" className="canvas-composer-hint">
                      {toolNotice}
                    </small>
                  )}
                </fieldset>
                {failedItems.length > 0 && !inputsEdited && (
                  <div className="canvas-composer-retries">
                    {failedItems.map((item) => (
                      <div key={item.index}>
                        <span>{tr('第 {0} 项', [item.index + 1])}</span>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() =>
                            onRetry(
                              item.index,
                              item.phase === 'save'
                                ? 'save'
                                : item.remoteTaskId
                                  ? 'resume'
                                  : 'generate',
                            )
                          }
                        >
                          {item.phase === 'save'
                            ? tr('重试保存')
                            : item.remoteTaskId
                              ? tr('继续查询')
                              : tr('重生成')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {failedItems.length > 0 && inputsEdited && (
                  <small className="canvas-composer-hint">{tr('输入已修改，请重新生成整组')}</small>
                )}
                <footer>
                  <button type="button" onClick={onConfigure}>
                    <Settings2 size={13} />
                    {tr('高级配置')}
                  </button>
                  <button
                    type="submit"
                    className="canvas-generate-button"
                    disabled={disabled || !!issue}
                    title={issue || undefined}
                  >
                    {running ? (
                      <LoaderCircle className="canvas-media-spinner" size={14} />
                    ) : (
                      <Play size={14} />
                    )}
                    {running
                      ? tr('生成中')
                      : existing
                        ? tr('运行节点')
                        : items.length
                          ? tr('重新生成')
                          : tr('生成')}
                  </button>
                </footer>
                {issue && <small className="canvas-composer-hint">{issue}</small>}
              </form>,
              composerTarget,
            )}
        </>
      )}
      {picker &&
        createPortal(
          <div onPointerDown={(e) => e.stopPropagation()}>
            <CanvasSourcePicker
              api={api}
              data={data}
              mediaOnly={picker === 'existing' ? kind : 'image'}
              onClose={() => setPicker(undefined)}
              onSelect={(_title, resource) => {
                void api
                  .canvasResourcePreview(resource)
                  .then((preview) => {
                    if (preview.type !== (picker === 'existing' ? kind : 'image'))
                      throw new Error(tr('请选择可用的媒体原件'));
                    if (picker === 'existing') patch({ resource });
                    else if (picker === 'referenceImages') {
                      const refs = [
                        ...new Map(
                          [...(media.referenceImages ?? []), resource].map((r) => [
                            resourceKey(r),
                            r,
                          ]),
                        ).values(),
                      ];
                      if (refs.length > 8) throw new Error(tr('最多选择 8 张参考图'));
                      update({ referenceImages: refs, mode: 'reference' });
                    } else
                      patch(
                        {
                          media: {
                            ...media,
                            [picker]: resource,
                            mode:
                              picker === 'lastFrame' || media.lastFrame ? 'frames' : 'first-frame',
                          },
                        },
                        incoming
                          .filter(({ edge }) => edge.toPort === picker)
                          .map(({ edge }) => edge.id),
                      );
                    setPicker(undefined);
                  })
                  .catch(onError);
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
