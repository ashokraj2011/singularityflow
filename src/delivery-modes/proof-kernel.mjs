/**
 * GDP-M3 deterministic proof kernel.
 *
 * Semantic builders in this module are pure and synchronous. They cannot reach Git, the
 * filesystem, a model, AST, the World Model, a clock, or lifecycle state. Operational evaluation
 * receipts are deliberately separate and require the caller to supply their clock observations.
 */
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PREDICATE_ID = /^pfc\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const REASON = /^[A-Z][A-Z0-9_]{2,95}$/;
const PROFILES = new Set(['standard', 'high-assurance', 'regulated', 'custom-registered']);
const VERDICTS = new Set(['pass', 'fail', 'unavailable', 'not-applicable']);
const SUMMARY_VERDICTS = new Set([
  'proof-satisfied', 'proof-satisfied-with-authorized-gaps', 'proof-failed',
  'proof-unavailable', 'proof-stale', 'proof-decision-required'
]);
const ALGORITHMS = new Set([
  'exact-digest-equality', 'required-input-present', 'exact-not-applicable'
]);

export const PROOF_KERNEL_LIMITS = Object.freeze({
  maximumPredicates: 64,
  maximumInputs: 256,
  maximumInputBytes: 1024 * 1024,
  maximumDepth: 16,
  maximumFanOut: 256,
  maximumFuel: 100_000,
  deadlineMilliseconds: 10_000,
  maximumOutputBytes: 64 * 1024,
  maximumFindings: 256,
  maximumGapItems: 256,
  maximumSignals: 256
});

export const PROOF_RECORD_FAMILIES = Object.freeze({
  'proof-profile-selection': Object.freeze({
    kind: 'proof-profile-selection', plane: 'decision', hashField: 'selectionSha256',
    keys: ['schemaVersion', 'kind', 'workId', 'proofProfile', 'policyRefs', 'status', 'selectionSha256']
  }),
  'proof-predicate-specification': Object.freeze({
    kind: 'proof-predicate-specification', plane: 'subject', hashField: 'specificationSha256',
    keys: ['schemaVersion', 'kind', 'predicate', 'acceptedInputs', 'algorithm', 'profiles', 'reasonCodes', 'limits', 'invalidationDependencies', 'acceptanceCriteria', 'specificationSha256']
  }),
  'proof-predicate-result': Object.freeze({
    kind: 'proof-predicate-result', plane: 'evidence', hashField: 'resultSha256',
    keys: ['schemaVersion', 'kind', 'predicate', 'proofSubjectSha256', 'proofProfile', 'inputs', 'verdict', 'reasonCode', 'findings', 'fuel', 'resultSha256']
  }),
  'proof-evaluation-receipt': Object.freeze({
    kind: 'proof-evaluation-receipt', plane: 'operational', hashField: 'receiptSha256',
    keys: ['schemaVersion', 'kind', 'proofSubjectSha256', 'resultSha256', 'startedAt', 'completedAt', 'durationMilliseconds', 'cacheStatus', 'deadlineMilliseconds', 'deadlineExceeded', 'receiptSha256']
  }),
  'proof-signal-observation': Object.freeze({
    kind: 'proof-signal-observation', plane: 'evidence', hashField: 'observationSha256',
    keys: ['schemaVersion', 'kind', 'proofSubjectSha256', 'signalId', 'inputs', 'value', 'unit', 'assurance', 'authority', 'gateEligible', 'observationSha256']
  }),
  'proof-summary': Object.freeze({
    kind: 'proof-summary', plane: 'evidence', hashField: 'summarySha256',
    keys: ['schemaVersion', 'kind', 'proofSubjectSha256', 'proofProfile', 'predicateResults', 'signals', 'gapRegisterSha256', 'gapDecisionRefs', 'verdict', 'summarySha256']
  }),
  'proof-evidence-invalidation': Object.freeze({
    kind: 'proof-evidence-invalidation', plane: 'evidence', hashField: 'invalidationSha256',
    keys: ['schemaVersion', 'kind', 'proofSubjectSha256', 'changedInputs', 'invalidatedResults', 'invalidatedSummaries', 'reasonCode', 'invalidationSha256']
  }),
  'proof-gap-item': Object.freeze({
    kind: 'proof-gap-item', plane: 'subject', hashField: 'gapSha256',
    keys: ['schemaVersion', 'kind', 'proofSubjectSha256', 'gapId', 'category', 'proposition', 'owner', 'mitigation', 'status', 'gapSha256']
  }),
  'proof-gap-register': Object.freeze({
    kind: 'proof-gap-register', plane: 'subject', hashField: 'gapRegisterSha256',
    keys: ['schemaVersion', 'kind', 'proofSubjectSha256', 'gapRefs', 'gapRegisterSha256']
  })
});

function fail(message, code = 'PFC_PREDICATE_INPUT_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function exactObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(exactObject(value, label)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} has an invalid field set.`);
}

function identifier(value, label, pattern = ID) {
  const text = String(value ?? '');
  if (!pattern.test(text)) fail(`${label} is invalid.`);
  return text;
}

function digest(value, label) {
  if (!DIGEST.test(String(value ?? ''))) fail(`${label} must be a sha256 digest.`);
  return String(value);
}

function reason(value, label = 'reasonCode') {
  const text = String(value ?? '');
  if (!REASON.test(text)) fail(`${label} is invalid.`);
  return text;
}

