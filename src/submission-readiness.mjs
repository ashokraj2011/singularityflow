import { convergenceTransitionRoute } from './phase-transition-routes.mjs';
import { sequenceGateMode } from './sequence.mjs';
import { stepBeingWritten, successorGenerationOpen } from './phase-generation-need.mjs';
import { approveRoute, authorRoute, versionQuestionRoute } from './action-command-map.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { directCopilotSkill, copilotSkillForCommand, approvalHoldContinuation } from './copilot-guidance.mjs';
import { modelFreeCommandForCommand } from './model-free-commands.mjs';
import { sourceReviewRequired } from './source-review-policy.mjs';
import { sourceReviewContinuation } from './source-review-continuation.mjs';
import { decisionFedBy, decisionSubmitArguments, recordedDecisionValues, storyDecisionView } from './workflow-decisions.mjs';
import { clarifiedValueQuestions } from './phase-roles.mjs';
import { storyRequiresStepActions, submissionEndsStory } from './step-actions.mjs';
import { phaseGovernanceHold } from './phase-governance-routing.mjs';
import { completionPhaseOf } from './lifecycle-transitions.mjs';
import { phaseAuthoringProgress, readPhaseDraftEvidence } from './phase-authoring-progress.mjs';
import { approvalCheckLines, blockingCommitLines, owedDecisionLines, owedDecisions, stepsThrough } from './owed-decisions.mjs';
import { blockingHolds, sheetRoute } from './step-sheet-route.mjs';
import { ASKED_FOR_HOLD, decisionRoutes, stepDecisionOf } from './step-decision.mjs';

function currentPublication(phase) {
  const generation = Number(phase?.generation ?? 0);
  if (!Number.isInteger(generation) || generation < 1) return null;
  const matches = (phase.generationPublications ?? []).filter((entry) =>
    Number(entry?.generation) === generation);
  return matches.length === 1 ? matches[0] : null;
}

function normalizedRepositoryPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096
      || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)) return false;
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

function publicationIsRecorded(publication) {
  return Boolean(
    publication
    && normalizedRepositoryPath(publication.record?.path)
    && /^sha256:[a-f0-9]{64}$/u.test(publication.record?.sha256 ?? '')
  );
}

function submitCommand(workflow, phase) {
  return `singularity-flow submit ${phase.id} --work-id ${workflow.workItem.id}${decisionInputsNeeded(workflow, phase).length ? decisionSubmitArguments(workflow, phase.id) : ''}`;
}

/**
 * The values a host must ask for before submitting: the decision after the phase reads them, and
 * none were recorded this round. The command carries a placeholder per value for shells and
 * Copilot; a host replaces them with what the person chose.
 */
function decisionInputsNeeded(workflow, phase) {
  const decision = decisionFedBy(workflow, phase.id);
  if (!decision || recordedDecisionValues(phase, decision)) return [];
  // A value the step's own clarification asked is read from the person's answer there at submission [ITW:REQ-011].
  const asked = clarifiedValueQuestions(workflow, phase.id);
  return decision.inputs.filter((input) => !asked.has(input.name)).map((input) => ({ ...input, decision: decision.id, decisionLabel: decision.label }));
}

function result(workflow, phase, overrides) {
  const publication = currentPublication(phase);
  const recorded = publicationIsRecorded(publication);
  const projected = {
    schemaVersion: 1,
    resultType: 'sflow-submission-readiness',
    workId: workflow?.workItem?.id ?? null,
    classification: 'not-applicable',
    lifecycleReady: false,
    phaseId: phase?.id ?? null,
    phaseStatus: phase?.status ?? null,
    currentGeneration: Number.isInteger(Number(phase?.generation))
      ? Number(phase.generation) : null,
    publishedGeneration: recorded ? Number(publication.generation) : null,
    draftExists: Boolean(phase?.authoringBaseline || recorded),
    draftModified: false,
    publicationRecorded: recorded,
    pendingSynchronization: false,
    confirmationRequired: false,
    sequenceGate: null,
    validation: 'deferred-to-submit',
    command: null,
    reasonCode: 'SUBMISSION_NOT_APPLICABLE',
    ...overrides
  };
  // `command` predates the explicit readiness contract and remains an alias while hosts migrate.
  // Derive the new route fields in one place so a refusal cannot point the terminal and Copilot at
  // different lifecycle operations.
  projected.nextCommand = Object.hasOwn(overrides, 'nextCommand')
    ? overrides.nextCommand
    : projected.command;
  projected.nextSkill = Object.hasOwn(overrides, 'nextSkill')
    ? overrides.nextSkill
    : projected.nextCommand
      ? copilotSkillForCommand(projected.nextCommand)
      : null;
  return projected;
}

