import { mediaModelCatalog, type MediaKind } from '../../shared/model-capabilities';
import { switchCanvasMediaTool } from '../../shared/canvas-media-settings';
import type { CanvasMedia } from '../../shared/canvas';
import type { Snapshot } from '../../shared/types';
import { t as tr } from '../../shared/i18n';
import '../connections/model-capabilities.css';

/** Both the compact node composer and advanced configuration use the same executable catalog. */
export function CanvasModelPicker({
  data,
  media,
  kind,
  mode = media.mode,
  onChange,
}: {
  data: Snapshot;
  media: CanvasMedia;
  kind: MediaKind;
  mode?: CanvasMedia['mode'];
  onChange(media: CanvasMedia): void;
}) {
  const choices = mediaModelCatalog(data.providers, data.plugins ?? [], kind, mode);
  const key = media.modelProviderId
    ? JSON.stringify([media.modelProviderId, media.registeredModel])
    : '';
  const selected = choices.find((c) => JSON.stringify([c.providerId, c.model]) === key);
  if (!choices.length && !key)
    return (
      <details className="canvas-model-picker">
        <summary>{tr('已配置的生成模型')}</summary>
        <small>{tr('可在模型连接中标记生成能力并绑定工具，也可直接选择下方插件。')}</small>
      </details>
    );
  return (
    <label className="canvas-model-picker">
      {tr('已配置的生成模型')}
      <select
        aria-label={tr('已配置的生成模型')}
        value={key}
        onChange={(e) => {
          const choice = choices.find(
            (c) => JSON.stringify([c.providerId, c.model]) === e.target.value,
          );
          if (!choice) {
            onChange({ ...media, modelProviderId: undefined, registeredModel: undefined });
            return;
          }
          if (choice.issue || !choice.binding || !choice.tool) return;
          const next = switchCanvasMediaTool(media, choice.binding.pluginId, choice.tool).media;
          onChange({
            ...next,
            model: choice.wireModel,
            modelProviderId: choice.providerId,
            registeredModel: choice.model,
          });
        }}
      >
        <option value="">{tr('直接选择插件与工具')}</option>
        {key && !selected && (
          <option value={key} disabled>
            {tr('所选模型不可用，请重新选择')}
          </option>
        )}
        {choices.map((c) => (
          <option
            key={JSON.stringify([c.providerId, c.model])}
            value={JSON.stringify([c.providerId, c.model])}
            disabled={!!c.issue}
          >
            {c.name} · {c.label}
            {c.issue ? ` · ${tr(c.issue)}` : ''}
          </option>
        ))}
      </select>
      {!choices.length && (
        <small>{tr('可在模型连接中标记生成能力并绑定工具，也可直接选择下方插件。')}</small>
      )}
      {selected?.issue && <small role="status">{tr(selected.issue)}</small>}
    </label>
  );
}
