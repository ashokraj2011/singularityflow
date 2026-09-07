/**
 * Deterministic, observe-only brownfield adoption projections.
 *
 * This module deliberately describes only the exact changed area. It never scans an entire
 * repository, invents historical cause, upgrades a proposal into authority, or participates in a
 * lifecycle gate. Durable cause authority remains a separate CMP P2 concern.
 */
import { recordSha256 } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import {
  CMP_CAUSE_KINDS, validateChangeRegionManifest
} from './contracts.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const GIT_COMMIT = /^[a-f0-9]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/u;
const MAXIMUM_BACKFILL_ENTRIES = 500;
const MAXIMUM_REFERENCES = 32;

export const CMP_BROWNFIELD_TOUCH_CLASSES = Object.freeze([
  'new-region', 'legacy-touched', 'mechanical-move-candidate'
]);

export const CMP_HISTORICAL_ASSURANCE = Object.freeze([
  'historically-confirmed', 'historically-inferred', 'unknown'
]);

export const CMP_HISTORICAL_EVIDENCE_KINDS = Object.freeze([
  'git-commit', 'issue', 'document', 'approval-decision'
]);

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeDeep(child);
  return value;
}

function canonicalSha256(value) {
  return `sha256:${recordSha256(value)}`;
}

function without(value, ...keys) {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

function exactKeys(value, keys) {
  return plain(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function normalizedPath(value, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  const candidate = String(value ?? '');
  if (!candidate || candidate.includes('\\') || candidate.includes('\0')
      || candidate.startsWith('/') || /^[A-Za-z]:/u.test(candidate)) return null;
  const parts = candidate.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return parts.join('/');
}

function withinScope(candidate, scope) {
  if (scope.kind === 'repository') return true;
  return candidate === scope.path || candidate.startsWith(`${scope.path}/`);
}

function exactMechanicalMove(region) {
  const location = region.location ?? {};
  return region.operation === 'renamed'
    && normalizedPath(location.pathBefore) !== normalizedPath(location.pathAfter)
    && /^[a-f0-9]{40}$/u.test(String(location.gitObjectBefore ?? ''))
    && location.gitObjectBefore === location.gitObjectAfter
    && location.modeBefore === location.modeAfter;
}

/**
 * Classify only exact changed regions under the incremental brownfield policy.
 *
 * An exact object-preserving rename is merely eligible for a mechanical-move decision. It still
 * requires a reviewed transformation receipt; this projection never grants that exception.
 */
export function buildBrownfieldTouchedAreaAssessment(manifest) {
  const checked = validateChangeRegionManifest(manifest);
  if (!checked.valid) {
    throw new SingularityFlowError(
      'Brownfield touched-area assessment requires one exact current change-region manifest.',
      { code: 'CMP_BROWNFIELD_MANIFEST_INVALID', details: { failures: checked.failures } }
    );
  }
  const regions = manifest.regions.map((region) => {
    const added = region.location?.pathBefore == null;
    const mechanical = !added && exactMechanicalMove(region);
    const touchClass = added ? 'new-region'
      : mechanical ? 'mechanical-move-candidate' : 'legacy-touched';
    return {
      regionId: region.regionId,
      regionSha256: region.regionSha256,
      operation: region.operation,
      pathBefore: region.location?.pathBefore ?? null,
      pathAfter: region.location?.pathAfter ?? null,
      origin: added ? 'new' : 'legacy',
      touchClass,
      priorLegacyLabel: added ? null : 'legacy-unexplained',
      requirement: mechanical
        ? 'transformation-receipt-required'
        : 'current-governed-cause-required',
      legacyStatusRetained: false
    };
  });
  const counts = Object.fromEntries(CMP_BROWNFIELD_TOUCH_CLASSES.map((kind) => [
    kind, regions.filter((region) => region.touchClass === kind).length
  ]));
  const core = {
    schemaVersion: 1, // schema-transient: read-only brownfield projection
    kind: 'comprehension-brownfield-touched-area',
    mode: 'observe-only',
    authoritative: false,
    lifecycleGate: false,
    candidateSha256: manifest.compatibilityCandidateSha256,
    manifestSha256: manifest.manifestSha256,
    policy: {
      profile: 'incremental-touched-area-v1',
      fullRepositoryBackfillRequired: false,
      untouchedLegacyLabel: 'legacy-unexplained',
      changedLegacyMayRemainUntouched: false
    },
    regions,
    counts: { regions: regions.length, ...counts }
  };
  return freezeDeep({ ...core, assessmentSha256: canonicalSha256(core) });
}

function validateCauseReference(reference, label, failures) {
  if (!exactKeys(reference, ['causeKind', 'causeId', 'recordSha256'])
      || !CMP_CAUSE_KINDS.includes(reference.causeKind)
      || !SAFE_ID.test(String(reference.causeId ?? ''))
      || /(?:todo|tbd|placeholder|unknown|example|sample)/iu.test(reference.causeId)
      || !SHA256.test(String(reference.recordSha256 ?? ''))) {
    failures.push({ code: 'CMP_BACKFILL_REFERENCE_INVALID', message: `${label} has an invalid cause reference.` });
    return false;
  }
  return true;
}

function validateEvidenceReference(reference, label, failures) {
  if (!exactKeys(reference, ['kind', 'id', 'recordSha256'])
      || !CMP_HISTORICAL_EVIDENCE_KINDS.includes(reference.kind)
      || !SAFE_ID.test(String(reference.id ?? ''))
      || !SHA256.test(String(reference.recordSha256 ?? ''))) {
    failures.push({ code: 'CMP_BACKFILL_REFERENCE_INVALID', message: `${label} has an invalid bounded evidence reference.` });
    return false;
  }
  return true;
}

function validateBackfillEntry(entry, index, scope, seen, failures) {
  const label = `Backfill entry ${index + 1}`;
  if (!exactKeys(entry, [
    'path', 'assurance', 'causeRefs', 'evidenceRefs', 'decisionSha256', 'entrySha256'
  ])) {
    failures.push({ code: 'CMP_BACKFILL_SCHEMA_INVALID', message: `${label} has an invalid field set.` });
    return;
  }
  const candidatePath = normalizedPath(entry.path);
  if (!candidatePath || !withinScope(candidatePath, scope)) {
    failures.push({ code: 'CMP_BACKFILL_SCOPE_INVALID', message: `${label} is outside its exact repository-relative scope.` });
  } else if (seen.has(candidatePath)) {
    failures.push({ code: 'CMP_BACKFILL_SCOPE_INVALID', message: `${label} duplicates path '${candidatePath}'.` });
  } else seen.add(candidatePath);
  if (!CMP_HISTORICAL_ASSURANCE.includes(entry.assurance)) {
    failures.push({ code: 'CMP_BACKFILL_ASSURANCE_INVALID', message: `${label} declares an unknown historical assurance.` });
  }
  if (!Array.isArray(entry.causeRefs) || entry.causeRefs.length > MAXIMUM_REFERENCES
      || !Array.isArray(entry.evidenceRefs) || entry.evidenceRefs.length > MAXIMUM_REFERENCES) {
    failures.push({ code: 'CMP_BACKFILL_LIMIT', message: `${label} exceeds the bounded reference ceiling.` });
    return;
  }
  entry.causeRefs.forEach((reference) => validateCauseReference(reference, label, failures));
  entry.evidenceRefs.forEach((reference) => validateEvidenceReference(reference, label, failures));
  if (entry.assurance === 'historically-confirmed') {
    const approval = entry.evidenceRefs.find((reference) => reference.kind === 'approval-decision'
      && reference.recordSha256 === entry.decisionSha256);
    if (!entry.causeRefs.length || !entry.evidenceRefs.length
        || !SHA256.test(String(entry.decisionSha256 ?? '')) || !approval) {
      failures.push({
        code: 'CMP_BACKFILL_ASSURANCE_INVALID',
        message: `${label} cannot claim historically-confirmed without a cause and exact approval-decision reference.`
      });
    }
  } else if (entry.assurance === 'historically-inferred') {
    if (!entry.causeRefs.length || !entry.evidenceRefs.length || entry.decisionSha256 !== null) {
      failures.push({
        code: 'CMP_BACKFILL_ASSURANCE_INVALID',
        message: `${label} must retain inference without a human decision digest.`
      });
    }
  } else if (entry.assurance === 'unknown'
      && (entry.causeRefs.length !== 0 || entry.decisionSha256 !== null)) {
    failures.push({
      code: 'CMP_BACKFILL_ASSURANCE_INVALID',
      message: `${label} labelled unknown cannot carry a cause or decision.`
    });
  }
  if (entry.entrySha256 !== canonicalSha256(without(entry, 'entrySha256'))) {
    failures.push({ code: 'CMP_BACKFILL_INTEGRITY_INVALID', message: `${label} failed its content-integrity check.` });
  }
}

/** Validate a bounded historical proposal without turning its labels into governed authority. */
export function validateHistoricalBackfillProposal(proposal, { sourceRevision = null } = {}) {
  const failures = [];
  if (!exactKeys(proposal, [
    'schemaVersion', 'kind', 'sourceRevision', 'scope', 'entries', 'proposalSha256'
  ]) || proposal.schemaVersion !== 1 // schema-transient: untrusted proposal input, never persisted or authorized
      || proposal.kind !== 'comprehension-historical-backfill-proposal') {
    failures.push({ code: 'CMP_BACKFILL_SCHEMA_INVALID', message: 'Historical backfill proposal has an invalid schema, kind, or field set.' });
  }
  if (!GIT_COMMIT.test(String(proposal?.sourceRevision ?? ''))
      || (sourceRevision != null && proposal?.sourceRevision !== sourceRevision)) {
    failures.push({ code: 'CMP_BACKFILL_SOURCE_STALE', message: 'Historical backfill proposal is not bound to the selected exact source revision.' });
  }
  let scope = null;
  if (exactKeys(proposal?.scope, ['kind', 'path'])
      && ['repository', 'module'].includes(proposal.scope.kind)) {
    const scopePath = normalizedPath(proposal.scope.path, { nullable: true });
    if ((proposal.scope.kind === 'repository' && proposal.scope.path === null)
        || (proposal.scope.kind === 'module' && scopePath)) {
      scope = { kind: proposal.scope.kind, path: scopePath };
    }
  }
  if (!scope) failures.push({ code: 'CMP_BACKFILL_SCOPE_INVALID', message: 'Historical backfill scope must be the repository or one normalized module path.' });
  if (!Array.isArray(proposal?.entries) || proposal.entries.length > MAXIMUM_BACKFILL_ENTRIES) {
    failures.push({ code: 'CMP_BACKFILL_LIMIT', message: `Historical backfill exceeds the ${MAXIMUM_BACKFILL_ENTRIES}-entry ceiling.` });
  } else if (scope) {
    const seen = new Set();
    proposal.entries.forEach((entry, index) => validateBackfillEntry(entry, index, scope, seen, failures));
    const paths = proposal.entries.map((entry) => entry?.path);
    if (JSON.stringify(paths) !== JSON.stringify([...paths].sort())) {
      failures.push({ code: 'CMP_BACKFILL_SCHEMA_INVALID', message: 'Historical backfill entries are not in canonical path order.' });
    }
  }
  if (plain(proposal)
      && proposal.proposalSha256 !== canonicalSha256(without(proposal, 'proposalSha256'))) {
    failures.push({ code: 'CMP_BACKFILL_INTEGRITY_INVALID', message: 'Historical backfill proposal failed its content-integrity check.' });
  }
  const entries = Array.isArray(proposal?.entries) ? proposal.entries : [];
  const counts = Object.fromEntries(CMP_HISTORICAL_ASSURANCE.map((assurance) => [
    assurance, entries.filter((entry) => entry?.assurance === assurance).length
  ]));
  const uniqueFailures = [...new Map(failures.map((failure) => [
    `${failure.code}\0${failure.message}`, failure
  ])).values()].sort((left, right) => left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message));
  const core = {
    schemaVersion: 1, // schema-transient: validation of untrusted historical proposal
    kind: 'comprehension-historical-backfill-validation',
    mode: 'observe-only',
    valid: uniqueFailures.length === 0,
    authoritative: false,
    lifecycleGate: false,
    proposalSha256: SHA256.test(String(proposal?.proposalSha256 ?? ''))
      ? proposal.proposalSha256 : null,
    sourceRevision: GIT_COMMIT.test(String(proposal?.sourceRevision ?? ''))
      ? proposal.sourceRevision : null,
    scope,
    counts: { entries: entries.length, ...counts },
    failures: uniqueFailures,
    notices: [
      'No full-repository backfill is required for new work.',
      'Historical labels remain untrusted proposals until the existing governed review authority accepts them.',
      'Historically inferred and unknown entries never become confirmed through validation.'
    ]
  };
  return freezeDeep({ ...core, validationSha256: canonicalSha256(core) });
}

export function sealHistoricalBackfillEntry(value) {
  return freezeDeep({ ...value, entrySha256: canonicalSha256(value) });
}

export function sealHistoricalBackfillProposal(value) {
  return freezeDeep({ ...value, proposalSha256: canonicalSha256(value) });
}
