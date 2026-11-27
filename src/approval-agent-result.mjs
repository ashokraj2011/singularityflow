import { safeCommandGuidance, TASK_ROUTE } from './safe-command-guidance.mjs';
import { contextBoundaryPresentation } from './context-policy.mjs';

/** One decision receipt, not a new-phase execution instruction. Full evidence remains retained. */
export function approvalAgentResult(result) {
  const contextBoundary = contextBoundaryPresentation(result.data?.contextBoundary);
  // A team that keeps the chat (contextPolicy keep; the shipped policy is new): the next step is named for the person, never run.
  const handoff = result.data?.contextBoundary;
  const nextStep = !contextBoundary && handoff?.mode === 'keep' && !handoff.complete && typeof handoff.commands?.[0] === 'string' ? handoff.commands[0] : null;
  // A task's /sf-task turn goes on (copilot-repository-boundary.mjs carryTaskTurn) [ITW:REQ-008, A17].
  const task = nextStep === TASK_ROUTE;
  return { schemaVersion: 1, resultType: 'sflow-approval-agent-result',
    operation: result.operation, subject: result.subject, outcome: result.outcome,
    effects: result.effects, turnBoundary: task ? 'task' : 'end',
    instruction: contextBoundary?.instruction ?? (task ? `Approved; ${handoff.nextPhase ?? 'the next step'} is next. When SFlow's note after this command says `
      + 'this /sf-task turn goes on, do /sf-task\'s step 1 again now; otherwise name /sf-task, typed in this chat, as the next step. Offer no other route; do not repeat the approval.'
      : nextStep ? `End this turn. Name the next step for the person: ${nextStep}. Do not repeat approval or author the next phase here.`
      : 'End this approval-only turn. Do not repeat approval or author the next phase. Inspect the returned next action in a new turn.'),
    ...(contextBoundary ? { contextBoundary } : {}), ...(nextStep ? { nextStep: { copilotCommand: nextStep, phase: handoff.nextPhase ?? null } } : {}),
    decision: { commit: result.data?.commit, pushed: result.data?.pushed,
      reviewer: result.data?.reviewer, authorityGroup: result.data?.authorityGroup,
      selfApproval: result.data?.selfApproval ?? false,
      reviewPacketSha256: result.data?.reviewPacketSha256,
      artifactSetSha256: result.data?.artifactSetSha256 },
    finalCheck: result.data?.finalCheck ?? null,
    // The lessons the step left [LRN:REQ-014]: said to the person in one line, numbered, with how to drop one.
    ...(Array.isArray(result.data?.lessons) && result.data.lessons.length ? { lessons: result.data.lessons } : {}),
    ...(result.data?.lessonsUse?.line ? { lessonsUse: result.data.lessonsUse.line } : {}),
    // A mistake repeated twice although its lesson was given: offered to the person as team guidance, never made so here.
    ...(Array.isArray(result.data?.ruleOffers) && result.data.ruleOffers.length ? { ruleOffers: result.data.ruleOffers } : {}),
    // Said plainly: "recorded under quality-reviewers, but self-approved" read as a fault (anu-bin, 2026-11-11).
    warnings: result.data?.selfApproval === true ? ['You approved a step you also worked on. This Story allows it, but it is not independent review.'] : [],
    personalization: result.data?.personalization,
    next: [safeCommandGuidance('singularity-flow nextsteps --json')] };
}
