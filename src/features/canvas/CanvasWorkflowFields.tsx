import { t as tr, getLocale } from '../../shared/i18n';
import { useEffect, useState } from 'react';
import type { Canvas, CanvasNode } from '../../shared/canvas';
import type { AutomationRule, TaskSchedule } from '../../shared/automation';
import type { Session, TongzhouAPI } from '../../shared/types';
import { ScheduleFields } from '../automation/AutomationFields';
import { errorMessage } from '../../lib/feedback';

export function CanvasWorkflowFields({
  api,
  canvas,
  node,
  owner,
  patch,
  save,
}: {
  api: TongzhouAPI;
  canvas: Canvas;
  node: CanvasNode;
  owner?: Session;
  patch(p: Partial<CanvasNode>): void;
  save(): Promise<Canvas | undefined>;
}) {
  const [rule, setRule] = useState<AutomationRule>();
  const [targets, setTargets] = useState<Awaited<ReturnType<TongzhouAPI['notificationTargets']>>>(
    [],
  );
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        if (node.pluginId === 'workflow.schedule') {
          const state = await api.automationState();
          if (active)
            setRule(
              state.rules.find(
                (r) =>
                  r.kind === 'canvas' && r.canvas?.id === canvas.id && r.canvas.nodeId === node.id,
              ),
            );
        } else {
          const next = await api.notificationTargets();
          if (active) setTargets(next);
        }
        if (active) setLoaded(true);
      } catch (e) {
        if (active) setError(errorMessage(e));
      }
    };
    setLoaded(false);
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = api.onEvent((e) => {
      if (e.type === 'changed' && !timer)
        timer = setTimeout(() => {
          timer = undefined;
          void load();
        }, 300);
    });
    return () => {
      active = false;
      off();
      clearTimeout(timer);
    };
  }, [api, canvas.id, node.id, node.pluginId]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const config = node.config ?? {};
  const schedule = (config.schedule ?? { kind: 'interval', minutes: 60 }) as TaskSchedule;
  const missed = config.missed === 'skip' ? 'skip' : 'once';
  return (
    <div className="canvas-media-fields">
      {node.pluginId === 'workflow.schedule' ? (
        <>
          <ScheduleFields
            schedule={schedule}
            missed={missed}
            setSchedule={(schedule) => patch({ config: { ...config, schedule } })}
            onMissed={(missed) => patch({ config: { ...config, missed } })}
          />
          <small>
            {tr(
              '连接下游节点后发布。仅在CoSail运行且电脑唤醒时调度；修改画布后需重新发布。执行权限为“需确认”，涉及工具操作时可能等待审批。',
            )}
          </small>
          {rule && (
            <small role="status">
              {rule.enabled ? tr('已启用') : tr('已暂停')}
              {tr(' · 发布版本 v')}
              {rule.canvas?.version}
              {rule.nextRunAt && rule.enabled
                ? tr(' · 下次 ') + new Date(rule.nextRunAt).toLocaleString(getLocale())
                : ''}
              {canvas.version !== rule.canvas?.version ? tr(' · 画布版本已变化') : ''}
            </small>
          )}
          {rule?.error && <small role="alert">{rule.error}</small>}
          <button
            disabled={busy || !loaded || !owner}
            onClick={() =>
              void act(async () => {
                if (!owner) throw new Error(tr('请先选择执行会话'));
                const saved = await save();
                if (!saved || saved.id !== canvas.id) throw new Error(tr('请先保存当前画布'));
                const latest = (await api.automationState()).rules.find(
                  (r) =>
                    r.kind === 'canvas' && r.canvas?.id === saved.id && r.canvas.nodeId === node.id,
                );
                const savedNode = saved.nodes.find((n) => n.id === node.id);
                if (!savedNode) throw new Error(tr('定时触发节点已删除'));
                setRule(
                  await api.automationSave({
                    id: latest?.id,
                    version: latest?.version,
                    name: (saved.title + ' · ' + node.title).slice(0, 100),
                    kind: 'canvas',
                    trigger: 'schedule',
                    enabled: true,
                    canvas: {
                      id: saved.id,
                      version: saved.version,
                      nodeId: node.id,
                      sessionId: owner.id,
                    },
                    projectId: owner.projectId ?? undefined,
                    permission: 'ask',
                    providerId: owner.providerId || undefined,
                    model: owner.model || undefined,
                    agentId: owner.agentId || undefined,
                    schedule: savedNode.config?.schedule as TaskSchedule,
                    missed: savedNode.config?.missed === 'skip' ? 'skip' : 'once',
                  }),
                );
              })
            }
          >
            {rule ? tr('保存并重新发布定时流程') : tr('保存并启用定时流程')}
          </button>
          {rule?.enabled && (
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => setRule(await api.automationSave({ ...rule, enabled: false })))
              }
            >
              {tr('暂停定时流程')}
            </button>
          )}
          {!owner && <small>{tr('请先在画布顶部选择执行会话。')}</small>}
          <small>
            {tr(
              '执行记录、立即运行、取消和重试可在“自动化”中管理。暂停只停止后续调度，已开始的流程需要单独取消。',
            )}
          </small>
        </>
      ) : (
        <>
          <label>
            {tr('通知渠道')}
            <select
              aria-label={tr('通知渠道')}
              value={String(config.targetId ?? '')}
              onChange={(e) => patch({ config: { ...config, targetId: e.target.value } })}
            >
              <option value="">{tr('选择已配置的通知目标')}</option>
              {config.targetId && !targets.some((t) => t.id === config.targetId) ? (
                <option value={String(config.targetId)}>{tr('原渠道不可用，请重新选择')}</option>
              ) : null}
              {targets.map((t) => (
                <option key={t.id} value={t.id} disabled={!t.available}>
                  {t.name}
                  {t.available ? '' : tr('（不可用）')}
                </option>
              ))}
            </select>
          </label>
          <small>
            {tr('正文支持 ')}
            {'{{input}}'}
            {tr('（合并上游正文）、')}
            {'{{input.1}}'}
            {tr('（第一个输入），最多 4000 字。请在“渠道”中配置账号或机器人；节点不保存密钥。')}
          </small>
          <small>
            {tr(
              '发送前沿用会话审批。执行后输出回执；不确定是否送达时请查看渠道记录，重试不会重复投递同一定时任务的通知。',
            )}
          </small>
          {loaded && !targets.length && (
            <small>{tr('暂无通知目标，请先在“渠道”中添加并启用。')}</small>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="danger">
          {error}
        </p>
      )}
    </div>
  );
}
