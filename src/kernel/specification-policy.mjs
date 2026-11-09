/** Specification policy and phase roles, independent of document reads and host review wording. */
import { SingularityFlowError } from '../foundation/failures.mjs';
import { validateSkillPhaseBindingHeader } from './skill-binding-header.mjs';

export const SPECIFICATION_CHECKLIST_ID = 'requirements-quality-v1';
// Only the default identity belongs to policy; checklist questions stay in their host/content owner.
const STARTER_CHECKLIST = Object.freeze({ id: SPECIFICATION_CHECKLIST_ID });


export const SPECIFICATION_QUALITY_MODES = Object.freeze(['off', 'warn', 'enforce']);


/**
 * The first witnessed-clause profile is intentionally small. `[WEL:REQ-002]` … `[WEL:REQ-005]`
 *
 * These values describe specification structure only. In particular, accepting `Witness:
 * inspection` here does not make inspection enforce-grade evidence; that requires a separate typed
 * evidence contract. v0.2 permits only `test` in the policy's enforceable set.
 */
export const WITNESSED_CLAUSE_PROFILE = 'witnessed-v1';

const ENFORCEABLE_WITNESS_TYPES = Object.freeze(['test']);

const WITNESSED_CLAUSE_TYPES = Object.freeze(['acceptance']);

const WITNESSED_LEXICAL_HINT_MODES = Object.freeze(['off', 'advisory']);

const DEFAULT_WITNESSED_LIMITS = Object.freeze({
  maxClauses: 500,
  maxFieldBytes: 4096,
  maxReportBytes: 262144
});

const WITNESSED_LIMIT_MAXIMUMS = Object.freeze({
  maxClauses: 10000,
  maxFieldBytes: 1024 * 1024,
  maxReportBytes: 10 * 1024 * 1024
});


function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new SingularityFlowError(`${label} contains unknown field '${key}'. Allowed: ${allowed.join(', ')}.`);
    }
  }
}


function normalizedUniqueArray(value, { label, fallback, allowed }) {
  const entries = value ?? fallback;
  if (!Array.isArray(entries) || !entries.length || entries.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new SingularityFlowError(`${label} must be a non-empty array.`);
  }
  if (new Set(entries).size !== entries.length) throw new SingularityFlowError(`${label} must not contain duplicates.`);
  for (const entry of entries) {
    if (!allowed.includes(entry)) throw new SingularityFlowError(`${label} contains unsupported value '${entry}'. Allowed: ${allowed.join(', ')}.`);
  }
  return Object.freeze([...entries]);
}


/** Normalize the opt-in `specificationQuality.witnessedClauses` extension. */
function witnessedClausePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SingularityFlowError('specificationQuality.witnessedClauses must be an object.');
  }
  rejectUnknownKeys(
    value,
    ['profile', 'clauseTypes', 'enforceableWitnessTypes', 'lexicalHints', 'limits'],
    'specificationQuality.witnessedClauses'
  );
  if (value.profile !== WITNESSED_CLAUSE_PROFILE) {
    throw new SingularityFlowError(`specificationQuality.witnessedClauses.profile must be '${WITNESSED_CLAUSE_PROFILE}'.`);
  }
  const clauseTypes = normalizedUniqueArray(value.clauseTypes, {
    label: 'specificationQuality.witnessedClauses.clauseTypes',
    fallback: WITNESSED_CLAUSE_TYPES,
    allowed: WITNESSED_CLAUSE_TYPES
  });
  const enforceableWitnessTypes = normalizedUniqueArray(value.enforceableWitnessTypes, {
    label: 'specificationQuality.witnessedClauses.enforceableWitnessTypes',
    fallback: ENFORCEABLE_WITNESS_TYPES,
    allowed: ENFORCEABLE_WITNESS_TYPES
  });
  const lexicalHints = value.lexicalHints ?? 'off';
  if (!WITNESSED_LEXICAL_HINT_MODES.includes(lexicalHints)) {
    throw new SingularityFlowError(`specificationQuality.witnessedClauses.lexicalHints must be ${WITNESSED_LEXICAL_HINT_MODES.join(' or ')}.`);
  }
  const configuredLimits = value.limits ?? {};
  if (!configuredLimits || typeof configuredLimits !== 'object' || Array.isArray(configuredLimits)) {
    throw new SingularityFlowError('specificationQuality.witnessedClauses.limits must be an object.');
  }
  rejectUnknownKeys(configuredLimits, Object.keys(DEFAULT_WITNESSED_LIMITS), 'specificationQuality.witnessedClauses.limits');
  const limits = { ...DEFAULT_WITNESSED_LIMITS, ...configuredLimits };
  for (const [key, maximum] of Object.entries(WITNESSED_LIMIT_MAXIMUMS)) {
    const minimum = key === 'maxReportBytes' ? 2048 : 1;
    if (!Number.isSafeInteger(limits[key]) || limits[key] < minimum || limits[key] > maximum) {
      throw new SingularityFlowError(
        `specificationQuality.witnessedClauses.limits.${key} must be an integer from ${minimum} to ${maximum}.`
      );
    }
  }
  return Object.freeze({
    profile: WITNESSED_CLAUSE_PROFILE,
    clauseTypes,
    enforceableWitnessTypes,
    lexicalHints,
    limits: Object.freeze(limits)
  });
}