/**
 * Read the current phase's primary review artifact through the same repository-path boundary used
 * by publication. `draftModified` means that the current authored bytes differ from the template
 * captured when generation one was prepared; managed metadata and input blocks do not count.
 */
async function submissionDraftEvidence(root, config, workflow, phaseId, changedPaths = null) {
  const phase = phaseId ? workflow?.phases?.[phaseId] ?? null : null;
  return readPhaseDraftEvidence(root, config, workflow, phase, { changedPaths });
}

/**
 * Build the host-facing readiness contract from verified lifecycle and filesystem evidence.
 * This is the shared entry point for CLI and editor surfaces; it never mutates Story state.
 */
export async function submissionReadiness(root, config, workflow, options = {}) {
  const readiness = await phaseReadiness(root, config, workflow, options);
  // Whether approving would pass, and the commits after the submission it would refuse for, named
  // while the step is reviewed rather than first by the refusal [SPEC-OAP M1]. Advisory:
  // classification stays submitted; known blocking holds replace the refusing approval route.
  const phase = readiness.phaseId ? workflow?.phases?.[readiness.phaseId] : null;
  const advisories = phase?.status === 'awaiting_approval'
    ? await (await import('./approval-check.mjs')).approvalAdvisories(root, config, workflow, phase) : null;
  const continuation = readiness.classification === 'already-submitted'
    ? approvalHoldContinuation(workflow.workItem.id, advisories?.approvalCheck) : null;
  const result = { ...readiness, ...(advisories ?? {}), ...(continuation ? {
    approvalContinuation: continuation, command: continuation.command, nextCommand: continuation.command,
    nextSkill: continuation.skill, reasonCode: 'APPROVAL_HOLDS_REQUIRED'
  } : {}) };
  // The one list's count and first item, which every editor surface shows [SPEC-OAP M3]. Asked for
  // by the surfaces that show it, never by publish or submit.
  if (!options.pendingList || !phase || phase.id !== workflow.currentPhase) return result;
  try {
    const [{ readPendingList }, { pendingSummary }] = await Promise.all([import('./decision-list-reads.mjs'), import('./decision-list.mjs')]);
    const packet = await readPendingList(root, config, workflow, { phaseId: phase.id, reuse: false, offline: true,
      ...(phase.status === 'awaiting_approval' ? { approvalCheck: advisories?.approvalCheck ?? null } : {}),
      ...(readiness.owedDecisions !== undefined ? { owed: readiness.owedDecisions } : {}),
      publication: options.pendingSynchronization === true });
    // One rule for what comes next: a held step's route is the sheet's next.
    const route = packet.sheet && readiness.classification === 'already-submitted' && blockingHolds(packet.sheet).length ? sheetRoute(packet.sheet) : null;
    return { ...result, ...(route ? { approvalContinuation: route, command: route.command, nextCommand: route.command, nextSkill: route.skill, reasonCode: 'APPROVAL_HOLDS_REQUIRED' } : {}),
      pending: pendingSummary(packet), ...(packet.sheet ? { sheet: packet.sheet } : {}) };
  } catch { return result; }
}

