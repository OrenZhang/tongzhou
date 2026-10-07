import { Copy, GitBranch, Quote, Terminal, Brain } from 'lucide-react';
import type { Message } from '../../shared/types';
import {
  turnEntries,
  finalTurnEntry,
  processGroups,
  type TurnEntry,
  type ConversationTurn as Turn,
} from '../../shared/turns';
import { ChatMessage, Markdown } from '../../components/components';
import { TurnProcess } from './RunActivity';
import { AttachmentCards } from '../../components/files/Attachments';
import type { ReactNode } from 'react';

interface Actions {
  onCopy: (message: Message) => void;
  onQuote: (message: Message) => void;
  onBranch: (message: Message) => void;
  branchDisabled: boolean;
}

function MessageActions({
  message,
  onQuote,
  onBranch,
  onCopy,
  branchDisabled,
}: Actions & { message: Message }) {
  return (
    <div className="message-actions">
      <button
        className="icon-button"
        aria-label="复制消息"
        title="复制完整消息"
        onClick={() => onCopy(message)}
      >
        <Copy size={14} />
      </button>
      <button
        className="icon-button"
        aria-label="引用补充"
        title="引用补充：将这段内容放入输入框，继续当前会话"
        onClick={() => onQuote(message)}
      >
        <Quote size={14} />
      </button>
      <button
        className="icon-button"
        aria-label="从此处新建分支"
        title="从此处新建分支：复制截至这里的历史，开启独立会话"
        disabled={branchDisabled}
        onClick={() => onBranch(message)}
      >
        <GitBranch size={14} />
      </button>
    </div>
  );
}

export function ConversationTurn({
  turn,
  delivery,
  artifacts,
  ...actions
}: Actions & { turn: Turn; delivery?: ReactNode; artifacts?: ReactNode }) {
  const first = turn.messages[0];
  const prompt = first?.role === 'user' ? first : undefined;
  const response = prompt ? turn.messages.slice(1) : turn.messages;
  const assistants = response.filter((m) => m.role === 'assistant');
  const assistant = assistants[0];
  const agentName = assistant?.agent ?? turn.run?.agentName;
  const active = turn.run
    ? turn.run.status === 'running'
    : assistants.some((m) => m.status === 'streaming');
  const hasResponse = response.length > 0 || turn.events.length > 0 || active;
  const endpoint = response.at(-1);
  const text = assistants
    .map((m) => m.content)
    .filter(Boolean)
    .join('\n\n');
  const status = turn.run?.status ?? assistants.at(-1)?.status;
  const entries = turnEntries(turn);
  const final = finalTurnEntry(entries, active);
  const renderEntry = (entry: TurnEntry) => {
    if ('event' in entry) {
      const event = entry.event;
      if (event.type === 'phase') {
        if (active && event === turn.events.filter((e) => e.type === 'phase').at(-1)) return null;
        return (
          <div key={entry.key} className="process-phase" data-entry-kind="phase">
            {event.text}
          </div>
        );
      }
      if (event.type === 'reasoning')
        return (
          <section key={entry.key} className="process-reasoning" data-entry-kind="reasoning">
            <div className="process-reasoning-label">
              <Brain size={13} />
              思考摘要
            </div>
            <Markdown text={event.text} />
          </section>
        );
      return (
        <div key={entry.key} className="process-event" data-entry-kind={event.type}>
          <Terminal size={13} />
          <span>{event.text}</span>
        </div>
      );
    }
    const m = entry.message;
    if (m.role === 'tool')
      return (
        <details key={entry.key} className="process-tool" data-entry-kind="tool-result">
          <summary>
            <Terminal size={13} />
            {m.toolName ?? '工具结果'}
            {m.status === 'error' ? ' · 未完成' : ''}
          </summary>
          <pre>{entry.text}</pre>
        </details>
      );
    if (m.role === 'user')
      return (
        <aside
          key={entry.key}
          className="turn-supplement"
          data-message-id={m.id}
          data-entry-kind="supplement"
        >
          <span>你补充</span>
          <AttachmentCards items={m.attachments} />
          <Markdown text={entry.text} />
          <MessageActions message={m} {...actions} />
        </aside>
      );
    return (
      <div
        key={entry.key}
        className="assistant-segment"
        data-message-id={m.id}
        data-entry-kind="response"
      >
        <Markdown text={entry.text} streaming={m.status === 'streaming'} />
      </div>
    );
  };
  return (
    <section
      className="conversation-turn"
      data-run-id={turn.runId}
      data-turn-key={turn.key}
      aria-label="会话轮次"
    >
      {prompt && (
        <ChatMessage message={prompt} footer={<MessageActions message={prompt} {...actions} />} />
      )}
      {hasResponse && (
        <article className={'chat-message assistant' + (active ? ' is-active' : '')}>
          <div className="message-body">
            <TurnProcess
              events={turn.events}
              run={turn.run}
              active={active}
              hasContent={entries.some(
                (entry) => entry !== final && !('event' in entry && entry.event.type === 'notice'),
              )}
              collapsedContent={entries
                .filter((e) => 'message' in e && e.message.role === 'user')
                .map(renderEntry)}
            >
              {processGroups(entries.filter((e) => e !== final)).map((group) =>
                group.tools && group.entries.length > 1 ? (
                  <details key={group.key} className="process-tool-group">
                    <summary>
                      <Terminal size={13} />
                      工具调用 · {group.entries.length} 项
                      {group.entries.some((e) => 'message' in e && e.message.status === 'error') &&
                        ' · 有未完成项'}
                    </summary>
                    <div className="process-tool-list">{group.entries.map(renderEntry)}</div>
                  </details>
                ) : (
                  group.entries.map(renderEntry)
                ),
              )}
              {!active && entries.filter((e) => e !== final).length === 0 && (
                <div className="process-phase">
                  {turn.events
                    .filter((e) => e.type === 'phase')
                    .map((e) => e.text)
                    .join(' → ')}
                </div>
              )}
            </TurnProcess>
            {final && <div className="turn-final">{renderEntry(final)}</div>}
            {artifacts}
            {!active && delivery}
            {response
              .filter((m) => m.role === 'system')
              .map((m) => (
                <ChatMessage key={m.id} message={m} />
              ))}
            {!active && (
              <div className="message-footer">
                {endpoint && text && (
                  <MessageActions message={{ ...endpoint, content: text }} {...actions} />
                )}
                <div className="message-meta">
                  {agentName && agentName !== '同舟' && <strong>{agentName}</strong>}
                  {(assistant?.model || turn.run?.model) && (
                    <span className="message-model" title={assistant?.model ?? turn.run?.model}>
                      {assistant?.model ?? turn.run?.model}
                    </span>
                  )}
                  <time>
                    {new Date(
                      assistant?.createdAt ?? turn.run?.startedAt ?? first?.createdAt ?? 0,
                    ).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </time>
                  {status === 'interrupted' && <span>已中断</span>}
                  {(status === 'failed' || status === 'error') && <span>未完成</span>}
                </div>
              </div>
            )}
          </div>
        </article>
      )}
    </section>
  );
}