/** Normalize and validate a `specificationQuality` policy `[SPK:REQ-050]`. */
export function specificationQualityPolicy(value = {}) {
  const mode = value?.mode ?? 'off';
  if (!SPECIFICATION_QUALITY_MODES.includes(mode)) {
    throw new SingularityFlowError(`specificationQuality.mode must be one of ${SPECIFICATION_QUALITY_MODES.join(', ')}; got '${mode}'.`);
  }
  const checklist = value?.checklist ?? STARTER_CHECKLIST.id;
  if (typeof checklist !== 'string' || !checklist) {
    throw new SingularityFlowError('specificationQuality.checklist must name a checklist definition.');
  }
  const approvalChecklist = value?.approvalChecklist;
  if (approvalChecklist !== undefined && !['off', 'required'].includes(approvalChecklist)) {
    throw new SingularityFlowError('specificationQuality.approvalChecklist must be off or required.');
  }
  /**
   * Who may take an exception `[SPK:REQ-061]`.
   *
   * Absent means the phase's own approval authority is enough: whoever may approve may also record
   * a reasoned exception. Naming a group narrows it — useful when "we are shipping without stated
   * latency numbers" should be a decision an architect takes rather than anyone with an approval
   * bit. Never a way to make an exception cheaper, only a way to make it dearer.
   */
  const exceptionAuthority = value?.exceptionAuthority ?? null;
  if (exceptionAuthority !== null && (typeof exceptionAuthority !== 'string' || !exceptionAuthority.trim())) {
    throw new SingularityFlowError('specificationQuality.exceptionAuthority must name an approval authority group.');
  }
  const witnessedClauses = value?.witnessedClauses === undefined
    ? undefined
    : witnessedClausePolicy(value.witnessedClauses);
  const scenarioCoverage = value?.scenarioCoverage;
  if (scenarioCoverage !== undefined && !['off', 'required'].includes(scenarioCoverage)) {
    throw new SingularityFlowError('specificationQuality.scenarioCoverage must be off or required.');
  }
  return Object.freeze({
    mode,
    checklist,
    // Keep the omitted field absent so existing normalized policies and their hashes do not change.
    ...(approvalChecklist === undefined ? {} : { approvalChecklist }),
    exceptionAuthority,
    // Assisted analysis is opt-in and never the default; the deterministic path must stand alone.
    assisted: Boolean(value?.assisted ?? false),
    // Omitted stays omitted: installing this checker never changes an existing policy digest.
    ...(scenarioCoverage === undefined ? {} : { scenarioCoverage }),
    // Omission is preserved rather than normalized to a disabled object. This keeps old policy
    // digests and old Story behaviour byte-for-byte stable when WEL was never configured.
    ...(witnessedClauses ? { witnessedClauses } : {})
  });
}

export const SPECIFICATION_DEFINITION_KINDS = Object.freeze(['requirements', 'implementation-spec']);

