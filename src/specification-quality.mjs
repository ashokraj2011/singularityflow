/**
 * Specification quality: "is the requirement good enough?" `[SPK:REQ-050]` … `[SPK:REQ-056]`
 *
 * Three questions get confused constantly, and `[SPK:CON-025]` insists they stay apart:
 * specification quality asks whether the requirement is good enough; verification asks whether the
 * implementation satisfies it; conformance asks whether the evidence traces to approved intent.
 * This module answers only the first, and only the deterministic part of it.
 *
 * **What the analyzer will not say** is the load-bearing constraint `[SPK:CON-027]`. It never claims
 * prose is complete, clear, consistent, or correct — those are judgements, and a tool that issues
 * them without a model is guessing while sounding certain. Undefined terms, ambiguous wording and
 * missing business behaviour are for a reviewer or an assisted candidate `[SPK:CON-028]`.
 *
 * So the findings here are all of one kind: things that are *checkably* wrong. A duplicate anchor.
 * A dependency pointing at a clause that does not exist. A cycle. An unresolved marker. A required
 * section that is absent. Each is a fact about the document, not an opinion about the writing.
 */
import { createHash } from 'node:crypto';

import { analysisLimits, assertWithinLimit, capWithDisclosure } from './analysis-limits.mjs';
import { extractMarkers, evaluateMarkerPolicy, markerPolicy, reconcileMarkers } from './clarification-markers.mjs';
import { extractClauses, ignoredRanges, isIgnored } from './specifications.mjs';
import { canonicalJson } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

export const SPECIFICATION_QUALITY_MODES = Object.freeze(['off', 'warn', 'enforce']);

/**
 * The first witnessed-clause profile is intentionally small. `[WEL:REQ-002]` … `[WEL:REQ-005]`
 *
 * These values describe specification structure only. In particular, accepting `Witness:
 * inspection` here does not make inspection enforce-grade evidence; that requires a separate typed
 * evidence contract. v0.2 permits only `test` in the policy's enforceable set.
 */
export const WITNESSED_CLAUSE_PROFILE = 'witnessed-v1';
export const WITNESS_TYPES = Object.freeze(['test', 'inspection', 'metric', 'runtime', 'manual']);
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
const WITNESSED_FIELDS = Object.freeze(['behavior', 'observable', 'witness']);

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

/**
 * The starter checklist `[SPK:REQ-052]`.
 *
 * Six articles, and deliberately none of them machine-decidable. That is the point: the checklist
 * is the *reviewer's* instrument `[SPK:REQ-059]`, and every article here is a question only a person
 * can answer about a specification they have read. The deterministic analyzer below supplies
 * evidence for them; it never answers them.
 */
export const STARTER_CHECKLIST = Object.freeze({
  id: 'requirements-quality-v1',
  version: 1,
  articles: Object.freeze([
    { id: 'completeness', title: 'Completeness', question: 'Does the specification cover every scenario the work is expected to serve, including failure and empty states?' },
    { id: 'ambiguity', title: 'Ambiguity', question: 'Is every requirement free of wording that two competent readers could implement differently?' },
    { id: 'consistency', title: 'Consistency', question: 'Do the requirements agree with each other, with the scenarios, and with the cited constitution articles?' },
    { id: 'verifiability', title: 'Verifiability', question: 'Can each requirement be proved or disproved by a stated test, check, or observation?' },
    { id: 'boundary-conditions', title: 'Boundary conditions', question: 'Are limits, sizes, counts, and timeouts stated, with the behaviour at and beyond each one?' },
    { id: 'non-functional', title: 'Non-functional requirements', question: 'Are latency, availability, privacy, accessibility and retention stated as measurable numbers rather than adjectives?' }
  ])
});

/** Decisions a reviewer may record for an article `[SPK:REQ-060]`. */
export const CHECKLIST_DECISIONS = Object.freeze(['satisfied', 'exception', 'not-applicable']);

