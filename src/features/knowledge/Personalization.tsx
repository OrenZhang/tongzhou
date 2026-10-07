import { useEffect, useState } from 'react';
import type { TongzhouAPI } from '../../shared/types';
import {
  defaultReply,
  replyOptions,
  replyInstructions,
  type Personalization as Profile,
  type PersonalizationState,
  type PreferenceCandidate,
  type ReplyPreferences,
} from '../../shared/personalization';
import { Field } from '../../components/components';
import './personalization.css';

const matches = (a: Profile['memories'][number], b: PreferenceCandidate) =>
  a.documentId === b.documentId && a.entryId === b.entryId && a.fingerprint === b.fingerprint;
const editable = (value: PersonalizationState): Profile => ({
  ...value.profile,
  reply: value.profile.reply ?? { ...defaultReply },
  memories: value.profile.memories.filter((ref) => value.candidates.some((e) => matches(ref, e))),
});
export function Personalization({
  api,
  onChat,
  onMemories,
}: {
  api: TongzhouAPI;
  onChat(): void;
  onMemories(): void;
}) {
  const [state, setState] = useState<PersonalizationState>(),
    [draft, setDraft] = useState<Profile>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [filter, setFilter] = useState('');
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const value = await api.personalizationState();
      setState(value);
      setDraft(editable(value));
      setNotice('');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, [api]);
  const dirty = !!draft && !!state && JSON.stringify(draft) !== JSON.stringify(state.profile);
  const change = (value: Profile) => {
    setDraft(value);
    setNotice('');
  };
  const setReply = (value: Partial<ReplyPreferences>) => {
    if (draft) change({ ...draft, reply: { ...defaultReply, ...draft.reply, ...value } });
  };
  const save = async (chat = false) => {
    if (!draft || !state) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const profile = await api.savePersonalization(draft);
      setDraft(profile);
      setState({ ...state, profile, unavailable: 0 });
      setNotice(profile.enabled ? '已保存，下一轮对话生效' : '已保存，已暂停使用个人偏好');
      if (chat) onChat();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const selected =
    state?.candidates.filter((e) => draft?.memories.some((ref) => matches(ref, e))) ?? [];
  const pending =
    state?.candidates.filter((e) => !draft?.memories.some((ref) => matches(ref, e))) ?? [];
  const reply = draft?.reply ?? defaultReply;
  const summary = replyInstructions(reply);
  const renderCandidate = (e: PreferenceCandidate) => {
    const checked = draft!.memories.some((ref) => matches(ref, e));
    const saved = state!.profile.memories.some((ref) => matches(ref, e));
    return (
      <article key={e.entryId}>
        <label className="row">
          <input
            type="checkbox"
            aria-label={e.subject}
            checked={checked}
            disabled={busy || (!checked && draft!.memories.length >= 12)}
            onChange={() =>
              change({
                ...draft!,
                memories: checked
                  ? draft!.memories.filter((ref) => !matches(ref, e))
                  : [
                      ...draft!.memories,
                      { documentId: e.documentId, entryId: e.entryId, fingerprint: e.fingerprint },
                    ],
              })
            }
          />
          <strong>{e.subject}</strong>
          <small className="preference-state">
            {checked
              ? saved
                ? state!.profile.enabled
                  ? '已启用'
                  : '已保存 · 已暂停'
                : '待保存'
              : saved
                ? '待移除'
                : '待确认'}
          </small>
        </label>
        <p>{e.content}</p>
        <small className="muted">
          {e.source} · {new Date(e.occurredAt).toLocaleDateString()}
        </small>
        {!!e.quotes.length && (
          <details>
            <summary>查看来源原话</summary>
            {e.quotes.map((quote, i) => (
              <blockquote key={i}>{quote}</blockquote>
            ))}
          </details>
        )}
      </article>
    );
  };
  return (
    <div className="personalization-panel">
      <header className="preference-heading">
        <div>
          <h2>让同舟更懂你的沟通习惯</h2>
          <p className="muted">先选一种回复方式，保存后从下一轮对话开始使用。</p>
        </div>
        {draft && (
          <span className="preference-state">
            {dirty ? '有未保存修改' : state?.profile.enabled ? '已启用' : '已暂停'}
          </span>
        )}
      </header>
      {error && (
        <div role="alert" className="danger">
          <p>{error}</p>
          <button className="text-button" disabled={busy} onClick={() => void load()}>
            载入最新设置
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {draft && state ? (
        <>
          <label className="preference-enable">
            <input
              type="checkbox"
              role="switch"
              checked={draft.enabled}
              disabled={busy}
              onChange={(e) => change({ ...draft, enabled: e.target.checked })}
            />
            使用我的个性与偏好
          </label>
          {!draft.enabled && <p className="muted">保存关闭后使用默认风格，下面的设置仍会保留。</p>}
          <div className="preference-layout">
            <div className="preference-editor">
              <section className="preference-section">
                <h3>回复方式</h3>
                <div className="preference-presets">
                  <span>快速设置</span>
                  <button
                    disabled={busy}
                    onClick={() => setReply({ length: 'concise', tone: 'direct' })}
                  >
                    简洁直接
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => setReply({ length: 'detailed', tone: 'friendly' })}
                  >
                    耐心讲解
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => setReply({ language: 'auto', length: 'auto', tone: 'auto' })}
                  >
                    默认方式
                  </button>
                </div>
                <div className="preference-fields">
                  <Field label="怎么称呼你">
                    <input
                      disabled={busy}
                      maxLength={80}
                      placeholder="例如：小林（选填）"
                      value={reply.name}
                      onChange={(e) => setReply({ name: e.target.value })}
                    />
                  </Field>
                  {(['language', 'length', 'tone'] as const).map((key) => (
                    <Field
                      key={key}
                      label={{ language: '回复语言', length: '回答长度', tone: '沟通语气' }[key]}
                    >
                      <select
                        disabled={busy}
                        value={reply[key]}
                        onChange={(e) => setReply({ [key]: e.target.value })}
                      >
                        {Object.entries(replyOptions[key]).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ))}
                </div>
                <Field label="补充要求" hint="只填写希望长期保持的习惯；临时要求直接在聊天里说。">
                  <textarea
                    rows={3}
                    maxLength={4000}
                    disabled={busy}
                    placeholder="例如：代码示例优先用 TypeScript；专业术语顺带解释。"
                    value={draft.userPreferences}
                    onChange={(e) => change({ ...draft, userPreferences: e.target.value })}
                  />
                </Field>
                <details className="preference-advanced">
                  <summary>调整助手性格（高级）</summary>
                  <Field
                    label="同舟的通用性格"
                    hint="选填。留空沿用默认性格，自定义 Agent 仍可补充自己的角色风格。"
                  >
                    <textarea
                      rows={4}
                      maxLength={2000}
                      disabled={busy}
                      value={draft.soul}
                      placeholder={state.defaultSoul}
                      onChange={(e) => change({ ...draft, soul: e.target.value })}
                    />
                  </Field>
                  <button
                    className="text-button"
                    disabled={busy || !draft.soul}
                    onClick={() => change({ ...draft, soul: '' })}
                  >
                    恢复默认性格
                  </button>
                </details>
              </section>
              <section className="preference-section personalization-memories">
                <div className="row between">
                  <h3>聊天中记住的偏好</h3>
                  <small>{draft.memories.length} / 12 已选择</small>
                </div>
                <p className="muted">每日记忆提取的建议，勾选并保存后才会用于其他会话。</p>
                {!!state.unavailable && (
                  <p role="status">
                    {state.unavailable} 条原文已修改或删除，已停止使用，请重新核对。
                  </p>
                )}
                {!!selected.length && (
                  <div className="personalization-candidates" aria-label="选中的长期偏好">
                    {selected.map(renderCandidate)}
                  </div>
                )}
                <details
                  className="preference-suggestions"
                  open={suggestionsOpen}
                  onToggle={(e) => setSuggestionsOpen(e.currentTarget.open)}
                >
                  <summary>待确认建议 · {pending.length}</summary>
                  {pending.length > 0 ? (
                    <>
                      <input
                        aria-label="筛选候选偏好"
                        placeholder="查找内容或来源"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      />
                      <div className="personalization-candidates">
                        {pending
                          .filter((e) =>
                            `${e.subject} ${e.content} ${e.source}`
                              .toLowerCase()
                              .includes(filter.toLowerCase()),
                          )
                          .map(renderCandidate)}
                      </div>
                    </>
                  ) : (
                    <p className="muted">
                      暂无待确认建议。现在就可以使用上面的回复方式，不必等待记忆生成。
                    </p>
                  )}
                </details>
                <button className="text-button" disabled={busy} onClick={onMemories}>
                  查看每日记忆
                </button>
              </section>
            </div>
            <aside className="preference-preview" aria-label="设置摘要">
              <h3>{dirty ? '保存后将使用' : '当前使用的设置'}</h3>
              {!draft.enabled ? (
                <p>同舟默认风格</p>
              ) : (
                <>
                  {summary.length ? (
                    <ul>
                      {summary.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>跟随对话语言，按问题难度回答。</p>
                  )}
                  {draft.userPreferences && (
                    <p className="preference-summary-text">{draft.userPreferences}</p>
                  )}
                  {draft.soul && <p>使用自定义助手性格</p>}
                  {!!selected.length && <p>另外带入 {selected.length} 条已选择的长期偏好。</p>}
                </>
              )}
              <small>这是设置摘要，实际回答会结合当前问题。</small>
              <details>
                <summary>在哪些对话中生效？</summary>
                <p>
                  新对话和已有本地会话的下一轮都会使用，跨项目通用。后台整理、子任务、文档对话及消息渠道不带入个人设置。当前聊天中的明确要求优先。
                </p>
              </details>
            </aside>
          </div>
          <footer className="preference-savebar">
            <span>{dirty ? '修改尚未保存' : '设置已保存'}</span>
            <button
              className="text-button"
              disabled={busy || !dirty}
              onClick={() => {
                setDraft(editable(state));
                setNotice('已撤销未保存修改');
              }}
            >
              撤销修改
            </button>
            <button className="secondary" disabled={busy} onClick={() => void save(true)}>
              保存并去试聊
            </button>
            <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>
              保存偏好
            </button>
          </footer>
        </>
      ) : (
        busy && <p role="status">正在读取偏好…</p>
      )}
    </div>
  );
}
