import type { Snapshot } from '../../shared/types';
import type { TaskSchedule } from '../../shared/automation';
import { Field, ModelPicker } from '../../components/components';
type ModelSelection = { providerId?: string; model?: string; agentId?: string };
export function defaultSchedule(): TaskSchedule {
  return {
    kind: 'daily',
    time: '09:00',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekdays: [1, 2, 3, 4, 5],
  };
}
export function ModelAgentFields({
  data,
  value,
  onChange,
}: {
  data: Snapshot;
  value: ModelSelection;
  onChange(value: ModelSelection): void;
}) {
  const provider = data.providers.find((p) => p.id === value.providerId);
  return (
    <div className="automation-grid">
      <Field label="模型连接">
        <select
          required
          aria-label="模型连接"
          value={value.providerId ?? ''}
          onChange={(e) =>
            onChange({
              providerId: e.target.value,
              model: data.providers.find((p) => p.id === e.target.value)?.models[0] ?? '',
            })
          }
        >
          <option value="">请选择</option>
          {data.providers
            .filter((p) => p.enabled !== false)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      </Field>
      <Field label="模型">
        <ModelPicker
          label="模型"
          value={value.model ?? ''}
          models={provider?.models ?? []}
          modelLabels={provider?.modelLabels}
          onChange={(model) => onChange({ model })}
        />
      </Field>
      <Field label="执行 Agent">
        <select
          aria-label="执行 Agent"
          value={value.agentId ?? ''}
          onChange={(e) => onChange({ agentId: e.target.value })}
        >
          <option value="">通用助手</option>
          {data.agents
            .filter((a) => !a.builtin)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
      </Field>
    </div>
  );
}
export function ScheduleFields({
  schedule,
  missed,
  setSchedule,
  onMissed,
}: {
  schedule: TaskSchedule;
  missed: 'once' | 'skip';
  setSchedule(s: TaskSchedule): void;
  onMissed(v: 'once' | 'skip'): void;
}) {
  return (
    <div className="automation-schedule">
      <Field label="执行频率">
        <select
          aria-label="执行频率"
          value={schedule.kind}
          onChange={(e) => {
            const kind = e.target.value;
            setSchedule(
              kind === 'once'
                ? { kind, at: Date.now() + 3600000 }
                : kind === 'interval'
                  ? { kind, minutes: 60 }
                  : {
                      kind: kind as 'daily' | 'weekly',
                      time: '09:00',
                      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                      weekdays: [1, 2, 3, 4, 5],
                    },
            );
          }}
        >
          <option value="daily">每天</option>
          <option value="weekly">每周</option>
          <option value="interval">固定间隔</option>
          <option value="once">仅一次</option>
        </select>
      </Field>
      {schedule.kind === 'interval' ? (
        <Field label="间隔分钟">
          <input
            aria-label="间隔分钟"
            required
            type="number"
            min={5}
            max={525600}
            value={schedule.minutes}
            onChange={(e) => setSchedule({ ...schedule, minutes: Number(e.target.value) })}
          />
        </Field>
      ) : schedule.kind === 'once' ? (
        <Field label="执行日期与时间（本机时区）">
          <input
            required
            aria-label="执行日期与时间"
            type="datetime-local"
            value={new Date(schedule.at - new Date(schedule.at).getTimezoneOffset() * 60000)
              .toISOString()
              .slice(0, 16)}
            onChange={(e) => {
              const at = new Date(e.target.value).getTime();
              if (Number.isFinite(at)) setSchedule({ ...schedule, at });
            }}
          />
        </Field>
      ) : (
        <>
          <div className="automation-grid">
            <Field label="执行时间">
              <input
                required
                aria-label="执行时间"
                type="time"
                value={schedule.time}
                onChange={(e) => setSchedule({ ...schedule, time: e.target.value })}
              />
            </Field>
            <Field label="时区">
              <input
                required
                aria-label="时区"
                value={schedule.timezone}
                onChange={(e) => setSchedule({ ...schedule, timezone: e.target.value })}
              />
            </Field>
          </div>
          {schedule.kind === 'weekly' && (
            <div className="row">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <label key={d}>
                  <input
                    type="checkbox"
                    checked={schedule.weekdays.includes(d)}
                    onChange={(e) =>
                      setSchedule({
                        ...schedule,
                        weekdays: e.target.checked
                          ? [...schedule.weekdays, d]
                          : schedule.weekdays.filter((v) => v !== d),
                      })
                    }
                  />
                  周{'日一二三四五六'[d]}
                </label>
              ))}
            </div>
          )}
        </>
      )}
      <Field label="错过执行时间">
        <select
          aria-label="错过执行时间"
          value={missed}
          onChange={(e) => onMissed(e.target.value as 'once' | 'skip')}
        >
          <option value="once">恢复后合并补跑一次</option>
          <option value="skip">跳过错过的执行</option>
        </select>
      </Field>
    </div>
  );
}
