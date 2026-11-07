import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PACKAGE_ROOT } from '../package-root.mjs';
import { createHash } from 'node:crypto';
import { recoveryPlan } from '../collaboration.mjs';
import { verifyClarificationRecord } from '../clarifications.mjs';
import {nextPhaseGeneration} from '../kernel/phase-policy.mjs';
import {approvedInputPhases,resolvedPhaseInputs} from '../kernel/phase-inputs.mjs';
import {loadManifest,documentPolicy} from '../documents-read.mjs';
import {documentOfferedToPhase} from '../document-identity.mjs';
import {isLocalDocument} from '../document-storage.mjs';
import {phaseDocumentReference} from './native-document-references.mjs';
import {workDirRelative} from '../story-paths.mjs';
import { phaseKernelOwned, phaseRequiresCodeDelivery } from '../code-delivery-policy.mjs';
import { phaseAuthoringSummary } from '../phase-authoring-summary.mjs';
import { gitDir } from '../git-execution.mjs';
import { storyReferenceRepositories, verifyReferenceRepositories } from '../reference-repositories.mjs';
import { SingularityFlowError } from '../util.mjs';
import { recoveryActionGuidance } from '../recovery-action-guidance.mjs';
import { phaseContextAdmissionPresentation, phaseAdmissionActions } from '../phase-entry-admission.mjs';
import { safeCommandGuidance } from '../safe-command-guidance.mjs';
import { phaseExecutionEvidence } from '../phase-execution-evidence.mjs';
import { phaseTaskCompletion, phaseAuthoringProgress, readPhaseDraftEvidence } from '../phase-authoring-progress.mjs';
import { endsStory, upstreamEntrySummary } from '../upstream-entry-summary.mjs';
import { measureCommandSpan } from '../dx-timing-context.mjs';
import { clarificationStagingPath } from '../phase-staging-paths.mjs';
import { repositoryCheckStatus } from '../repository-check-cache.mjs';

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
      const canonical = (await import('../documents-read.mjs')).committedDocumentBytes(
        root, relative, { sha256: record.renderedSha256 }, bytes);
      if (canonical) {
        bytes = canonical;
        sha256 = createHash('sha256').update(bytes).digest('hex');
        const privateFile = await (await import('../document-runtime.mjs')).writePrivateDocumentContext(root, bytes.toString('utf8'));
        return { ...privateFile, sourcePath: relative,
          differsFromText: 'Exact committed snapshot; private copy avoids checkout line-ending conversion. Runtime evidence and personalization are in the delivered context.' };
      }
    }
    return sha256 === record.renderedSha256
      ? { path: relative, sha256, bytes: bytes.length, differsFromText: 'omits the presentation-only reply personalization and any execution-evidence or evidence-consistency refresh added on reuse (recorded visual reviews arrive in the latter) (the packet carries those as retainedExecutionEvidence, recordedVisualReviews and evidenceConsistency)' }
      : null;
  } catch { return null; }
}

/** Native observations only; admission and optional composition are coordinated by the SDK. */
export async function inspectNativePhaseEntry(entry, {modelEnabled}) {
  const {root,definition,workflow,phase}=entry;
  const authoring = await measureCommandSpan('phase-entry.authoring', () => phaseAuthoringSummary(root, definition, workflow, phase, { includeEntry: true }));
  const documentManifest = await loadManifest(root, definition, workflow);
  const documentReadiness = await (await import('../document-runtime.mjs')).phaseDocumentReadiness(root, definition, workflow, phase.id, {manifest:documentManifest});
  const recovery = await measureCommandSpan('phase-entry.recovery', () => recoveryPlan(root, definition, workflow, {
    phaseId: phase.id, inspectActivePhase: true, modelEnabled
  }));
  const references = await measureCommandSpan('phase-entry.references', async () => verifyReferenceRepositories(root,
    await storyReferenceRepositories(root, definition, workflow)));
  const retainedExecutionEvidence = await measureCommandSpan('phase-entry.execution-evidence', () => phaseExecutionEvidence(root, definition, workflow, phase));
  // The human visual reviews the Story recorded (decision witness), for a step that reports on them.
  const recordedVisualReviews = workflow.witnessRecords?.length
    ? await (await import('../verification/witness-decisions.mjs')).phaseWitnessDecisions(root, workflow, phase) : null;
  const evidenceConsistency = await (await import('../evidence-consistency-read.mjs')).readEvidenceConsistency(
    root, definition, workflow, phase, { executionEvidence: retainedExecutionEvidence, visualReviews: recordedVisualReviews });
  const scopeReview = await measureCommandSpan('phase-entry.scope-review', async () =>
    (await import('../scope/authoring.mjs')).scopeAuthoringCheckpoint(root, definition, workflow, phase));
  // What earlier steps left open, and at the closing step the final evaluation's preview [A7, B5].
  const upstream = await measureCommandSpan('phase-entry.upstream', async () => upstreamEntrySummary(root, definition, workflow, phase, {
    evaluateTerminalReadiness: endsStory(workflow, phase)
      ? (await import('../evidence/terminal.mjs')).evaluateTerminalReadiness : null,
    owedDecisions: (await import('../owed-decisions.mjs')).owedDecisions
  }));
  return {authoring,documentManifest,documentReadiness,recovery,references,retainedExecutionEvidence,
    recordedVisualReviews,evidenceConsistency,scopeReview,upstream};
}

