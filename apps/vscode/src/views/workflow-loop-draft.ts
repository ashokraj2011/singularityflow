/** A review-gated return path in one Story workflow, not an autonomous cycle. */
export interface WorkflowLoopDraft {
  from: string;
  to: string;
  maxAttempts: number;
  resetOnPhase?: string;
}

export function workflowLoopIssues(phases: string[], loops: WorkflowLoopDraft[]): string[] {
  const positions = new Map(phases.map((id, index) => [id, index]));
  const seen = new Set<string>();
  const targetPolicies = new Map<string, { maxAttempts: number; resetOnPhase: string }>();
  const issues: string[] = [];
  for (const [index, loop] of loops.entries()) {
    const label = `Loop ${index + 1}`;
    const source = positions.get(loop.from);
    const target = positions.get(loop.to);
    const reset = loop.resetOnPhase ? positions.get(loop.resetOnPhase) : undefined;
    if (source === undefined) issues.push(`${label}: choose a source phase in this workflow.`);
    if (target === undefined) issues.push(`${label}: choose a return phase in this workflow.`);
    if (source !== undefined && target !== undefined && target >= source) {
      issues.push(`${label}: the return phase must be earlier than the source phase.`);
    }
    if (!Number.isInteger(loop.maxAttempts) || loop.maxAttempts < 1 || loop.maxAttempts > 100) {
      issues.push(`${label}: maximum attempts must be a whole number from 1 through 100.`);
    }
    if (loop.resetOnPhase && reset === undefined) {
      issues.push(`${label}: the reset phase must be in this workflow.`);
    } else if (reset !== undefined && target !== undefined && reset >= target) {
      issues.push(`${label}: the reset phase must be earlier than the return phase.`);
    }
    if (loop.from && loop.to) {
      const key = `${loop.from}\0${loop.to}`;
      if (seen.has(key)) issues.push(`${label}: this source and return pair is already listed.`);
      seen.add(key);
    }
    if (loop.to) {
      const policy = { maxAttempts: loop.maxAttempts, resetOnPhase: loop.resetOnPhase ?? '' };
      const previous = targetPolicies.get(loop.to);
      if (previous && (previous.maxAttempts !== policy.maxAttempts
          || previous.resetOnPhase !== policy.resetOnPhase)) {
        issues.push(`${label}: loops returning to '${loop.to}' must use the same maximum attempts and reset phase.`);
      } else targetPolicies.set(loop.to, policy);
    }
  }
  return issues;
}