function profile(value) {
  if (!PROFILES.has(value)) fail(`Unsupported proof profile '${value}'.`);
  return value;
}

function boundedText(value, label, maximum = 512) {
  const text = String(value ?? '');
  if (!text || Buffer.byteLength(text, 'utf8') > maximum || /[\u0000-\u001f\u007f]/u.test(text)) {
    fail(`${label} must be non-empty, bounded text.`);
  }
  return text;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function sortedUnique(values, normalize, label, maximum) {
  if (!Array.isArray(values) || values.length > maximum) fail(`${label} exceeds ${maximum} entries.`);
  const normalized = values.map((value, index) => normalize(value, `${label}[${index}]`));
  const keyed = new Map(normalized.map((value) => [canonicalJson(value), value]));
  if (keyed.size !== normalized.length) fail(`${label} contains duplicate entries.`);
  return [...keyed.values()].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function digestRefs(values, label, maximum = PROOF_KERNEL_LIMITS.maximumFanOut) {
  return sortedUnique(values, (value, at) => digest(value, at), label, maximum);
}

function requireCanonicalList(values, normalize, label, maximum, minimum = 0) {
  const normalized = sortedUnique(values, normalize, label, maximum);
  if (normalized.length < minimum || canonicalJson(normalized) !== canonicalJson(values)) {
    fail(`${label} must be a canonical sorted set.`);
  }
  return normalized;
}

function requireRebuiltRecord(record, rebuilt, label) {
  if (canonicalJson(record) !== canonicalJson(rebuilt)) {
    fail(`${label} is not the canonical registered record.`, 'PFC_PROOF_SUBJECT_INVALID');
  }
}

function proofInput(value, label) {
  exactKeys(value, ['kind', 'sha256'], label);
  return { kind: identifier(value.kind, `${label}.kind`), sha256: digest(value.sha256, `${label}.sha256`) };
}

function predicateIdentity(value, label = 'predicate') {
  exactKeys(value, ['id', 'version', 'implementationSha256'], label);
  return {
    id: identifier(value.id, `${label}.id`, PREDICATE_ID),
    version: integer(value.version, `${label}.version`, 1, 2_147_483_647),
    implementationSha256: digest(value.implementationSha256, `${label}.implementationSha256`)
  };
}

function semanticRecord(family, fields) {
  const descriptor = PROOF_RECORD_FAMILIES[family];
  if (!descriptor) fail(`Unknown proof family '${family}'.`, 'PFC_SCHEMA_UNAVAILABLE');
  const core = {
    schemaVersion: currentSchemaVersion(family),
    kind: descriptor.kind,
    ...fields
  };
  const record = { ...core, [descriptor.hashField]: `sha256:${recordSha256(core)}` };
  if (Buffer.byteLength(canonicalJson(record), 'utf8') > PROOF_KERNEL_LIMITS.maximumOutputBytes) {
    fail(`${family} exceeds its ${PROOF_KERNEL_LIMITS.maximumOutputBytes}-byte ceiling.`, 'PFC_RECORD_TOO_LARGE');
  }
  return Object.freeze(record);
}

function algorithmImplementationSha256(algorithm) {
  return `sha256:${recordSha256({
    schemaVersion: 1, // schema-transient: implementation identity component, never stored alone.
    kind: 'pfc-algorithm-definition',
    engine: 'pfc-proof-kernel-v1',
    algorithm,
    verdicts: [...VERDICTS],
    missingInput: 'unavailable',
    signalAuthority: 'none',
    fuelExhaustion: 'unavailable',
    deadlineExhaustion: 'unavailable'
  })}`;
}

function normalizedLimits(value = {}) {
  exactObject(value, 'limits');
  const allowed = new Set(['maximumInputs', 'maximumInputBytes', 'maximumFuel', 'deadlineMilliseconds', 'maximumOutputBytes']);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail('limits has an invalid field set.');
  return {
    maximumInputs: integer(value.maximumInputs ?? PROOF_KERNEL_LIMITS.maximumInputs, 'limits.maximumInputs', 1, PROOF_KERNEL_LIMITS.maximumInputs),
    maximumInputBytes: integer(value.maximumInputBytes ?? PROOF_KERNEL_LIMITS.maximumInputBytes, 'limits.maximumInputBytes', 128, PROOF_KERNEL_LIMITS.maximumInputBytes),
    maximumFuel: integer(value.maximumFuel ?? PROOF_KERNEL_LIMITS.maximumFuel, 'limits.maximumFuel', 1, PROOF_KERNEL_LIMITS.maximumFuel),
    deadlineMilliseconds: integer(value.deadlineMilliseconds ?? PROOF_KERNEL_LIMITS.deadlineMilliseconds, 'limits.deadlineMilliseconds', 1, PROOF_KERNEL_LIMITS.deadlineMilliseconds),
    maximumOutputBytes: integer(value.maximumOutputBytes ?? PROOF_KERNEL_LIMITS.maximumOutputBytes, 'limits.maximumOutputBytes', 1024, PROOF_KERNEL_LIMITS.maximumOutputBytes)
  };
}

export function buildProofProfileSelection({ workId, proofProfile, policyRefs = [], status = 'shadow' } = {}) {
  if (!['shadow', 'resolved'].includes(status)) fail(`Unsupported proof profile selection status '${status}'.`);
  return semanticRecord('proof-profile-selection', {
    workId: identifier(workId, 'workId'),
    proofProfile: profile(proofProfile),
    policyRefs: digestRefs(policyRefs, 'policyRefs'),
    status
  });
}

export function buildPredicateSpecification({
  id, version = 1, algorithm, acceptedInputs, profiles = [...PROFILES], reasonCodes,
  limits = {}, invalidationDependencies = [], acceptanceCriteria = []
} = {}) {
  if (!ALGORITHMS.has(algorithm)) fail(`Unsupported proof algorithm '${algorithm}'.`);
  const inputs = sortedUnique(acceptedInputs ?? [], (entry, label) => {
    exactKeys(entry, ['kind', 'required', 'maximumOccurrences'], label);
    return {
      kind: identifier(entry.kind, `${label}.kind`),
      required: entry.required === true,
      maximumOccurrences: integer(entry.maximumOccurrences, `${label}.maximumOccurrences`, 1, 256)
    };
  }, 'acceptedInputs', 32);
  if (!inputs.length) fail('acceptedInputs must name at least one input family.');
  const reasons = sortedUnique(reasonCodes ?? [], (value, label) => reason(value, label), 'reasonCodes', 32);
  if (!reasons.length) fail('reasonCodes must not be empty.');
  const selectedProfiles = sortedUnique(profiles, (value) => profile(value), 'profiles', PROFILES.size);
  const predicate = {
    id: identifier(id, 'predicate.id', PREDICATE_ID),
    version: integer(version, 'predicate.version', 1, 2_147_483_647),
    implementationSha256: algorithmImplementationSha256(algorithm)
  };
  return semanticRecord('proof-predicate-specification', {
    predicate,
    acceptedInputs: inputs,
    algorithm,
    profiles: selectedProfiles,
    reasonCodes: reasons,
    limits: normalizedLimits(limits),
    invalidationDependencies: sortedUnique(
      invalidationDependencies, (value, label) => identifier(value, label),
      'invalidationDependencies', 32
    ),
    acceptanceCriteria: sortedUnique(
      acceptanceCriteria, (value, label) => identifier(value, label), 'acceptanceCriteria', 64
    )
  });
}

function resultRecord({ specification, proofSubjectSha256, proofProfile, inputs, verdict, reasonCode, findings, maximumFuel }) {
  const normalizedInputs = sortedUnique(
    inputs, proofInput, 'inputs', specification.limits.maximumInputs
  );
  const fuelRequired = 12 + (normalizedInputs.length * 3);
  const consumedSteps = Math.min(maximumFuel, fuelRequired);
  return semanticRecord('proof-predicate-result', {
    predicate: specification.predicate,
    proofSubjectSha256: digest(proofSubjectSha256, 'proofSubjectSha256'),
    proofProfile: profile(proofProfile),
    inputs: normalizedInputs,
    verdict,
    reasonCode: reason(reasonCode),
    findings: sortedUnique(findings, (value, label) => boundedText(value, label), 'findings', PROOF_KERNEL_LIMITS.maximumFindings),
    fuel: { maximumSteps: maximumFuel, consumedSteps }
  });
}

export function evaluateProofPredicate({
  specification, proofSubjectSha256, proofProfile, inputs = [], changedInputSha256s = [],
  deadlineExceeded = false, maximumFuel = null
} = {}) {
  validateProofRecord('proof-predicate-specification', specification);
  const selectedProfile = profile(proofProfile);
  const normalizedInputs = sortedUnique(inputs, proofInput, 'inputs', specification.limits.maximumInputs);
  const inputBytes = Buffer.byteLength(canonicalJson(normalizedInputs), 'utf8');
  const fuel = integer(maximumFuel ?? specification.limits.maximumFuel,
    'maximumFuel', 1, specification.limits.maximumFuel);
  const requiredFuel = 12 + (normalizedInputs.length * 3);
  const changed = new Set(digestRefs(changedInputSha256s, 'changedInputSha256s'));
  const byKind = new Map();
  for (const input of normalizedInputs) {
    const list = byKind.get(input.kind) ?? [];
    list.push(input);
    byKind.set(input.kind, list);
  }
  const accepted = new Map(specification.acceptedInputs.map((entry) => [entry.kind, entry]));
  let verdict = 'unavailable';
  let reasonCode = 'PFC_REQUIRED_INPUT_UNAVAILABLE';
  let findings = [];

  if (!specification.profiles.includes(selectedProfile)) {
    verdict = 'not-applicable';
    reasonCode = 'PFC_PROFILE_NOT_APPLICABLE';
  } else if (deadlineExceeded) {
    reasonCode = 'PFC_DEADLINE_EXHAUSTED';
  } else if (inputBytes > specification.limits.maximumInputBytes) {
    reasonCode = 'PFC_INPUT_LIMIT_EXCEEDED';
  } else if (requiredFuel > fuel) {
    reasonCode = 'PFC_FUEL_EXHAUSTED';
  } else if (normalizedInputs.some((input) => changed.has(input.sha256))) {
    reasonCode = 'PFC_INPUT_STALE';
  } else if (normalizedInputs.some((input) => input.kind === 'proof-signal-observation')) {
    reasonCode = 'PFC_SIGNAL_NOT_PREDICATE';
  } else if (normalizedInputs.some((input) => !accepted.has(input.kind))) {
    reasonCode = 'PFC_INPUT_KIND_UNSUPPORTED';
  } else if (specification.acceptedInputs.some((entry) => (
    entry.required && !(byKind.get(entry.kind)?.length)
  ))) {
    reasonCode = 'PFC_REQUIRED_INPUT_UNAVAILABLE';
  } else if (specification.acceptedInputs.some((entry) => (
    (byKind.get(entry.kind)?.length ?? 0) > entry.maximumOccurrences
  ))) {
    reasonCode = 'PFC_INPUT_CONTRADICTORY';
  } else if (specification.algorithm === 'exact-digest-equality') {
    const required = specification.acceptedInputs.filter((entry) => entry.required)
      .flatMap((entry) => byKind.get(entry.kind) ?? []);
    if (required.length < 2) reasonCode = 'PFC_REQUIRED_INPUT_UNAVAILABLE';
    else if (required.every((input) => input.sha256 === required[0].sha256)) {
      verdict = 'pass';
      reasonCode = 'PFC_EXACT_INPUTS_EQUAL';
    } else {
      verdict = 'fail';
      reasonCode = 'PFC_EXACT_INPUTS_DIFFER';
      findings = ['Exact bound input digests differ.'];
    }
  } else if (specification.algorithm === 'required-input-present') {
    verdict = 'pass';
    reasonCode = 'PFC_REQUIRED_INPUTS_PRESENT';
  } else if (specification.algorithm === 'exact-not-applicable') {
    verdict = 'not-applicable';
    reasonCode = 'PFC_EXACTLY_NOT_APPLICABLE';
  }
  if (!specification.reasonCodes.includes(reasonCode)) {
    fail(`Predicate '${specification.predicate.id}' did not register reason code '${reasonCode}'.`);
  }
  const result = resultRecord({
    specification, proofSubjectSha256, proofProfile: selectedProfile, inputs: normalizedInputs,
    verdict, reasonCode, findings, maximumFuel: fuel
  });
  if (Buffer.byteLength(canonicalJson(result), 'utf8') > specification.limits.maximumOutputBytes) {
    return resultRecord({
      specification, proofSubjectSha256, proofProfile: selectedProfile, inputs: normalizedInputs,
      verdict: 'unavailable', reasonCode: 'PFC_OUTPUT_LIMIT_EXCEEDED', findings: [], maximumFuel: fuel
    });
  }
  return result;
}

export function buildEvaluationReceipt({
  proofSubjectSha256, resultSha256, startedAt, completedAt, durationMilliseconds,
  cacheStatus = 'miss', deadlineMilliseconds, deadlineExceeded = false
} = {}) {
  const start = new Date(startedAt);
  const end = new Date(completedAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) {
    fail('Evaluation receipt timestamps are invalid.');
  }
  if (end.getTime() - start.getTime() !== durationMilliseconds) {
    fail('Evaluation receipt duration must equal its exact timestamp interval.');
  }
  if (!['hit', 'miss', 'reused'].includes(cacheStatus)) fail(`Unsupported cache status '${cacheStatus}'.`);
  return semanticRecord('proof-evaluation-receipt', {
    proofSubjectSha256: digest(proofSubjectSha256, 'proofSubjectSha256'),
    resultSha256: digest(resultSha256, 'resultSha256'),
    startedAt: start.toISOString(),
    completedAt: end.toISOString(),
    durationMilliseconds: integer(durationMilliseconds, 'durationMilliseconds', 0, 86_400_000),
    cacheStatus,
    deadlineMilliseconds: integer(deadlineMilliseconds, 'deadlineMilliseconds', 1, PROOF_KERNEL_LIMITS.deadlineMilliseconds),
    deadlineExceeded: deadlineExceeded === true
  });
}

export function buildSignalObservation({
  proofSubjectSha256, signalId, inputs = [], value, unit, assurance = 'observed'
} = {}) {
  if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value))) {
    fail('Signal value must be a finite JSON scalar.');
  }
  if (typeof value === 'string') boundedText(value, 'signal.value', 256);
  return semanticRecord('proof-signal-observation', {
    proofSubjectSha256: digest(proofSubjectSha256, 'proofSubjectSha256'),
    signalId: identifier(signalId, 'signalId'),
    inputs: sortedUnique(inputs, proofInput, 'inputs', PROOF_KERNEL_LIMITS.maximumInputs),
    value,
    unit: identifier(unit, 'unit'),
    assurance: identifier(assurance, 'assurance'),
    authority: 'none',
    gateEligible: false
  });
}

