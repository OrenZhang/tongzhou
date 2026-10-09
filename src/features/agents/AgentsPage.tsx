import { useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  Bot,
  Check,
  Layers3,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  ShieldCheck,
  Trash2,
  Users,
  Zap,
} from 'lucide-react';
import type { AgentProfile, Snapshot, TongzhouAPI } from '../../shared/types';
import type { View } from '../../app/views';
import { Field, Modal, ModelPicker } from '../../components/components';

interface Props {
  api: TongzhouAPI;
  data: Snapshot;
  providerId: string;
  running: boolean;
  refresh: () => Promise<void>;
  perform: <T>(action: () => Promise<T>) => Promise<T | undefined>;
  onNavigate: (view: View) => void;
  onUseAgent: (agent: AgentProfile) => void;
}
export function AgentsPage({
  api,
  data,
  providerId,
  running,
  refresh,
  perform,
  onNavigate,
  onUseAgent,
}: Props) {
  const [agentEdit, setAgentEdit] = useState<AgentProfile | null>(null);
  return (
    <>
      <main className="page">
        <div className="page-heading">
          <div className="page-title-row">
            <div>
              <h1>Agent</h1>
              <p>内置 Agent 处理专门任务，也可以创建自己的角色。普通聊天无需选择 Agent。</p>
            </div>
            <button
              className="primary"
              onClick={() =>
                setAgentEdit({
                  id: crypto.randomUUID(),
                  name: '',
                  description: '',
                  instructions: '',
                  providerId: '',
                  model: '',
                  permission: 'read-only',
                  maxSteps: 0,
                })
              }
            >
              <Plus size={16} />
              创建 Agent
            </button>
          </div>
        </div>
        <div className="agent-grid">
          {!data.agents.length && (
            <div className="empty-state collection-empty">
              <Bot size={28} />
              <h3>按需创建你的专属角色</h3>
              <p>普通聊天无需 Agent。需要固定指令、模型或职责时，再创建一个。</p>
            </div>
          )}
          {data.agents
            .filter((a) => a.builtin)
            .map((a) => (
              <article className="agent-card" key={a.id}>
                <div className="card-top">
                  <span className="agent-avatar tone-0">
                    <BookOpen size={25} />
                  </span>
                  <span className="tag">
                    内置 · {a.builtin === 'memory-organizer' ? '记忆整理' : '知识整理'}
                    {a.customized ? ' · 已自定义' : ''}
                  </span>
                </div>
                <h3>{a.name}</h3>
                <p>{a.description}</p>
                <div className="agent-instructions">
                  {a.builtin === 'memory-organizer'
                    ? '后台收集候选 → 核对原文 → 按日分类归并 → 持续补充'
                    : '阅读来源 → 查重与补充 → 生成草稿 → 人工核对收录'}
                </div>
                <div className="agent-detail">
                  <span>
                    <Layers3 size={13} />
                    {a.model || (a.providerId ? '使用指定连接的默认模型' : '继承来源会话模型')}
                  </span>
                  <span>
                    <ShieldCheck size={13} />
                    {a.builtin === 'memory-organizer' ? '仅处理本批记忆来源' : '仅整理知识资料'}
                  </span>
                </div>
                <div className="card-footer">
                  <span>
                    {a.builtin === 'memory-organizer'
                      ? '在定时任务中管理触发与记录'
                      : '在智库选择资料后启动'}
                  </span>
                  <button
                    onClick={() =>
                      onNavigate(a.builtin === 'memory-organizer' ? 'automations' : 'knowledge')
                    }
                  >
                    {a.builtin === 'memory-organizer' ? '管理任务' : '前往智库'}
                    <ArrowRight size={13} />
                  </button>
                  <button className="primary" onClick={() => setAgentEdit(a)}>
                    配置
                  </button>
                </div>
              </article>
            ))}
          {data.agents
            .filter((a) => !a.builtin)
            .map((a, i) => (
              <article className="agent-card" key={a.id}>
                <div className="card-top">
                  <span className={'agent-avatar tone-' + (i % 3)}>
                    <Bot size={25} />
                  </span>
                  <span className="tag">
                    {a.permission === 'read-only' ? '只读分析' : '审批后执行'}
                  </span>
                  <button
                    className="icon-button"
                    aria-label={'编辑 ' + a.name}
                    onClick={() => setAgentEdit(a)}
                  >
                    <SlidersHorizontal size={17} />
                  </button>
                </div>
                <h3>{a.name}</h3>
                <p>{a.description}</p>
                <div className="agent-instructions">{a.instructions}</div>
                <div className="agent-detail">
                  <span>
                    <Layers3 size={13} />
                    {a.model || '继承会话模型'}
                  </span>
                  <span>
                    <Zap size={13} />
                    Codex 执行核心
                  </span>
                </div>
                <div className="card-footer">
                  <span>
                    {data.providers.find((p) => p.id === a.providerId)?.name ?? '继承会话连接'}
                  </span>
                  <button
                    aria-label={`使用 ${a.name}`}
                    disabled={running}
                    onClick={() => {
                      onUseAgent(a);
                    }}
                  >
                    用于当前会话
                  </button>
                  <button onClick={() => setAgentEdit(a)}>
                    配置
                    <ArrowRight size={13} />
                  </button>
                </div>
              </article>
            ))}
        </div>
        <div className="section-note">
          <Users size={20} />
          <div>
            <strong>从同一个问题，获得不同视角</strong>
            <p>
              在会话输入任务后点击协作按钮，同时运行最多 3 个
              Agent。第一版的并行协作使用只读权限，结果回到主会话，由主助手继续实施。
            </p>
          </div>
        </div>
      </main>
      {agentEdit && (
        <Modal
          title="配置 Agent"
          subtitle={
            agentEdit.builtin
              ? '调整内置 Agent 的整理方式与模型；执行范围固定，保存后用于下一次任务。'
              : '角色配置可以独立选择模型，也可以继承当前会话。'
          }
          onClose={() => setAgentEdit(null)}
        >
          <div className="modal-content">
            <div className="form-grid">
              <Field label="名称">
                <input
                  value={agentEdit.name}
                  onChange={(e) => setAgentEdit({ ...agentEdit, name: e.target.value })}
                />
              </Field>
              <Field label="执行权限">
                {agentEdit.builtin ? (
                  <input
                    readOnly
                    value={
                      agentEdit.builtin === 'memory-organizer'
                        ? '本批记忆来源与记忆提交（固定）'
                        : '知识资料读取与草稿整理（固定）'
                    }
                  />
                ) : (
                  <select
                    value={agentEdit.permission}
                    onChange={(e) =>
                      setAgentEdit({
                        ...agentEdit,
                        permission: e.target.value as 'ask' | 'read-only',
                      })
                    }
                  >
                    <option value="read-only">只读分析</option>
                    <option value="ask">修改与命令需审批</option>
                  </select>
                )}
              </Field>
            </div>
            <Field label="职责描述">
              <input
                value={agentEdit.description}
                onChange={(e) => setAgentEdit({ ...agentEdit, description: e.target.value })}
              />
            </Field>
            <Field label="角色指令">
              <textarea
                rows={5}
                value={agentEdit.instructions}
                onChange={(e) => setAgentEdit({ ...agentEdit, instructions: e.target.value })}
              />
            </Field>
            {!agentEdit.builtin && (
              <Field
                label="性格与表达风格"
                hint="留空继承同舟的通用性格。只影响表达方式，身份仍为同舟。"
              >
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={agentEdit.soul ?? ''}
                  placeholder="例如：像耐心的技术导师，先给结论，再用小例子解释。"
                  onChange={(e) => setAgentEdit({ ...agentEdit, soul: e.target.value })}
                />
              </Field>
            )}
            <div className="form-grid">
              <Field
                label="模型连接"
                hint={
                  agentEdit.builtin
                    ? '默认继承来源会话。指定其他连接但未选模型时，使用该连接的第一个模型。'
                    : undefined
                }
              >
                <select
                  value={agentEdit.providerId}
                  onChange={(e) =>
                    setAgentEdit({ ...agentEdit, providerId: e.target.value, model: '' })
                  }
                >
                  <option value="">继承会话连接</option>
                  {data.providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="模型">
                <ModelPicker
                  key={agentEdit.providerId || providerId}
                  label="Agent 模型"
                  inherit
                  modelLabels={
                    data.providers.find((p) => p.id === (agentEdit.providerId || providerId))
                      ?.modelLabels
                  }
                  value={agentEdit.model}
                  models={
                    data.providers.find((p) => p.id === (agentEdit.providerId || providerId))
                      ?.models ?? []
                  }
                  load={
                    agentEdit.providerId || providerId
                      ? () => api.models(agentEdit.providerId || providerId)
                      : undefined
                  }
                  onChange={(model) => setAgentEdit({ ...agentEdit, model })}
                />
              </Field>
            </div>
          </div>
          <div className="modal-footer">
            {data.agents.some((a) => a.id === agentEdit.id) && (
              <button
                className={agentEdit.builtin ? 'text-button' : 'text-button danger'}
                onClick={() =>
                  perform(async () => {
                    await api.deleteAgent(agentEdit.id);
                    setAgentEdit(null);
                    await refresh();
                  })
                }
              >
                {agentEdit.builtin ? <RefreshCw size={14} /> : <Trash2 size={14} />}
                {agentEdit.builtin ? '恢复默认' : '删除'}
              </button>
            )}
            <span className="spacer" />
            <button
              className="primary"
              onClick={() =>
                perform(async () => {
                  await api.saveAgent(agentEdit);
                  setAgentEdit(null);
                  await refresh();
                })
              }
            >
              保存 Agent
              <Check size={15} />
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
