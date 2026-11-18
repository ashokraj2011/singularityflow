/**
 * A version SFlow opened to fix its own review's findings, when every blocking one is about tests or evidence
 * [owner, 2026-11-18]. Such a version carries the published version's exact source, as a reviewer's return asking only for
 * tests does (delivery-evidence.mjs), and the gate runs its tests again, so that run, or the test change, answers the
 * finding. Before, only a person's rejection counted: a version opened on the person's yes to "fix the review's findings"
 * was refused as having no product source and sent to an appeal, a read-only preflight and the doctor (Story
 * new-ash-graph). It is read from the Story as it stands, so a version already open in that state is admitted as it is.
 */
import { stepDecisionOf } from './step-decision.mjs';

// About the tests, or about an evidence file the reviewer inspected (an attestation, no line): no product source is asked.
const testOrEvidenceFinding = (entry) => entry?.check === 'tests'
  || (entry?.check === 'plan' && typeof entry.attestation === 'string' && entry.attestation.trim() !== '' && entry.line == null);

/** `{ priorGeneration, priorReceiptSha256, findingIds }` for such a version, or null. */
export async function testOnlyReviewCorrection(root, config, workflow, phase) {
  const evidence = phase?.deliveryEvidence;
  const opening = phase?.versionOpening;
  // The kernel's answer: a version is published, and the one being written is the one this opening opened [OSA:REQ-001].
  const version = opening?.reason === 'review-corrections' ? stepDecisionOf(workflow, phase)?.version : null;
  if (!(Number(version?.published) > 0) || version.writing == null || Number(version.writing) !== Number(opening.version)
      || !(evidence?.sourcePaths ?? []).length || !Array.isArray(evidence.paths)) return null;
  const report = await (await import('./source-review-lifecycle.mjs')).retainedReviewReport(root, config, workflow, phase.id).catch(() => null);
  const blocking = (Array.isArray(report?.findings) ? report.findings : [])
    .filter((entry) => entry?.severity === 'blocking' && (!entry.ownerPhase || entry.ownerPhase === phase.id));
  if (!blocking.length || !blocking.every(testOrEvidenceFinding)) return null;
  return { priorGeneration: Number(version.published), priorReceiptSha256: evidence.receiptSha256 ?? null,
    findingIds: blocking.map((entry) => String(entry.id)).slice(0, 20) };
}
