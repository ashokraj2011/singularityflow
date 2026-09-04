/** GDP-M9 local hermetic proof evaluator. It evaluates digest-only evidence and executes no product code. */
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_ITEMS = 1024;
const FAMILIES = Object.freeze({
  'executable-change-map': ['changeMapSha256', [
    'schemaVersion', 'kind', 'workId', 'proofSubjectSha256', 'candidateSha256',
    'regions', 'profile', 'changeMapSha256'
  ]],
  'changed-region-coverage': ['coverageSha256', [
    'schemaVersion', 'kind', 'workId', 'proofSubjectSha256', 'changeMapSha256',
    'requiredRegionRefs', 'coveredRegionRefs', 'uncoveredRegionRefs', 'failedRegionRefs',
    'status', 'executionRefs', 'coverageSha256'
  ]],
  'witness-independence': ['independenceSha256', [
    'schemaVersion', 'kind', 'workId', 'proofSubjectSha256', 'witnessRefs',
    'independentRefs', 'conflictingRefs', 'status', 'independenceSha256'
  ]],
  'mutation-observation': ['observationSha256', [
    'schemaVersion', 'kind', 'workId', 'proofSubjectSha256', 'mutationIdSha256',
    'targetRegionSha256', 'resultSha256', 'outcome', 'authority', 'gateEligible',
    'observationSha256'
  ]],
  'proof-gap-acceptance': ['acceptanceSha256', [
    'schemaVersion', 'kind', 'workId', 'proofSubjectSha256', 'gapSha256',
    'decision', 'reasonSha256', 'decidedBy', 'expiresAt', 'acceptanceSha256'
  ]]
});

function fail(message, code = 'PFC_HIGH_ASSURANCE_INPUT_INVALID') {
  const error = new TypeError(`GDP high assurance: ${message}`); error.code = code; throw error;
}
function digest(value) { return `sha256:${recordSha256(value)}`; }
function exact(value, label) {
  if (!DIGEST.test(String(value ?? ''))) fail(`${label} must be a sha256 digest.`);
  return String(value);
}
function text(value, label, maximum = 160) {
  const result = String(value ?? '');
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/u.test(result)) fail(`${label} is invalid.`);
  return result;
}
function exactKeys(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...fields].sort())) {
    fail(`${label} has an invalid field set.`);
  }
}
function bounded(values, normalize, label) {
  if (!Array.isArray(values) || values.length > MAX_ITEMS) fail(`${label} exceeds ${MAX_ITEMS} entries.`);
  const result = values.map(normalize);
  if (new Set(result.map(canonicalJson)).size !== result.length) fail(`${label} contains duplicates.`);
  return result.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}
function seal(family, fields) {
  const [hashField] = FAMILIES[family];
  const core = { schemaVersion: currentSchemaVersion(family), kind: family, ...fields };
  return Object.freeze({ ...core, [hashField]: digest(core) });
}

function region(value, index) {
  exactKeys(value, ['resourceIdSha256', 'regionSha256', 'executable', 'required'], `regions[${index}]`);
  if (typeof value.executable !== 'boolean' || typeof value.required !== 'boolean') fail('region flags must be boolean.');
  return {
    resourceIdSha256: exact(value.resourceIdSha256, 'resourceIdSha256'),
    regionSha256: exact(value.regionSha256, 'regionSha256'),
    executable: value.executable, required: value.required
  };
}
function execution(value, index) {
  exactKeys(value, ['regionSha256', 'testIdentitySha256', 'resultSha256', 'outcome'], `executions[${index}]`);
  if (!['passed', 'failed', 'skipped', 'unavailable'].includes(value.outcome)) fail('execution outcome is invalid.');
  return {
    regionSha256: exact(value.regionSha256, 'regionSha256'),
    testIdentitySha256: exact(value.testIdentitySha256, 'testIdentitySha256'),
    resultSha256: exact(value.resultSha256, 'resultSha256'), outcome: value.outcome
  };
}
function witness(value, index) {
  exactKeys(value, ['witnessSha256', 'authorIdentitySha256', 'executorIdentitySha256'], `witnesses[${index}]`);
  return {
    witnessSha256: exact(value.witnessSha256, 'witnessSha256'),
    authorIdentitySha256: exact(value.authorIdentitySha256, 'authorIdentitySha256'),
    executorIdentitySha256: exact(value.executorIdentitySha256, 'executorIdentitySha256')
  };
}
function mutation(value, index) {
  exactKeys(value, ['mutationIdSha256', 'targetRegionSha256', 'resultSha256', 'outcome'], `mutations[${index}]`);
  if (!['killed', 'survived', 'unavailable'].includes(value.outcome)) fail('mutation outcome is invalid.');
  return {
    mutationIdSha256: exact(value.mutationIdSha256, 'mutationIdSha256'),
    targetRegionSha256: exact(value.targetRegionSha256, 'targetRegionSha256'),
    resultSha256: exact(value.resultSha256, 'resultSha256'), outcome: value.outcome
  };
}

