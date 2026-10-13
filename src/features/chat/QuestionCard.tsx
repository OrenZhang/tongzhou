import { useState } from 'react';
import type { Approval } from '../../shared/types';
import type { QuestionAnswers } from '../../shared/agent-execution';
import { errorMessage } from '../../lib/feedback';

export function QuestionCard({
  request,
  onAnswer,
}: {
  request: Approval;
  onAnswer(id: string, answers: QuestionAnswers | null): Promise<void>;
}) {
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const questions = request.questions ?? [];
  const answers: QuestionAnswers = Object.fromEntries(
    questions.map((q) => [
      q.id,
      [
        (selected[q.id] === '__other' || !q.options?.length
          ? custom[q.id]
          : selected[q.id]
        )?.trim() ?? '',
      ],
    ]),
  );
  const submit = async (value: QuestionAnswers | null) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onAnswer(request.id, value);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <form
      className="question-card"
      aria-label="待回答问题"
      aria-busy={busy}
      onSubmit={(e) => {
        e.preventDefault();
        void submit(answers);
      }}
    >
      {questions.map((q) => (
        <fieldset key={q.id} disabled={busy}>
          <legend>{q.header || '需要你的补充'}</legend>
          <p>{q.question}</p>
          {q.options?.map((option) => (
            <label className="question-option" key={option.label}>
              <input
                type="radio"
                name={`${request.id}:${q.id}`}
                value={option.label}
                checked={selected[q.id] === option.label}
                onChange={() => setSelected({ ...selected, [q.id]: option.label })}
              />
              <span>
                {option.label}
                {option.description && <small>{option.description}</small>}
              </span>
            </label>
          ))}
          {q.isOther && !!q.options?.length && (
            <label className="question-option">
              <input
                type="radio"
                name={`${request.id}:${q.id}`}
                checked={selected[q.id] === '__other'}
                onChange={() => setSelected({ ...selected, [q.id]: '__other' })}
              />
              <span>自定义回答</span>
            </label>
          )}
          {(!q.options?.length || (q.isOther && selected[q.id] === '__other')) && (
            <input
              aria-label={q.header || q.question}
              type={q.isSecret ? 'password' : 'text'}
              autoComplete="off"
              maxLength={8000}
              value={custom[q.id] ?? ''}
              onChange={(e) => setCustom({ ...custom, [q.id]: e.target.value })}
            />
          )}
        </fieldset>
      ))}
      <div className="question-actions">
        <small className="muted">
          {request.isBlocking ? '回答后继续当前任务' : '可补充回答，任务会继续进行'}
        </small>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void submit(null)}
        >
          跳过
        </button>
        <button type="submit" disabled={busy || questions.some((q) => !answers[q.id][0])}>
          {busy ? '提交中…' : '提交回答'}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
