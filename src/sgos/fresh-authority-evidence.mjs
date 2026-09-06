/**
 * Read-only SGOS evidence reconstruction against freshly resolved authority.
 *
 * Portable Process Evidence remains a historical, repository-independent integrity bundle.  This
 * module deliberately does not upgrade that bundle.  It first verifies the exact local trace and
 * then creates a separate deterministic report which compares that trace with the currently
 * approved Program, Capability Pack, Story, and policy authority.
 */
import { canonicalJson } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import { sgosCapabilityPackAuthoritiesSha256 } from './capability-pack-authority.mjs';
import { SGOS_INSTALLED_LIMITS } from './limits.mjs';
import { compareSgosCodePoints } from './order.mjs';
import { inspectFreshSgosProcessPolicyAuthority } from './pinned-policy.mjs';
import {
  assertSgosProgramExecutionAdmission, loadApprovedSgosProgramAuthority
} from './program-trust.mjs';
import {
  compileSgosProcessEvidence, verifySgosProcessEvidence
} from './process-evidence.mjs';
import { sgosSha256 } from './evidence.mjs';
import { assertSgosStoryAuthority, loadSgosStoryAuthority } from './story-authority.mjs';

const FORMAT = 'sflow.sgos.fresh-authority-evidence/v1';
const MAXIMUM_BYTES = Math.min(2 * 1024 * 1024, SGOS_INSTALLED_LIMITS.maximumRecordBytes);
const UNAVAILABLE_CODES = new Set([
  'ENOENT', 'APPROVED_CONFIGURATION_INCOMPLETE',
  'SGOS_PROGRAM_AUTHORITY_UNAVAILABLE', 'SGOS_PROGRAM_AUTHORITY_REQUIRED',
  'SGOS_STORY_STATE_PATH_UNAVAILABLE', 'SGOS_STORY_STATE_ATTESTATION_UNAVAILABLE',
  'SGOS_POLICY_APPROVED_CONFIGURATION_REQUIRED', 'SGOS_POLICY_CONFIGURATION_PARTIAL'
]);

function fail(message, code = 'SGOS_FRESH_AUTHORITY_EVIDENCE_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function issue(code, subject, reference = null) {
  return Object.freeze({ code, subject, reference });
}

function issueIdentity(value) {
  return `${value.code}\u0000${value.subject}\u0000${value.reference ?? ''}`;
}

function canonicalIssues(values) {
  const unique = new Map(values.map((value) => [issueIdentity(value), value]));
  return Object.freeze([...unique.values()].sort((left, right) =>
    compareSgosCodePoints(issueIdentity(left), issueIdentity(right))));
}

function sourceIdentity(value) {
  return [
    value.kind, value.family ?? '', value.sha256 ?? '', value.ref ?? '', value.commit ?? '',
    value.path ?? '', value.blobSha256 ?? ''
  ].join('\u0000');
}

