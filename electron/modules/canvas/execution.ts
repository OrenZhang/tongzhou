import { createHash } from 'node:crypto';
import type {
  CanvasExecute,
  CanvasIteration,
  CanvasNodeRun,
  CanvasOutput,
  CanvasRun,
  CanvasEdge,
} from '../../../src/shared/canvas';
import { canvasFailurePort } from '../../../src/shared/canvas-ports';
import type { CanvasNodePlugins } from './node-plugins';
import { combineOutputs, foreachConfig } from './control-plugins';
import { executionUnits, type CanvasExecutionPlan, type CanvasLoopPlan } from './execution-plan';

const iterationExternal = (external: CanvasRun['external'], key: string) =>
  Object.fromEntries(
    Object.entries(external ?? {}).filter(
      ([id]) => id.endsWith(':' + key) || id.includes(':' + key + '/'),
    ),
  );

const canvasRunNodeEntries = (nodes: Record<string, CanvasNodeRun>): [string, CanvasNodeRun][] =>
  Object.entries(nodes).flatMap(([id, node]) => [
    [id, node] as [string, CanvasNodeRun],
    ...(node.iterations ?? []).flatMap((iteration) => canvasRunNodeEntries(iteration.nodes)),
  ]);

export const canvasRunNodes = (nodes: Record<string, CanvasNodeRun>): CanvasNodeRun[] =>
  canvasRunNodeEntries(nodes).map(([, node]) => node);

export function canvasEdgeActive(run: CanvasRun, edge: CanvasEdge) {
  const source = run.nodes[edge.from];
  if (!source) return false;
  if (edge.fromPort === canvasFailurePort) return source.status === 'failed';
  if (
    !['completed', 'cached'].includes(source.status) &&
    !(source.status === 'running' && source.iterations && source.output?.ports?.item)
  )
    return false;
  return (
    !source.output?.activePorts || source.output.activePorts.includes(edge.fromPort ?? 'result')
  );
}

interface ExecutionHost {
  plugins: CanvasNodePlugins;
  persist(): void;
  assertState(): void;
  executeNode(
    id: string,
    options: CanvasExecute,
    signal: AbortSignal,
    inputs?: CanvasOutput[],
  ): Promise<void>;
  executeGroup(ids: string[], options: CanvasExecute, signal: AbortSignal): Promise<void>;
  inputs(id: string, signal: AbortSignal): Promise<CanvasOutput[]>;
  history(): CanvasRun[];
  validateOutput(output: CanvasOutput): Promise<boolean>;
  cacheContext(id: string, options: CanvasExecute): unknown;
}