export function buildGapItem({
  proofSubjectSha256, gapId, category, proposition, owner, mitigation, status = 'open'
} = {}) {
  if (!['open', 'mitigated', 'unavailable'].includes(status)) fail(`Unsupported gap status '${status}'.`);
  return semanticRecord('proof-gap-item', {
    proofSubjectSha256: digest(proofSubjectSha256, 'proofSubjectSha256'),
    gapId: identifier(gapId, 'gapId'),
    category: identifier(category, 'category'),
    proposition: boundedText(proposition, 'proposition'),
    owner: identifier(owner, 'owner'),
    mitigation: boundedText(mitigation, 'mitigation'),
    status
  });
}

export function buildGapRegister({ proofSubjectSha256, gaps = [] } = {}) {
  if (!Array.isArray(gaps) || gaps.length > PROOF_KERNEL_LIMITS.maximumGapItems) {
    fail(`gaps exceeds ${PROOF_KERNEL_LIMITS.maximumGapItems} entries.`);
  }
  for (const gap of gaps) {
    validateProofRecord('proof-gap-item', gap);
    if (gap.proofSubjectSha256 !== proofSubjectSha256) fail('Gap item binds another Proof Subject.');
  }
  return semanticRecord('proof-gap-register', {
    proofSubjectSha256: digest(proofSubjectSha256, 'proofSubjectSha256'),
    gapRefs: digestRefs(gaps.map((gap) => gap.gapSha256), 'gapRefs', PROOF_KERNEL_LIMITS.maximumGapItems)
  });
}