function canonicalSources(values) {
  const unique = new Map(values.map((value) => [sourceIdentity(value), Object.freeze(value)]));
  return Object.freeze([...unique.values()].sort((left, right) =>
    compareSgosCodePoints(sourceIdentity(left), sourceIdentity(right))));
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function comparableSafety(value) {
  const safety = clone(value);
  if (safety?.registry) safety.registry.verified = false;
  return safety;
}

function programAdmissionMatches(stored, current, program, process) {
  if (stored == null || current == null) return false;
  const method = stored.provenance?.method;
  const provenanceMatches = [
    'approved-program-authority', 'approved-authority+deterministic-recompilation'
  ].includes(method)
    && stored.provenance?.programSha256 === program.programSha256
    && stored.provenance?.ratificationSha256 === program.ratificationSha256
    && (method !== 'approved-authority+deterministic-recompilation'
      || (stored.provenance?.intentIrSha256 === program.intentIrSha256
        && stored.provenance?.workflowSha256 === program.workflowSha256))
    && canonicalJson(stored.provenance?.source ?? null)
      === canonicalJson(current.provenance?.source ?? null);
  return stored.admitted === true
    && stored.programId === program.programId
    && stored.programSha256 === program.programSha256
    && provenanceMatches
    && canonicalJson(comparableSafety(stored.safety))
      === canonicalJson(comparableSafety(current.safety))
    && canonicalJson(process.authorityBinding?.configurationAuthority ?? null)
      === canonicalJson(current.provenance?.source?.configurationAuthority ?? null);
}

function authorityFailure(error, subject, gaps, contradictions, sources) {
  const code = typeof error?.code === 'string' && error.code ? error.code : 'SGOS_AUTHORITY_CHECK_FAILED';
  const target = UNAVAILABLE_CODES.has(code) || /(?:UNAVAILABLE|NOT_FOUND)$/u.test(code)
    ? gaps : contradictions;
  target.push(issue(
    target === gaps ? 'fresh-authority-unavailable' : 'fresh-authority-contradiction',
    subject,
    code
  ));
  return Object.freeze({
    id: subject, status: target === gaps ? 'unavailable' : 'contradictory',
    sources: canonicalSources(sources)
  });
}

function exactTraceSources(bundle) {
  return canonicalSources([
    { kind: 'process-head', family: 'gvm-process', sha256: bundle.processSha256 },
    { kind: 'immutable-index-head', family: 'sgos-record-index', sha256: bundle.recordIndexSha256 },
    ...(bundle.controlEventSha256 == null ? [] : [{
      kind: 'immutable-control-head', family: 'sgos-control-event', sha256: bundle.controlEventSha256
    }]),
    ...bundle.records.map((entry) => ({
      kind: 'immutable-process-record', family: entry.family, sha256: entry.recordSha256
    }))
  ]);
}

function programSources(bundle, authority) {
  return canonicalSources([
    { kind: 'immutable-process-record', family: 'gvm-program', sha256: bundle.programSha256 },
    {
      kind: 'approved-configuration-blob', ref: authority.source.ref,
      commit: authority.source.commit, path: authority.source.path,
      blobSha256: authority.source.blobSha256
    },
    {
      kind: 'approved-workflow-blob', ref: authority.source.configurationAuthority.ref,
      commit: authority.source.configurationAuthority.commit,
      path: 'singularity/workflow.yml',
      blobSha256: authority.source.configurationAuthority.workflowBlobSha256
    }
  ]);
}

function storySources(bundle, authority) {
  return canonicalSources([
    {
      kind: 'immutable-process-record', family: 'process-binding',
      sha256: bundle.processBindingSha256
    },
    {
      kind: 'governed-story-blob', commit: authority.revision, path: authority.path,
      blobSha256: authority.blobSha256, sha256: authority.stateSha256
    }
  ]);
}

function policySources(bundle, inspection) {
  const status = inspection.authority;
  const fresh = inspection.configurationAuthority;
  return canonicalSources([
    {
      kind: 'immutable-process-record', family: 'process-binding',
      sha256: bundle.processBindingSha256
    },
    {
      kind: 'immutable-process-record', family: 'gvm-program', sha256: bundle.programSha256
    },
    ...(fresh?.ref && fresh?.commit ? [{
      kind: 'approved-configuration-ref', ref: fresh.ref, commit: fresh.commit
    }] : []),
    ...(inspection.current == null ? [] : [{
      kind: 'approved-policy-bundle', ref: fresh?.ref, commit: fresh?.commit,
      path: inspection.current.path, sha256: inspection.current.bundleSha256
    }]),
    ...(status?.amendmentSha256 ? [{
      kind: 'immutable-policy-amendment', family: 'sgos-policy-amendment-receipt',
      sha256: status.amendmentSha256
    }] : [])
  ]);
}

function bounded(report, maximumBytes) {
  const limit = maximumBytes ?? MAXIMUM_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_BYTES) {
    fail('Fresh-authority reconstruction maximumBytes must be a positive installed-bound integer.',
      'SGOS_FRESH_AUTHORITY_EVIDENCE_LIMIT_INVALID', {
        maximumInstalledBytes: MAXIMUM_BYTES, received: limit ?? null
      });
  }
  const actualBytes = Buffer.byteLength(canonicalJson(report), 'utf8');
  if (actualBytes > limit) {
    fail('Fresh-authority evidence reconstruction exceeds its installed bound.',
      'SGOS_FRESH_AUTHORITY_EVIDENCE_LIMIT', { maximumBytes: limit, actualBytes });
  }
  return actualBytes;
}

/**
 * Reconstruct current authority claims without mutating Process, repository, or authority state.
 * A counterfeit or non-canonical local trace is refused before any authority claim is evaluated.
 */
