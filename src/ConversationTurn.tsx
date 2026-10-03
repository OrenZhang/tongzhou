import { GitBranch, Quote } from 'lucide-react';
import type { Message } from './shared/types';
import type { ConversationTurn as Turn } from './shared/turns';
import { ChatMessage, Mark, Markdown } from './components';
import { TurnThinking } from './RunActivity';

interface Actions {
  onQuote: (message: Message) => void;
  onBranch: (message: Message) => void;
  branchDisabled: boolean;
}

function MessageActions({
  message,
  onQuote,
  onBranch,
  branchDisabled,
}: Actions & { message: Message }) {
  return (
    <div className="message-actions">
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

export function ConversationTurn({ turn, ...actions }: Actions & { turn: Turn }) {
  const first = turn.messages[0];
  const prompt = first?.role === 'user' ? first : undefined;
  const response = prompt ? turn.messages.slice(1) : turn.messages;
  const assistants = response.filter((m) => m.role === 'assistant');
  const assistant = assistants[0];
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
        <article className="chat-message assistant">
          <div className="message-avatar">
            <Mark small />
          </div>
          <div className="message-body">
            <div className="message-meta">
              <strong>{assistant?.agent ?? turn.run?.agentName ?? '同舟'}</strong>
              {(assistant?.model || turn.run?.model) && (
                <span>{assistant?.model ?? turn.run?.model}</span>
              )}
              <time>
                {new Date(
                  assistant?.createdAt ?? turn.run?.startedAt ?? first?.createdAt ?? 0,
                ).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </time>
              {status === 'interrupted' && <span>已中断</span>}
              {(status === 'failed' || status === 'error') && <span>未完成</span>}
            </div>
            <TurnThinking events={turn.events} run={turn.run} active={active} />
            {response.map((m) => {
              if (m.role === 'tool') return null;
              if (m.role === 'system') return <ChatMessage key={m.id} message={m} />;
              if (m.role === 'user')
                return (
                  <aside key={m.id} className="turn-supplement" data-message-id={m.id}>
                    <span>你补充</span>
                    <Markdown text={m.content} />
                    <MessageActions message={m} {...actions} />
                  </aside>
                );
              return m.content ? (
                <div key={m.id} className="assistant-segment" data-message-id={m.id}>
                  <Markdown text={m.content} />
                </div>
              ) : null;
            })}
            {!active && endpoint && text && (
              <MessageActions message={{ ...endpoint, content: text }} {...actions} />
            )}
          </div>
        </article>
      )}
    </section>
  );
}