function resultSets(results) {
  const sets = { passed: [], failed: [], unavailable: [], notApplicable: [] };
  for (const result of results) {
    const key = {
      pass: 'passed', fail: 'failed', unavailable: 'unavailable',
      'not-applicable': 'notApplicable'
    }[result.verdict];
    sets[key].push(result.resultSha256);
  }
  return Object.fromEntries(Object.entries(sets).map(([key, values]) => [
    key, [...new Set(values)].sort()
  ]));
}

export function buildProofSummary({
  proofSubjectSha256, proofProfile, results = [], signals = [], gapRegister = null,
  gapDecisionRefs = []
} = {}) {
  if (gapDecisionRefs?.length) {
    fail(
      'GDP-M3 cannot authorize gap decisions; gap acceptance is introduced by a later milestone.',
      'PFC_SCHEMA_UNAVAILABLE'
    );
  }
  if (!Array.isArray(results) || results.length > PROOF_KERNEL_LIMITS.maximumPredicates) {
    fail(`results exceeds ${PROOF_KERNEL_LIMITS.maximumPredicates} entries.`);
  }
  if (!Array.isArray(signals) || signals.length > PROOF_KERNEL_LIMITS.maximumSignals) {
    fail(`signals exceeds ${PROOF_KERNEL_LIMITS.maximumSignals} entries.`);
  }
  const subject = digest(proofSubjectSha256, 'proofSubjectSha256');
  const selectedProfile = profile(proofProfile);
  for (const result of results) {
    validateProofRecord('proof-predicate-result', result);
    if (result.proofSubjectSha256 !== subject || result.proofProfile !== selectedProfile) {
      fail('Predicate Result binds another Proof Subject or profile.');
    }
  }
  for (const signal of signals) {
    validateProofRecord('proof-signal-observation', signal);
    if (signal.proofSubjectSha256 !== subject || signal.authority !== 'none' || signal.gateEligible !== false) {
      fail('Signal cannot gain predicate or gate authority.');
    }
  }
  if (gapRegister) {
    validateProofRecord('proof-gap-register', gapRegister);
    if (gapRegister.proofSubjectSha256 !== subject) fail('Gap Register binds another Proof Subject.');
  }
  const identities = new Map();
  let contradictory = false;
  for (const result of results) {
    const key = `${result.predicate.id}@${result.predicate.version}`;
    const previous = identities.get(key);
    if (previous && previous !== result.resultSha256) contradictory = true;
    identities.set(key, result.resultSha256);
  }
  let verdict = 'proof-unavailable';
  if (contradictory) verdict = 'proof-unavailable';
  else if (results.some((result) => result.verdict === 'fail')) verdict = 'proof-failed';
  else if (results.some((result) => result.verdict === 'unavailable')) verdict = 'proof-unavailable';
  else if (!results.some((result) => result.verdict === 'pass')) verdict = 'proof-unavailable';
  else if (gapRegister?.gapRefs.length && !(gapDecisionRefs?.length)) verdict = 'proof-decision-required';
  else if (gapRegister?.gapRefs.length) verdict = 'proof-satisfied-with-authorized-gaps';
  else verdict = 'proof-satisfied';
  return semanticRecord('proof-summary', {
    proofSubjectSha256: subject,
    proofProfile: selectedProfile,
    predicateResults: resultSets(results),
    signals: digestRefs(signals.map((signal) => signal.observationSha256), 'signals', PROOF_KERNEL_LIMITS.maximumSignals),
    gapRegisterSha256: gapRegister?.gapRegisterSha256 ?? null,
    gapDecisionRefs: digestRefs(gapDecisionRefs ?? [], 'gapDecisionRefs'),
    verdict
  });
}

