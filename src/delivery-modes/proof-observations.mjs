/**
 * GDP-M4 deterministic intent, testability, impact, and environment observations.
 *
 * This module is intentionally pure. It consumes already-bounded records supplied by an adapter;
 * it never reads source, invokes a model, starts a test, rebuilds the World Model, or decides a
 * reviewer checklist. Unsupported or incomplete inputs stay visible as `unavailable`.
 */
import { canonicalJson, recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const REASON = /^[A-Z][A-Z0-9_]{2,95}$/;
const MAX_ITEMS = 256;
const MAX_BYTES = 64 * 1024;
const CHECKLIST = Object.freeze([
  'completeness', 'ambiguity', 'consistency', 'verifiability',
  'boundary-conditions', 'non-functional'
]);
const JAVA_ORACLE = /\b(?:assertEquals|assertNotEquals|assertTrue|assertFalse|assertNull|assertNotNull|assertSame|assertNotSame|assertArrayEquals|assertIterableEquals|assertLinesMatch|assertThrows|assertThrowsExactly|assertDoesNotThrow|fail|verify)\s*\(/u;
const JAVA_LIFECYCLE = /@(?:AfterEach|AfterAll|BeforeEach|BeforeAll)\b/u;

export const M4_RECORD_FAMILIES = Object.freeze({
  'impact-should-set': Object.freeze({
    hashField: 'shouldSetSha256', keys: [
      'schemaVersion', 'kind', 'proofSubjectSha256', 'policySha256', 'worldModel',
      'items', 'assurance', 'authority', 'gateEligible', 'shouldSetSha256'
    ]
  }),
  'impact-disposition': Object.freeze({
    hashField: 'dispositionSha256', keys: [
      'schemaVersion', 'kind', 'proofSubjectSha256', 'shouldSetSha256', 'decidedBy',
      'items', 'dispositionSha256'
    ]
  }),
  'environment-profile': Object.freeze({
    hashField: 'profileSha256', keys: [
      'schemaVersion', 'kind', 'proofSubjectSha256', 'platform', 'architecture',
      'runtime', 'toolchainSha256', 'dependencyLockSha256', 'localePolicy',
      'clockPolicy', 'profileSha256'
    ]
  }),
  'environment-attestation': Object.freeze({
    hashField: 'attestationSha256', keys: [
      'schemaVersion', 'kind', 'proofSubjectSha256', 'candidateSha256',
      'environmentProfileSha256', 'commandSha256', 'adapter', 'resultSha256',
      'status', 'gaps', 'attestationSha256'
    ]
  }),
  'nondeterminism-profile': Object.freeze({
    hashField: 'nondeterminismSha256', keys: [
      'schemaVersion', 'kind', 'proofSubjectSha256', 'witnessSha256', 'attempts',
      'outcomes', 'status', 'gaps', 'nondeterminismSha256'
    ]
  })
});

function fail(message, code = 'PFC_PREDICATE_INPUT_INVALID') {
  throw new SingularityFlowError(message, { code });
}

function exactObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function exactKeys(value, keys, label) {
  const actual = Object.keys(exactObject(value, label)).sort();
  if (canonicalJson(actual) !== canonicalJson([...keys].sort())) fail(`${label} has an invalid field set.`);
}

function digest(value, label, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (!DIGEST.test(String(value ?? ''))) fail(`${label} must be a sha256 digest.`);
  return String(value);
}

function id(value, label) {
  const text = String(value ?? '');
  if (!ID.test(text)) fail(`${label} is invalid.`);
  return text;
}

function reason(value, label) {
  const text = String(value ?? '');
  if (!REASON.test(text)) fail(`${label} is invalid.`);
  return text;
}

function text(value, label, maximum = 512) {
  const result = String(value ?? '');
  if (!result || Buffer.byteLength(result, 'utf8') > maximum || /[\u0000-\u001f\u007f]/u.test(result)) {
    fail(`${label} must be non-empty bounded text.`);
  }
  return result;
}

function integer(value, label, minimum = 0, maximum = 1_000_000) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function sortedUnique(values, normalize, label, maximum = MAX_ITEMS) {
  if (!Array.isArray(values) || values.length > maximum) fail(`${label} exceeds ${maximum} entries.`);
  const normalized = values.map((value, index) => normalize(value, `${label}[${index}]`));
  const unique = new Map(normalized.map((value) => [canonicalJson(value), value]));
  if (unique.size !== normalized.length) fail(`${label} contains duplicate entries.`);
  return [...unique.values()].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function semanticRecord(family, fields) {
  const descriptor = M4_RECORD_FAMILIES[family];
  if (!descriptor) fail(`Unknown M4 record family '${family}'.`, 'PFC_SCHEMA_UNAVAILABLE');
  const core = { schemaVersion: currentSchemaVersion(family), kind: family, ...fields };
  const record = { ...core, [descriptor.hashField]: `sha256:${recordSha256(core)}` };
  if (Buffer.byteLength(canonicalJson(record), 'utf8') > MAX_BYTES) {
    fail(`${family} exceeds its ${MAX_BYTES}-byte ceiling.`, 'PFC_RECORD_TOO_LARGE');
  }
  return Object.freeze(record);
}

function worldModel(value) {
  exactKeys(value, ['status', 'baselineSha256', 'candidateDeltaSha256', 'reasonCode'], 'worldModel');
  if (!['ready', 'unavailable', 'not-required'].includes(value.status)) fail('worldModel.status is invalid.');
  const result = {
    status: value.status,
    baselineSha256: digest(value.baselineSha256, 'worldModel.baselineSha256', { nullable: true }),
    candidateDeltaSha256: digest(value.candidateDeltaSha256, 'worldModel.candidateDeltaSha256', { nullable: true }),
    reasonCode: value.reasonCode == null ? null : reason(value.reasonCode, 'worldModel.reasonCode')
  };
  if (result.status === 'ready' && !result.baselineSha256) fail('A ready World Model requires a baseline digest.');
  if (result.status !== 'ready' && (result.baselineSha256 || result.candidateDeltaSha256)) {
    fail('Unavailable or not-required World Model bindings cannot carry model digests.');
  }
  return result;
}

function shouldItem(value, label) {
  exactKeys(value, ['itemId', 'resource', 'basisSha256', 'status'], label);
  if (!['observed', 'unavailable'].includes(value.status)) fail(`${label}.status is invalid.`);
  return {
    itemId: id(value.itemId, `${label}.itemId`),
    resource: text(value.resource, `${label}.resource`, 512),
    basisSha256: digest(value.basisSha256, `${label}.basisSha256`),
    status: value.status
  };
}

export function buildImpactShouldSet({
  proofSubjectSha256, policySha256, worldModel: model, items = [], assurance = 'observed'
} = {}) {
  return semanticRecord('impact-should-set', {
    proofSubjectSha256: digest(proofSubjectSha256, 'proofSubjectSha256'),
    policySha256: digest(policySha256, 'policySha256'),
    worldModel: worldModel(model),
    items: sortedUnique(items, shouldItem, 'items'),
    assurance: id(assurance, 'assurance'),
    authority: 'none',
    gateEligible: false
  });
}

function dispositionItem(value, label) {
  exactKeys(value, ['itemId', 'disposition', 'reason'], label);
  if (!['claimed', 'excluded', 'deferred', 'requires-workflow'].includes(value.disposition)) {
    fail(`${label}.disposition is invalid.`);
  }
  return {
    itemId: id(value.itemId, `${label}.itemId`), disposition: value.disposition,
    reason: text(value.reason, `${label}.reason`)
  };
}

export function buildImpactDisposition({
  proofSubjectSha256, shouldSetSha256, decidedBy, items = []
} = {}) {
  exactKeys(decidedBy, ['kind', 'identitySha256', 'authoritySha256'], 'decidedBy');
  if (!['human', 'policy'].includes(decidedBy.kind)) fail('decidedBy.kind is invalid.');
  const actor = {
    kind: decidedBy.kind,
    identitySha256: digest(decidedBy.identitySha256, 'decidedBy.identitySha256', { nullable: true }),
    authoritySha256: digest(decidedBy.authoritySha256, 'decidedBy.authoritySha256', { nullable: true })
  };
  if (actor.kind === 'human' && !actor.identitySha256) fail('A human disposition requires an identity digest.');
  if (actor.kind === 'policy' && !actor.authoritySha256) fail('A policy disposition requires an authority digest.');
  return semanticRecord('impact-disposition', {
    proofSubjectSha256: digest(proofSubjectSha256, 'proofSubjectSha256'),
    shouldSetSha256: digest(shouldSetSha256, 'shouldSetSha256'),
    decidedBy: actor,
    items: sortedUnique(items, dispositionItem, 'items')
  });
}

export function buildEnvironmentProfile({
  proofSubjectSha256, platform, architecture, runtime, toolchainSha256 = null,
  dependencyLockSha256 = null, localePolicy = 'uncontrolled', clockPolicy = 'uncontrolled'
} = {}) {
  return semanticRecord('environment-profile', {
    proofSubjectSha256: digest(proofSubjectSha256, 'proofSubjectSha256'),
    platform: id(platform, 'platform'), architecture: id(architecture, 'architecture'),
    runtime: id(runtime, 'runtime'),
    toolchainSha256: digest(toolchainSha256, 'toolchainSha256', { nullable: true }),
    dependencyLockSha256: digest(dependencyLockSha256, 'dependencyLockSha256', { nullable: true }),
    localePolicy: id(localePolicy, 'localePolicy'), clockPolicy: id(clockPolicy, 'clockPolicy')
  });
}

export function buildEnvironmentAttestation({
  proofSubjectSha256, candidateSha256, environmentProfileSha256, commandSha256,
  adapter, resultSha256 = null, status = 'unavailable', gaps = []
} = {}) {
  if (!['passed', 'failed', 'unavailable'].includes(status)) fail('environment attestation status is invalid.');
  return semanticRecord('environment-attestation', {
    proofSubjectSha256: digest(proofSubjectSha256, 'proofSubjectSha256'),
    candidateSha256: digest(candidateSha256, 'candidateSha256'),
    environmentProfileSha256: digest(environmentProfileSha256, 'environmentProfileSha256'),
    commandSha256: digest(commandSha256, 'commandSha256'), adapter: id(adapter, 'adapter'),
    resultSha256: digest(resultSha256, 'resultSha256', { nullable: true }), status,
    gaps: sortedUnique(gaps, (value, label) => id(value, label), 'gaps')
  });
}

export function buildNondeterminismProfile({
  proofSubjectSha256, witnessSha256, attempts, outcomes = [], status = 'unavailable', gaps = []
} = {}) {
  if (!['stable', 'conflicting', 'unavailable'].includes(status)) fail('nondeterminism status is invalid.');
  const normalized = sortedUnique(outcomes, (value, label) => {
    exactKeys(value, ['attempt', 'resultSha256', 'outcome'], label);
    if (!['passed', 'failed', 'skipped', 'unavailable'].includes(value.outcome)) fail(`${label}.outcome is invalid.`);
    return {
      attempt: integer(value.attempt, `${label}.attempt`, 1, 100),
      resultSha256: digest(value.resultSha256, `${label}.resultSha256`), outcome: value.outcome
    };
  }, 'outcomes', 100);
  const attemptCount = integer(attempts, 'attempts', 0, 100);
  if (normalized.length !== attemptCount) fail('attempts must equal the number of exact outcomes.');
  if (status === 'stable' && (!normalized.length || new Set(normalized.map((entry) => entry.outcome)).size !== 1)) {
    fail('A stable profile requires one repeated outcome.');
  }
  if (status === 'conflicting' && new Set(normalized.map((entry) => entry.outcome)).size < 2) {
    fail('A conflicting profile requires different outcomes.');
  }
  return semanticRecord('nondeterminism-profile', {
    proofSubjectSha256: digest(proofSubjectSha256, 'proofSubjectSha256'),
    witnessSha256: digest(witnessSha256, 'witnessSha256'), attempts: attemptCount,
    outcomes: normalized, status,
    gaps: sortedUnique(gaps, (value, label) => id(value, label), 'gaps')
  });
}

export function validateM4Record(family, record) {
  const descriptor = M4_RECORD_FAMILIES[family];
  if (!descriptor) fail(`Unknown M4 record family '${family}'.`, 'PFC_SCHEMA_UNAVAILABLE');
  exactKeys(record, descriptor.keys, family);
  const readable = readRecord(family, record);
  if (readable.migratedThrough.length || record.kind !== family) fail(`${family} is not current.`, 'PFC_SCHEMA_UNAVAILABLE');
  const supplied = digest(record[descriptor.hashField], `${family}.${descriptor.hashField}`);
  const core = structuredClone(record);
  delete core[descriptor.hashField];
  if (supplied !== `sha256:${recordSha256(core)}`) fail(`${family} self hash is invalid.`, 'PFC_PROOF_SUBJECT_INVALID');
  if (Buffer.byteLength(canonicalJson(record), 'utf8') > MAX_BYTES) fail(`${family} exceeds its byte ceiling.`, 'PFC_RECORD_TOO_LARGE');
  return Object.freeze(structuredClone(record));
}

function javaLexicalMask(source) {
  const input = String(source);
  let output = '';
  let state = 'code';
  let quote = null;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (state === 'line-comment') {
      if (character === '\n') { state = 'code'; output += '\n'; } else output += ' ';
    } else if (state === 'block-comment') {
      if (character === '*' && next === '/') { output += '  '; index += 1; state = 'code'; }
      else output += character === '\n' ? '\n' : ' ';
    } else if (state === 'string') {
      if (character === '\\') { output += '  '; index += 1; }
      else if (character === quote) { output += ' '; state = 'code'; quote = null; }
      else output += character === '\n' ? '\n' : ' ';
    } else if (character === '/' && next === '/') {
      output += '  '; index += 1; state = 'line-comment';
    } else if (character === '/' && next === '*') {
      output += '  '; index += 1; state = 'block-comment';
    } else if (character === '"' || character === "'") {
      output += ' '; state = 'string'; quote = character;
    } else output += character;
  }
  if (state === 'block-comment' || state === 'string') fail('Java test source has an unterminated lexical construct.');
  return output;
}

function matchingBrace(source, opening) {
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) return index;
  }
  fail('Java test method has an unmatched body brace.');
}

