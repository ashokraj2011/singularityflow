/** Read-only drafting milestones. Neither source changes nor tests imply publication. */
import { phaseRequiresCodeDelivery, generationSkillForPhase } from './code-delivery-policy.mjs';
import { nextPhaseGeneration } from './phase-generation.mjs';
import { phaseNeedsGeneration } from './sequence.mjs';
import { phaseUsesDeterministicGeneration } from './manual-authorship.mjs';
import { safeCommandGuidance } from './safe-command-guidance.mjs';

export function phaseAuthoringProgress(workflow, phase, { draftEvidence = null } = {}) {
  if (!phase || phase.status !== 'in_progress' || workflow.currentPhase !== phase.id
      || !phaseNeedsGeneration(workflow, phase) || phaseUsesDeterministicGeneration(phase)) return null;
  const code = phaseRequiresCodeDelivery(phase);
  const generation = nextPhaseGeneration(phase);
  const open = code && phase.generationIntent?.status === 'open'
    && Number(phase.generationIntent.generation) === generation;
  let stage, argv, instruction;
  let skill = generationSkillForPhase(phase, workflow);
  if (code && phase.generationIntent?.status === 'consumed') {
    stage = 'review-successor'; argv = ['recover', workflow.workItem.id, '--phase', phase.id, '--json']; skill = '/sf-recover';
    instruction = 'Preserve the published generation and current edits. Review the guarded successor boundary before changing source.';
  } else if (code && !open) {
    stage = 'open-code-generation'; argv = ['phase', 'begin', phase.id, '--json'];
    instruction = 'Open the exact code generation before any application edit. Existing changes require the returned adoption review; never auto-confirm or discard them.';
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
export async function readPhaseDraftEvidence(root, definition, workflow, phase, { changedPaths = null } = {}) {
  if (!phase?.requiredArtifact?.path) return { draftExists: false, draftModified: false };
  const { phaseAuthoredReviewArtifacts } = await import('./publication-preflight.mjs');
  const review = await phaseAuthoredReviewArtifacts(root, definition, workflow, phase);
  const primary = review.artifacts.find(artifact => artifact.scope === 'primary');
  const baseline = phase.authoringBaseline;
  const changed = !baseline && primary?.exists
    ? (changedPaths ?? (await import('./git.mjs')).changedFiles(root)).includes(primary.path)
    : false;
  return { draftExists: Boolean(primary?.exists), draftModified: Boolean(primary?.exists
    && (changed || (baseline?.path === phase.requiredArtifact.path && baseline.fingerprint
    && primary.fingerprint !== baseline.fingerprint))) };
}