export function buildProofInvalidation({
  proofSubjectSha256, changedInputs = [], results = [], summaries = [], reasonCode = 'PFC_INPUT_CHANGED'
} = {}) {
  const changed = new Set(digestRefs(changedInputs, 'changedInputs'));
  const invalidatedResults = [];
  for (const result of results) {
    validateProofRecord('proof-predicate-result', result);
    if (result.proofSubjectSha256 === proofSubjectSha256
        && result.inputs.some((input) => changed.has(input.sha256))) {
      invalidatedResults.push(result.resultSha256);
    }
  }
  const stale = new Set(invalidatedResults);
  const invalidatedSummaries = [];
  for (const summary of summaries) {
    validateProofRecord('proof-summary', summary);
    const refs = Object.values(summary.predicateResults).flat();
    if (summary.proofSubjectSha256 === proofSubjectSha256 && refs.some((ref) => stale.has(ref))) {
      invalidatedSummaries.push(summary.summarySha256);
    }
  }
  return semanticRecord('proof-evidence-invalidation', {
    proofSubjectSha256: digest(proofSubjectSha256, 'proofSubjectSha256'),
    changedInputs: [...changed].sort(),
    invalidatedResults: [...new Set(invalidatedResults)].sort(),
    invalidatedSummaries: [...new Set(invalidatedSummaries)].sort(),
    reasonCode: reason(reasonCode)
  });
}