const SPECIFICATION_DEFINITION_KIND_SET = new Set(SPECIFICATION_DEFINITION_KINDS);


/**
 * Read the declared role of the exact primary output after the configuration/Story owner has
 * verified the compiled binding. A secondary report, a phase name, and clause-like text cannot
 * promote the primary artifact to a normative source.
 */
export function skillPhasePrimaryOutputRole(phase) {
  if (!phase || typeof phase !== 'object' || phase.kind !== 'skill') return null;
  let binding;
  try { binding = validateSkillPhaseBindingHeader(phase.skillBinding, phase.id); }
  catch { return null; }
  const artifact = phase.requiredArtifact ?? phase.artifact;
  const outputs = binding.bindingRefs?.outputs;
  if (!Array.isArray(outputs)) return null;
  const matches = outputs.filter((output) =>
    output?.path === artifact?.path && output.kind === artifact?.kind && output.required === true);
  return matches.length === 1 ? matches[0].claimRole : null;
}


/**
 * Only producer artifacts that define requirements may contribute clauses to the authoritative
 * specification universe. Reports may cite clauses without creating new requirements.
 */
export function isSpecificationDefinitionPhase(phase) {
  // Skill contracts use their reviewed role even when the chosen artifact kind happens to be
  // called requirements. Findings and evidence therefore remain references, never new law.
  if (typeof phase === 'object' && (phase?.kind === 'skill' || phase?.skillBinding != null)) {
    return skillPhasePrimaryOutputRole(phase) === 'criteria';
  }
  const kind = typeof phase === 'string'
    ? phase
    : phase?.requiredArtifact?.kind ?? phase?.artifact?.kind ?? null;
  // Historical workflow snapshots did not persist the artifact kind on every phase. They remain
  // readable as definition producers; current snapshots always carry the kind and therefore
  // exclude reports/convergence artifacts explicitly. Treating an absent legacy field as a
  // reference-only report would silently erase already-approved clauses from grounding.
  return kind == null || SPECIFICATION_DEFINITION_KIND_SET.has(kind);
}

/** taggedAcceptanceIds' result without the tag lines in `excluded`, which bind nothing here. */
export function withoutTags(tags, excluded) {
  const drop = new Set(excluded);
  const locations = tags.locations.filter((location) => !drop.has(location));
  const bindings = new Map(locations.map((location) => [JSON.stringify([location.clauseId, location.testSource]),
    { clauseId: location.clauseId, testSource: location.testSource, bindingAssurance: 'namespace-qualified' }]));
  return {
    ...tags, ids: [...new Set(locations.map((location) => location.clauseId))].sort(), locations,
    bindings: [...bindings.values()].sort((left, right) => left.clauseId.localeCompare(right.clauseId) || left.testSource.localeCompare(right.testSource))
  };
}

/**
 * The criteria a test tag can name [E2G-015]: the clauses of the Story's active specification
 * indexes, the same set submission binds each witness to (story-lineage witnessReviewSnapshot).
 * `namespaces` are the Story's own: its Work ID, the configured specification namespace and every
 * namespace its specification uses. Every one but the Work ID is in `sharedNamespaces`: a configured
 * namespace is the same for every Story of its work type, and two specifications may choose the
 * same one, so a file can already carry another Story's tag there. Null for a Story without a
 * specification index: one created before indexes existed, one whose specification mode is off,
 * or a route that omits scope.
 */
export function specificationCriteria(records, workflow, config = {}) {
  if (!(records?.indexes ?? []).length) return null;
  const clauses = records.indexes.flatMap((index) => index.clauses ?? []);
  const story = String(workflow?.workItem?.id ?? '').toUpperCase();
  const namespaces = new Set([story, (workflow?.resolution?.spec ?? config.spec)?.namespace,
    ...clauses.map((clause) => namespaceOf(clause?.id))]
    .filter(Boolean).map((value) => String(value).toUpperCase()));
  return {
    held: new Set(clauses.filter((clause) => clause?.bodySha256).map((clause) => String(clause.id).toUpperCase())),
    namespaces,
    sharedNamespaces: new Set([...namespaces].filter((namespace) => namespace !== story))
  };
}

