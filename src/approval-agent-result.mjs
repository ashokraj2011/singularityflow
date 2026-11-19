import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { contextBoundaryPresentation } from './context-policy.mjs';

/** One decision receipt, not a new-phase execution instruction. Full evidence remains retained. */
export function approvalAgentResult(result) {
  const contextBoundary = contextBoundaryPresentation(result.data?.contextBoundary);
  // The chat is kept (contextPolicy keep, shipped since 2026-11-19): the next step's own command, in this same chat, which
  // VS Code puts in the chat input for one Enter. No /clear between steps.
  const handoff = result.data?.contextBoundary;
  const nextStep = !contextBoundary && handoff?.mode === 'keep' && !handoff.complete && typeof handoff.commands?.[0] === 'string' ? handoff.commands[0] : null;
  return { schemaVersion: 1, resultType: 'sflow-approval-agent-result',
    operation: result.operation, subject: result.subject, outcome: result.outcome,
    effects: result.effects, turnBoundary: 'end',
    instruction: contextBoundary?.instruction ?? (nextStep
      ? `End this approval-only turn with the one next step, ${nextStep}, in this same chat. Do not repeat approval or author the next phase here.`
      : 'End this approval-only turn. Do not repeat approval or author the next phase. Inspect the returned next action in a new turn.'),
    ...(contextBoundary ? { contextBoundary } : {}), ...(nextStep ? { nextStep: { copilotCommand: nextStep, phase: handoff.nextPhase ?? null } } : {}),
    decision: { commit: result.data?.commit, pushed: result.data?.pushed,
      reviewer: result.data?.reviewer, authorityGroup: result.data?.authorityGroup,
      selfApproval: result.data?.selfApproval ?? false,
      reviewPacketSha256: result.data?.reviewPacketSha256,
      artifactSetSha256: result.data?.artifactSetSha256 },
    finalCheck: result.data?.finalCheck ?? null,
    // Said plainly: "recorded under quality-reviewers, but self-approved" read as a fault (anu-bin, 2026-11-11).
    warnings: result.data?.selfApproval === true ? ['You approved a step you also worked on. This Story allows it, but it is not independent review.'] : [],
    personalization: result.data?.personalization,
    next: [safeCommandGuidance('singularity-flow nextsteps --json')] };
}
