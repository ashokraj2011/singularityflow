import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from './package-root.mjs';
import { createHash } from 'node:crypto';
import { recoveryPlan } from './collaboration.mjs';
import { verifyClarificationRecord } from './clarifications.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { phaseKernelOwned, phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { isConformancePhase } from './phase-roles.mjs';
import { phaseAuthoringSummary } from './phase-authoring-summary.mjs';
import { gitDir } from './git-execution.mjs';
import { storyReferenceRepositories, verifyReferenceRepositories } from './reference-repositories.mjs';
import { SingularityFlowError } from './util.mjs';
import { recoveryActionGuidance } from './recovery-action-guidance.mjs';
import { phaseContextAdmission, phaseAdmissionActions } from './phase-entry-admission.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { phaseExecutionEvidence } from './phase-execution-evidence.mjs';
import { phaseAuthoringProgress, readPhaseDraftEvidence } from './phase-authoring-progress.mjs';
import { endsStory, upstreamEntrySummary } from './upstream-entry-summary.mjs';
import { measureCommandSpan } from './dx-timing-context.mjs';
import { CLARIFICATION_RESPONSE_FORMAT, clarificationStagingPath } from './phase-staging-paths.mjs';
import { repositoryCheckStatus } from './repository-check-cache.mjs';

/**
 * The composed prompt file this entry's context came from, verified by its recorded hash.
 *
 * A host can cut a large tool result, and an agent that cannot see the whole context must stop. The
 * composer already writes the exact prompt into the Story's context directory; naming it (with its
 * hash) lets the agent read it in bounded portions with its own file tool. The delivered text adds
 * the presentation-only reply personalization and, on reuse, a refresh of execution evidence the
 * packet also carries. No path is offered unless the bytes match.
 */
async function composedPromptFile(root, workItemRoot, workId, phaseId, generation) {
  const contextDirectory = path.posix.join(workItemRoot, workId, 'context');
  try {
    const record = JSON.parse(await readFile(path.join(root, contextDirectory, `${phaseId}-gen${generation}.json`), 'utf8'));
    const relative = path.posix.normalize(String(record?.promptPath ?? ''));
    if (!relative.startsWith(`${contextDirectory}/prompts/`) || relative.split('/').includes('..')
        || !/^[0-9a-f]{64}$/u.test(String(record?.renderedSha256 ?? ''))) return null;
    let bytes = await readFile(path.join(root, relative));
    let sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== record.renderedSha256) {
      const canonical = (await import('./documents-read.mjs')).committedDocumentBytes(
        root, relative, { sha256: record.renderedSha256 }, bytes);
      if (canonical) {
        bytes = canonical;
        sha256 = createHash('sha256').update(bytes).digest('hex');
        const privateFile = await (await import('./document-runtime.mjs')).writePrivateDocumentContext(root, bytes.toString('utf8'));
        return { ...privateFile, sourcePath: relative,
          differsFromText: 'Exact committed snapshot; private copy avoids checkout line-ending conversion. Runtime evidence and personalization are in the delivered context.' };
      }
    }
    return sha256 === record.renderedSha256
      ? { path: relative, sha256, bytes: bytes.length, differsFromText: 'omits the presentation-only reply personalization and any execution-evidence or evidence-consistency refresh added on reuse (recorded visual reviews arrive in the latter) (the packet carries those as retainedExecutionEvidence, recordedVisualReviews and evidenceConsistency)' }
      : null;
  } catch { return null; }
}

