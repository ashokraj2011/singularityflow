import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadAcceptedStoryExecution } from './accepted-story-execution.mjs';
import { recoveryPlan } from './collaboration.mjs';
import { verifyClarificationRecord } from './clarifications.mjs';
import { phaseInspectionGeneration } from './code-submission-evidence.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { phaseAuthoringSummary } from './phase-authoring-summary.mjs';
import { branch, head, repoRoot, gitDir } from './git.mjs';
import { agentSessionStatus } from './session.mjs';
import { storyReferenceRepositories, verifyReferenceRepositories } from './reference-repositories.mjs';
import { readCopilotMode, copilotModePresentation } from './copilot-mode.mjs';
import { resolvePersonalization } from './personalization.mjs';
import { activeWorkspaceFile, workspaceRegistryFile, resolveWorkspaceExecutionContext } from './workspace-context.mjs';
import { contextBoundaryPresentation, pendingContextBoundary } from './context-policy.mjs';
import { storyRequestSummary } from './story-request-summary.mjs';
import { SingularityFlowError } from './util.mjs';
import { phaseUsesDeterministicGeneration } from './manual-authorship.mjs';
import { recoveryActionGuidance } from './recovery-action-guidance.mjs';
import { phaseContextAdmission, phaseAdmissionActions } from './phase-entry-admission.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { PHASE_JOURNEY_CONTRACT } from './phase-journey.mjs';
import { BUILD_INFO, versionLine } from './build-info.mjs';
import { assertStoryNotArchived } from './governance-archive.mjs';
import { deriveMutationContract, mutationContractPresentation } from './phase-mutation-contract.mjs';
import { phaseAuthoringContract } from './phase-authoring-contract.mjs';
import { phaseExecutionEvidence } from './phase-execution-evidence.mjs';

/** Verified per-invocation binding shared by phase entry, nextsteps and inputs. */
export async function phaseEntryContext({ cwd = process.cwd(), phaseId = null, workId = null,
  allowTerminal = false, turnMode = 'authoring' } = {}) {
  const mode = readCopilotMode();
  if (mode.paused) return { packet: copilotModePresentation(mode) };
  const selected = await resolveWorkspaceExecutionContext(activeWorkspaceFile(), workspaceRegistryFile(), { cwd });
  const root = path.resolve(selected?.repositoryPath ?? repoRoot(cwd));
  // Keep the exact effective definition: operation-local catalog verification is reusable.
  // Explicit ids verify, never silently select a different Story in this checkout.
  const accepted = await loadAcceptedStoryExecution(root);
  const { definition, workflow } = accepted;
  const actualId = workflow.workItem.id;
  if ([workId, selected?.storyId].some(id => id && id !== actualId)) throw new SingularityFlowError(
    'Requested or selected Story does not match the active checkout. Attach it explicitly.', {
      code: 'ACTIVE_SUBJECT_MISMATCH', details: { expectedWorkId: workId ?? selected?.storyId,
        actualWorkId: actualId, repositoryPath: root }
    });
  // Entry grants authoring guidance; archived Stories remain inspectable through phase show,
  // but must not hand an agent permission to edit their preserved application or draft files.
  assertStoryNotArchived(root, workflow);
  const phase = workflow.phases?.[phaseId ?? workflow.currentPhase];
  if ((!phase && !(allowTerminal && !workflow.currentPhase && !phaseId))
      || (phase && phase.id !== workflow.currentPhase)) throw new SingularityFlowError(
    'Phase entry must name the current Story phase; historical inspection uses phase show.',
    { code: 'PHASE_DRAFT_NOT_ACTIVE', details: { requestedPhase: phaseId, currentPhase: workflow.currentPhase } });
  const session = await agentSessionStatus(root, definition, workflow);
  const ready = (selected?.selectionStatus ?? 'ready') === 'ready' && (phase ? session.ready : true);
  // The request near the top, so an agent that reads only the start of the packet still has it.
  const story = await readFile(path.join(root, definition.workItemRoot, actualId, 'source.json'), 'utf8')
    .then((text) => storyRequestSummary(JSON.parse(text))).catch(() => null);
  const binding = { ready, repositoryPath: root, workItemRoot: definition.workItemRoot,
    workId: actualId, ...(story ? { story } : {}), phase: phase?.id ?? null, phaseStatus: phase?.status ?? null, generation: phase?.generation ?? null,
    inspectionGeneration: phase ? phaseInspectionGeneration(workflow, phase) : null,
    activeAgent: session.activeAgent, phaseAgent: session.phaseAgent,
    selectionSource: selected?.selectionSource ?? 'cwd', branch: branch(root), head: head(root) };
  const contextBoundary = phase ? contextBoundaryPresentation(pendingContextBoundary(workflow)) : null;
  const packet = { schemaVersion: 1, resultType: 'sflow-phase-entry', paused: false,
    personalization: resolvePersonalization({ root }), ...binding,
    mutationContract: mutationContractPresentation(deriveMutationContract({ root, definition, workflow, phase, turnMode })),
    authoringContract: phaseAuthoringContract(definition, workflow, phase),
    build: { description: versionLine(), ...BUILD_INFO },
    continuationReview: phase ? { contractRevision: PHASE_JOURNEY_CONTRACT, readOnly: true,
      commandGuidance: safeCommandGuidance({ executable: 'singularity-flow', argv: ['appeal', 'resolve',
        '--work-id', actualId, '--phase', phase.id, '--json'] }),
      detail: 'Inspect one preserved-work journey when blocked. This route does not repair, run tests, accept evidence or approve.' } : null,
    generationPolicy: phase?.generationPolicy ?? null, generatesCode: phase ? phaseRequiresCodeDelivery(phase) : false,
    intent: phase?.generationIntent ?? null,
    ...(contextBoundary ? { contextBoundary } : {}) };
  return { packet, root, ...accepted, phase, session };
}

