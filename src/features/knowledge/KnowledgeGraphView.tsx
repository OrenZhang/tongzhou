import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FileText, Network, Search } from 'lucide-react';
import { ChoicePicker } from '../../components/controls/ChoicePicker';
import type { TongzhouAPI } from '../../shared/types';
import { entityTypes, relationTypes, type KnowledgeGraph } from '../../shared/ontology';

const statuses = { confirmed: '已确认', pending: '待核对', stale: '来源失效', expired: '已过期' };
export function KnowledgeGraphView({
  api,
  project,
  onOpen,
  scopeName,
}: {
  api: TongzhouAPI;
  project?: string;
  onOpen(id: string): void;
  scopeName(scope: string): string;
}) {
  const [query, setQuery] = useState(''),
    [graph, setGraph] = useState<KnowledgeGraph>(),
    [entity, setEntity] = useState(''),
    [status, setStatus] = useState('all'),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const requestKey = useRef('');
  requestKey.current = JSON.stringify([query, project]);
  useEffect(() => {
    let alive = true;
    setGraph(undefined);
    setEntity('');
    setError('');
    const timer = setTimeout(() => {
      setLoading(true);
      api
        .knowledgeGraph(query, project)
        .then(
          (g) => {
            if (alive) setGraph(g);
          },
          (e) => {
            if (alive) setError(String(e));
          },
        )
        .finally(() => {
          if (alive) setLoading(false);
        });
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, query, project]);
  const facts = (graph?.facts ?? []).filter(
    (f) =>
      (!entity || f.subjectId === entity || f.objectId === entity) &&
      (status === 'all' || (status === 'conflict' ? f.conflict : f.status === status)),
  );
  return (
    <div className="knowledge-layout ontology-layout">
      <aside className="knowledge-library">
        <label className="knowledge-search">
          <Search size={15} />
          <input
            aria-label="搜索知识关系"
            placeholder="搜索实体、事实或关系…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <ChoicePicker
          label="知识状态"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: '全部状态' },
            ...Object.entries(statuses).map(([value, label]) => ({ value, label })),
            { value: 'conflict', label: '可能冲突' },
          ]}
        />
        <button
          className={'ontology-entity' + (!entity ? ' selected' : '')}
          onClick={() => setEntity('')}
        >
          <Network size={16} />
          <span>全部实体</span>
          <small className="ontology-entity-count">{graph?.entities.length ?? 0}</small>
        </button>
        {graph?.entities.map((e) => (
          <button
            className={'ontology-entity' + (entity === e.id ? ' selected' : '')}
            key={e.id}
            title={`${e.name} · ${entityTypes[e.type]} · ${scopeName(e.scope)}`}
            onClick={() => setEntity(e.id)}
          >
            <span className="ontology-node" />
            <span>
              <span className="ontology-entity-name">{e.name}</span>
              <small>
                {entityTypes[e.type]} · {scopeName(e.scope)}
              </small>
            </span>
          </button>
        ))}
      </aside>
      <main className="knowledge-reader" tabIndex={0} aria-label="知识关系内容">
        <div className="ontology-heading">
          <div>
            <h2>{graph?.entities.find((e) => e.id === entity)?.name ?? '知识与记忆'}</h2>
            <p>从文档和每日记忆提炼，按来源核对。Agent 通过工具按需查询。</p>
          </div>
          <span className="knowledge-type">
            {facts.length} 条 / {graph?.total ?? 0}
          </span>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!facts.length && (
          <div className="knowledge-welcome">
            <Network size={30} />
            <h3>{loading ? '正在读取…' : '暂无符合条件的知识'}</h3>
            <p>
              在文档中点“让 Agent
              整理”，或编辑文档的“结构化知识”。已有每日记忆会自动出现在这里；原文不会被擅自改写。
            </p>
          </div>
        )}
        {facts.map((f) => (
          <article className="ontology-fact" key={f.id}>
            <div className="ontology-fact-meta">
              <span className={'ontology-status ' + f.status}>{statuses[f.status]}</span>
              {f.conflict && <span className="ontology-status conflict">可能冲突 · 请核对</span>}
              <small>{scopeName(f.scope)}</small>
            </div>
            <div className="ontology-triple">
              <strong>{f.subject}</strong>
              <span>
                {relationTypes[f.relation].label}
                <ArrowRight size={14} />
              </span>
              {f.objectId ? (
                <button className="text-button" onClick={() => setEntity(f.objectId!)}>
                  {f.object}
                </button>
              ) : (
                <p>{f.object}</p>
              )}
            </div>
            {(f.validFrom || f.validUntil) && (
              <p className="knowledge-section-hint">
                有效期：{f.validFrom ?? '未注明'} — {f.validUntil ?? '未注明'}
              </p>
            )}
            <details className="ontology-evidence">
              <summary>
                证据与维护 · {f.evidence.length} 处来源
                {f.evidence.some((e) => e.stale) ? ' · 含失效来源' : ''}
              </summary>
              {f.evidence.map((e, i) => (
                <div key={i}>
                  <blockquote>{e.quote}</blockquote>
                  <button className="text-button" onClick={() => onOpen(e.documentId)}>
                    <FileText size={13} />
                    {e.title} · v{e.version} ·{' '}
                    {e.stale ? '需复核' : e.reviewed ? '已核对' : '待核对'}
                    <span>查看 / 修正</span>
                  </button>
                </div>
              ))}
            </details>
          </article>
        ))}
        {graph?.nextOffset != null && (
          <button
            className="secondary"
            disabled={loading}
            onClick={async () => {
              const key = requestKey.current;
              setLoading(true);
              try {
                const g = await api.knowledgeGraph(query, project, graph.nextOffset!);
                if (key !== requestKey.current) return;
                setGraph((old) =>
                  old
                    ? {
                        ...g,
                        facts: [...old.facts, ...g.facts],
                        entities: [
                          ...new Map(
                            [...old.entities, ...g.entities].map((e) => [e.id, e]),
                          ).values(),
                        ],
                      }
                    : g,
                );
              } catch (e) {
                if (key === requestKey.current) setError(String(e));
              } finally {
                if (key === requestKey.current) setLoading(false);
              }
            }}
          >
            加载更多知识
          </button>
        )}
        <p className="knowledge-section-hint">
          相同范围、实体、关系、值与有效期的条目会合并展示。不同项目分别管理；“可能冲突”是结构检查，仍需核对原文。
        </p>
      </main>
    </div>
  );
}
