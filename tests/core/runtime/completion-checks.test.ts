import { describe, expect, it } from 'vitest';
import { CompletionChecks } from '../../../electron/core/runtime/completion-checks';
import { ToolScope } from '../../../electron/core/tools/extensions';
import type { Run, ToolOutput } from '../../../src/shared/types';

function fixture(
  execute: () => Promise<ToolOutput> = async () => ({
    text: JSON.stringify({ status: 'completed', exitCode: 0 }),
  }),
) {
  const run = { id: 'run' } as Run;
  const controller = new AbortController();
  const calls: string[] = [];
  const scope = new ToolScope(
    controller.signal,
    async () => true,
    (name) => {
      calls.push(name);
    },
  );
  scope.add({ name: 'run_command', description: '', parameters: {} }, '', execute, false);
  const checks = new CompletionChecks(run, () => {});
  checks.attach(scope);
  const register = (command = 'node --test') =>
    scope.call('completion_check', {
      checks: [{ command, description: 'Existing behavior and regression' }],
    });
  return { run, controller, scope, checks, register, calls };
}

describe('completion checks', () => {
  it('waits for native children before checking files they can still change', async () => {
    const f = fixture();
    await f.register();
    f.run.agents = [
      { threadId: 'child', parentThreadId: 'root', name: 'child', status: 'running' },
    ];
    expect(await f.checks.evaluate(f.scope, f.controller.signal)).toContain('子任务结束');
    expect(f.calls.filter((n) => n === 'run_command')).toHaveLength(0);
    f.run.agents[0].status = 'completed';
    expect(await f.checks.evaluate(f.scope, f.controller.signal)).toBeUndefined();
    expect(f.calls.filter((n) => n === 'run_command')).toHaveLength(1);
  });
  it('does no work without registration and requires real successful receipts', async () => {
    const f = fixture();
    expect(await f.checks.evaluate(f.scope, f.controller.signal)).toBeUndefined();
    expect(f.calls).toEqual([]);
    await f.register();
    expect(await f.checks.evaluate(f.scope, f.controller.signal)).toBeUndefined();
    expect(f.run.completionChecks).toMatchObject({ attempts: 1, checks: [{ status: 'passed' }] });
  });
  it('keeps registered checks immutable and retries a failed check after correction', async () => {
    let exitCode = 1;
    const f = fixture(async () => ({ text: JSON.stringify({ status: 'completed', exitCode }) }));
    await f.register();
    await f.register('node --test regression.mjs');
    await f.scope.call('completion_check', {
      checks: [{ command: 'node --test', description: 'Replace', timeoutMs: 1000 }],
    });
    expect(f.run.completionChecks!.checks).toHaveLength(2);
    expect(f.run.completionChecks!.checks[0].description).not.toBe('Replace');
    expect(await f.checks.evaluate(f.scope, f.controller.signal)).toContain('完成检查未通过');
    exitCode = 0;
    expect(await f.checks.evaluate(f.scope, f.controller.signal)).toBeUndefined();
    expect(f.calls.filter((n) => n === 'run_command')).toHaveLength(4);
  });
  it('stops after three failed rounds instead of claiming completion', async () => {
    const f = fixture(async () => ({ text: JSON.stringify({ status: 'completed', exitCode: 1 }) }));
    await f.register();
    for (let n = 0; n < 2; n++)
      expect(await f.checks.evaluate(f.scope, f.controller.signal)).toContain('未通过');
    await expect(f.checks.evaluate(f.scope, f.controller.signal)).rejects.toThrow('三轮');
    await expect(f.checks.evaluate(f.scope, f.controller.signal)).rejects.toThrow('三轮');
    expect(f.calls.filter((n) => n === 'run_command')).toHaveLength(3);
  });
  it.each([
    { text: '用户拒绝了命令执行。' },
    { text: '工具未启用', isError: true },
    { text: JSON.stringify({ status: 'timeout', exitCode: null }) },
    { text: JSON.stringify({ status: 'completed', exitCode: null }) },
  ])('cannot pass a denied, unavailable, timed out or incomplete receipt: %j', async (result) => {
    const f = fixture(async () => result);
    await f.register();
    await expect(f.checks.evaluate(f.scope, f.controller.signal)).rejects.toThrow('不会自动重试');
    expect(f.run.completionChecks!.checks[0].status).toBe('blocked');
    expect(f.calls.filter((n) => n === 'run_command')).toHaveLength(1);
  });
  it('honors cancellation during a check and hides registration without command capability', async () => {
    const f = fixture(async () => {
      f.controller.abort();
      return { text: JSON.stringify({ status: 'completed', exitCode: 0 }) };
    });
    await f.register();
    await expect(f.checks.evaluate(f.scope, f.controller.signal)).rejects.toThrow();
    expect(f.run.completionChecks!.checks[0].status).toBe('pending');
    const restricted = new ToolScope(
      new AbortController().signal,
      async () => true,
      () => {},
    );
    f.checks.attach(restricted);
    expect(restricted.has('completion_check')).toBe(false);
  });
});
