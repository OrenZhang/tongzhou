import { Plus, Trash2 } from 'lucide-react';
import { ChoicePicker } from './ChoicePicker';
import { Field } from './components';
import {
  entityTypes,
  relationTypes,
  type KnowledgeAssertion,
  type EntityType,
  type RelationType,
} from './shared/ontology';
export function KnowledgeAssertions({
  value,
  onChange,
  sources,
}: {
  value: KnowledgeAssertion[];
  onChange(v: KnowledgeAssertion[]): void;
  sources: { id: string; title: string }[];
}) {
  const change = (i: number, patch: Partial<KnowledgeAssertion>) =>
    onChange(value.map((a, n) => (n === i ? { ...a, ...patch } : a)));
  return (
    <details className="ontology-editor">
      <summary>结构化知识 · {value.length} 条</summary>
      <p className="knowledge-section-hint">
        把明确的事实、关系提炼为 Agent
        可检索的知识。摘录必须与选定来源原文一致；不要把猜测当作事实。
      </p>
      {value.map((a, i) => (
        <fieldset key={i}>
          <legend>知识 {i + 1}</legend>
          <div className="form-grid">
            <Field label="实体名称">
              <input
                aria-label={`实体名称 ${i + 1}`}
                value={a.subject}
                onChange={(e) => change(i, { subject: e.target.value })}
              />
            </Field>
            <Field label="实体类型">
              <ChoicePicker
                label={`实体类型 ${i + 1}`}
                value={a.subjectType}
                options={Object.entries(entityTypes).map(([value, label]) => ({ value, label }))}
                onChange={(v) => change(i, { subjectType: v as EntityType })}
              />
            </Field>
            <Field label="关系 / 属性">
              <ChoicePicker
                label={`关系 ${i + 1}`}
                value={a.relation}
                options={Object.entries(relationTypes).map(([value, r]) => ({
                  value,
                  label: r.label,
                }))}
                onChange={(v) =>
                  change(i, {
                    relation: v as RelationType,
                    objectType: relationTypes[v as RelationType].entity
                      ? v === 'owner'
                        ? 'person'
                        : 'system'
                      : undefined,
                  })
                }
              />
            </Field>
            <Field label="目标 / 值">
              <input
                aria-label={`知识值 ${i + 1}`}
                value={a.object}
                onChange={(e) => change(i, { object: e.target.value })}
              />
            </Field>
            {relationTypes[a.relation].entity && (
              <Field label="目标类型">
                <ChoicePicker
                  label={`目标类型 ${i + 1}`}
                  value={a.objectType ?? 'system'}
                  options={Object.entries(entityTypes)
                    .filter(
                      ([v]) => a.relation !== 'owner' || ['person', 'organization'].includes(v),
                    )
                    .map(([value, label]) => ({ value, label }))}
                  onChange={(v) => change(i, { objectType: v as EntityType })}
                />
              </Field>
            )}
            <Field label="证据来源">
              <ChoicePicker
                label={`证据来源 ${i + 1}`}
                value={a.sourceId ?? ''}
                options={[
                  { value: '', label: '本文' },
                  ...sources.map((s) => ({ value: s.id, label: s.title })),
                ]}
                onChange={(v) => change(i, { sourceId: v || undefined })}
              />
            </Field>
            <Field label="有效起始日（可选）">
              <input
                type="date"
                value={a.validFrom ?? ''}
                onChange={(e) => change(i, { validFrom: e.target.value || undefined })}
              />
            </Field>
            <Field label="有效截止日（可选）">
              <input
                type="date"
                value={a.validUntil ?? ''}
                onChange={(e) => change(i, { validUntil: e.target.value || undefined })}
              />
            </Field>
          </div>
          <Field label="原文摘录">
            <textarea
              aria-label={`证据摘录 ${i + 1}`}
              value={a.quote}
              onChange={(e) => change(i, { quote: e.target.value })}
            />
          </Field>
          <button
            className="text-button danger"
            onClick={() => onChange(value.filter((_, n) => n !== i))}
          >
            <Trash2 size={14} />
            移除此条知识
          </button>
        </fieldset>
      ))}
      <button
        className="secondary"
        disabled={value.length >= 100}
        onClick={() =>
          onChange([
            ...value,
            { subject: '', subjectType: 'concept', relation: 'fact', object: '', quote: '' },
          ])
        }
      >
        <Plus size={14} />
        添加结构化知识
      </button>
    </details>
  );
}