/** The namespace of a qualified clause or criterion ID: everything before its colon. */
export function namespaceOf(clauseId) {
  return String(clauseId ?? '').split(':')[0];
}

/**
 * Whether a tag naming something the specification lacks is the Story's to correct [E2G-011,
 * E2G-015]: in its Work ID wherever it sits, in a namespace other Stories share only where the
 * generation added it, and in any other namespace never. `carried` returns the IDs the generation's
 * files already named at its baseline (carriedTags); it is asked only about a shared namespace.
 */
export function storyOwnsTag(criteria, clauseId, carried) {
  const namespace = namespaceOf(clauseId);
  if (!criteria?.namespaces.has(namespace)) return false;
  return !criteria.sharedNamespaces.has(namespace) || !carried().has(clauseId);
}

export function tagKey(relative, line) {
  return JSON.stringify([relative, line]);
}

/**
 * Test tags naming a criterion the specification does not hold, each with the file and line to
 * correct [E2G-015]. Submission refuses such a tag once it sits on an exactly identified test
 * (WEL_WITNESS_MAPPING_STALE), so publication refuses it first, in any namespace, and in a Story
 * without a specification index too: that Story holds no criterion for a test to witness. With an
 * index, a tag in the Story's Work ID is refused wherever it sits, so a mistyped criterion cannot
 * hide in a module whose runner only counts tests; in a namespace other Stories share, so is one
 * the generation adds. Another Story's tag that sits on no exact test binds nothing here and stays,
 * as do a legacy Story's tags its runner only counts. `carried` returns the criteria the tagged
 * files already named at the generation's baseline (carriedTags), given every tag read now; it is
 * asked only about a shared namespace, and by default nothing is carried. `owed` are the criteria
 * the step must tag; without an index they come from its earlier artifacts' text (acceptanceIds),
 * and their message says that removing the tag cannot help.
 */
export function* unknownCriterionTagsReplay(criteria, {
  locations = [], witnesses = [], unattachedTags = [], owed = []
} = {}) {
  const key = (testSource, clauseId) => JSON.stringify([testSource, String(clauseId ?? '').toUpperCase()]);
  // Exactly the witnesses submission reviews: an identified test with no gaps.
  const exact = new Set(witnesses.filter((witness) => witness.identity && !(witness.gaps ?? []).length)
    .map((witness) => key(witness.testSource, witness.clauseId)));
  const tagged = new Set(locations.map((location) => key(location.testSource, location.clauseId)));
  const occurrences = [
    ...locations,
    ...unattachedTags.flatMap((tag) => (tag.clauseIds ?? []).map((clauseId) => ({ clauseId, testSource: tag.testSource, line: tag.line }))),
    // A tag only the module's adapter reads still becomes a witness; name its test's line.
    ...witnesses.filter((witness) => !tagged.has(key(witness.testSource, witness.clauseId)))
      .map((witness) => ({ clauseId: witness.clauseId, testSource: witness.testSource, line: witness.line }))
  ];
  let carriedIds = null;

  const findings = new Map();
  for (const { clauseId: rawClauseId, testSource, line } of occurrences) {
    const clauseId = String(rawClauseId ?? '').toUpperCase();
    if (!clauseId || criteria?.held.has(clauseId)) continue;
    if (!exact.has(key(testSource, clauseId))) {
      const namespace=namespaceOf(clauseId);
      if(!criteria?.namespaces.has(namespace))continue;
      if(criteria.sharedNamespaces.has(namespace)){
        carriedIds??=yield Object.freeze({kind:'carried-criterion-tags',occurrences:occurrences.map(occurrence=>({
          clauseId:String(occurrence.clauseId??'').toUpperCase(),path:occurrence.testSource}))});
        if(carriedIds.has(clauseId))continue;
      }
    }
    const where = `${testSource}${line ? `:${line}` : ''}`;
    findings.set(JSON.stringify([testSource, line ?? null, clauseId]), {
      code: 'EVIDENCE_CRITERION_UNKNOWN', clauseId, path: testSource, line: line ?? null,
      message: criteria
        ? `@ac:${clauseId} at ${where} names a criterion the active specification does not hold.`
        : owed.includes(clauseId)
          ? `@ac:${clauseId} at ${where} names a criterion this step owes, but this Story has no specification index, so submission cannot review the test that witnesses it.`
          : `@ac:${clauseId} at ${where} names a criterion, but this Story has no specification index, so no test can witness one.`
    });
  }
  return [...findings.values()].sort((left, right) => left.path.localeCompare(right.path)
    || (left.line ?? 0) - (right.line ?? 0) || left.clauseId.localeCompare(right.clauseId));
}
/** Existing synchronous value API; the baseline reader is explicit and invoked only when owed. */
export function unknownCriterionTags(criteria,{carried=()=>new Set(),...inputs}={}) {
  const replay=unknownCriterionTagsReplay(criteria,inputs);let step=replay.next();
  while(!step.done)step=replay.next(carried(step.value.occurrences));
  return step.value;
}