/** One model-free entry packet; no tests, begin, prepare, commit, push or lifecycle decisions. */
export async function enterPhase({ cwd = process.cwd(), phaseId = null, workId = null,
  compose = false, modelEnabled = true } = {}) {
  const entry = await phaseEntryContext({ cwd, phaseId, workId });
  if (entry.packet.paused) return entry.packet;
  const { root, definition, workflow, phase, session } = entry;
  const actualId = workflow.workItem.id;
  const base = { ...entry.packet,
    effects: { contextCompositionRequested: compose, testsRun: false, storyAdvanced: false,
      committed: false, pushed: false }, modelInvocations: 0 };
  if (!base.ready) return { ...base, status: 'binding-required', context: null,
    contextAdmission: phaseContextAdmission({ ready: false }),
    next: session.phaseAgent?.handoff ? [recoveryActionGuidance(session.phaseAgent.handoff)] : [], authoringAllowed: false };
  const authoring = await phaseAuthoringSummary(root, definition, workflow, phase, { includeEntry: true });
  const recovery = await recoveryPlan(root, definition, workflow, {
    phaseId: phase.id, inspectActivePhase: true, modelEnabled
  });
  const references = await verifyReferenceRepositories(root,
    await storyReferenceRepositories(root, definition, workflow));
  const retainedExecutionEvidence = await phaseExecutionEvidence(root, definition, workflow, phase);
  const requiresDecision = recovery.actions.some(action => action.id === 'working-tree'
    && action.confirmation !== 'none');
  const contextAdmission = phaseContextAdmission({ authoring, recovery, references,
    deterministic: phaseUsesDeterministicGeneration(phase) });
  const canCompose = contextAdmission.allowed;
  let context = null;
  if (compose && canCompose) {
    // The existing composer owns pinned inputs, immutable reuse, authority replay and locking.
    const { composePhasePrompt } = await import('./worldmodel.mjs');
    const text = await composePhasePrompt(root, { workId: actualId, phase: phase.id });
    context = { text, deliveredSha256: createHash('sha256').update(text).digest('hex'),
      generation: base.inspectionGeneration };
  }
  const clarification = await verifyClarificationRecord(root, definition, workflow, phase, {
    generation: base.inspectionGeneration
  });
  if (clarification.mode !== 'off') {
    clarification.responseStagingPath = path.join(gitDir(root), 'singularity-flow', 'clarification-responses',
      `${phase.id}-gen${base.inspectionGeneration}.json`);
    await (await import('./copilot-mutation-guard.mjs')).issueMutationStaging(root, clarification.responseStagingPath, 'clarification');
  }
  const authoringAllowed = Boolean(canCompose && clarification.errors.length === 0);
  const checkpoint = clarification.checkpoint;
  checkpoint.questioningAllowed &&= canCompose;
  checkpoint.contextRequired = checkpoint.questioningAllowed && !context;
  checkpoint.contextDelivered = Boolean(context);
  checkpoint.artifactAuthoringAllowed = authoringAllowed;
  checkpoint.answerBinding = { workId: actualId, phase: phase.id, generation: base.inspectionGeneration,
    promptSha256: context?.deliveredSha256 ?? clarification.record?.promptSha256 ?? null };
  checkpoint.recordAction = checkpoint.questioningAllowed && context ? recoveryActionGuidance({
    id: `record-clarification:${phase.id}`, safe: true, automatic: false, confirmation: 'none',
    scope: 'clarification-only', requiresActualHumanReplies: true,
    detail: 'After matching actual human replies to answerBinding, stage the issued JSON with a file-edit tool and run this command alone. Recording failure does not require repeating the questions.',
    ...safeCommandGuidance({ argv: ['clarification', 'record', phase.id,
      '--response-file', clarification.responseStagingPath, '--json'] })
  }) : null;
  // A missing answer blocks drafting, not loading the evidence needed to ask a question.
  // Do not offer another status lookup or a record command with invented Q/A placeholders.
  const clarificationAction = checkpoint.questioningAllowed ? {
    id: `clarify:${phase.id}`, safe: true, automatic: false, confirmation: 'none',
    scope: 'clarification-only', skill: authoring.effectiveAuthoringSkill,
    command: context ? null : `singularity-flow phase enter ${phase.id} --work-id ${actualId} --compose --for-agent --json`,
    detail: context ? checkpoint.instruction : 'Load the exact composed context once; match existing human replies before deriving unanswered questions. A missing record does not mean unanswered. Missing answers do not forbid question formulation.',
    agentAction: context ? 'derive-and-ask' : 'load-context',
    ...(context ? { copilotCommand: authoring.effectiveAuthoringSkill, modelFreeCommand: null } : {})
  } : null;
  checkpoint.nextAction = clarificationAction ? context
    ? { ...clarificationAction, commandGuidance: {
      // Verify the configured Copilot route through the same crosswalk as the context-loading
      // action, but do not present its shell command as another composition or a fabricated answer.
      copilotCommand: safeCommandGuidance({ ...clarificationAction,
        command: `singularity-flow phase enter ${phase.id} --work-id ${actualId} --compose --for-agent --json`
      })?.copilotCommand ?? null,
      command: null, copyable: false, modelFreeCommand: null,
      shellReason: 'Formulate the questions and ask the human in Copilot; record only the actual reply.'
    }, modelFreeStatus: 'unavailable' }
    : recoveryActionGuidance(clarificationAction) : null;
  const preparationAdmitted = authoring.policyVerified
    && authoring.entry?.status === 'successor-preparation-required'
    && !recovery.requiresRecovery && !requiresDecision && references.status !== 'blocked';
  const status = authoring.entry?.status === 'retained-generation' ? 'retained-generation'
    : preparationAdmitted ? 'successor-preparation-required' : authoringAllowed ? 'authoring-entry' : 'attention-required';
  let next = preparationAdmitted ? authoring.entry.actions
    : authoring.entry?.status === 'attention-required' ? authoring.entry.actions
    : status === 'retained-generation' ? authoring.entry?.actions ?? authoring.handoff : recovery.actions;
  if (authoringAllowed && contextAdmission.pendingEvidence) next = [{
    id: `continue-draft:${phase.id}`, safe: true, automatic: false, confirmation: 'none',
    skill: authoring.effectiveAuthoringSkill, command: `singularity-flow prepare ${phase.id}`,
    detail: contextAdmission.pendingEvidence.detail,
    scope: 'draft-only', evidenceAccepted: false, publicationReviewRequired: true
  }, ...next];
  const nextActions = phaseAdmissionActions(next, contextAdmission, { authoring, recovery }).map(recoveryActionGuidance);
  if (!canCompose && authoring.entry?.status === 'authoring-entry' && base.continuationReview?.commandGuidance) nextActions.unshift(recoveryActionGuidance({
    id: `inspect-continuation:${phase.id}`, safe: true, automatic: false, confirmation: 'none',
    scope: 'read-only', command: base.continuationReview.commandGuidance.command, skill: '/sf-appeal',
    detail: 'Inspect one preserved-work journey and its exact repair/human/owner route. This inspection changes nothing and cannot grant authoring or publication permission.'
  }));
  return { ...base, status, authoringAllowed, contextAdmission,
    ...(preparationAdmitted ? { successor: { targetGeneration: authoring.entry.targetGeneration,
      preparation: authoring.entry.preparation, automatic: false } } : {}),
    authoring, recovery, retainedExecutionEvidence, references, clarification, context,
    contextComposition: !compose ? 'not-requested' : context ? 'delivered' : 'not-admitted',
    next: clarificationAction ? [checkpoint.nextAction, ...nextActions.filter(action =>
      action.id !== `resolve-clarification:${phase.id}`)] : nextActions,
    inspectionCommands: { recovery: `singularity-flow recover ${actualId} --phase ${phase.id} --json`,
      documents: `singularity-flow phase show ${phase.id} --json` } };
}
