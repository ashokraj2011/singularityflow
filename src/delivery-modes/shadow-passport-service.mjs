/**
 * State-aware adapter for the pure GDP shadow Passport builder.
 *
 * Repository discovery and legacy reads live here so both `change` and `proof` commands use the
 * same Candidate, policy, recovery, and provenance selection. The builders remain filesystem-free.
 */
import { readAutoFlightState } from '../auto/auto-flight-store.mjs';
import { recordSha256 } from '../records.mjs';
import { buildRepositorySubjectIndex, resolveContext } from '../repository-subject-index.mjs';
import { loadStoryAggregate, storyPublicationPending } from '../state-stores.mjs';
import { projectLegacyGdpCompatibility } from './compatibility-projection.mjs';
import { buildShadowChangePassport } from './shadow-passport.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RAW_DIGEST = /^[a-f0-9]{64}$/;

export function prefixedDigest(value) {
  const source = String(value ?? '');
  if (DIGEST.test(source)) return source;
  if (RAW_DIGEST.test(source)) return `sha256:${source}`;
  return null;
}

function findCandidate(workflow, autoFlight) {
  if (prefixedDigest(autoFlight?.candidate?.candidateSha256)) return autoFlight.candidate;
  for (const phaseId of [...(workflow.phaseOrder ?? [])].reverse()) {
    const delivery = workflow.phases?.[phaseId]?.deliveryEvidence;
    for (const value of [delivery?.autoCandidate, delivery?.codeDelivery?.autoCandidate]) {
      if (prefixedDigest(value?.candidateSha256)) return value;
    }
  }
  for (const value of [workflow.candidate, workflow.codeDelivery?.candidate]) {
    if (prefixedDigest(value?.candidateSha256)) return value;
  }
  return null;
}

function digestRefs(value, keyPattern, output = new Set(), depth = 0) {
  if (depth > 10 || output.size >= 256 || value == null || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    if (keyPattern.test(key)) {
      const exact = prefixedDigest(child);
      if (exact) output.add(exact);
    }
    if (child && typeof child === 'object') digestRefs(child, keyPattern, output, depth + 1);
  }
  return output;
}

export async function resolveShadowPassportDiagnostic(root, definition, requested, {
  proofProfile = 'standard'
} = {}) {
  const selected = resolveContext(await buildRepositorySubjectIndex(root), {
    reference: requested,
    kind: 'story',
    required: true
  });
  const workflow = await loadStoryAggregate(root, definition, selected.id);
  const autoFlight = workflow.executionOrigin?.flightId
    ? await readAutoFlightState(root, workflow.executionOrigin.flightId).catch((error) => {
      if (error?.code === 'AUTO_FLIGHT_NOT_FOUND') return null;
      throw error;
    })
    : null;
  const candidate = findCandidate(workflow, autoFlight);
  const projectedWorkflow = {
    ...workflow,
    ...(candidate ? { candidate: {
      ...candidate, candidateSha256: prefixedDigest(candidate.candidateSha256)
    } } : {}),
    ...(workflow.worldModelReference == null && autoFlight?.worldModelReference
      ? { worldModelReference: autoFlight.worldModelReference } : {})
  };
  const pending = await storyPublicationPending(root, definition, workflow.workItem.id, {
    migrate: false
  });
  const compatibility = projectLegacyGdpCompatibility({
    sourceKind: 'workflow-story',
    record: projectedWorkflow,
    recovery: pending ? { status: 'recovery-required' } : null
  });
  const sourcePolicySha256 = prefixedDigest(workflow.resolution?.policySha256)
    ?? compatibility.projectionSha256;
  const decisionRefs = [...digestRefs(workflow.phases, /(?:approval|decision).*Sha256$/iu)];
  // A test/evidence receipt is not publication authority. Only explicitly named publication
  // digests belong in the Passport publication reference set.
  const publicationRefs = [...digestRefs(workflow.phases, /publication.*Sha256$/iu)];
  return {
    workflow,
    diagnostic: buildShadowChangePassport({
      compatibility,
      sourcePolicySha256,
      sourceRecordSha256: `sha256:${recordSha256(compatibility)}`,
      proofProfile,
      decisionRefs,
      publicationRefs
    })
  };
}