export function validateProofRecord(family, record) {
  const descriptor = PROOF_RECORD_FAMILIES[family];
  if (!descriptor) fail(`Unknown proof family '${family}'.`, 'PFC_SCHEMA_UNAVAILABLE');
  exactKeys(record, descriptor.keys, family);
  const readable = readRecord(family, record);
  if (readable.migratedThrough.length !== 0 || record.kind !== descriptor.kind) {
    fail(`${family} schema or kind is not current.`, 'PFC_SCHEMA_UNAVAILABLE');
  }
  const supplied = digest(record[descriptor.hashField], `${family}.${descriptor.hashField}`);
  const core = structuredClone(record);
  delete core[descriptor.hashField];
  const expected = `sha256:${recordSha256(core)}`;
  if (supplied !== expected) fail(`${family} self hash is invalid.`, 'PFC_PROOF_SUBJECT_INVALID');
  if (Buffer.byteLength(canonicalJson(record), 'utf8') > PROOF_KERNEL_LIMITS.maximumOutputBytes) {
    fail(`${family} exceeds its byte ceiling.`, 'PFC_RECORD_TOO_LARGE');
  }
  for (const [key, value] of Object.entries(record)) {
    if (key.endsWith('Sha256') && value != null) digest(value, `${family}.${key}`);
  }
  if (record.proofSubjectSha256 != null) digest(record.proofSubjectSha256, `${family}.proofSubjectSha256`);
  if (record.predicate) predicateIdentity(record.predicate);
  if (record.proofProfile) profile(record.proofProfile);
  if (record.verdict && family === 'proof-predicate-result' && !VERDICTS.has(record.verdict)) {
    fail(`Unsupported predicate verdict '${record.verdict}'.`);
  }
  if (record.verdict && family === 'proof-summary' && !SUMMARY_VERDICTS.has(record.verdict)) {
    fail(`Unsupported proof-summary verdict '${record.verdict}'.`);
  }
  if (family === 'proof-signal-observation'
      && (record.authority !== 'none' || record.gateEligible !== false)) {
    fail('Signal records can never carry proof or gate authority.');
  }
  if (family === 'proof-profile-selection') {
    identifier(record.workId, 'proof-profile-selection.workId');
    digestRefs(record.policyRefs, 'proof-profile-selection.policyRefs');
    if (!['shadow', 'resolved'].includes(record.status)) fail('Proof profile selection status is invalid.');
    requireRebuiltRecord(record, buildProofProfileSelection({
      workId: record.workId, proofProfile: record.proofProfile,
      policyRefs: record.policyRefs, status: record.status
    }), family);
  } else if (family === 'proof-predicate-specification') {
    if (!ALGORITHMS.has(record.algorithm)) fail('Predicate specification algorithm is invalid.');
    if (!Array.isArray(record.acceptedInputs) || !record.acceptedInputs.length || record.acceptedInputs.length > 32) {
      fail('Predicate specification acceptedInputs is invalid.');
    }
    for (const [index, input] of record.acceptedInputs.entries()) {
      exactKeys(input, ['kind', 'required', 'maximumOccurrences'], `acceptedInputs[${index}]`);
      identifier(input.kind, `acceptedInputs[${index}].kind`);
      if (typeof input.required !== 'boolean') fail('Predicate input required flag is invalid.');
      integer(input.maximumOccurrences, `acceptedInputs[${index}].maximumOccurrences`, 1, 256);
    }
    requireCanonicalList(record.profiles, (value) => profile(value), 'profiles', PROFILES.size, 1);
    requireCanonicalList(record.reasonCodes, (value, label) => reason(value, label), 'reasonCodes', 32, 1);
    normalizedLimits(record.limits);
    requireCanonicalList(record.invalidationDependencies,
      (value, label) => identifier(value, label), 'invalidationDependencies', 32);
    requireCanonicalList(record.acceptanceCriteria,
      (value, label) => identifier(value, label), 'acceptanceCriteria', 64);
    requireRebuiltRecord(record, buildPredicateSpecification({
      id: record.predicate.id,
      version: record.predicate.version,
      algorithm: record.algorithm,
      acceptedInputs: record.acceptedInputs,
      profiles: record.profiles,
      reasonCodes: record.reasonCodes,
      limits: record.limits,
      invalidationDependencies: record.invalidationDependencies,
      acceptanceCriteria: record.acceptanceCriteria
    }), family);
  } else if (family === 'proof-predicate-result') {
    requireCanonicalList(record.inputs, proofInput, 'inputs', PROOF_KERNEL_LIMITS.maximumInputs, 1);
    reason(record.reasonCode);
    requireCanonicalList(record.findings,
      (value, label) => boundedText(value, label), 'findings', PROOF_KERNEL_LIMITS.maximumFindings);
    exactKeys(record.fuel, ['maximumSteps', 'consumedSteps'], 'fuel');
    integer(record.fuel?.maximumSteps, 'fuel.maximumSteps', 1, PROOF_KERNEL_LIMITS.maximumFuel);
    integer(record.fuel?.consumedSteps, 'fuel.consumedSteps', 0, record.fuel.maximumSteps);
  } else if (family === 'proof-evaluation-receipt') {
    const started = Date.parse(record.startedAt);
    const completed = Date.parse(record.completedAt);
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
      fail('Evaluation receipt timestamp is invalid.');
    }
    integer(record.durationMilliseconds, 'durationMilliseconds', 0, 86_400_000);
    if (completed - started !== record.durationMilliseconds) {
      fail('Evaluation receipt duration does not match its timestamp interval.');
    }
    integer(record.deadlineMilliseconds, 'deadlineMilliseconds', 1, PROOF_KERNEL_LIMITS.deadlineMilliseconds);
    if (!['hit', 'miss', 'reused'].includes(record.cacheStatus)
        || typeof record.deadlineExceeded !== 'boolean') fail('Evaluation receipt operation state is invalid.');
    requireRebuiltRecord(record, buildEvaluationReceipt({
      proofSubjectSha256: record.proofSubjectSha256,
      resultSha256: record.resultSha256,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      durationMilliseconds: record.durationMilliseconds,
      cacheStatus: record.cacheStatus,
      deadlineMilliseconds: record.deadlineMilliseconds,
      deadlineExceeded: record.deadlineExceeded
    }), family);
  } else if (family === 'proof-signal-observation') {
    requireCanonicalList(record.inputs, proofInput, 'inputs', PROOF_KERNEL_LIMITS.maximumInputs);
    identifier(record.signalId, 'signalId');
    identifier(record.unit, 'unit');
    identifier(record.assurance, 'assurance');
    if (!['string', 'number', 'boolean'].includes(typeof record.value)
        || (typeof record.value === 'number' && !Number.isFinite(record.value))) fail('Signal value is invalid.');
    requireRebuiltRecord(record, buildSignalObservation({
      proofSubjectSha256: record.proofSubjectSha256,
      signalId: record.signalId,
      inputs: record.inputs,
      value: record.value,
      unit: record.unit,
      assurance: record.assurance
    }), family);
  } else if (family === 'proof-summary') {
    exactKeys(record.predicateResults, ['passed', 'failed', 'unavailable', 'notApplicable'], 'predicateResults');
    const resultRefs = [];
    for (const [key, values] of Object.entries(record.predicateResults)) {
      requireCanonicalList(values, (value, label) => digest(value, label),
        `predicateResults.${key}`, PROOF_KERNEL_LIMITS.maximumPredicates);
      resultRefs.push(...values);
    }
    if (new Set(resultRefs).size !== resultRefs.length) fail('Predicate Result sets overlap.');
    requireCanonicalList(record.signals, (value, label) => digest(value, label),
      'signals', PROOF_KERNEL_LIMITS.maximumSignals);
    requireCanonicalList(record.gapDecisionRefs, (value, label) => digest(value, label),
      'gapDecisionRefs', PROOF_KERNEL_LIMITS.maximumFanOut);
    if (record.gapDecisionRefs.length) fail('GDP-M3 Proof Summary cannot authorize gap decisions.', 'PFC_SCHEMA_UNAVAILABLE');
  } else if (family === 'proof-evidence-invalidation') {
    requireCanonicalList(record.changedInputs, (value, label) => digest(value, label),
      'changedInputs', PROOF_KERNEL_LIMITS.maximumFanOut);
    requireCanonicalList(record.invalidatedResults, (value, label) => digest(value, label),
      'invalidatedResults', PROOF_KERNEL_LIMITS.maximumFanOut);
    requireCanonicalList(record.invalidatedSummaries, (value, label) => digest(value, label),
      'invalidatedSummaries', PROOF_KERNEL_LIMITS.maximumFanOut);
    reason(record.reasonCode);
  } else if (family === 'proof-gap-item') {
    identifier(record.gapId, 'gapId');
    identifier(record.category, 'category');
    identifier(record.owner, 'owner');
    boundedText(record.proposition, 'proposition');
    boundedText(record.mitigation, 'mitigation');
    if (!['open', 'mitigated', 'unavailable'].includes(record.status)) fail('Gap status is invalid.');
    requireRebuiltRecord(record, buildGapItem({
      proofSubjectSha256: record.proofSubjectSha256,
      gapId: record.gapId,
      category: record.category,
      proposition: record.proposition,
      owner: record.owner,
      mitigation: record.mitigation,
      status: record.status
    }), family);
  } else if (family === 'proof-gap-register') {
    requireCanonicalList(record.gapRefs, (value, label) => digest(value, label),
      'gapRefs', PROOF_KERNEL_LIMITS.maximumGapItems);
  }
  return Object.freeze(structuredClone(record));
}