/** Sections the starter template leads with, and whose absence is checkable. */
const REQUIRED_SECTIONS = Object.freeze(['Actors', 'User scenarios', 'Requirements']);

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
  return Object.freeze({
    mode,
    checklist,
    exceptionAuthority,
    // Assisted analysis is opt-in and never the default; the deterministic path must stand alone.
    assisted: Boolean(value?.assisted ?? false),
    // Omission is preserved rather than normalized to a disabled object. This keeps old policy
    // digests and old Story behaviour byte-for-byte stable when WEL was never configured.
    ...(witnessedClauses ? { witnessedClauses } : {})
  });
}

/** The hash a report binds itself to, so a finding set is traceable to the policy that produced it. */
export function policyHash(policy, checklist = STARTER_CHECKLIST) {
  return createHash('sha256')
    .update(canonicalJson({ policy: specificationQualityPolicy(policy), checklist }))
    .digest('hex');
}

function sectionsOf(markdown) {
  return new Set(String(markdown).split('\n')
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => line.replace(/^#+\s*/, '').trim().toLowerCase()));
}

function asciiLowerCase(value) {
  return String(value).replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

function escapedRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function witnessedHeadingIsValid(markdown, clause) {
  const line = String(markdown).split('\n')[Number(clause.source?.line ?? 1) - 1] ?? '';
  return new RegExp(
    `^ {0,3}#{1,6}[\\t ]+${escapedRegExp(clause.anchor)}(?:[\\t ]+#+)?[\\t ]*\\r?$`
  ).test(line);
}

/**
 * Parse only explicit field declarations. There is no prose inference here: a sentence mentioning
 * a behavior is not silently promoted into the governed `Behavior:` field. `[WEL:CON-007]`
 */
function witnessedFields(body) {
  const occurrences = Object.fromEntries(WITNESSED_FIELDS.map((field) => [field, []]));
  const malformed = Object.fromEntries(WITNESSED_FIELDS.map((field) => [field, []]));
  const ignored = ignoredRanges(String(body));
  let lineStart = 0;
  for (const [offset, rawLine] of String(body).split('\n').entries()) {
    const candidate = rawLine.trim().replace(/^[-*+]\s+/, '');
    const candidateOffset = rawLine.indexOf(candidate);
    if (!candidate || isIgnored(lineStart + Math.max(0, candidateOffset), ignored)) {
      lineStart += rawLine.length + 1;
      continue;
    }
    const recordMalformed = () => {
      const folded = asciiLowerCase(candidate);
      for (const field of WITNESSED_FIELDS) {
        if (folded === field || folded.startsWith(`${field} `) || folded.startsWith(`${field}-`)) {
          malformed[field].push(offset);
        }
      }
    };
    const colon = candidate.indexOf(':');
    if (colon >= 0) {
      const field = asciiLowerCase(candidate.slice(0, colon).trim());
      if (WITNESSED_FIELDS.includes(field)) {
        const value = candidate.slice(colon + 1).trim();
        occurrences[field].push({
          value,
          bytes: Buffer.byteLength(value, 'utf8')
        });
      } else recordMalformed();
    } else {
      recordMalformed();
    }
    lineStart += rawLine.length + 1;
  }
  return { occurrences, malformed };
}

/** Exact authored field values for a human witness-mapping review; never used as a verdict. */
export function witnessedClauseReviewFields(body) {
  const parsed = witnessedFields(body);
  return Object.freeze(Object.fromEntries(WITNESSED_FIELDS.map((field) => [
    field,
    parsed.occurrences[field].length === 1 && parsed.malformed[field].length === 0
      ? parsed.occurrences[field][0].value
      : null
  ])));
}

function boundedDiagnosticValue(value, maximum = 80) {
  const compact = String(value).replace(/\s+/g, ' ').trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum)}…`;
}

function fieldStatus(occurrences, malformedLines, maximumBytes) {
  if (!occurrences.length) return malformedLines.length ? 'malformed' : 'missing';
  if (occurrences.length > 1) return 'duplicate';
  if (!occurrences[0].value) return 'empty';
  if (occurrences[0].bytes > maximumBytes) return 'over-limit';
  if (malformedLines.length) return 'malformed';
  return 'present';
}

/** Build the optional witnessed-clause projection from the authoritative extracted clauses. */
function analyzeWitnessedClauses(markdown, clauses, policy) {
  const findings = [];
  const add = (kind, message, detail = {}) => findings.push({ kind, message, ...detail });
  // `acceptance` is the only v0.2 selector and maps to the kernel's existing `AC` identity. No
  // second WEL anchor namespace or clause index is introduced.
  const enrolled = clauses.filter((clause) => clause.type === 'AC');
  const selected = enrolled.slice(0, policy.limits.maxClauses);
  const truncations = [];
  if (enrolled.length > selected.length) {
    const dropped = enrolled.length - selected.length;
    add(
      'witnessed-clause-limit-exceeded',
      `${enrolled.length} acceptance clauses exceed witnessedClauses.limits.maxClauses ${policy.limits.maxClauses}; ${dropped} clauses were not analyzed.`,
      { actual: enrolled.length, limit: policy.limits.maxClauses, dropped }
    );
    truncations.push({
      limit: 'maxClauses', actual: enrolled.length, kept: selected.length, dropped,
      disclosure: `${dropped} enrolled acceptance clauses were not analyzed because the configured clause bound is ${policy.limits.maxClauses}.`
    });
  }

  const projections = selected.map((clause) => {
    const headingValid = witnessedHeadingIsValid(markdown, clause);
    if (!headingValid) {
      add(
        'witnessed-clause-heading-malformed',
        `clause ${clause.id} must use a standalone Markdown heading containing only its existing anchor`,
        { clauseId: clause.id, line: clause.source?.line ?? null }
      );
    }
    const parsed = witnessedFields(clause.body);
    for (const field of WITNESSED_FIELDS) {
      const entries = parsed.occurrences[field];
      const malformedLines = parsed.malformed[field];
      if (!entries.length) {
        add('witnessed-field-missing', `clause ${clause.id} has no ${field[0].toUpperCase()}${field.slice(1)} field`, {
          clauseId: clause.id, field
        });
      }
      if (entries.length > 1) {
        add('witnessed-field-duplicate', `clause ${clause.id} has ${entries.length} ${field[0].toUpperCase()}${field.slice(1)} fields; exactly one is required`, {
          clauseId: clause.id, field, occurrences: entries.length
        });
      }
      if (entries.some((entry) => !entry.value)) {
        add('witnessed-field-empty', `clause ${clause.id} has an empty ${field[0].toUpperCase()}${field.slice(1)} field`, {
          clauseId: clause.id, field
        });
      }
      if (malformedLines.length) {
        add('witnessed-field-malformed', `clause ${clause.id} has a malformed ${field[0].toUpperCase()}${field.slice(1)} declaration; use '${field[0].toUpperCase()}${field.slice(1)}: value'`, {
          clauseId: clause.id, field
        });
      }
      const oversized = entries.filter((entry) => entry.bytes > policy.limits.maxFieldBytes);
      if (oversized.length) {
        add(
          'witnessed-field-limit-exceeded',
          `clause ${clause.id} ${field[0].toUpperCase()}${field.slice(1)} field exceeds witnessedClauses.limits.maxFieldBytes ${policy.limits.maxFieldBytes}`,
          { clauseId: clause.id, field, actualBytes: Math.max(...oversized.map((entry) => entry.bytes)), limit: policy.limits.maxFieldBytes }
        );
      }
    }

    const declaredWitnesses = parsed.occurrences.witness
      .map((entry) => entry.value)
      .filter(Boolean);
    const unknownWitnesses = declaredWitnesses.filter((value) => !WITNESS_TYPES.includes(value));
    if (unknownWitnesses.length) {
      add(
        'witnessed-witness-unknown',
        `clause ${clause.id} declares unknown Witness value '${boundedDiagnosticValue(unknownWitnesses[0])}'; allowed values are ${WITNESS_TYPES.join(', ')}`,
        { clauseId: clause.id, field: 'witness' }
      );
    }
    const declaredWitnessType = declaredWitnesses.length === 1
      ? (WITNESS_TYPES.includes(declaredWitnesses[0]) ? declaredWitnesses[0] : boundedDiagnosticValue(declaredWitnesses[0]))
      : null;
    const witnessType = declaredWitnesses.length === 1 && WITNESS_TYPES.includes(declaredWitnesses[0])
      ? declaredWitnesses[0]
      : null;
    return {
      clauseId: clause.id,
      line: clause.source?.line ?? null,
      heading: headingValid ? 'present' : 'malformed',
      fields: Object.fromEntries(WITNESSED_FIELDS.map((field) => [field, {
        status: fieldStatus(parsed.occurrences[field], parsed.malformed[field], policy.limits.maxFieldBytes),
        occurrences: parsed.occurrences[field].length,
        bytes: parsed.occurrences[field].length === 1 ? parsed.occurrences[field][0].bytes : null
      }])),
      declaredWitnessType,
      witnessType,
      enforceable: witnessType !== null && policy.enforceableWitnessTypes.includes(witnessType)
    };
  });

  const report = (reportedClauses, disclosures = truncations) => ({
    profile: policy.profile,
    clauseTypes: policy.clauseTypes,
    enforceableWitnessTypes: policy.enforceableWitnessTypes,
    lexicalHintsMode: policy.lexicalHints,
    enrolledClauseCount: enrolled.length,
    analyzedClauseCount: selected.length,
    reportedClauseCount: reportedClauses.length,
    clauses: reportedClauses,
    // Lexical hints are presentation-only and never enter `findings`, even when advisory mode is
    // selected. The initial structural slice deliberately emits none.
    lexicalHints: [],
    findingCount: findings.length,
    ...(disclosures.length ? { truncated: { disclosures } } : {})
  });

  let projection = report(projections);
  const unboundedBytes = Buffer.byteLength(canonicalJson(projection), 'utf8');
  if (unboundedBytes > policy.limits.maxReportBytes) {
    add(
      'witnessed-report-limit-exceeded',
      `witnessed clause report exceeds witnessedClauses.limits.maxReportBytes ${policy.limits.maxReportBytes}; clause projections were truncated`,
      { actualBytes: unboundedBytes, limit: policy.limits.maxReportBytes }
    );
    let kept = [...projections];
    while (true) {
      const reportDisclosure = {
        limit: 'maxReportBytes', actualBytes: unboundedBytes, maximumBytes: policy.limits.maxReportBytes,
        kept: kept.length, dropped: projections.length - kept.length,
        disclosure: `${projections.length - kept.length} analyzed clause projections were omitted to keep the witnessed report within ${policy.limits.maxReportBytes} bytes.`
      };
      projection = report(kept, [...truncations, reportDisclosure]);
      if (Buffer.byteLength(canonicalJson(projection), 'utf8') <= policy.limits.maxReportBytes) break;
      if (!kept.length) {
        throw new SingularityFlowError(
          `specificationQuality.witnessedClauses.limits.maxReportBytes ${policy.limits.maxReportBytes} is too small for the bounded report envelope.`
        );
      }
      kept = kept.slice(0, -1);
    }
  }
  return { findings, report: projection };
}

/**
 * Deterministic specification analysis `[SPK:REQ-054]` `[SPK:REQ-055]`.
 *
 * Pure over its inputs and free of a clock, so the same artifact bytes always produce the same
 * findings `[SPK:REQ-056]` — the observation timestamp is the caller's to add.
 */
export function analyzeSpecification(markdown, {
  artifactPath = null, phase = null, generation = null, policy = {}, checklist = STARTER_CHECKLIST,
  previousMarkers = [], answers = [], namespace = null, limits = undefined
} = {}) {
  const resolved = specificationQualityPolicy(policy);
  // `[SPK:REQ-130]`: refused rather than analysed. A document this size is a mistake, and spending
  // the analysis budget proving that helps nobody.
  const bounds = analysisLimits(limits);
  assertWithinLimit(Buffer.byteLength(String(markdown), 'utf8'), 'maxArtifactBytes', {
    limits: bounds, label: `Specification ${artifactPath ?? 'artifact'}`, unit: ' bytes'
  });
  const findings = [];
  const add = (kind, message, detail = {}) => findings.push({ kind, message, ...detail });

  let clauses = [];
  try {
    // `extractClauses` returns the array itself, and names the dependency edge `dependsOn` and the
    // clause text `body`. Reading `.clauses`, `.dependencies` and `.text` produced zero findings on
    // every document — a dead check that looks exactly like a clean one.
    clauses = extractClauses(markdown, { sourcePath: artifactPath, namespace });
  } catch (error) {
    add('clause-extraction-failed', error.message);
  }

  // Duplicate anchors, dangling dependencies and cycles are **not** re-checked here. The kernel's
  // own `extractClauses` already refuses all three and throws with a precise message, which the
  // catch above surfaces as a finding. A second implementation would be a weaker copy of a check
  // that is already better placed — and, as written, unreachable, which is the kind of dead check
  // that reads as a clean result forever.
  // Two active clauses whose normalized text is identical are one requirement written twice, and
  // they will be verified twice and traced twice.
  const normalized = new Map();
  for (const clause of clauses) {
    const text = String(clause.body ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!text) continue;
    if (normalized.has(text)) add('duplicate-clause-text', `clauses ${normalized.get(text)} and ${clause.id} state the same requirement`, { clauseId: clause.id });
    else normalized.set(text, clause.id);
  }

  const { markers, malformed } = extractMarkers(markdown);
  const reconciled = reconcileMarkers({ current: markers, previous: previousMarkers, answers });
  for (const marker of reconciled.open) add('unresolved-clarification', `unresolved clarification marker at line ${marker.line}: ${marker.question}`, { line: marker.line });
  for (const marker of malformed) add('malformed-clarification', `malformed clarification marker at line ${marker.line}: ${marker.reason}`, { line: marker.line });
  for (const marker of reconciled.vanished) add('clarification-removed-unanswered', `clarification marker removed without a recorded answer: ${marker.question}`);

  const present = sectionsOf(markdown);
  for (const section of REQUIRED_SECTIONS) {
    if (!present.has(section.toLowerCase())) add('missing-required-section', `the specification has no '${section}' section`, { section });
  }

  const witnessed = resolved.witnessedClauses
    ? analyzeWitnessedClauses(markdown, clauses, resolved.witnessedClauses)
    : null;
  if (witnessed) findings.push(...witnessed.findings);

  const ordered = findings.sort((left, right) =>
    left.kind.localeCompare(right.kind) || String(left.message).localeCompare(String(right.message)));
  // Capped *and disclosed*: a list of 500 findings that stops at 500 reads exactly like a complete
  // list of 500, and a reader has no way to tell which one they are looking at.
  const capped = capWithDisclosure(ordered, 'maxFacts', { limits: bounds, label: 'findings' });
  const sorted = capped.items;

  return {
    schemaVersion: 1,
    resultType: 'specification-quality-analysis',
    // Bound to exactly what produced it `[SPK:REQ-054]`, so a report cannot be quoted against a
    // different artifact than the one it read.
    binding: {
      artifactPath,
      artifactSha256: createHash('sha256').update(String(markdown), 'utf8').digest('hex'),
      phase,
      generation,
      policySha256: policyHash(resolved, checklist),
      checklist: checklist.id
    },
    mode: resolved.mode,
    clauseCount: clauses.length,
    // The IDs, not only the count. An assisted pass citing `APP:REQ-009` in a document that stops at
    // REQ-004 has to be checkable against something, and re-extracting the clauses at the caller
    // would be a second reading of the same bytes that could disagree with this one.
    clauseIds: clauses.map((clause) => clause.id),
    markerCount: markers.length,
    // The reconciled marker sets, not only their count. Every consumer needs them — the publication
    // gate to decide, the review packet to render `[SPK:REQ-059]` — and each one re-extracting them
    // would be a second place for the rules to drift from this one.
    markers: {
      open: reconciled.open.map(({ question, questionHash, line }) => ({ question, questionHash, line })),
      resolved: reconciled.resolved.map(({ question, questionHash }) => ({ question, questionHash })),
      vanished: reconciled.vanished.map(({ question, questionHash, reason }) => ({ question, questionHash, reason })),
      malformed: malformed.map(({ line, reason }) => ({ line, reason }))
    },
    ...(witnessed ? { witnessedClauses: witnessed.report } : {}),
    findings: sorted,
    ...(capped.disclosure ? { truncated: { dropped: capped.dropped, disclosure: capped.disclosure } } : {}),
    // Said out loud in the report itself, because a clean deterministic run is the moment someone
    // is most likely to read it as "the specification is good" `[SPK:CON-027]`.
    disclaimer: 'Deterministic analysis only. It reports checkable defects and makes no claim that the specification is complete, clear, consistent, or correct.'
  };
}

/**
 * Findings that belong to the marker policy rather than to this one.
 *
 * The two policies are pinned separately `[SPK:REQ-064]`, so an unresolved marker must be reported
 * by exactly one of them. Reported by both, a single omission reads as two problems and the reviewer
 * cannot tell which gate they are actually standing in front of.
 */
export const MARKER_FINDING_KINDS = Object.freeze([
  'unresolved-clarification', 'malformed-clarification', 'clarification-removed-unanswered'
]);

/**
 * Apply the policy to a report: `enforce` blocks, `warn` reports, `off` is silent.
 *
 * `exclude` lets the caller hand the marker findings to the marker policy instead. It defaults to
 * empty so a direct `spec analyze` still shows the reader everything the analyzer found.
 */
export function evaluateSpecificationQuality(report, { exclude = [] } = {}) {
  const messages = report.findings
    .filter((finding) => !exclude.includes(finding.kind))
    .map((finding) => finding.message);
  if (report.mode === 'off' || !messages.length) return { errors: [], warnings: [] };
  return report.mode === 'enforce' ? { errors: messages, warnings: [] } : { errors: [], warnings: messages };
}

/**
 * Every required article must carry a decision, or the approval does not count `[SPK:REQ-181]`.
 *
 * A model may summarize the evidence, but it may not produce this record under a human's identity
 * `[SPK:CON-030]` — so the caller passes the decisions an authenticated human actually made, and an
 * absent article is a refusal rather than a default.
 */
export function validateChecklistDecisions(decisions = [], { checklist = STARTER_CHECKLIST, mode = 'enforce' } = {}) {
  const byArticle = new Map(decisions.map((entry) => [entry.article, entry]));
  const problems = [];
  for (const article of checklist.articles) {
    const decision = byArticle.get(article.id);
    if (!decision) { problems.push(`checklist article '${article.id}' has no decision`); continue; }
    if (!CHECKLIST_DECISIONS.includes(decision.decision)) {
      problems.push(`checklist article '${article.id}' has decision '${decision.decision}'; expected ${CHECKLIST_DECISIONS.join(', ')}`);
    }
    // An exception is a considered choice, and a considered choice has a reason `[SPK:REQ-061]`.
    if (decision.decision !== 'satisfied' && !String(decision.reason ?? '').trim()) {
      problems.push(`checklist article '${article.id}' is '${decision.decision}' and needs a human-authored reason`);
    }
  }
  return mode === 'enforce' ? { errors: problems, warnings: [] } : { errors: [], warnings: problems };
}

export { evaluateMarkerPolicy, markerPolicy };