export function evaluateLocalHermeticEvidence(value) {
  exactKeys(value, [
    'schemaVersion', 'kind', 'workId', 'proofSubjectSha256', 'candidateSha256',
    'regions', 'executions', 'witnesses', 'mutations'
  ], 'local hermetic evidence');
  if (value.schemaVersion !== 1 || value.kind !== 'gdp-local-hermetic-evidence') { // schema-transient: read-only caller evidence envelope
    fail('evidence schema is not current.');
  }
  const workId = text(value.workId, 'workId');
  const proofSubjectSha256 = exact(value.proofSubjectSha256, 'proofSubjectSha256');
  const candidateSha256 = exact(value.candidateSha256, 'candidateSha256');
  const regions = bounded(value.regions, region, 'regions');
  const executions = bounded(value.executions, execution, 'executions');
  const witnesses = bounded(value.witnesses, witness, 'witnesses');
  const mutations = bounded(value.mutations, mutation, 'mutations');
  const knownRegions = new Set(regions.map((entry) => entry.regionSha256));
  if (executions.some((entry) => !knownRegions.has(entry.regionSha256))
      || mutations.some((entry) => !knownRegions.has(entry.targetRegionSha256))) {
    fail('execution or mutation references an unknown changed region.');
  }
  const changeMap = seal('executable-change-map', {
    workId, proofSubjectSha256, candidateSha256, regions, profile: 'local-hermetic-v1'
  });
  const required = regions.filter((entry) => entry.required && entry.executable).map((entry) => entry.regionSha256);
  const covered = [];
  const failed = [];
  for (const regionSha256 of required) {
    const occurrences = executions.filter((entry) => entry.regionSha256 === regionSha256);
    if (occurrences.some((entry) => entry.outcome === 'passed')) covered.push(regionSha256);
    else if (occurrences.some((entry) => entry.outcome === 'failed')) failed.push(regionSha256);
  }
  const uncovered = required.filter((entry) => !covered.includes(entry) && !failed.includes(entry));
  const coverage = seal('changed-region-coverage', {
    workId, proofSubjectSha256, changeMapSha256: changeMap.changeMapSha256,
    requiredRegionRefs: required.sort(), coveredRegionRefs: covered.sort(),
    uncoveredRegionRefs: uncovered.sort(), failedRegionRefs: failed.sort(),
    status: failed.length ? 'failed' : uncovered.length || !required.length ? 'unavailable' : 'passed',
    executionRefs: executions.map((entry) => entry.resultSha256).sort()
  });
  const independent = witnesses.filter((entry) => (
    entry.authorIdentitySha256 !== entry.executorIdentitySha256
  )).map((entry) => entry.witnessSha256);
  const conflicting = witnesses.filter((entry) => (
    entry.authorIdentitySha256 === entry.executorIdentitySha256
  )).map((entry) => entry.witnessSha256);
  const independence = seal('witness-independence', {
    workId, proofSubjectSha256, witnessRefs: witnesses.map((entry) => entry.witnessSha256).sort(),
    independentRefs: independent.sort(), conflictingRefs: conflicting.sort(),
    status: conflicting.length ? 'conflicting' : independent.length ? 'independent' : 'unavailable'
  });
  const mutationObservations = mutations.map((entry) => seal('mutation-observation', {
    workId, proofSubjectSha256, ...entry, authority: 'none', gateEligible: false
  }));
  const core = {
    schemaVersion: 1, kind: 'gdp-local-hermetic-evaluation', mode: 'observe',
    authority: 'none', workId, proofSubjectSha256, candidateSha256,
    changeMap, coverage, independence, mutationObservations,
    verdict: coverage.status === 'passed' && independence.status === 'independent'
      ? 'observed-sufficient' : 'proof-unavailable',
    gaps: [
      ...(coverage.status === 'passed' ? [] : ['CHANGED_REGION_COVERAGE_UNAVAILABLE']),
      ...(independence.status === 'independent' ? [] : ['WITNESS_INDEPENDENCE_UNAVAILABLE']),
      'RUNNER_AUTHENTICATION_UNAVAILABLE'
    ],
    guarantees: {
      executesProductCode: false, noModel: true, pathFree: true,
      gateEligible: false, consumedByLifecycle: false
    }
  };
  return Object.freeze({ ...core, evaluationSha256: digest(core) });
}

export function buildProofGapAcceptance({
  workId, proofSubjectSha256, gapSha256, decision, reasonSha256, decidedBy, expiresAt
} = {}) {
  if (!['accepted-with-exception', 'rejected'].includes(decision)) fail('gap decision is invalid.');
  const expiry = new Date(expiresAt);
  if (!Number.isFinite(expiry.getTime())) fail('expiresAt is invalid.');
  const actor = {
    kind: decidedBy?.kind,
    identitySha256: exact(decidedBy?.identitySha256, 'identitySha256'),
    authoritySha256: exact(decidedBy?.authoritySha256, 'authoritySha256')
  };
  if (actor.kind !== 'human') fail('gap acceptance requires human authority.');
  return seal('proof-gap-acceptance', {
    workId: text(workId, 'workId'), proofSubjectSha256: exact(proofSubjectSha256, 'proofSubjectSha256'),
    gapSha256: exact(gapSha256, 'gapSha256'), decision,
    reasonSha256: exact(reasonSha256, 'reasonSha256'), decidedBy: actor,
    expiresAt: expiry.toISOString()
  });
}

export function validateHighAssuranceRecord(family, value) {
  const descriptor = FAMILIES[family];
  if (!descriptor) fail(`unknown family '${family}'.`);
  if (canonicalJson(Object.keys(value ?? {}).sort()) !== canonicalJson([...descriptor[1]].sort())) fail(`${family} has an invalid field set.`);
  const readable = readRecord(family, value);
  if (readable.migratedThrough.length || value.kind !== family) fail(`${family} is not current.`);
  const core = structuredClone(value); delete core[descriptor[0]];
  if (value[descriptor[0]] !== digest(core)) fail(`${family} self hash is invalid.`);
  return Object.freeze(structuredClone(value));
}

export const M9_RECORD_FAMILIES = FAMILIES;