function candidateSpecification() {
  return buildPredicateSpecification({
    id: 'pfc.candidate-binding', algorithm: 'exact-digest-equality',
    acceptedInputs: [
      { kind: 'candidate-expected', required: true, maximumOccurrences: 1 },
      { kind: 'candidate-observed', required: true, maximumOccurrences: 1 }
    ],
    reasonCodes: [
      'PFC_EXACT_INPUTS_EQUAL', 'PFC_EXACT_INPUTS_DIFFER', 'PFC_REQUIRED_INPUT_UNAVAILABLE',
      'PFC_DEADLINE_EXHAUSTED', 'PFC_INPUT_LIMIT_EXCEEDED', 'PFC_FUEL_EXHAUSTED',
      'PFC_INPUT_STALE', 'PFC_SIGNAL_NOT_PREDICATE', 'PFC_INPUT_KIND_UNSUPPORTED',
      'PFC_INPUT_CONTRADICTORY', 'PFC_PROFILE_NOT_APPLICABLE', 'PFC_OUTPUT_LIMIT_EXCEEDED'
    ],
    invalidationDependencies: ['candidate'],
    acceptanceCriteria: ['PFC:AC-004', 'PFC:AC-007', 'PFC:AC-040', 'PFC:AC-041']
  });
}

function policySpecification() {
  return buildPredicateSpecification({
    id: 'pfc.proof-policy-authority', algorithm: 'required-input-present',
    acceptedInputs: [
      { kind: 'proof-subject', required: true, maximumOccurrences: 1 },
      { kind: 'proof-policy-authority', required: true, maximumOccurrences: 1 }
    ],
    reasonCodes: [
      'PFC_REQUIRED_INPUTS_PRESENT', 'PFC_REQUIRED_INPUT_UNAVAILABLE',
      'PFC_DEADLINE_EXHAUSTED', 'PFC_INPUT_LIMIT_EXCEEDED', 'PFC_FUEL_EXHAUSTED',
      'PFC_INPUT_STALE', 'PFC_SIGNAL_NOT_PREDICATE', 'PFC_INPUT_KIND_UNSUPPORTED',
      'PFC_INPUT_CONTRADICTORY', 'PFC_PROFILE_NOT_APPLICABLE', 'PFC_OUTPUT_LIMIT_EXCEEDED'
    ],
    invalidationDependencies: ['proof-policy'],
    acceptanceCriteria: ['PFC:AC-007', 'PFC:AC-038']
  });
}

