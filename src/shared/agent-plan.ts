export interface AgentPlan {
  explanation: string | null;
  plan: { step: string; status: 'pending' | 'inProgress' | 'completed' }[];
}

/** Validate native plan snapshots before persistence or rendering. */
export function agentPlan(value: unknown): AgentPlan | undefined {
  if (!value || typeof value !== 'object') return;
  const candidate = value as AgentPlan;
  if (
    !Array.isArray(candidate.plan) ||
    candidate.plan.length > 80 ||
    !(candidate.explanation === null || typeof candidate.explanation === 'string') ||
    candidate.plan.some(
      (item) =>
        !item ||
        typeof item.step !== 'string' ||
        !item.step.trim() ||
        !['pending', 'inProgress', 'completed'].includes(item.status),
    )
  )
    return;
  const plan = {
    explanation: candidate.explanation?.slice(0, 4000) ?? null,
    plan: candidate.plan.map(({ step, status }) => ({ step: step.slice(0, 600), status })),
  };
  // Escaped control characters can exceed the event limit despite short strings.
  return JSON.stringify(plan).length <= 64000 ? plan : undefined;
}

export function parseAgentPlan(text: string): AgentPlan | undefined {
  try {
    return agentPlan(JSON.parse(text));
  } catch {
    return;
  }
}