async function phaseReadiness(root, config, workflow, {
  phaseId = workflow?.currentPhase ?? null,
  pendingSynchronization = false,
  changedPaths = null
} = {}) {
  const draftEvidence = await submissionDraftEvidence(root, config, workflow, phaseId, changedPaths);
  let sourceReviewEvidence = null;
  const phase = phaseId ? workflow?.phases?.[phaseId] : null;
  if (phase && sourceReviewRequired(workflow, phaseId)
      && phase.status === 'in_progress' && Number(phase.generation) > 0) {
    try {
      sourceReviewEvidence = await (await import('./source-review-lifecycle.mjs')).readSourceReviewStatus(root, config, workflow, phaseId);
    } catch (error) {
      // An unavailable or malformed source is a review blocker, not a reason to lose the whole
      // host-facing readiness projection. The exact command still owns the detailed refusal.
      sourceReviewEvidence = {
        status: 'correction-required', findings: [{ code: error.code ?? 'source-review-unavailable',
          message: error.message }]
      };
    }
  }
  // Only a Story that pinned a required action reads its receipts; any other pays nothing.
  let stepActionHold = null;
  if (phase?.status === 'in_progress' && storyRequiresStepActions(workflow)) {
    try {
      const { requiredStepActionHold, stepActionHoldSentence } = await import('./step-action-receipts.mjs');
      const hold = await requiredStepActionHold(root, config, workflow);
      stepActionHold = hold ? { ...hold, reason: stepActionHoldSentence(hold) } : null;
    } catch { stepActionHold = null; }
  }
  // Where the step's task stopped, kept across turns (workflow-task-outcome.mjs); the kernel applies it to an open version only.
  const taskOutcome = phase?.status === 'in_progress' && phaseId === workflow.currentPhase
    ? await (await import('./workflow-task-outcome.mjs')).readTaskOutcome(root, workflow, phase, pendingSynchronization ? { pending: true } : {}) : null;
  const readiness = submissionReadinessSnapshot(workflow, {
    phaseId,
    pendingSynchronization,
    draftEvidence,
    sourceReviewEvidence,
    stepActionHold,
    taskOutcome
  });
  if (phase && phaseId === workflow.currentPhase && ['in_progress', 'awaiting_approval'].includes(phase.status)) {
    try {
      const { assertPhaseRepairSettled } = await import('./phase-repair-journal.mjs');
      await assertPhaseRepairSettled(root, workflow, phase);
    } catch (error) {
      const journalInvalid = error.code !== 'PHASE_REPAIR_RECHECK_REQUIRED';
      const command = journalInvalid ? `singularity-flow appeal repair-quarantine --phase ${phase.id} --json`
        : `singularity-flow appeal repair-resume --phase ${phase.id} --json`;
      return { ...readiness, lifecycleReady: false, classification: 'repair-recheck-required',
        reasonCode: error.code ?? 'PHASE_REPAIR_JOURNAL_INVALID', reason: error.message,
        command, nextCommand: command, nextSkill: '/sf-appeal' };
    }
  }
  if (phase && phaseId === workflow.currentPhase
      && ['in_progress', 'awaiting_approval'].includes(phase.status)
      && (workflow.phaseAppeals !== undefined || workflow.phaseAppealDecisions !== undefined)) {
    try {
      const { assertPhaseAppealsResolved } = await import('./phase-appeals.mjs');
      await assertPhaseAppealsResolved(root, config, workflow, phase);
    } catch (error) {
      return { ...readiness, lifecycleReady: false, classification: 'appeal-review-required',
        reasonCode: error.code ?? 'PHASE_APPEAL_INTEGRITY', reason: error.message,
        command: `singularity-flow appeal list --phase ${phase.id} --json`,
        nextCommand: `singularity-flow appeal list --phase ${phase.id} --json`, nextSkill: '/sf-appeal' };
    }
  }
  // Files changed after the published draft, which submission refuses: its in-step repair, never "ready" first (N7).
  if (readiness.classification === 'ready-to-attempt' && phase?.status === 'in_progress' && config) {
    const changed = await import('./changes-after-publication.mjs');
    const after = await changed.changesAfterPublication(root, config, workflow, phase).catch(() => null);
    if (after) {
      const { include } = changed.changesAfterPublicationRoutes(workflow, phase, after);
      return { ...readiness, lifecycleReady: false, classification: 'changed-after-publication', reasonCode: changed.CHANGED_AFTER_PUBLICATION,
        reason: `${after.paths.join(', ')} changed after ${phase.id} draft ${phase.generation} was published. ${include.label}`,
        command: include.command, nextCommand: include.command, nextSkill: '/sf-code',
        changedAfterPublication: { paths: after.paths, uncommitted: after.uncommitted, committed: after.committed, copilotCommand: include.copilotCommand } };
    }
  }
  // Enforced visual coverage submission would refuse for, with the same routes: never "ready" first.
  if (readiness.lifecycleReady && phase?.status === 'in_progress' && phaseId === workflow.currentPhase
      && workflow.resolution?.verification?.coverage === 'enforce' && config) {
    const { visualCoverageHold } = await import('./visual-coverage.mjs');
    const { workDir } = await import('./story-paths.mjs');
    const hold = await visualCoverageHold(root, workflow, phase, { itemDirectory: workDir(root, config, workflow.workItem.id) }).catch(() => null);
    if (hold) return { ...readiness, lifecycleReady: false, classification: 'visual-coverage-required', reasonCode: hold.code,
      reason: hold.reason, command: hold.command, nextCommand: hold.command, nextSkill: copilotSkillForCommand(hold.command) };
  }
  // Decisions approval would refuse for (a conformance gap, an open upstream issue at the Story's end)
  // route to the decision list before any approval is offered [decision list parity].
  if (phase?.status === 'awaiting_approval' && phaseId === workflow.currentPhase) {
    const held = await (await import('./decision-list-facts.mjs')).pendingDecisionSummary(root, config, workflow, phase).catch(() => null);
    if (held) {
      return { ...readiness, lifecycleReady: false, classification: 'decisions-required', reasonCode: 'DECISIONS_REQUIRED',
        reason: held.headline, command: held.command, nextCommand: held.command, nextSkill: held.skill,
        decisions: { count: held.count, headline: held.headline, copilotCommand: held.copilotCommand } };
    }
  }
  // Before submission, the command must first run fresh quality checks and refresh observed claim
  // bindings; it performs the terminal preview at that last pre-mutation boundary. Re-evaluate
  // here only once the phase is already awaiting approval, so host routing cannot mistake
  // not-yet-recorded test evidence for an integrity failure.
  if (phase?.status === 'awaiting_approval'
      && completionPhaseOf(workflow)?.id === phase.id) {
    try {
      const { terminalReadinessOnce } = await import('./evidence/terminal.mjs');
      const terminal = await terminalReadinessOnce(root, config, workflow);
      if (terminal.blockers.length) {
        const command = terminal.recovery[0] ?? `singularity-flow evidence matrix ${workflow.workItem.id} --json`;
        return {
          ...readiness,
          lifecycleReady: false,
          classification: 'terminal-obligations-required',
          reasonCode: 'STORY_TERMINAL_READINESS_REFUSED',
          reason: `Final Story readiness has ${terminal.blockers.length} open obligation${terminal.blockers.length === 1 ? '' : 's'}.`,
          command,
          nextCommand: command,
          nextSkill: copilotSkillForCommand(command),
          terminal: {
            inputSha256: terminal.evaluation.inputSha256,
            blockers: terminal.blockers,
            actions: terminal.recovery
          }
        };
      }
    } catch (error) {
      return {
        ...readiness,
        lifecycleReady: false,
        classification: 'terminal-readiness-unavailable',
        reasonCode: error.code ?? 'STORY_TERMINAL_READINESS_UNAVAILABLE',
        reason: error.message,
        command: `singularity-flow evidence matrix ${workflow.workItem.id} --json`,
        nextCommand: `singularity-flow evidence matrix ${workflow.workItem.id} --json`,
        nextSkill: '/sf-evidence'
      };
    }
  }
  // A step awaiting approval lists the sign-offs and scope decisions its approvers owe the ending,
  // so they are asked for while the step is reviewed, not first by the final evaluation. Advisory.
  if (phase?.status === 'awaiting_approval' && phaseId === workflow.currentPhase
      && completionPhaseOf(workflow)?.id !== phase.id) {
    const owed = await owedDecisions(root, config, workflow, stepsThrough(workflow, phase.id));
    if (owed) return { ...readiness, owedDecisions: owed };
  }
  return readiness;
}

