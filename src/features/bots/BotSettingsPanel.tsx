import { useEffect, useState } from 'react';
import type { BotSettings, Snapshot, TongzhouAPI } from '../../shared/types';

export function BotSettingsPanel({
  data,
  api,
  refresh,
  onClose,
}: {
  data: Snapshot;
  api: TongzhouAPI;
  refresh: () => Promise<void>;
  onClose: () => void;
}) {
  const saved = data.botSettings ?? {
    providerId: '',
    model: '',
    permission: 'full-access' as const,
    mode: 'workbench' as const,
  };
  const [draft, setDraft] = useState<BotSettings>(saved);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    setDraft(saved);
  }, [saved.providerId, saved.model, saved.permission, saved.mode, saved.defaultProjectId]);
  const providers = data.providers.filter((p) => p.enabled !== false);
  const provider = providers.find((p) => p.id === draft.providerId);
  const changed = JSON.stringify(saved) !== JSON.stringify(draft);
  return (
    <div className="bot-settings-panel modal-content">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setNotice('');
          try {
            await api.saveBotSettings(draft);
            await refresh();
            setNotice('已保存，下次消息生效');
          } catch (error) {
            setNotice(String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          模型连接
          <select
            aria-label="机器人模型连接"
            value={draft.providerId}
            onChange={(event) => {
              const next = providers.find((p) => p.id === event.target.value);
              setDraft({ ...draft, providerId: next?.id ?? '', model: next?.models[0] ?? '' });
            }}
          >
            <option value="" disabled>
              选择模型连接
            </option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          模型
          <select
            aria-label="机器人模型"
            value={draft.model}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
          >
            <option value="" disabled>
              选择模型
            </option>
            {provider?.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        {draft.mode === 'workbench' && (
          <label>
            执行模式
            <select
              aria-label="机器人执行模式"
              value={draft.permission}
              onChange={(event) =>
                setDraft({ ...draft, permission: event.target.value as BotSettings['permission'] })
              }
            >
              <option value="read-only">只读</option>
              <option value="ask">按需批准</option>
              <option value="full-access">完全开放</option>
            </select>
          </label>
        )}
        <label>
          使用模式
          <select
            aria-label="机器人使用模式"
            value={draft.mode}
            onChange={(e) => setDraft({ ...draft, mode: e.target.value as BotSettings['mode'] })}
          >
            <option value="workbench">控制工作台</option>
            <option value="chat">仅聊天</option>
          </select>
        </label>
        {draft.mode === 'workbench' && (
          <label>
            新建会话默认项目
            <select
              aria-label="机器人默认项目"
              value={draft.defaultProjectId ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, defaultProjectId: e.target.value || undefined })
              }
            >
              <option value="">普通聊天</option>
              {data.projects
                .filter((p) => !p.removed)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <p className="bot-settings-hint">修改设置会停止正在处理的机器人任务。</p>
        <div className="bot-settings-actions">
          <button type="button" onClick={onClose}>
            关闭
          </button>
          <button
            className="primary"
            disabled={busy || !draft.providerId || !draft.model || !changed}
          >
            {busy ? '保存中…' : '保存设置'}
          </button>
        </div>
        {notice && (
          <p role="status" className="bot-settings-hint">
            {notice}
          </p>
        )}
      </form>
    </div>
  );
}