/**
 * Bind the intentionally small reviewed JUnit 5/Surefire subset.
 *
 * The binder rejects parameterized/dynamic tests, nested classes, overloaded names, lifecycle
 * hooks, missing or ambiguous report identities, and bodies with no recognized failure-producing
 * oracle. Refusal is `exact: false`; it never guesses from a display name.
 */
export function bindReviewedJunit5Witnesses(sources = [], occurrences = []) {
  if (!Array.isArray(sources) || !Array.isArray(occurrences)
      || sources.length > 256 || occurrences.length > 100_000) {
    fail('JUnit witness inputs exceed the reviewed adapter bounds.');
  }
  const declarations = [];
  const gaps = new Set();
  for (const [sourceIndex, entry] of sources.entries()) {
    exactKeys(entry, ['path', 'contents'], `sources[${sourceIndex}]`);
    const sourcePath = text(entry.path, `sources[${sourceIndex}].path`, 512);
    if (!sourcePath.endsWith('.java')) { gaps.add('UNSUPPORTED_TEST_SOURCE'); continue; }
    const contents = String(entry.contents ?? '');
    if (!contents || Buffer.byteLength(contents, 'utf8') > 1024 * 1024) {
      gaps.add('TEST_SOURCE_LIMIT_EXCEEDED'); continue;
    }
    const masked = javaLexicalMask(contents);
    if (/@(?:ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|Nested)\b/u.test(masked)) {
      gaps.add('UNSUPPORTED_JUNIT5_CONSTRUCT'); continue;
    }
    if (JAVA_LIFECYCLE.test(masked)) {
      gaps.add('JUNIT_LIFECYCLE_HOOK_PRESENT'); continue;
    }
    const packageMatches = [...masked.matchAll(/\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/gu)];
    const classMatches = [...masked.matchAll(/\b(?:public\s+)?(?:final\s+)?class\s+([A-Za-z_$][\w$]*)[^\{]*\{/gu)];
    if (packageMatches.length > 1 || classMatches.length !== 1) {
      gaps.add('JAVA_CLASS_IDENTITY_AMBIGUOUS'); continue;
    }
    const packageName = packageMatches[0]?.[1] ?? null;
    const className = classMatches[0][1];
    const qualifiedClassName = packageName ? `${packageName}.${className}` : className;
    const method = /@(?:org\.junit\.jupiter\.api\.)?Test\b(?:\s*@\w+(?:\([^)]*\))?)*\s*(?:(?:public|protected|private|static|final|synchronized)\s+)*void\s+([A-Za-z_$][\w$]*)\s*\(\s*\)\s*(?:throws\s+[^\{]+)?\{/gu;
    for (const match of masked.matchAll(method)) {
      const opening = match.index + match[0].lastIndexOf('{');
      const closing = matchingBrace(masked, opening);
      const body = masked.slice(opening + 1, closing);
      const original = contents.slice(match.index, closing + 1);
      declarations.push({
        path: sourcePath, className: qualifiedClassName, methodName: match[1],
        declarationSha256: `sha256:${recordSha256({ sourcePath, bytes: original })}`,
        oracleProven: JAVA_ORACLE.test(body)
      });
    }
  }
  const identities = new Map();
  for (const declaration of declarations) {
    const key = `${declaration.className}#${declaration.methodName}`;
    if (identities.has(key)) gaps.add('TEST_DECLARATION_COLLISION');
    identities.set(key, declaration);
  }
  const bindings = [];
  for (const occurrence of occurrences) {
    const className = String(occurrence?.className ?? '');
    const methodName = String(occurrence?.name ?? '');
    if (!className || !methodName || !/^[A-Za-z_$][\w$]*$/u.test(methodName)) {
      gaps.add('REPORT_TEST_IDENTITY_UNAVAILABLE'); continue;
    }
    const declaration = identities.get(`${className}#${methodName}`);
    if (!declaration) { gaps.add('REPORT_SOURCE_DECLARATION_UNMATCHED'); continue; }
    if (!declaration.oracleProven) gaps.add('ORACLE_IDENTITY_UNAVAILABLE');
    if (occurrence.outcome !== 'passed') gaps.add(
      occurrence.outcome === 'skipped' ? 'SKIPPED_TESTS_PRESENT' : 'TEST_OUTCOME_NOT_PASSING'
    );
    bindings.push({
      className, methodName, sourcePath: declaration.path,
      declarationSha256: declaration.declarationSha256, outcome: occurrence.outcome
    });
  }
  if (!occurrences.length) gaps.add('REPORT_TESTCASE_OCCURRENCES_UNAVAILABLE');
  if (bindings.length !== occurrences.length) gaps.add('REPORT_SOURCE_COVERAGE_INCOMPLETE');
  const exact = gaps.size === 0 && bindings.length > 0;
  return Object.freeze({
    exact, adapter: 'junit5-surefire-reviewed-v1', bindings,
    oracleProven: exact, teardownProven: ![...gaps].includes('JUNIT_LIFECYCLE_HOOK_PRESENT'),
    retriesObserved: false, gaps: [...gaps].sort()
  });
}

function clauseObservation(clause) {
  const structural = clause?.structural === true;
  const witnessed = clause?.witnessed === true;
  const status = structural && witnessed ? 'observed' : 'unavailable';
  return {
    clauseId: id(clause?.clauseId, 'clause.clauseId'),
    bodySha256: digest(clause?.bodySha256, 'clause.bodySha256'),
    provenance: structural ? 'bound' : 'unavailable',
    testability: witnessed ? 'declared-witness' : 'unavailable',
    status
  };
}

/** Build the M4 view shown by proof status. It is a projection only and never a gate input. */
export function observeProofInputs({
  proofSubject, policySha256, clauses = [], checklistDecisions = [], shouldSetItems = [],
  environment = null, junit = null
} = {}) {
  const proofSubjectSha256 = digest(proofSubject?.proofSubjectSha256, 'proofSubject.proofSubjectSha256');
  const candidateSha256 = digest(proofSubject?.candidateSha256, 'proofSubject.candidateSha256');
  const model = worldModel(proofSubject?.worldModel);
  const normalizedClauses = sortedUnique(clauses, clauseObservation, 'clauses');
  const decisionByArticle = new Map((checklistDecisions ?? []).map((entry) => [entry.article, entry]));
  const checklist = CHECKLIST.map((article) => {
    const decision = decisionByArticle.get(article);
    return decision && ['satisfied', 'exception', 'not-applicable'].includes(decision.decision)
      ? { article, status: 'reviewed', decision: decision.decision }
      : { article, status: 'human-review-required', decision: null };
  });
  const shouldSet = buildImpactShouldSet({
    proofSubjectSha256, policySha256,
    worldModel: model,
    items: shouldSetItems,
    assurance: model.status === 'ready' ? 'bound-observation' : 'repository-observation'
  });
  let environmentProfile = null;
  let environmentAttestation = null;
  let nondeterminism = null;
  if (environment) {
    environmentProfile = buildEnvironmentProfile({ proofSubjectSha256, ...environment });
  }
  if (environmentProfile && junit) {
    const gaps = [...new Set([
      ...(junit.gaps ?? []),
      ...(junit.exact === true ? [] : ['TESTCASE_IDENTITY_NOT_EXACT']),
      ...(junit.skipped > 0 ? ['SKIPPED_TESTS_PRESENT'] : []),
      ...(junit.retriesObserved ? ['RETRY_SEMANTICS_UNAVAILABLE'] : []),
      ...(junit.teardownProven ? [] : ['TEARDOWN_STATUS_UNAVAILABLE']),
      ...(junit.oracleProven ? [] : ['ORACLE_IDENTITY_UNAVAILABLE'])
    ])].sort();
    const status = junit.failed > 0 ? 'failed'
      : junit.exact === true && junit.discovered > 0 && junit.skipped === 0 && gaps.length === 0
        ? 'passed' : 'unavailable';
    environmentAttestation = buildEnvironmentAttestation({
      proofSubjectSha256, candidateSha256,
      environmentProfileSha256: environmentProfile.profileSha256,
      commandSha256: digest(junit.commandSha256, 'junit.commandSha256'),
      adapter: junit.adapter ?? 'junit5-surefire-v1', resultSha256: junit.resultSha256 ?? null,
      status, gaps
    });
    const outcomes = junit.outcomes ?? [];
    nondeterminism = buildNondeterminismProfile({
      proofSubjectSha256,
      witnessSha256: junit.resultSha256 ?? junit.commandSha256,
      attempts: outcomes.length,
      outcomes,
      status: outcomes.length < 2 ? 'unavailable'
        : new Set(outcomes.map((entry) => entry.outcome)).size === 1 ? 'stable' : 'conflicting',
      gaps: outcomes.length < 2 ? ['IMMEDIATE_RERUN_UNAVAILABLE'] : []
    });
  }
  const gaps = [
    ...checklist.filter((entry) => entry.status !== 'reviewed').map((entry) => `CHECKLIST_${entry.article.toUpperCase().replaceAll('-', '_')}_UNREVIEWED`),
    ...normalizedClauses.filter((entry) => entry.status === 'unavailable').map((entry) => `CLAUSE_${entry.clauseId}_TESTABILITY_UNAVAILABLE`),
    ...(model.status === 'ready' ? [] : ['WORLD_MODEL_UNAVAILABLE_NON_BLOCKING']),
    ...(environment ? [] : ['ENVIRONMENT_PROFILE_UNAVAILABLE']),
    ...(junit ? [] : ['JUNIT5_SUREFIRE_OBSERVATION_UNAVAILABLE']),
    ...(environmentAttestation?.gaps ?? []),
    ...(nondeterminism?.gaps ?? [])
  ];
  const core = {
    schemaVersion: 1, // schema-transient: read-only aggregate; durable children are MIG registered.
    kind: 'gdp-m4-proof-input-observation', mode: 'observe', authority: 'none', gateEligible: false,
    proofSubjectSha256, clauses: normalizedClauses, checklist,
    shouldSet, environmentProfile, environmentAttestation, nondeterminism,
    gaps: [...new Set(gaps)].sort(),
    guarantees: {
      noModel: true, astRequired: false, worldModelRequired: false,
      exactTestIdentityRequiredForPass: true, reviewerJudgmentNotInferred: true,
      consumedByLifecycle: false
    }
  };
  return Object.freeze({ ...core, observationSha256: `sha256:${recordSha256(core)}` });
}
