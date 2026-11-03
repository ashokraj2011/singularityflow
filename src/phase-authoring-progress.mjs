/** Read-only drafting milestones. Neither source changes nor tests imply publication. */
import { phaseRequiresCodeDelivery, generationSkillForPhase } from './code-delivery-policy.mjs';
import { consumedByPublishedGeneration, nextPhaseGeneration } from './phase-generation.mjs';
import { phaseNeedsGeneration } from './sequence.mjs';
import { phaseUsesDeterministicGeneration } from './manual-authorship.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';
import { phaseAuthoredReviewArtifacts } from './artifact-review-read.mjs';

/** The current task, not a promise that reading or preparation completed its deliverable. */
export function phaseTaskCompletion(result) {
  const successor = result?.status === 'successor-preparation-required' && result.successor?.preparation;
  if (result?.resultType !== 'sflow-phase-entry' || !result.ready || result.paused
      || !result.workId || !result.phase || !successor && (!result.authoringProgress
      || result.authoring?.entry?.status !== 'authoring-entry')) return null;
  const allowed = result.authoringAllowed === true && result.contextAdmission?.allowed !== false;
  const loadContext = allowed && result.contextComposition === 'not-requested';
  const compact = action => {
    const value = action?.commandGuidance ?? action;
    return value ? { command: value.command ?? null, copilotCommand: value.copilotCommand ?? value.skill ?? null,
      modelFreeCommand: value.modelFreeCommand ?? null } : null;
  };
  return { revision: 'workflow-task-completion-v1', kind: 'phase-authoring', workId: result.workId,
    phaseId: result.phase, generation: successor ? result.successor.targetGeneration : result.authoringProgress.generation,
    complete: false, state: successor ? 'prepare-successor' : loadContext ? 'load-context' : allowed ? 'author-draft' : 'blocked',
    checkpoint: 'published-generation', publicationVerified: false,
    nextAction: compact(successor || (loadContext ? safeCommandGuidance({ argv: ['phase', 'enter', result.phase,
      '--work-id', result.workId, '--compose', '--for-agent', '--json'] })
      : allowed ? result.authoringProgress.next : result.next?.[0])),
    recheck: compact(safeCommandGuidance({ argv: ['phase', 'prepublish', result.phase, '--work-id', result.workId,
      '--for-agent', '--json', '--publish-if-ready'] })),
    recovery: compact(safeCommandGuidance({ argv: ['recover', result.workId, '--phase', result.phase, '--for-agent', '--json'] })),
    instruction: 'Input reads, preparation and diagnostic tests are incomplete. Finish the admitted task or preserve its exact blocker and owner route. Never submit, approve or start another phase.' };
}

export function phaseAuthoringProgress(workflow, phase, { draftEvidence = null } = {}) {
  if (!phase || phase.status !== 'in_progress' || workflow.currentPhase !== phase.id
      || !phaseNeedsGeneration(workflow, phase) || phaseUsesDeterministicGeneration(phase)) return null;
  const code = phaseRequiresCodeDelivery(phase);
  const generation = nextPhaseGeneration(phase);
  const open = code && phase.generationIntent?.status === 'open'
    && Number(phase.generationIntent.generation) === generation;
  let stage, argv, instruction;
  let skill = generationSkillForPhase(phase, workflow);
  if (code && phase.generationIntent?.status === 'consumed' && !consumedByPublishedGeneration(phase)) {
    stage = 'review-successor'; argv = ['recover', workflow.workItem.id, '--phase', phase.id, '--json']; skill = '/sf-recover';
    instruction = 'Preserve the published generation and current edits. Review the guarded successor boundary before changing source.';
  } else if (code && !open) {
    // A step returned for rework still holds the intent its published generation consumed. Its
    // successor opens with `phase begin` from that publication (recovery has nothing to repair
    // while the published bytes are unchanged; when they changed, nextsteps routes to recovery
    // before this point), and begin's own adoption review guards any edits made since.
    stage = 'open-code-generation'; argv = ['phase', 'begin', phase.id, '--json'];
    instruction = phase.generationIntent?.status === 'consumed'
      ? `Open ${phase.id} generation ${generation} from published generation ${phase.generation} before any application edit; the published generation stays preserved. Existing changes require the returned adoption review; never auto-confirm or discard them.`
      : 'Open the exact code generation before any application edit. Existing changes require the returned adoption review; never auto-confirm or discard them.';
  } else if (draftEvidence?.draftExists && draftEvidence.draftModified) {
    stage = 'validate-existing-draft'; argv = ['phase', 'prepublish', phase.id, '--for-agent', '--json'];
    instruction = 'Preserve the existing code, tests and authored draft. Validate it, repair only the returned findings, and publish only when fresh prepublish returns commands.publish. An authored draft or manual test pass is not publication.';
  } else {
    stage = draftEvidence?.draftExists ? 'complete-draft' : draftEvidence ? 'create-missing-draft' : 'resume-draft';
    argv = ['prepare', phase.id];
    instruction = `${code ? 'Keep existing application edits and tests; do not restart implementation. ' : 'Preserve any existing authored draft. '}${draftEvidence?.draftExists ? 'Complete' : 'Prepare and complete'} the configured phase artifact, including its Agent brief and real evidence. Resolve planned source/test bindings, then run prepublish and publish only when ready. Preparation scaffolds records; it is not completed authoring.`;
  }
  const next = safeCommandGuidance({ argv, skill });
  return { stage, generation, codeGenerationOpen: open,
    draft: draftEvidence ?? { draftExists: null, draftModified: null }, instruction, next,
    preserveExistingWork: true, codeComplete: 'not-inferred', publishReady: false,
    testsAttested: false, automaticApproval: false };
}

/** Only inspect the current prospective primary artifact; never recheck approved phases. */
export async function readPhaseDraftEvidence(root, definition, workflow, phase, { changedPaths = null, observeFile = null } = {}) {
  if (!phase?.requiredArtifact?.path) return { draftExists: false, draftModified: false };
  const review = await phaseAuthoredReviewArtifacts(root, definition, workflow, phase, { observeFile, primaryOnly: true });
  const primary = review.artifacts.find(artifact => artifact.scope === 'primary');
  const baseline = phase.authoringBaseline;
  const changed = !baseline && primary?.exists
    ? changedPaths ? changedPaths.includes(primary.path)
      : (await import('./git.mjs')).pathHasChanges(root, primary.path)
    : false;
  return { draftExists: Boolean(primary?.exists), draftModified: Boolean(primary?.exists
    && (changed || (baseline?.path === phase.requiredArtifact.path && baseline.fingerprint
    && primary.fingerprint !== baseline.fingerprint))) };
}