/** The kernel's route for a step being written, as the edit permission renders it; null when it names none. */
function kernelRoute(workflow, phase) {
  const [route] = decisionRoutes(stepDecisionOf(workflow, phase), workflow, phase);
  return route?.command ? route : null;
}

/**
 * Produce a small, read-only lifecycle projection for hosts that need to decide whether to invoke
 * submission. It deliberately does not predict quality-gate success: the submit command remains
 * the one authority that verifies artifacts, tests, policy and publication evidence.
 */
export function submissionReadinessSnapshot(workflow, {
  phaseId = workflow?.currentPhase ?? null,
  pendingSynchronization = false,
  draftEvidence = null,
  sourceReviewEvidence = null,
  stepActionHold = null,
  taskOutcome = null
} = {}) {
  const phase = phaseId ? workflow?.phases?.[phaseId] ?? null : null;
  const draft = draftEvidence == null ? {} : {
    draftExists: draftEvidence.draftExists === true,
    draftModified: draftEvidence.draftModified === true
  };
  if (!phase) return result(workflow, null, {
    ...draft,
    phaseId,
    classification: 'not-applicable',
    reasonCode: phaseId ? 'PHASE_NOT_FOUND' : 'NO_ACTIVE_PHASE'
  });

  if (phaseId !== workflow.currentPhase) return result(workflow, phase, {
    ...draft,
    classification: 'phase-not-current',
    reasonCode: 'PHASE_NOT_CURRENT'
  });

  // A commit retained here (the task's `publication-pending` stage): its sync leads, as the kernel names it [OSA:REQ-012].
  if (pendingSynchronization || taskOutcome?.outcome === 'publication-pending') return result(workflow, phase, {
    ...draft,
    classification: 'synchronization-required',
    pendingSynchronization: true,
    command: 'singularity-flow sync',
    reasonCode: 'PUBLICATION_SYNCHRONIZATION_REQUIRED'
  });

  const governanceHold = phaseGovernanceHold(workflow, phase);
  if (governanceHold) return result(workflow, phase, {
    ...draft, classification: governanceHold.classification,
    reasonCode: governanceHold.code, reason: governanceHold.reason,
    command: governanceHold.actions[0]?.command ?? null,
    nextSkill: governanceHold.actions[0]?.skill ?? null,
    actions: governanceHold.actions
  });

  // A Story waiting for a person has nothing to submit; the decision is the next action.
  if (workflow.pendingDecision) {
    const pending = storyDecisionView(workflow).pending;
    return result(workflow, phase, {
      ...draft,
      classification: 'decision-required',
      command: `singularity-flow decision show ${workflow.workItem.id}`,
      nextSkill: '/sf-decide',
      reasonCode: 'DECISION_REQUIRED',
      decision: {
        key: pending.key, decision: pending.decision, label: pending.label, reason: pending.reason,
        after: pending.after, by: pending.by, anyStep: pending.anyStep, round: pending.round, maxRounds: pending.maxRounds,
        options: pending.options.map((option) => ({
          id: option.id, label: option.label, to: option.to, toLabel: option.toLabel, reach: option.reach, skips: option.skips
        }))
      }
    });
  }

  if (phase.status === 'awaiting_approval') return result(workflow, phase, {
    ...draft,
    classification: 'already-submitted',
    command: approveRoute(workflow, phase).command,
    reasonCode: 'PHASE_ALREADY_SUBMITTED'
  });

  if (phase.status !== 'in_progress') return result(workflow, phase, {
    ...draft,
    classification: 'not-applicable',
    reasonCode: 'PHASE_NOT_IN_PROGRESS'
  });

  // A required after-step action of an earlier step without a receipt holds only the Story's ending
  // [PHR:REQ-003]: the hold is the next action only where this submission ends the Story.
  if (stepActionHold?.missing?.length && submissionEndsStory(workflow, phase)) return result(workflow, phase, {
    ...draft,
    classification: 'step-action-required',
    // The Copilot route follows the command: retry and record are /sf-integrations, a pipeline's
    // receipt arrives with /sf-refresh-branch.
    command: stepActionHold.nextAction ?? `singularity-flow integrations status --work-id ${workflow.workItem.id} --all`,
    reasonCode: 'STEP_ACTION_REQUIRED_UNRECORDED',
    stepActionHold: {
      reason: stepActionHold.reason ?? null,
      runnableHere: Boolean(stepActionHold.nextAction),
      missing: stepActionHold.missing.map((entry) => ({
        key: entry.key, phaseId: entry.phaseId, generation: entry.generation, action: entry.action, target: entry.target, here: entry.here
      }))
    }
  });

  const publication = currentPublication(phase);
  const publicationRecorded = publicationIsRecorded(publication);
  // Before the publication check: a step being written is never "ready to submit" or "review version N" while version
  // N+1 is open, and an open version is never submitted past a soft gate either [OSA:REQ-032, C2].
  const writing = stepBeingWritten(workflow, phase);
  const convergenceRoute = convergenceTransitionRoute(workflow, phase, { needsGeneration: writing });
  if (convergenceRoute) return result(workflow, phase, {
    ...draft, ...convergenceRoute, nextSkill: directCopilotSkill(convergenceRoute.skill)
  });
  // Its task stopped at a boundary its author cannot cross alone, or its execution still runs after publication (a
  // submission's tests): that wait is the next step, as every view says [§5 `waiting`, §8, OSA:REQ-051].
  const waiting = (writing || taskOutcome?.outcome === 'running') && taskOutcome
    ? stepDecisionOf(workflow, phase, { review: sourceReviewEvidence, task: taskOutcome }) : null;
  if (waiting?.state === 'waiting') {
    const [route] = decisionRoutes(waiting, workflow, phase);
    return result(workflow, phase, { ...draft, classification: 'task-waiting', lifecycleReady: false, command: route?.command ?? null,
      nextSkill: route?.skill ?? null, reason: route?.detail ?? null, taskOutcome: { outcome: taskOutcome.outcome, code: taskOutcome.code },
      reasonCode: waiting.next.reasonCodes[0] ?? 'TASK_WAITING' });
  }
  const authoringProgress = phaseAuthoringProgress(workflow, phase, { draftEvidence });
  if (writing) return result(workflow, phase, {
    ...draft,
    ...(!successorGenerationOpen(phase) && sequenceGateMode(workflow, 'freshGeneration') === 'soft'
        && (publicationRecorded || sequenceGateMode(workflow, 'generationCommit') === 'soft')
      ? {
          classification: 'soft-sequence-confirmation-required',
          lifecycleReady: true,
          confirmationRequired: true,
          sequenceGate: 'freshGeneration',
          command: submitCommand(workflow, phase),
          nextSkill: '/sf-submit',
          reasonCode: 'SOFT_SEQUENCE_CONFIRMATION_REQUIRED',
          ...(decisionInputsNeeded(workflow, phase).length ? { decisionInputs: decisionInputsNeeded(workflow, phase) } : {})
        }
      : {
          classification: 'generation-required',
          // The task's stage, else the kernel's own route for the step (a kernel-built code step opens with `phase begin`),
          // as the entry and every other view name it [OSA:REQ-020].
          command: authoringProgress?.next?.command
            ?? kernelRoute(workflow, phase)?.command ?? authorRoute(workflow, phase).command,
          nextSkill: authoringProgress?.next?.copilotCommand
            ?? kernelRoute(workflow, phase)?.skill ?? authorRoute(workflow, phase).skill,
          authoringProgress,
          reason: authoringProgress?.instruction ?? null,
          reasonCode: 'PHASE_GENERATION_REQUIRED'
        })
  });

  if (!publicationRecorded) return result(workflow, phase, {
    ...draft,
    ...(sequenceGateMode(workflow, 'generationCommit') === 'soft'
      ? {
          classification: 'soft-sequence-confirmation-required',
          lifecycleReady: true,
          confirmationRequired: true,
          sequenceGate: 'generationCommit',
          command: submitCommand(workflow, phase),
          nextSkill: '/sf-submit',
          reasonCode: 'SOFT_SEQUENCE_CONFIRMATION_REQUIRED',
          ...(decisionInputsNeeded(workflow, phase).length ? { decisionInputs: decisionInputsNeeded(workflow, phase) } : {})
        }
      : {
          classification: Number(phase.generation ?? 0) < 1
            ? 'generation-commit-required'
            : 'publication-record-missing',
          command: 'singularity-flow doctor --json',
          reasonCode: Number(phase.generation ?? 0) < 1
            ? 'PHASE_GENERATION_COMMIT_REQUIRED'
            : 'PHASE_PUBLICATION_RECORD_MISSING'
        })
  });

  // A typed change waits for the next version (taskOutcome): its question leads. The person's No (the kernel's `declined`)
  // submits this version as it is (`submission`, /sf-submit's), or names what that waits for (`otherwise`).
  const decided = taskOutcome?.changeRequested || taskOutcome?.askedFor?.length
    ? stepDecisionOf(workflow, phase, { review: sourceReviewEvidence, task: taskOutcome }) : null;
  const asked = decided?.next.inputs.reason === 'change-requested' ? decided : null;
  if (asked) {
    const [route] = decisionRoutes(asked, workflow, phase);
    const declined = asked.next.inputs.declined ? { ...asked, next: asked.next.inputs.declined } : null;
    const rest = declinedReadiness(workflow, phase, { draft, sourceReviewEvidence, declined });
    const submittable = rest.classification === 'ready-to-attempt';
    return result(workflow, phase, { ...draft, classification: 'change-requested', lifecycleReady: submittable, command: route?.command ?? null, nextSkill: route?.skill ?? null,
      reason: route?.detail ?? null, reasonCode: 'CHANGE_REQUESTED', ...(submittable ? { submission: rest.command } : {
        otherwise: { classification: rest.classification, command: rest.command, skill: rest.nextSkill, reason: rest.reason ?? null } }),
      ...(rest.decisionInputs ? { decisionInputs: rest.decisionInputs } : {}),
      ...(rest.sourceReviewStatus ? { sourceReviewStatus: rest.sourceReviewStatus, sourceReviewFindings: rest.sourceReviewFindings } : {}) });
  }
  return declinedReadiness(workflow, phase, { draft, sourceReviewEvidence, declined: decided });
}