export function recordOrder(left, right) {
  const generation = Number(left?.generation ?? -1) - Number(right?.generation ?? -1);
  if (generation) return generation;
  const timestamp = String(left?.completedAt ?? left?.recordedAt ?? '').localeCompare(String(right?.completedAt ?? right?.recordedAt ?? ''));
  if (timestamp) return timestamp;
  return String(left?.phase ?? '').localeCompare(String(right?.phase ?? ''));
}

export function sortedUnique(values) {
  return [...new Set(values.filter((value) => value != null).map(String))].sort();
}

export function mergePlannedClaimRecords(maps = []) {
  const grouped = new Map();
  for (const map of [...maps].sort(recordOrder)) {
    for (const [id, claim] of Object.entries(map?.claims ?? {})) {
      const current = grouped.get(id) ?? {
        expectedPaths: [], tests: [], dispositions: [], reasons: [], criteria: [], deviation: null, fulfillment: null, steps: [], observableResult: null, obligations: []
      };
      current.obligations.push({ ...claim, owner: map.phase ?? null });
      if (claim.fulfillment) current.fulfillment = claim.fulfillment;
      current.steps.push(...(claim.steps ?? []));
      if (claim.observableResult) current.observableResult = claim.observableResult;
      current.expectedPaths.push(...(claim.expectedPaths ?? []));
      current.tests.push(...(claim.tests ?? []));
      current.dispositions.push(claim.testDisposition ?? 'unspecified');
      if (claim.verificationCriterion) current.criteria.push(claim.verificationCriterion);
      if (claim.testReason) current.reasons.push(claim.testReason);
      if (claim.deviation != null) current.deviation = claim.deviation;
      grouped.set(id, current);
    }
  }
  return Object.fromEntries([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, value]) => {
    const tests = sortedUnique(value.tests);
    const allNotApplicable = value.dispositions.length > 0
      && value.dispositions.every((entry) => entry === 'not-applicable');
    const allNonTest = value.dispositions.length > 0
      && value.dispositions.every((entry) => entry === 'non-test') && new Set(value.criteria).size === 1;
    return [id, {
      expectedPaths: sortedUnique(value.expectedPaths),
      tests,
      testDisposition: tests.length ? 'applicable' : allNotApplicable ? 'not-applicable' : allNonTest ? 'non-test' : 'unspecified',
      testReason: tests.length || !allNotApplicable ? null : value.reasons.at(-1) ?? null,
      ...(!tests.length && allNonTest ? { verificationCriterion: value.criteria[0] } : {}),
      deviation: value.deviation,
      ...(value.fulfillment && new Set(value.obligations.map((claim) => claim.fulfillment ?? null)).size === 1 ? { fulfillment: value.fulfillment } : {}),
      ...(value.obligations.length > 1 ? { obligations: value.obligations } : {}),
      ...(value.steps.length ? { steps: sortedUnique(value.steps) } : {}),
      ...(value.observableResult ? { observableResult: value.observableResult } : {})
    }];
  }));
}

export function accountedAmendmentPaths(planned = []) {
  return [...new Set(planned.filter((record) => record?.amendment)
    .flatMap((record) => Object.values(record.accountedPaths ?? {}).flat()))].sort();
}

export const SOURCE_CHANGING_FULFILLMENT=Object.freeze(['new','modified']);
