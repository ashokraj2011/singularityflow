/** Exact REV reference projection for an existing retained SGOS candidate. */
import { recordSha256 } from '../records.mjs';
import { readSgosRetainedCandidate } from '../sgos/candidate-lifecycle.mjs';
import { SingularityFlowError } from '../util.mjs';

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function hash(value) { return `sha256:${recordSha256(value)}`; }

function referenceFromRetained(retained) {
  const { candidate, repository } = retained;
  if (!['human', 'agent', 'service'].includes(candidate.createdBy?.kind)
      || !repository.retainedRef?.startsWith('refs/singularity-flow/candidates/')
      || repository.retainedRef.split('/').at(-1) !== candidate.candidateId) {
    fail('REV_PARENT_CANDIDATE_INVALID', 'Retained SGOS candidate does not have a REV-compatible creator or namespace.');
  }
  return Object.freeze({
    family: 'sgos-candidate', namespace: repository.retainedRef,
    candidateId: candidate.candidateId,
    retainedRecordSha256: retained.retainedCandidateSha256,
    candidateSha256: candidate.candidateSha256,
    repository: {
      baselineCommit: repository.baselineCommit,
      candidateTree: repository.candidateTree,
      objectFormat: repository.candidateTree.length === 64 ? 'sha256' : 'sha1'
    },
    sourceManifestSha256: candidate.candidate.manifestSha256,
    effectSetSha256: hash({ kind: 'revision-candidate-effect-set', resources: candidate.resources }),
    createdBy: { kind: candidate.createdBy.kind, id: candidate.createdBy.id }
  });
}

export async function sgosRevisionCandidateReference(root, candidateId) {
  return referenceFromRetained(await readSgosRetainedCandidate(root, candidateId));
}

export async function verifySgosRevisionCandidateReference(root, expected, {
  subjectId = null
} = {}) {
  if (!expected || expected.family !== 'sgos-candidate') return false;
  const retained = await readSgosRetainedCandidate(root, expected.candidateId);
  if (subjectId != null && retained.candidate.subject.id !== subjectId) return false;
  return hash(expected) === hash(referenceFromRetained(retained));
}