/** The published version's way on with no change waiting, or declined: its author's account, its review, its submission. */
function declinedReadiness(workflow, phase, { draft, sourceReviewEvidence, declined }) {
  // What the person typed waits for its account in a step nobody approves (taskOutcome): its submission, which completes
  // it, waits for that, so the author's account leads, as the kernel names it [SCS:REQ-042].
  if (declined?.next.prerequisites?.some((entry) => entry.code === ASKED_FOR_HOLD)) {
    const [route] = decisionRoutes(declined, workflow, phase);
    return result(workflow, phase, { ...draft, classification: 'instructions-unaccounted', lifecycleReady: false, command: route?.command ?? null,
      nextSkill: route?.skill ?? null, reason: route?.detail ?? null, reasonCode: ASKED_FOR_HOLD });
  }

  // Submission refuses a published code version with no receipt (CODE_DELIVERY_RECEIPT_MISSING): never "ready" first; its
  // route is that refusal's own, the next version on the person's yes (only a publication records one).
  if (phaseRequiresCodeDelivery(phase) && Number(phase.deliveryEvidence?.generation) !== Number(phase.generation)) {
    const route = versionQuestionRoute(workflow, phase);
    return result(workflow, phase, { ...draft, classification: 'code-delivery-receipt-missing', lifecycleReady: false,
      command: route.command, nextSkill: route.skill, reasonCode: 'CODE_DELIVERY_RECEIPT_MISSING',
      reason: `Version ${phase.generation} of ${phase.id} has no code-delivery receipt, so it cannot be submitted. Its next version records one. It opens only on the person's yes.` });
  }

  if (sourceReviewRequired(workflow, phase.id) && sourceReviewEvidence?.status !== 'ready') {
    const continuation = sourceReviewContinuation(workflow, phase, sourceReviewEvidence);
    return result(workflow, phase, {
      ...draft,
      classification: 'source-review-required',
      lifecycleReady: false,
      validation: 'source-review-pending',
      sourceReviewStatus: sourceReviewEvidence?.status ?? 'unverified',
      sourceReviewFindings: sourceReviewEvidence?.findings ?? [],
      command: continuation.nextCommand,
      nextSkill: continuation.nextSkill,
      continuation,
      reasonCode: continuation.classification === 'successor-publication-required'
        ? 'SOURCE_REVIEW_CORRECTION_REQUIRED' : 'SOURCE_REVIEW_REQUIRED'
    });
  }

  const decisionInputs = decisionInputsNeeded(workflow, phase);
  return result(workflow, phase, {
    ...draft,
    classification: 'ready-to-attempt',
    lifecycleReady: true,
    command: submitCommand(workflow, phase),
    nextSkill: '/sf-submit',
    reasonCode: 'SUBMISSION_READY',
    ...(decisionInputs.length ? { decisionInputs } : {})
  });
}