/** Loaded only after the binding owner has admitted the current phase/agent. */
export async function completePhaseEntry(entry, base, { compose, modelEnabled }) {
  const { root, definition, workflow, phase, session } = entry;
  const actualId = workflow.workItem.id;
  const authoring = await measureCommandSpan('phase-entry.authoring', () => phaseAuthoringSummary(root, definition, workflow, phase, { includeEntry: true }));
  const documentReadiness = await (await import('./document-runtime.mjs')).phaseDocumentReadiness(root, definition, workflow, phase.id);
  const recovery = await measureCommandSpan('phase-entry.recovery', () => recoveryPlan(root, definition, workflow, {
    phaseId: phase.id, inspectActivePhase: true, modelEnabled
  }));
  const references = await measureCommandSpan('phase-entry.references', async () => verifyReferenceRepositories(root,
    await storyReferenceRepositories(root, definition, workflow)));
  const retainedExecutionEvidence = await measureCommandSpan('phase-entry.execution-evidence', () => phaseExecutionEvidence(root, definition, workflow, phase));
  // The human visual reviews the Story recorded (decision witness), for a step that reports on them.
  const recordedVisualReviews = workflow.witnessRecords?.length
    ? await (await import('./verification/witness-decisions.mjs')).phaseWitnessDecisions(root, workflow, phase) : null;
  const evidenceConsistency = await (await import('./evidence-consistency-read.mjs')).readEvidenceConsistency(
    root, definition, workflow, phase, { executionEvidence: retainedExecutionEvidence, visualReviews: recordedVisualReviews });
  const scopeReview = await measureCommandSpan('phase-entry.scope-review', async () =>
    (await import('./scope/authoring.mjs')).scopeAuthoringCheckpoint(root, definition, workflow, phase));
  // What earlier steps left open, and at the closing step the final evaluation's preview [A7, B5].
  const upstream = await measureCommandSpan('phase-entry.upstream', async () => upstreamEntrySummary(root, definition, workflow, phase, {
    evaluateTerminalReadiness: endsStory(workflow, phase)
      ? (await import('./evidence/terminal.mjs')).evaluateTerminalReadiness : null,
    owedDecisions: (await import('./owed-decisions.mjs')).owedDecisions
  }));
  const requiresDecision = recovery.actions.some(action => action.id === 'working-tree'
    && action.confirmation !== 'none');
  const contextAdmission = phaseContextAdmission({ authoring, recovery, references,
    deterministic: phaseKernelOwned(phase) });
  if (documentReadiness.status !== 'ready') {
    contextAdmission.allowed = false;
    contextAdmission.blockers.push({ code: 'DOCUMENT_REUPLOAD_REQUIRED', message: documentReadiness.instruction,
      documents: documentReadiness.missing.map(({ id, name, sha256 }) => ({ id, name, sha256 })) });
  }
  const canCompose = contextAdmission.allowed;
  let context = null;
  if (compose && canCompose) {
    // The existing composer owns pinned inputs, immutable reuse, authority replay and locking.
    const { composePhasePrompt } = await import('./phase-prompt-composer.mjs');
    const text = await composePhasePrompt(root, { workId: actualId, phase: phase.id });
    // The composer writes the prompt of the generation to author next. A published step's inspection
    // generation is the one before it, so naming that file offered the previous generation's prompt.
    const generation = nextPhaseGeneration(phase);
    const durableFile = await composedPromptFile(root, definition.workItemRoot, actualId, phase.id, generation);
    let file = durableFile;
    if (documentReadiness.localDocumentCount) {
      file = await (await import('./document-runtime.mjs')).writePrivateDocumentContext(root, text);
    }
    context = { text, deliveredSha256: createHash('sha256').update(text).digest('hex'),
      renderedSha256: durableFile?.sha256 ?? null, generation, ...(file ? { file } : {}),
      ...(documentReadiness.localDocumentCount ? { durableFile } : {}) };
  }
  const clarification = await measureCommandSpan('phase-entry.clarification', () => verifyClarificationRecord(root, definition, workflow, phase, {
    generation: base.inspectionGeneration
  }));
  if (clarification.mode !== 'off') {
    clarification.responseStagingPath = clarificationStagingPath(gitDir(root), workflow, phase);
    await (await import('./copilot-mutation-guard.mjs')).issueMutationStaging(root, clarification.responseStagingPath, 'clarification');
  }
  const authoringAllowed = Boolean(canCompose && clarification.errors.length === 0);
  const codeAuthoringReady = Boolean(base.generatesCode && authoringAllowed
    && base.mutationContract.codeAuthoringReady);
  const authoringProgress = authoring.entry?.status === 'authoring-entry'
    ? phaseAuthoringProgress(workflow, phase, {
      draftEvidence: await readPhaseDraftEvidence(root, definition, workflow, phase)
    }) : null;
  const checkpoint = clarification.checkpoint;
  checkpoint.questioningAllowed &&= canCompose;
  checkpoint.contextRequired = checkpoint.questioningAllowed && !context;
  checkpoint.contextDelivered = Boolean(context);
  checkpoint.artifactAuthoringAllowed = authoringAllowed;
  // Bind answers to the hash a clarification record keeps: the composed prompt without the reply
  // personalization. The delivered hash includes it, so with a reply name set it never matched a record.
  checkpoint.answerBinding = { workId: actualId, phase: phase.id, generation: base.inspectionGeneration,
    promptSha256: (context?.generation === base.inspectionGeneration ? context.renderedSha256 : null)
      ?? clarification.record?.promptSha256 ?? null };
  checkpoint.recordAction = checkpoint.questioningAllowed && context ? recoveryActionGuidance({
    id: `record-clarification:${phase.id}`, safe: true, automatic: false, confirmation: 'none',
    scope: 'clarification-only', requiresActualHumanReplies: true, responseFormat: CLARIFICATION_RESPONSE_FORMAT,
    detail: 'After matching actual human replies to answerBinding, write them as responseFormat (one entry per question; a deferral adds "status":"deferred") to the --response-file path with a file-edit tool, then run this command alone. Recording failure does not require repeating the questions.',
    ...safeCommandGuidance({ argv: ['clarification', 'record', phase.id,
      '--response-file', clarification.responseStagingPath, '--json'] })
  }) : null;
  // A question can arise after the checkpoint was recorded, while the step is being authored
  // (coding found a case nobody asked about). The record is append-only and keeps every earlier
  // answer, so a new one joins it while the step still allows questions; settled ones stay settled.
  const recordedQuestions = clarification.record?.responses?.length ?? 0;
  checkpoint.remainingQuestions = checkpoint.stage === 'complete' ? Math.max(0, checkpoint.maxQuestions - recordedQuestions) : null;
  checkpoint.newQuestionAction = checkpoint.stage === 'complete' && canCompose && checkpoint.remainingQuestions > 0 ? recoveryActionGuidance({
    id: `add-clarification:${phase.id}`, safe: true, automatic: false, confirmation: 'none',
    scope: 'clarification-only', requiresActualHumanReplies: true, responseFormat: CLARIFICATION_RESPONSE_FORMAT,
    detail: 'Only for a new question that arose while authoring and that the person here can answer; never re-ask a recorded one. Stage only the new reply as responseFormat with a file-edit tool and run this command alone.',
    ...safeCommandGuidance({ argv: ['clarification', 'record', phase.id,
      '--response-file', clarification.responseStagingPath, '--json'] })
  }) : null;
  // Answers recorded before this generation's prompt was recomposed (its documents, inputs or change
  // requests changed) are bound to the old prompt. Nothing re-binds them automatically: the person
  // confirms or changes each one against the current context, recorded with --replace. Without this
  // route the step stopped at inspect-binding with no action.
  checkpoint.rebindAction = checkpoint.stage === 'inspect-binding' && clarification.staleOnly && canCompose
    ? recoveryActionGuidance(context ? {
      id: `rebind-clarification:${phase.id}`, safe: true, automatic: false, confirmation: 'none',
      scope: 'clarification-only', requiresActualHumanReplies: true, skill: authoring.effectiveAuthoringSkill, responseFormat: CLARIFICATION_RESPONSE_FORMAT,
      detail: 'The prompt was recomposed after these answers were recorded. Show the person each recorded question and answer (clarification.record.responses) against the current context; stage only the answers they confirm or change as responseFormat with a file-edit tool and run this command alone.',
      ...safeCommandGuidance({ argv: ['clarification', 'record', phase.id,
        '--response-file', clarification.responseStagingPath, '--replace', '--json'] })
    } : {
      id: `rebind-clarification:${phase.id}`, safe: true, automatic: false, confirmation: 'none',
      scope: 'clarification-only', agentAction: 'load-context', skill: authoring.effectiveAuthoringSkill,
      command: `singularity-flow phase enter ${phase.id} --work-id ${actualId} --compose --for-agent --json`,
      detail: 'The recorded answers are bound to an earlier prompt. Load the current composed context once, then re-bind them with the person.'
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
  // Unanswered questions are the authoring skill's own next step (compose, then ask), not a hold:
  // reported as attention-required, a skill relayed itself as the next action and stopped.
  const status = documentReadiness.status !== 'ready' ? 'documents-required'
    : authoring.entry?.status === 'retained-generation' ? 'retained-generation'
    : preparationAdmitted ? 'successor-preparation-required' : authoringAllowed ? 'authoring-entry'
      : canCompose && authoring.entry?.status === 'authoring-entry' && checkpoint.questioningAllowed ? 'clarification-required'
        : 'attention-required';
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
  if (documentReadiness.status !== 'ready') nextActions.unshift(...documentReadiness.missing.map(record => ({
    id: `restore-document:${record.id}`, safe: true, automatic: false, confirmation: 'choose-local-file',
    detail: record.instruction, ...record.commandGuidance, commandGuidance: record.commandGuidance,
    scope: 'machine-local-document-only' })));
  if (authoringAllowed && authoringProgress?.next) nextActions.unshift({
    id: `resume-authoring:${phase.id}`, safe: true, automatic: false, confirmation: 'none',
    detail: authoringProgress.instruction, ...authoringProgress.next,
    commandGuidance: authoringProgress.next, scope: 'current-draft', preserveExistingWork: true
  });
  // Input routes lead when inputs refused admission; the journey inspection follows them.
  const inputsBlocked = contextAdmission.blockers.some(item => item.code === 'PHASE_CONTEXT_INPUTS_NOT_READY')
    // A hold a person can settle (keep the files or set them aside) leads with that route, not the read-only inspection.
    || recovery.actions.some(action => action.id === 'set-aside-worktree');
  if (!canCompose && authoring.entry?.status === 'authoring-entry' && base.continuationReview?.commandGuidance) nextActions[inputsBlocked ? 'push' : 'unshift'](recoveryActionGuidance({
    id: `inspect-continuation:${phase.id}`, safe: true, automatic: false, confirmation: 'none',
    scope: 'read-only', command: base.continuationReview.commandGuidance.command, skill: '/sf-appeal',
    detail: 'Inspect one preserved-work journey and its exact repair/human/owner route. This inspection changes nothing and cannot grant authoring or publication permission.'
  }));
  // A retest step names the step whose Code evidence it re-checks; skills read this, never a step name.
  const testEvidenceFrom = workflow.resolution?.phases?.find((entry) => entry.id === phase.id)?.testEvidenceFrom ?? null;
  const applicationReviewRepair = workflow.applicationReviews?.length && phaseRequiresCodeDelivery(phase)
    ? (await import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'application-review.mjs')).href)).applicationReviewRepairContext(workflow, phase) : null;
  // What the plan's amendments changed, for a code step: the turn after one must hear it from the record (bin-opr2).
  const planChanges = base.generatesCode && workflow.planAmendments?.length ? await (await import('./plan-amendment-notes.mjs')).planChangeNotes(root, workflow) : [];
  // And its departures: what waits for a person, and what one rejected, which this turn restores [CQF:REQ-026].
  const departures = base.generatesCode && workflow.departures?.length ? await (await import('./departure-records.mjs')).departureSummary(root, workflow, phase) : null;
  // And the findings register's items on what the Story touches, the eligible ones this turn fixes on the way [CQF:REQ-066].
  // From the CLI source, so the VS Code bundles that read an entry do not carry the register.
  const fixOnTheWay = base.generatesCode ? await measureCommandSpan('phase-entry.findings-on-the-way', async () =>
    (await import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'findings', 'register', 'on-the-way.mjs')).href)).itemsOnTheWay(root, definition, workflow, phase)) : null;
  // What the person typed into this step's turns, each with its account, so this turn accounts for the rest [SCS:REQ-042]; a
  // conformance step reads what was asked in the code steps, quoted, as data to compare against [SCS:REQ-043].
  // From the CLI source, so the VS Code bundles that read an entry do not carry the records.
  const askedForRecords = () => import(pathToFileURL(path.join(PACKAGE_ROOT, 'src', 'asked-for-records.mjs')).href);
  const askedFor = base.generatesCode ? await (await askedForRecords()).askedForSummary(root, workflow, phase)
    : isConformancePhase(phase) && workflow.askedFor?.length ? (await askedForRecords()).askedForConformanceInput(workflow, phase) : null;
  return { ...base, ...(planChanges.length ? { planChanges } : {}), ...(departures ? { departures } : {}), ...(askedFor ? { askedFor } : {}), ...(fixOnTheWay ? { fixOnTheWay } : {}), ...(applicationReviewRepair ? { applicationReviewRepair } : {}), repositoryChecks: repositoryCheckStatus(root), status, upstream, scopeReview, testEvidenceFrom, authoringAllowed, codeAuthoringReady, authoringProgress, contextAdmission,
    ...(preparationAdmitted ? { successor: { targetGeneration: authoring.entry.targetGeneration,
      preparation: authoring.entry.preparation, automatic: false } } : {}),
    authoring, recovery, retainedExecutionEvidence, evidenceConsistency, ...(recordedVisualReviews ? { recordedVisualReviews } : {}),
    references, documentReadiness, clarification, context,
    contextComposition: !compose ? 'not-requested' : context ? 'delivered' : 'not-admitted',
    next: clarificationAction ? [checkpoint.nextAction, ...nextActions.filter(action =>
      action.id !== `resolve-clarification:${phase.id}`)] : checkpoint.rebindAction ? [checkpoint.rebindAction, ...nextActions] : nextActions,
    inspectionCommands: { recovery: `singularity-flow recover ${actualId} --phase ${phase.id} --json`,
      documents: `singularity-flow phase show ${phase.id} --json` } };
}
