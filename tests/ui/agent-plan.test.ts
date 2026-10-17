import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { agentPlan, parseAgentPlan } from '../../src/shared/agent-plan';
import { TurnProcess } from '../../src/features/chat/RunActivity';
import { turnEntries } from '../../src/shared/turns';
import type { RunEvent } from '../../src/shared/types';

const plan = {
  explanation: null,
  plan: [
    { step: '检查现状', status: 'completed' },
    { step: '验证结果', status: 'inProgress' },
  ],
};
const event: RunEvent = {
  id: 'plan',
  runId: 'run',
  sessionId: 'chat',
  seq: 1,
  time: 1,
  type: 'plan',
  text: JSON.stringify(plan),
};

it('renders a compact task plan instead of protocol JSON and does not mark interrupted work complete', () => {
  const html = renderToStaticMarkup(
    createElement(TurnProcess, {
      events: [event],
      active: false,
      hasContent: false,
      children: null,
    }),
  );
  expect(html).toContain('任务计划 · 1/2');
  expect(html).toContain('验证结果');
  expect(html).toContain('aria-label="未完成"');
  expect(html).not.toContain('"explanation"');
  expect(turnEntries({ key: 'run', messages: [], events: [event] })).toEqual([]);
});

it('validates status values and bounds persisted payloads before rendering', () => {
  expect(parseAgentPlan('{')).toBeUndefined();
  expect(agentPlan({ ...plan, plan: [{ step: 'fake', status: 'done' }] })).toBeUndefined();
  expect(
    agentPlan({ ...plan, plan: [{ step: '<script>unsafe()</script>', status: 'pending' }] }),
  ).toBeDefined();
  const oversized = agentPlan({
    explanation: 'e'.repeat(10000),
    plan: Array.from({ length: 80 }, () => ({ step: 'x'.repeat(10000), status: 'pending' })),
  });
  expect(JSON.stringify(oversized).length).toBeLessThan(64000);
  expect(agentPlan({ ...plan, plan: Array(81).fill(plan.plan[0]) })).toBeUndefined();
  expect(
    agentPlan({ ...plan, plan: Array(80).fill({ step: '\u0000'.repeat(600), status: 'pending' }) }),
  ).toBeUndefined();
});
