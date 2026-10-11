import { safeCommandGuidance } from './safe-command-guidance.mjs';

/** One decision receipt, not a new-phase execution instruction. Full evidence remains retained. */
export function approvalAgentResult(result) {
  return { schemaVersion: 1, resultType: 'sflow-approval-agent-result',
    operation: result.operation, subject: result.subject, outcome: result.outcome,
    effects: result.effects, turnBoundary: 'end',
    instruction: 'End this approval-only turn. Do not repeat approval or author the next phase. Inspect the returned next action in a new turn.',
    decision: { commit: result.data?.commit, pushed: result.data?.pushed,
      reviewer: result.data?.reviewer, authorityGroup: result.data?.authorityGroup,
      selfApproval: result.data?.selfApproval ?? false,
      reviewPacketSha256: result.data?.reviewPacketSha256,
      artifactSetSha256: result.data?.artifactSetSha256 },
    finalCheck: result.data?.finalCheck ?? null,
    warnings: result.data?.selfApproval === true ? ['Self-approval is not independent review.'] : [],
    personalization: result.data?.personalization,
    next: [safeCommandGuidance('singularity-flow nextsteps --json')] };
}