export async function composeNativePhaseEntry(entry,facts) {
  const {root,definition,workflow,phase}=entry,actualId=workflow.workItem.id;
  const {documentReadiness}=facts;
  let context=null;
  // The existing composer owns pinned inputs, immutable reuse, authority replay and locking.
  const { composePhasePrompt } = await import('../phase-prompt-composer.mjs');
  const text = await composePhasePrompt(root, { workId: actualId, phase: phase.id });
  // The composer writes the prompt of the generation to author next. A published step's inspection
  // generation is the one before it, so naming that file offered the previous generation's prompt.
  const generation = nextPhaseGeneration(phase);
  const durableFile = await composedPromptFile(root, definition.workItemRoot, actualId, phase.id, generation);
  let file = durableFile;
  if (documentReadiness.localDocumentCount) {
    file = await (await import('../document-runtime.mjs')).writePrivateDocumentContext(root, text);
  }
  context = { text, deliveredSha256: createHash('sha256').update(text).digest('hex'),
    renderedSha256: durableFile?.sha256 ?? null, generation, ...(file ? { file } : {}),
    ...(documentReadiness.localDocumentCount ? { durableFile } : {}) };
  return context;
}

export async function clarifyNativePhaseEntry(entry,base,facts) {
  const {root,definition,workflow,phase}=entry;
  const {authoring}=facts;
  const clarification = await measureCommandSpan('phase-entry.clarification', () => verifyClarificationRecord(root, definition, workflow, phase, {
    generation: base.inspectionGeneration
  }));
  if (clarification.mode !== 'off') {
    clarification.responseStagingPath = clarificationStagingPath(gitDir(root), workflow, phase);
    await (await import('../copilot-mutation-guard.mjs')).issueMutationStaging(root, clarification.responseStagingPath, 'clarification');
  }
  const authoringProgress = authoring.entry?.status === 'authoring-entry'
    ? phaseAuthoringProgress(workflow, phase, {
      draftEvidence: await readPhaseDraftEvidence(root, definition, workflow, phase)
    }) : null;
  return {clarification,authoringProgress};
}

