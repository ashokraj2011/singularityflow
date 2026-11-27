import { submitRoute } from './action-command-map.mjs';
/** Publication is not submission: a successor must collect its own observed/test evidence. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { exactFileAtObject } from './git.mjs';
import { publishedGenerationCommit } from './generation-publication-store.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { canonicalJson } from './records.mjs';
import { readRecord } from './schema-migrations.mjs';
import { phaseNeedsGeneration } from './sequence.mjs';
export { hasPublishedPhaseGeneration, requiresProspectivePhaseInspection, phaseInspectionGeneration } from './phase-generation-need.mjs';
import { secureRepositoryPath, SingularityFlowError } from './util.mjs';
import { storyLocation } from './story-paths.mjs';




const same = (left, right) => canonicalJson(left ?? null) === canonicalJson(right ?? null);
function stale(phase, message) {
  throw new SingularityFlowError(message, { code: 'SPECIFICATION_CLAIM_MAP_BINDING_STALE',
    details: { phase: phase.id, generation: phase.generation, owner: 'workflow-maintainer',
      recoveryCommand: `singularity-flow recover --phase ${phase.id} --json` } });
}
function committedJson(root, commit, relative) {
  const bytes = exactFileAtObject(root, commit, relative, { maximumBytes: 16 * 1024 * 1024, regularOnly: true });
  if (!bytes) throw new SingularityFlowError(`Required published evidence is unavailable: ${relative}.`, {
    code: 'GENERATION_PUBLICATION_INVALID'
  });
  return JSON.parse(bytes.toString('utf8'));
}
async function unchangedRecord(root, commit, relative, phase, records = root) {
  const stored = committedJson(root, commit, relative);
  // The current copy is in the Story's records: the state checkout for a state-ref Story [SSB M3].
  const boundary = await secureRepositoryPath(records, relative, { label: 'Published submission evidence', mustExist: true, type: 'file' });
  const current = JSON.parse(await readFile(boundary.absolute, 'utf8'));
  if (!same(stored, current)) stale(phase, `Published submission evidence changed: ${relative}. Preserve and inspect its exact committed bytes.`);
  return current;
}

/**
 * Authenticate the narrow pre-submission state, including publications from the old rollover
 * writer that retained a prior generation's live pointer. That pointer is history, never proof.
 * Changed/current/future claim bindings are not waived. This function does not write or run tests.
 */
export async function pendingCodeSubmissionEvidence(root, config, workflow, phase) {
  if (workflow.status !== 'in_progress' || !phaseRequiresCodeDelivery(phase)
      || phase.status !== 'in_progress' || phase.id !== workflow.currentPhase || phaseNeedsGeneration(workflow, phase)
      || phase.generationIntent?.status !== 'consumed'
      || Number(phase.generationIntent.generation) !== Number(phase.generation)
      || phase.deliveryEvidence?.status !== 'pending-tests'
      || Number(phase.deliveryEvidence.generation) !== Number(phase.generation)) return null;
  const pointer = phase.claimMaps?.observed;
  if (pointer && Number(pointer.generation) >= Number(phase.generation)) {
    stale(phase, 'A current or future observed claim map cannot replace pending submission tests.');
  }
  const commit = publishedGenerationCommit(root, workflow, phase);
  if (!commit) throw new SingularityFlowError('The current generation has no authenticated publication.', {
    code: 'GENERATION_PUBLICATION_MISSING'
  });
  // The Story's records at its lifecycle commit: at a state commit's root for a state-ref Story [SSB M3].
  const location = storyLocation(root, [config, workflow], workflow.workItem.id);
  const stored = committedJson(root, commit, location.record('workflow.json')).phases?.[phase.id];
  if (!stored || Number(stored.generation) !== Number(phase.generation)
      || !same(stored.generationIntent, phase.generationIntent)
      || !same(stored.claimMaps?.observed, pointer)
      || !same(stored.generationCommit, phase.generationCommit)
      || !same(stored.publicationCommit, phase.publicationCommit)) {
    stale(phase, `Phase '${phase.id}' pending submission binding differs from its authenticated publication.`);
  }
  for (const key of ['generation', 'status', 'receiptPath', 'changeSetPath', 'sourceTreeSha256', 'testInputSha256']) {
    if (!same(stored.deliveryEvidence?.[key], phase.deliveryEvidence[key])) {
      stale(phase, `Phase '${phase.id}' pending delivery binding changed after publication.`);
    }
  }
  const receipt = await unchangedRecord(root, commit, phase.deliveryEvidence.receiptPath, phase, location.recordsRoot);
  readRecord('code-delivery', receipt);
  if (receipt.workId !== workflow.workItem.id || receipt.phase !== phase.id
      || Number(receipt.generation) !== Number(phase.generation) || receipt.status !== 'pending-tests'
      || (receipt.testExecutions ?? []).length) stale(phase, 'Pending submission requires this generation\'s unvalidated delivery receipt.');
  if (pointer) {
    const expected = location.record('context', 'claims', `${phase.id}-gen${pointer.generation}-observed.json`);
    if (pointer.path !== expected || !Number.isSafeInteger(Number(pointer.generation)) || Number(pointer.generation) < 1) {
      stale(phase, 'Historical observed claim binding does not name an exact earlier generation.');
    }
    const old = await unchangedRecord(root, commit, pointer.path, phase, location.recordsRoot);
    const digest = createHash('sha256').update(canonicalJson(old)).digest('hex');
    readRecord('specification-claim-map', old);
    if (old.kind !== 'observed' || old.workId !== workflow.workItem.id || old.phase !== phase.id
        || Number(old.generation) !== Number(pointer.generation) || digest !== pointer.sha256) {
      stale(phase, 'Historical observed claim binding failed its retained identity/hash check.');
    }
  }
  return { status: 'pending-submission-evidence', generation: Number(phase.generation), evidenceCommit: commit,
    historicalObservedGeneration: pointer ? Number(pointer.generation) : null,
    next: submitRoute(workflow, phase).command,
    skill: '/sf-submit', testsWaived: false, phaseApproved: false };
}
