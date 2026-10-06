import { SingularityFlowError } from './util.mjs';

/** Agent modes are capabilities, not merely prose in a prompt. */
export function readOnlyAgent(config, workflow, session) {
  const id = session?.agent;
  if (!id) return null;
  const mode = config?.agents?.[id]?.metadata?.['sflow-mode'];
  if (['read-only', 'read-only-review'].includes(mode)) return { id, mode };
  if (id === workflow?.resolution?.sourceReview?.reviewerAgent) return { id, mode: 'read-only-review' };
  return null;
}

export function phaseAgentMutationRestriction(config, workflow, phase, session, operation) {
  const agent = readOnlyAgent(config, workflow, session);
  if (!agent) return null;
  const author = phase?.defaultAgent;
  const command = author ? `singularity-flow agent --agent ${author}` : null;
  return {
    code: agent.mode === 'read-only-review'
      ? `SOURCE_REVIEW_REVIEWER_CANNOT_${operation.toUpperCase().replaceAll('-', '_')}`
      : 'READ_ONLY_AGENT_CANNOT_MUTATE',
    category: 'agent-role', phase: phase?.id ?? null, workId: workflow?.workItem?.id ?? null,
    message: `The read-only ${agent.mode === 'read-only-review' ? 'source reviewer' : 'governed agent'} '${agent.id}' cannot ${operation.replaceAll('-', ' ')} phase '${phase?.id}'. Select the configured phase author${command ? ` with ${command}` : ''}; preserve published authorship and review history.`,
    actions: [{ command, skill: command ? '/sf-agent' : null,
      detail: 'Select the accepted phase author before any lifecycle mutation.' }]
  };
}

export function assertPhaseAgentMayMutate(config, workflow, phase, session, operation) {
  const restriction = phaseAgentMutationRestriction(config, workflow, phase, session, operation);
  if (restriction) throw new SingularityFlowError(restriction.message, {
    code: restriction.code, details: restriction
  });
}