export async function reconstructSgosProcessEvidence(root, processId, options = {}) {
  const bundle = await compileSgosProcessEvidence(root, processId);
  const verification = verifySgosProcessEvidence(bundle);
  if (verification.integrity !== 'valid') {
    fail('Fresh-authority reconstruction refused invalid or non-canonical Process trace material.',
      'SGOS_FRESH_AUTHORITY_TRACE_INVALID', {
        processId, contradictions: verification.contradictions
      });
  }

  const gaps = [...verification.gaps];
  const contradictions = [];
  const claims = [Object.freeze({
    id: 'process-trace', status: 'verified', sources: exactTraceSources(bundle)
  })];

  try {
    const authority = await loadApprovedSgosProgramAuthority(root, bundle.program, {
      refreshAuthority: true
    });
    const admission = assertSgosProgramExecutionAdmission(bundle.program, { programAuthority: authority });
    const admissionMatches = programAdmissionMatches(
      bundle.process.authorityBinding?.executionAdmission ?? null,
      admission, bundle.program, bundle.process
    );
    if (!admissionMatches) {
      contradictions.push(issue('fresh-program-authority-stale', 'program-authority', bundle.programSha256));
    }
    const sources = programSources(bundle, authority);
    claims.push(Object.freeze({
      id: 'program-authority', status: admissionMatches ? 'verified' : 'stale',
      programSha256: bundle.programSha256,
      authorityRecordSha256: sgosSha256(authority.record), sources
    }));
    claims.push(Object.freeze({
      id: 'capability-pack-authority', status: 'verified',
      authoritiesSha256: sgosCapabilityPackAuthoritiesSha256(authority.capabilityPackAuthorities),
      packSha256: authority.capabilityPackAuthorities[0].packSha256,
      sources
    }));
  } catch (error) {
    const unavailableProgramSources = [{
      kind: 'immutable-process-record', family: 'gvm-program', sha256: bundle.programSha256
    }];
    claims.push(authorityFailure(
      error, 'program-authority', gaps, contradictions, unavailableProgramSources
    ));
    claims.push(Object.freeze({
      id: 'capability-pack-authority', status: 'unavailable',
      sources: canonicalSources(unavailableProgramSources)
    }));
    gaps.push(issue('fresh-authority-unavailable', 'capability-pack-authority', error?.code ?? null));
  }

  if (bundle.process.authorityBinding?.kind === 'story') {
    try {
      const observed = loadSgosStoryAuthority(root, {
        subjectId: bundle.process.authorityBinding.subjectId,
        revision: bundle.processBinding.baselineRevision
      }).authority;
      assertSgosStoryAuthority(bundle.processBinding.subjectAuthority, observed);
      assertSgosStoryAuthority(bundle.process.authorityBinding.subjectAuthority, observed);
      claims.push(Object.freeze({
        id: 'story-authority', status: 'verified', subjectId: observed.subjectId,
        sources: storySources(bundle, observed)
      }));
    } catch (error) {
      claims.push(authorityFailure(error, 'story-authority', gaps, contradictions, [{
        kind: 'immutable-process-record', family: 'process-binding',
        sha256: bundle.processBindingSha256
      }]));
    }
  } else {
    claims.push(Object.freeze({
      id: 'story-authority', status: 'not-applicable',
      sources: canonicalSources([{
        kind: 'immutable-process-record', family: 'process-binding',
        sha256: bundle.processBindingSha256
      }])
    }));
  }

  try {
    const inspection = await inspectFreshSgosProcessPolicyAuthority(root, {
      operation: 'evidence.reconstruct', processId: bundle.processId,
      process: bundle.process
    });
    const policy = inspection.authority;
    if (policy.status === 'unconfigured') {
      gaps.push(issue('fresh-policy-authority-unconfigured', 'policy-authority', bundle.process.policySnapshotSha256));
    }
    claims.push(Object.freeze({
      id: 'policy-authority',
      status: policy.status === 'unconfigured' ? 'unconfigured' : 'verified',
      policySnapshotSha256: bundle.process.policySnapshotSha256,
      activePolicySnapshotSha256: policy.activePolicySnapshotSha256 ?? null,
      sources: policySources(bundle, inspection)
    }));
  } catch (error) {
    claims.push(authorityFailure(error, 'policy-authority', gaps, contradictions, [{
      kind: 'immutable-process-record', family: 'gvm-program', sha256: bundle.programSha256
    }, {
      kind: 'immutable-process-record', family: 'process-binding',
      sha256: bundle.processBindingSha256
    }]));
  }

  const finalGaps = canonicalIssues(gaps);
  const finalContradictions = canonicalIssues(contradictions);
  const core = {
    format: FORMAT,
    processId: bundle.processId,
    processSha256: bundle.processSha256,
    bundleSha256: bundle.bundleSha256,
    status: finalContradictions.length ? 'failed' : finalGaps.length ? 'incomplete' : 'verified',
    freshAuthorityVerification: finalContradictions.length ? 'contradictory'
      : finalGaps.some((entry) => entry.code.startsWith('fresh-')) ? 'incomplete' : 'verified',
    claims: Object.freeze(claims),
    gaps: finalGaps,
    contradictions: finalContradictions
  };
  const reconstruction = Object.freeze({ ...core, reconstructionSha256: sgosSha256(core) });
  bounded(reconstruction, options.maximumBytes);
  return reconstruction;
}

export const SGOS_FRESH_AUTHORITY_EVIDENCE_FORMAT = FORMAT;
export const SGOS_FRESH_AUTHORITY_EVIDENCE_MAXIMUM_BYTES = MAXIMUM_BYTES;
