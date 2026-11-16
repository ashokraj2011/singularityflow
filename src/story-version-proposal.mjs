/**
 * SPEC-OSA v1.1 §7.1: the scoped successor proposal and the plain-language question the person answers [OSA:REQ-030]. Pure:
 * the step's record in, `VersionOpeningProposal/v1`, its digest and its question out. Kept apart from the opening operation
 * (story-version-opening.mjs) so the entry, which only asks, loads none of the operation's code.
 */
import { recordSha256 } from './records.mjs';
import { SingularityFlowError } from './util.mjs';
import { versionNumbers } from './kernel/step-versions.mjs';
import { versionFactsOf } from './phase-generation-need.mjs';

const refuse = (message, code, details = {}) => new SingularityFlowError(message, { code, details });

export const OPENING_OPERATION = 'version-opening/v1';
export const PROPOSAL_SCHEMA = 'version-opening-proposal/v1';

/**
 * The plain-language question for a proposal, with its actual numbers [§7.1]: tests are named only when the published
 * version recorded them, and a Story with nothing published says what happened to an abandoned reservation.
 */
export function consentQuestion(proposal) {
  const purpose = proposal.reason === 'review-corrections' ? ' to fix the review\'s findings' : '';
  const kept = proposal.from?.published >= 1
    ? `Published version ${proposal.from.published}${proposal.evidence?.testsRecorded ? ' and its recorded tests' : ''} will stay unchanged.`
    : proposal.abandoned ? `No version was published; version ${proposal.abandoned} was reserved earlier and abandoned, so its number is not used again.`
      : 'Nothing was published yet.';
  return `Start version ${proposal.version} of ${proposal.step}${purpose}? ${kept}`;
}

/** The digest of a published version as its publication recorded it, or null. */
function publicationDigest(phase, published) {
  return published < 1 ? null : (phase.generationPublications ?? []).find((entry) => Number(entry.generation) === published)?.resultDigest ?? null;
}

/** Whether the published version recorded test executions (the question never promises tests that were not recorded). */
function testsRecorded(phase, published) {
  const evidence = phase.deliveryEvidence;
  return published >= 1 && Number(evidence?.generation ?? published) === published && Array.isArray(evidence?.testExecutions)
    && evidence.testExecutions.length > 0;
}

/**
 * `VersionOpeningProposal/v1` for `phase` as its record stands, and its digest [§7.1]: the exact version (the next free
 * number, or a legacy local opening's own), the high-watermark before it, the last publication and its digest, the reason,
 * the confirmation a preview showed, and the configuration and lifecycle revisions it expects. Pure.
 */
export function versionProposal(workflow, phase, { reason, confirmation = null, lifecycleRevision = null, adoption = null } = {}) {
  const facts = versionFactsOf(workflow, phase);
  const numbers = versionNumbers(facts);
  if (!numbers.ok) throw refuse(`${phase.id}'s version counters cannot be read, so no version is proposed.`, numbers.code, { phase: phase.id });
  const legacy = facts.opening?.record === 'legacy' && numbers.writing !== null;
  const version = legacy ? numbers.writing : numbers.proposedNext;
  if (version === null) throw refuse(`Version ${numbers.writing} of ${phase.id} is already open.`, 'VERSION_ALREADY_OPEN', { phase: phase.id, version: numbers.writing });
  const before = numbers.next - 1;
  const code = Boolean(phase.generationPolicy?.task === 'code' || phase.generationIntent);
  const proposal = { schema: PROPOSAL_SCHEMA, operation: OPENING_OPERATION, workId: workflow.workItem.id, phase: phase.id,
    step: String(phase.label ?? phase.id), kind: code ? 'code' : 'document', version, highWatermark: before,
    from: { published: numbers.published, publicationDigest: publicationDigest(phase, numbers.published) },
    abandoned: numbers.published === 0 && before > 0 ? before : null,
    reason: legacy ? 'legacy-promotion' : reason ?? (version === 1 ? 'initial' : 'watermark'),
    consent: version === 1 ? 'not-required' : 'required',
    evidence: { testsRecorded: testsRecorded(phase, numbers.published) },
    confirmation: confirmation ?? null, adoption: adoption ?? null,
    configurationRevision: workflow.resolution?.configSha256 ?? null, lifecycleRevision: lifecycleRevision ?? null };
  return { proposal, digest: `sha256:${recordSha256(proposal)}`, question: consentQuestion(proposal) };
}