/** Translate existing native records to semantic observations, without prompt text or shell routes. */
export function phaseEntryInspectionFacts(entry,facts) {
  const {definition,workflow,phase}=entry,workId=workflow.workItem.id;
  const {authoring,recovery,references,documentReadiness}=facts;
  const resources=[],declarations=resolvedPhaseInputs(workflow,phase);
  for(const id of approvedInputPhases(workflow,phase)) {
    const producer=Object.hasOwn(workflow.phases,id)?workflow.phases[id]:null;
    const file=producer?.requiredArtifact?.path?path.posix.join(workDirRelative(definition,workId),producer.requiredArtifact.path):null;
    const retained=file?(producer.artifacts??[]).find(item=>item.path===file):null;
    resources.push({id:`INPUT-${id}`,role:'approved-input',producer:id,sourceKey:file,
      reference:file?phaseDocumentReference(workId,producer,{path:file,type:'artifact'}):null,
      required:declarations.some(item=>(typeof item==='string'?item:item?.phase)===id&&(typeof item==='string'||item.required!==false)),
      expected:retained?.sha256?{sha256:retained.sha256,bytes:retained.size??null}:null,
      locality:'project',availability:file?'verify-on-read':'unavailable'});
  }
  for(const id of ['SYS-STORY','SYS-SOURCE'])resources.push({id,role:'story-source',producer:null,sourceKey:null,
    reference:{kind:'story-document',id,workId},required:true,expected:null,locality:'project',availability:'verify-on-read'});
  const documents=facts.documentManifest.documents.filter(record=>record.status!=='detached'&&documentOfferedToPhase(record,phase.id));
  for(const record of documents)resources.push({id:record.id,role:'supporting-document',producer:null,sourceKey:null,
    reference:{kind:'story-document',id:record.id,workId},required:true,
    expected:record.sha256?{sha256:record.sha256,bytes:record.size??null}:null,
    locality:record.type==='url'?'external':isLocalDocument(record)?'machine-local':'project',
    availability:record.type==='url'?'reference-only':isLocalDocument(record)
      ?documentReadiness.missing.some(item=>item.id===record.id)?'reupload-required':'verified-local':'verify-on-read'});
  return {workId,phase:phase.id,generation:Number(phase.generation??0),inspectionGeneration:entry.packet.inspectionGeneration,
    deterministic:phaseKernelOwned(phase),authoring:{entry:{status:authoring.entry?.status??null,reason:authoring.entry?.reason??null},
      policyVerified:Boolean(authoring.policyVerified),policyReason:authoring.policyReason??null,
      hasAuthoringRoute:Boolean(authoring.effectiveAuthoringSkill),targetGeneration:authoring.entry?.targetGeneration??null},
    recovery:{requiresRecovery:Boolean(recovery.requiresRecovery),actions:(recovery.actions??[]).map(action=>({
      id:action.id,automatic:Boolean(action.automatic),mode:action.mode??null,confirmation:action.confirmation??null,
      paths:action.paths??[],unexpectedPaths:action.unexpectedPaths??[],authoringContinuation:action.authoringContinuation?{
        allowed:action.authoringContinuation.allowed===true,status:action.authoringContinuation.status??null}:null})),
      blockers:(recovery.blockers??[]).filter(blocker=>blocker.category==='inputs').map(blocker=>({
        category:'inputs',path:blocker.path??null,details:{upstreamPhase:blocker.details?.upstreamPhase??null,
          status:blocker.details?.status??null,restorable:blocker.details?.restorable===true}}))},references:{status:references.status},
    documents:{status:documentReadiness.status,localDocumentCount:documentReadiness.localDocumentCount,documentCount:documents.length,
      missing:documentReadiness.missing.map(({id,name,sha256})=>({id,name,sha256}))},resources,
    budgets:{documentPreviewBytes:Math.min(documentPolicy(workflow,definition).maxPreviewBytes??1_048_576,1_048_576),
      supportingTotalBytes:documentPolicy(workflow,definition).maxPromptEvidenceBytes??48*1024}};
}

