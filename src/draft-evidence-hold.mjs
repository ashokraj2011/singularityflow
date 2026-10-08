/** Pending evidence can be preserved while its phase draft is repaired; it is not owned proof. */
import { createHash } from 'node:crypto';
import { requiresProspectivePhaseInspection, phaseInspectionGeneration } from './code-submission-evidence.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { verifyOpenGenerationIntent } from './generation-boundary.mjs';
import { assertApprovedDocumentsIntact, correctionOwner, evidenceContractRecoveryActions } from './phase-evidence-amendment.mjs';
import { readRepositoryManifest } from './repository-manifest.mjs';
import { assertNoHiddenWorktreeChanges } from './worktree-fingerprint.mjs';
import { EvidenceAmendmentSchema } from './plan-evidence-amendments.mjs';
import { inspectLifecycleWorktree } from './lifecycle-worktree.mjs';
import { expectedPhaseEvidencePaths } from './recovery-preparation-context.mjs';

export async function inspectDraftEvidenceHold(root, config, workflow, phase, {
  unexpectedPaths, expectedPaths, inspection, simpleStatus
}) {
  if (!simpleStatus || !unexpectedPaths.length || unexpectedPaths.length > 64
      || phase?.id !== workflow.currentPhase || workflow.status !== 'in_progress'
      || !requiresProspectivePhaseInspection(workflow, phase) || !correctionOwner(workflow, phase)) return null;
  const prefix = `${config.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}/evidence/`;
  const guards = [...(config.governance?.protectedPaths ?? []),
    ...(workflow.resolution?.capability?.policy?.protectedPaths ?? [])];
  const untracked = new Set(inspection.entries.filter(entry => entry.type === 'untracked'
    && entry.path.kind === 'utf8').map(entry => entry.path.value));
  if (unexpectedPaths.some(relative => !relative.startsWith(prefix) || !untracked.has(relative)
      || !EvidenceAmendmentSchema.shape.path.safeParse(relative).success
      || guards.some(guard => relative.toLowerCase() === String(guard).toLowerCase()
        || relative.toLowerCase().startsWith(`${String(guard).replace(/\/$/u, '').toLowerCase()}/`)))) return null;
  try {
    assertNoHiddenWorktreeChanges(root, 'Draft evidence preservation');
    if (phaseRequiresCodeDelivery(phase)) {
      const intent = await verifyOpenGenerationIntent(root, workflow, phase);
      if (!intent || intent.status !== 'open') return null;
    }
    await assertApprovedDocumentsIntact(root, config, workflow, phase);
    const heldEvidence = [];
    let total = 0;
    for (const relative of unexpectedPaths) {
      const captured = await readRepositoryManifest(root, relative, { maxBytes: 16 * 1024 * 1024 });
      total += captured.bytes.length;
      if (captured.links?.length || total > 32 * 1024 * 1024) return null;
      heldEvidence.push({ path: relative, size: captured.bytes.length,
        sha256: createHash('sha256').update(captured.bytes).digest('hex') });
    }
    return { allowed: true, status: 'draft-only', phaseId: phase.id,
      generation: phaseInspectionGeneration(workflow, phase), expectedDraftPaths: expectedPaths,
      heldEvidence, publicationReviewRequired: true, testsWaived: false, evidenceAccepted: false,
      detail: 'Continue only the current phase\'s verified source/artifact draft. Preserve these exact untracked evidence files and the index; do not edit, execute, stage, delete or treat them as passing proof. Their contract/authority review remains required before publication.' };
  } catch (error) {
    return { allowed: false, status: 'review-required', code: error.code ?? 'DRAFT_EVIDENCE_UNVERIFIED',
      detail: error.message };
  }
}

/** Fresh publication inspection: a draft-only hold never changes the approved ownership roster. */
export async function inspectPendingEvidenceContracts(root, config, workflow, phase, {
  generation = phaseInspectionGeneration(workflow, phase)
} = {}) {
  if (!correctionOwner(workflow, phase) || !requiresProspectivePhaseInspection(workflow, phase)) return { paths: [], actions: [] };
  const itemRoot = `${config.workItemRoot ?? 'singularity/work-items'}/${workflow.workItem.id}`;
  const candidates = inspectLifecycleWorktree(root, config, workflow).entries
    .filter(entry => entry.path.kind === 'utf8' && entry.path.value.startsWith(`${itemRoot}/evidence/`))
    .map(entry => entry.path.value);
  if (!candidates.length) return { paths: [], actions: [] };
  const expected = new Set(await expectedPhaseEvidencePaths(root, config, workflow, phase, {
    itemRoot, generation, changedPaths: candidates
  }));
  const paths = candidates.filter(relative => !expected.has(relative));
  return { paths, actions: paths.length
    ? await evidenceContractRecoveryActions(root, config, workflow, phase, { unexpectedPaths: paths }) : [] };
}