export function observeShadowProof(passportDiagnostic) {
  if (!passportDiagnostic || passportDiagnostic.kind !== 'gdp-shadow-passport-diagnostic') {
    fail('A verified GDP-M2 shadow Passport diagnostic is required.');
  }
  const proofSubject = passportDiagnostic.records?.proofSubject ?? null;
  if (!proofSubject) return Object.freeze({
    schemaVersion: 1, // schema-transient: read-only command aggregate, never durable.
    kind: 'gdp-proof-observation', mode: 'observe', authority: 'none', status: 'unavailable',
    proofSubject: null, predicateSpecifications: [], results: [], signals: [], gaps: [],
    gapRegister: null, summary: null, invalidation: null,
    guarantees: { consumedByLifecycle: false, noWrites: true, noModel: true, signalsGateEligible: false }
  });
  const subjectSha256 = proofSubject.proofSubjectSha256;
  const specifications = [candidateSpecification(), policySpecification()];
  const candidate = passportDiagnostic.candidate.candidateSha256;
  const results = [
    evaluateProofPredicate({
      specification: specifications[0], proofSubjectSha256: subjectSha256,
      proofProfile: proofSubject.proofProfile,
      inputs: [
        { kind: 'candidate-expected', sha256: proofSubject.candidateSha256 },
        { kind: 'candidate-observed', sha256: candidate }
      ]
    }),
    evaluateProofPredicate({
      specification: specifications[1], proofSubjectSha256: subjectSha256,
      proofProfile: proofSubject.proofProfile,
      inputs: [{ kind: 'proof-subject', sha256: subjectSha256 }]
    })
  ];
  const gaps = [buildGapItem({
    proofSubjectSha256: subjectSha256,
    gapId: 'gdp-shadow-policy-authority',
    category: 'policy-authority',
    proposition: 'M2 policy identities are legacy shadow projections rather than ratified GDP proof authority.',
    owner: 'repository-maintainers',
    mitigation: 'Select and ratify a proof policy in a later enrolled GDP milestone.',
    status: 'open'
  })];
  if (passportDiagnostic.worldModel.status === 'unavailable') gaps.push(buildGapItem({
    proofSubjectSha256: subjectSha256,
    gapId: 'world-model-unavailable',
    category: 'world-model',
    proposition: 'A reusable World Model identity was unavailable for this Proof Subject.',
    owner: 'repository-maintainers',
    mitigation: 'Reuse or refresh the shared model when useful; ordinary work remains unblocked.',
    status: 'unavailable'
  }));
  const gapRegister = buildGapRegister({ proofSubjectSha256: subjectSha256, gaps });
  const summary = buildProofSummary({
    proofSubjectSha256: subjectSha256,
    proofProfile: proofSubject.proofProfile,
    results,
    signals: [],
    gapRegister
  });
  const core = {
    schemaVersion: 1, // schema-transient: read-only command aggregate, never durable.
    kind: 'gdp-proof-observation', mode: 'observe', authority: 'none',
    status: summary.verdict,
    proofSubject,
    predicateSpecifications: specifications,
    results,
    signals: [],
    gaps,
    gapRegister,
    summary,
    invalidation: null,
    guarantees: {
      consumedByLifecycle: false, noWrites: true, noModel: true, signalsGateEligible: false
    }
  };
  return Object.freeze({ ...core, observationSha256: `sha256:${recordSha256(core)}` });
}