/** Existing host wording and command crosswalks are private compatibility presentation. */
export async function presentNativePhaseEntry(entry,base,facts,{admission,plan,context,clarification,authoringProgress}) {
  const {root,definition,workflow,phase}=entry,actualId=workflow.workItem.id;
  const {authoring,documentReadiness,recovery,references,retainedExecutionEvidence,recordedVisualReviews,
    evidenceConsistency,scopeReview,upstream}=facts;
  const contextAdmission=phaseContextAdmissionPresentation(admission,{recovery,documents:documentReadiness});
  const canCompose=admission.allowed,authoringAllowed=plan.authoringAllowed,codeAuthoringReady=plan.codeAuthoringReady;
  const compose=plan.compositionRequested;
  const checkpoint = clarification.checkpoint;
  Object.assign(checkpoint, plan.checkpoint);
  checkpoint.recordAction = plan.recordingAllowed ? recoveryActionGuidance({
    id: `record-clarification:${phase.id}`, safe: true, automatic: false, confirmation: 'none',
    scope: 'clarification-only', requiresActualHumanReplies: true,
    detail: 'After matching actual human replies to answerBinding, stage the issued JSON with a file-edit tool and run this command alone. Recording failure does not require repeating the questions.',
    ...safeCommandGuidance({ argv: ['clarification', 'record', phase.id,
      '--response-file', clarification.responseStagingPath, '--json'] })
  }) : null;
  // A question can arise after the checkpoint was recorded, while the step is being authored
  // (coding found a case nobody asked about). The record is append-only and keeps every earlier
  // answer, so a new one joins it while the step still allows questions; settled ones stay settled.
  checkpoint.newQuestionAction = plan.newQuestionAllowed ? recoveryActionGuidance({
    id: `add-clarification:${phase.id}`, safe: true, automatic: false, confirmation: 'none',
    scope: 'clarification-only', requiresActualHumanReplies: true,
    detail: 'Only for a new question that arose while authoring and that the person here can answer; never re-ask a recorded one. Stage only the new reply as {"responses":[...]} with a file-edit tool and run this command alone.',
    ...safeCommandGuidance({ argv: ['clarification', 'record', phase.id,
      '--response-file', clarification.responseStagingPath, '--json'] })
  }) : null;
  // Answers recorded before this generation's prompt was recomposed (its documents, inputs or change
  // requests changed) are bound to the old prompt. Nothing re-binds them automatically: the person
  // confirms or changes each one against the current context, recorded with --replace. Without this
  // route the step stopped at inspect-binding with no action.
  checkpoint.rebindAction = plan.rebindAllowed
    ? recoveryActionGuidance(context ? {
      id: `rebind-clarification:${phase.id}`, safe: true, automatic: false, confirmation: 'none',
      scope: 'clarification-only', requiresActualHumanReplies: true, skill: authoring.effectiveAuthoringSkill,
      detail: 'The prompt was recomposed after these answers were recorded. Show the person each recorded question and answer (clarification.record.responses) against the current context; stage only the answers they confirm or change as {"responses":[...]} with a file-edit tool and run this command alone.',
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
  const {preparationAdmitted,status} = plan;
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
  const planChanges = base.generatesCode && workflow.planAmendments?.length ? await (await import('../plan-amendment-notes.mjs')).planChangeNotes(root, workflow) : [];
  return { ...base, ...(planChanges.length ? { planChanges } : {}), ...(applicationReviewRepair ? { applicationReviewRepair } : {}), repositoryChecks: repositoryCheckStatus(root), status, upstream, scopeReview, testEvidenceFrom, authoringAllowed, codeAuthoringReady, authoringProgress, contextAdmission,
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

/** Native local checkpoint writes; these never publish or approve a generation. */
export async function checkpointNativePhaseEntry(entry,result) {
  const base=entry.packet;
  const taskCompletion = (await import('../phase-authoring-progress.mjs')).phaseTaskCompletion(result);
  const { resumeWorkflowTask } = await import('../workflow-task-store.mjs');
  const taskResume = await resumeWorkflowTask(entry.root, entry.workflow, entry.phase, {
    generation: taskCompletion?.generation ?? (result.authoring?.entry?.status === 'retained-generation' ? entry.phase.generation : base.inspectionGeneration),
    progress: taskCompletion,
    published: result.authoring?.entry?.status === 'retained-generation',
    blocked: taskCompletion?.state === 'blocked' ? { code: result.documentReadiness?.status === 'ready'
      ? 'PHASE_ENTRY_NOT_ADMITTED' : result.documentReadiness ? 'DOCUMENT_REUPLOAD_REQUIRED' : 'PHASE_ENTRY_NOT_ADMITTED',
    nextAction: taskCompletion.nextAction } : null
  });
  return { ...result, taskResume, ...(taskCompletion && taskResume ? { taskCompletion: { ...taskCompletion,
    operationId: taskResume.operationId, continuationBudget: taskResume.continuationBudget,
    ...(taskResume.state === 'inspect-interrupted-operation' ? { state: 'blocked', nextAction: taskResume.nextAction,
      instruction: 'Inspect the interrupted operation before any replay. Preserve its draft and original recovery route.' } : {}) } } : {}) };
}