/** One shared execution budget and semaphore cover independent branches and nested loop bodies. */
export class CanvasExecution {
  private controller = new AbortController();
  private signal: AbortSignal;
  private active = 0;
  private waiters: (() => void)[] = [];
  private fatal?: Error;
  constructor(
    private run: CanvasRun,
    private plan: CanvasExecutionPlan,
    private options: CanvasExecute,
    signal: AbortSignal,
    private host: ExecutionHost,
  ) {
    this.signal = AbortSignal.any([signal, this.controller.signal]);
  }
  async execute() {
    try {
      const failures = await this.scope(new Set(this.plan.order), this.options);
      if (failures.length)
        throw new Error(failures.map((id) => this.run.nodes[id].error).join('\n'));
    } catch (error) {
      this.controller.abort();
      throw this.fatal ?? error;
    }
  }
  private check() {
    this.signal.throwIfAborted();
    try {
      this.host.assertState();
    } catch (error) {
      this.fatal = error instanceof Error ? error : new Error(String(error));
      this.controller.abort();
      throw this.fatal;
    }
  }
  private async permit(ids: string[], action: () => Promise<void>) {
    this.check();
    while (this.active >= (this.run.definition.execution?.concurrency ?? 4)) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      this.check();
    }
    this.active++;
    try {
      const max = this.run.definition.execution?.maxSteps ?? 500;
      if ((this.run.stepsExecuted ?? 0) + ids.length > max) {
        this.fatal = new Error('工作流超过总执行步数限制：' + max);
        this.controller.abort();
        throw this.fatal;
      }
      this.run.stepsExecuted = (this.run.stepsExecuted ?? 0) + ids.length;
      await action();
      this.check();
    } finally {
      this.active--;
      for (const wake of this.waiters.splice(0)) wake();
    }
  }
  private skip(ids: string[], reason: string) {
    for (const id of ids) {
      const step = this.run.nodes[id];
      if (step.status === 'pending')
        Object.assign(step, { status: 'skipped', skipReason: reason, endedAt: Date.now() });
    }
    this.host.persist();
  }
  private fail(ids: string[], error: unknown) {
    for (const id of ids) {
      const step = this.run.nodes[id],
        message = error instanceof Error ? error.message : String(error);
      const value = { nodeId: id, message, executionKey: step.executionKey };
      Object.assign(step, {
        status: this.signal.aborted ? 'cancelled' : 'failed',
        error: message,
        endedAt: Date.now(),
        output: {
          ...step.output,
          text: step.output?.text ?? message,
          resources: step.output?.resources ?? [],
          activePorts: [canvasFailurePort],
          ports: {
            ...step.output?.ports,
            [canvasFailurePort]: { text: message, value, resources: [] },
          },
        },
      });
    }
    this.host.persist();
  }
  private async scope(ids: Set<string>, options: CanvasExecute): Promise<string[]> {
    this.check();
    const { units, dependencies } = executionUnits(
      this.run.definition,
      this.host.plugins,
      this.plan,
      ids,
    );
    const pending = new Set(units.map((u) => u.id)),
      running = new Map<string, Promise<void>>();
    try {
      while (pending.size || running.size) {
        this.check();
        for (const unit of units) {
          if (
            !pending.has(unit.id) ||
            [...dependencies.get(unit.id)!].some((d) => pending.has(d) || running.has(d))
          )
            continue;
          pending.delete(unit.id);
          const incoming = options.saveResource
            ? []
            : this.run.definition.edges.filter(
                (e) =>
                  e.kind === 'dependency' &&
                  (unit.loop ? e.to === unit.loop.start : unit.ids.includes(e.to)) &&
                  !unit.ids.includes(e.from),
              );
          const active = incoming.filter((e) => canvasEdgeActive(this.run, e));
          const node = this.run.definition.nodes.find((n) => n.id === unit.ids[0])!;
          const any =
            this.host.plugins.get(node).definition.control === 'join' &&
            node.config?.mode !== 'all';
          if (incoming.length && (any ? !active.length : active.length !== incoming.length)) {
            this.skip(unit.ids, '上游分支未激活或执行失败');
            continue;
          }
          const execute = async () => {
            try {
              if (unit.loop) await this.loop(unit.loop, options);
              else
                await this.permit(unit.ids, () =>
                  unit.ids.length > 1 || this.host.plugins.groupKey(node)
                    ? this.host.executeGroup(unit.ids, options, this.signal)
                    : this.host.executeNode(unit.ids[0], options, this.signal),
                );
            } catch (error) {
              const failed =
                unit.loop && this.run.nodes[unit.loop.end].status === 'running'
                  ? unit.loop.end
                  : unit.loop?.start;
              this.fail(failed ? [failed] : unit.ids, error);
              if (unit.loop) this.skip([...unit.loop.members], '遍历已停止');
            }
          };
          // Yield before execution so readiness never depends on synchronous plugin completion.
          const promise = Promise.resolve()
            .then(execute)
            .finally(() => running.delete(unit.id));
          running.set(unit.id, promise);
        }
        if (running.size) await Promise.race(running.values());
        else if (pending.size) throw new Error('执行依赖无法调度');
      }
      this.check();
    } catch (error) {
      this.controller.abort();
      await Promise.allSettled(running.values());
      throw this.fatal ?? error;
    }
    const failed = units
      .flatMap((unit) => (unit.loop ? [unit.loop.start, unit.loop.end] : unit.ids))
      .filter((id) => this.run.nodes[id].status === 'failed');
    const handled = (id: string): boolean => {
      const handlers = this.run.definition.edges.filter(
        (e) => e.from === id && e.fromPort === canvasFailurePort && ids.has(e.to),
      );
      return handlers.some(
        (e) =>
          ['completed', 'cached'].includes(this.run.nodes[e.to].status) ||
          (this.run.nodes[e.to].status === 'failed' && handled(e.to)),
      );
    };
    for (const id of failed) this.run.nodes[id].handled = handled(id);
    for (const unit of units)
      if (!unit.loop && unit.ids.some((id) => this.run.nodes[id].handled))
        for (const id of unit.ids)
          if (this.run.nodes[id].status === 'failed') this.run.nodes[id].handled = true;
    this.host.persist();
    return failed.filter((id) => !this.run.nodes[id].handled);
  }
  private async loop(loop: CanvasLoopPlan, options: CanvasExecute) {
    const node = this.run.definition.nodes.find((n) => n.id === loop.start)!;
    const config = foreachConfig.parse(node.config);
    await this.permit([loop.start], () => this.host.executeNode(loop.start, options, this.signal));
    const step = this.run.nodes[loop.start],
      values = step.output!.value as unknown[];
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          input: step.fingerprint,
          definition: this.run.definition.nodes.map(({ x, y, width, height, group, ...n }) => n),
          externalInputs: this.run.definition.edges
            .filter((e) => loop.body.has(e.to) && !loop.members.has(e.from))
            .map((e) => this.run.nodes[e.from]?.output),
          edges: this.run.definition.edges.filter((e) => loop.members.has(e.to)),
          plugins: [...loop.members].map((id) => this.run.nodes[id].plugin),
          contexts: [...loop.members].map((id) => this.host.cacheContext(id, options)),
        }),
      )
      .digest('hex');
    step.iterationFingerprint = fingerprint;
    const history = options.reuse
      ? this.host
          .history()
          .flatMap((run) =>
            canvasRunNodeEntries(run.nodes).map(([id, state]) => ({ run, id, state })),
          )
          .filter(({ id, state }) => id === loop.start && state.executionKey === step.executionKey)
      : [];
    const previous = history.filter(({ state }) => state.iterationFingerprint === fingerprint);
    const cacheableBody = [...loop.body].every(
      (id) =>
        this.host.plugins.get(this.run.definition.nodes.find((n) => n.id === id)!).definition
          .cache !== 'never',
    );
    step.iterations = [];
    step.status = 'running';
    if (!values.length) this.skip([...loop.body], '遍历输入为空');
    const results: CanvasOutput[] = [];
    for (const [index, value] of values.entries()) {
      this.check();
      const executionKey = [step.executionKey, loop.start, index]
        .filter((v) => v !== undefined && v !== '')
        .join('/');
      const previousItem = previous.find(({ state }) =>
        state.iterations?.some((item) => item.index === index),
      );
      const old = previousItem?.state.iterations?.find((item) => item.index === index);
      // Remote-job safety is independent of cache compatibility. A configuration change or
      // fingerprint upgrade must not silently resubmit a task whose outcome is still unknown.
      const latest = history.find(({ state }) =>
        state.iterations?.some((item) => item.index === index),
      );
      const latestItem = latest?.state.iterations?.find((item) => item.index === index);
      const latestExternal =
        latestItem?.external ?? iterationExternal(latest?.run.external, executionKey);
      if (
        latestItem &&
        !['completed', 'cached'].includes(latestItem.status) &&
        (canvasRunNodes(latestItem.nodes).some((n) =>
          n.generation?.some((g) => g.remoteTaskId && g.status !== 'completed'),
        ) ||
          Object.values(latestExternal).some((task) => task.promptId || task.uncertain))
      )
        throw new Error('失败轮次仍有远端媒体任务 ID，请先检查原任务；关闭结果复用后才会重新提交');
      const previousSuccess =
        old &&
        ['completed', 'cached'].includes(old.status) &&
        old.output &&
        (await this.host.validateOutput(old.output));
      const reusable = previousSuccess && cacheableBody;
      const iteration: CanvasIteration = reusable
        ? { ...structuredClone(old), status: 'cached' }
        : {
            index,
            value,
            status: 'running',
            nodes: Object.fromEntries(
              [...loop.body].map((id) => {
                const next: CanvasNodeRun = {
                  status: 'pending',
                  plugin: this.run.nodes[id].plugin,
                  executionKey,
                };
                return [id, next];
              }),
            ),
          };
      step.iterations.push(iteration);
      for (const [id, state] of Object.entries(iteration.nodes)) {
        for (const parent of Object.values(this.run.nodes))
          for (const active of parent.iterations ?? [])
            if (active.status === 'running' && Object.hasOwn(active.nodes, id))
              active.nodes[id] = state;
        this.run.nodes[id] = state;
      }
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      step.output = {
        ...step.output!,
        activePorts: ['item'],
        ports: { item: step.output!.iterationInputs?.[index] ?? { text, value, resources: [] } },
      };
      step.progress = { value: index, max: values.length };
      this.host.persist();
      try {
        if (!reusable) {
          const failed = await this.scope(loop.body, {
            ...options,
            // Revisit non-cacheable nodes, retaining unchanged paid outputs from a successful
            // iteration. Failed iterations still rerun their body as one recovery unit.
            reuse: !!previousSuccess,
            regenerate: undefined,
            resumeRunId: undefined,
          });
          if (failed.length)
            throw new Error(failed.map((id) => this.run.nodes[id].error).join('\n'));
          iteration.output = combineOutputs(await this.host.inputs(loop.end, this.signal));
          iteration.status = 'completed';
        }
        results.push(iteration.output!);
      } catch (error) {
        iteration.status = this.signal.aborted ? 'cancelled' : 'failed';
        iteration.error = error instanceof Error ? error.message : String(error);
        if (this.signal.aborted || config.onError === 'stop') throw error;
        results.push({
          text: iteration.error,
          value: { index, error: iteration.error },
          resources: [],
        });
      } finally {
        iteration.external = {
          ...iteration.external,
          ...iterationExternal(this.run.external, executionKey),
        };
        step.progress = { value: index + 1, max: values.length };
        this.host.persist();
      }
    }
    step.status = 'completed';
    step.endedAt = Date.now();
    await this.permit([loop.end], () =>
      this.host.executeNode(loop.end, { ...options, reuse: false }, this.signal, results),
    );
    step.status = 'completed';
    step.endedAt = Date.now();
    this.host.persist();
  }
}