/** The one list in two lines: how many items are open and the first one [SPEC-OAP M3]. */
export function pendingListLines(pending) {
  if (!pending?.open) return [];
  return [`Open on the decision list: ${pending.open} (${pending.command}).`, `First: ${pending.next.title} — ${pending.next.command}`];
}

export function submissionReadinessText(snapshot) {
  const state = snapshot.lifecycleReady ? 'ready' : 'not ready';
  const artifactState = !snapshot.publicationRecorded
    ? snapshot.draftExists
      ? `${snapshot.draftModified ? 'Authored draft' : 'Seeded draft'} — not published`
      : 'Draft not created — not published'
    : snapshot.classification === 'already-submitted'
      ? `Published generation ${snapshot.publishedGeneration} — submitted for approval`
      : snapshot.classification === 'synchronization-required'
        ? `Published generation ${snapshot.publishedGeneration} — synchronization required`
        : snapshot.classification === 'convergence-advance-required'
          ? `Published generation ${snapshot.publishedGeneration} — ready to submit for approval`
          : snapshot.lifecycleReady
            ? `Published generation ${snapshot.publishedGeneration} — ready to submit`
            : `Published generation ${snapshot.publishedGeneration} — not ready to submit`;
  return [
    `${snapshot.workId ?? 'Story'} · ${snapshot.phaseId ?? 'no active phase'} · ${state}`,
    `Classification: ${snapshot.classification}`,
    `Phase status: ${snapshot.phaseStatus ?? 'none'} · generation ${snapshot.currentGeneration ?? 'none'} · published ${snapshot.publishedGeneration ?? 'none'}`,
    artifactState,
    snapshot.confirmationRequired ? `Human confirmation required: soft gate ${snapshot.sequenceGate}` : null,
    snapshot.sourceReviewStatus && snapshot.sourceReviewStatus !== 'ready'
      ? `Independent source review: ${snapshot.sourceReviewStatus}` : null,
    snapshot.stepActionHold?.reason ?? null,
    snapshot.reason ?? null,
    ...(snapshot.terminal?.blockers ?? []).slice(0, 5).map((blocker) => `Open obligation: ${blocker}`),
    ...owedDecisionLines(snapshot.owedDecisions),
    ...approvalCheckLines(snapshot.approvalCheck),
    ...blockingCommitLines(snapshot.blockingCommits),
    ...pendingListLines(snapshot.pending),
    `Full artifact, test, policy, and evidence validation: ${snapshot.validation}`,
    snapshot.nextSkill ? `Copilot: ${snapshot.nextSkill}` : null,
    snapshot.nextCommand ? `Shell: ${snapshot.nextCommand}` : null,
    snapshot.nextCommand
      ? `VS Code (model-free): ${modelFreeCommandForCommand(snapshot.nextCommand) ?? 'not available for this action'}` : null
  ].filter(Boolean).join('\n');
}
