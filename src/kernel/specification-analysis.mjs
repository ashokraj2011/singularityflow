/** Deterministic specification analysis over explicit UTF-8 values and declared review content. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson,textValueSyntax,TEXT_DIGEST_PROFILE,SPECIFICATION_ANALYSIS_REPORT_SCHEMA} from '../foundation/record-schema.mjs';
import {specificationQualityPolicy} from './specification-policy.mjs';
import {matchApprovalAuthority} from './approval-policy.mjs';
import {resolvedSpecificationQualityPolicy} from './specification-policy.mjs';
import {resolvedClarificationPolicy} from './phase-inputs.mjs';
import {analysisLimits,assertWithinLimit,capWithDisclosure} from './configuration-declarations.mjs';
import {specificationValuePolicies,ignoredRanges,isIgnored} from './specification-values.mjs';
import {extractMarkers,reconcileMarkers} from './specification-markers.mjs';
import {inspectSpecificationScenarios} from './specification-scenarios.mjs';
export const SPECIFICATION_ANALYSIS_DECLARATIONS='sflow-specification-analysis-declarations/v1';
export function specificationAnalysisPublicationPolicy(definition,workflow,phase) {
  const quality=resolvedSpecificationQualityPolicy(definition,workflow,phase),markerMode=resolvedClarificationPolicy(definition,workflow,phase).markers.mode;
  return quality.mode==='off'&&markerMode==='off'?null:{quality,markerMode};
}
export const WITNESS_TYPES = Object.freeze(['test', 'inspection', 'metric', 'runtime', 'manual']);
export const CHECKLIST_DECISIONS = Object.freeze(['satisfied', 'exception', 'not-applicable']);
export const MARKER_FINDING_KINDS = Object.freeze([
  'unresolved-clarification', 'malformed-clarification', 'clarification-removed-unanswered'
]);
function declaredContent(value) {
 if(!value||value.profile!==SPECIFICATION_ANALYSIS_DECLARATIONS||Object.keys(value).some(key=>!['profile','requiredSections','starterChecklist'].includes(key))
  ||!Array.isArray(value.requiredSections)||!value.requiredSections.length||value.requiredSections.length>256
  ||value.requiredSections.some(text=>typeof text!=='string'||!text||text.length>256))throw new SingularityFlowError('Use versioned specification-analysis content declarations.',{code:'ENGINE_INPUT_INVALID'});
 const checklist=value.starterChecklist;
 if(!checklist||typeof checklist.id!=='string'||!checklist.id||!Number.isSafeInteger(checklist.version)||checklist.version<1
  ||Object.keys(checklist).some(key=>!['id','version','articles'].includes(key))
  ||!Array.isArray(checklist.articles)||!checklist.articles.length||checklist.articles.length>256
  ||checklist.articles.some(article=>!article||Object.keys(article).some(key=>!['id','title','question'].includes(key))
    ||['id','title','question'].some(key=>typeof article[key]!=='string'||!article[key]||article[key].length>65536))
  ||new Set(checklist.articles.map(article=>article.id)).size!==checklist.articles.length)throw new SingularityFlowError('Declare the exact default checklist content.',{code:'ENGINE_INPUT_INVALID'});
 return {requiredSections:Object.freeze([...value.requiredSections]),starterChecklist:Object.freeze({...checklist,
  articles:Object.freeze(checklist.articles.map(article=>Object.freeze({...article})))})};
}
export const SPECIFICATION_GATE_EMPTY = Object.freeze({
  applies: false, markerMode: 'off', qualityMode: 'off',
  errors: [], warnings: [], open: [], report: null, record: null
});
export function specificationAnalysisPolicies(values,declarations) {
const {sha256Utf8,byteLengthUtf8}=textValueSyntax(values),declared=declaredContent(declarations);
const STARTER_CHECKLIST=declared.starterChecklist,REQUIRED_SECTIONS=declared.requiredSections;
const {extractClauses}=specificationValuePolicies(Object.freeze({profile:TEXT_DIGEST_PROFILE,sha256Utf8}));
const WITNESSED_FIELDS = Object.freeze(['behavior', 'observable', 'witness']);
function policyHash(policy, checklist = STARTER_CHECKLIST) {
  return sha256Utf8(canonicalJson({policy:specificationQualityPolicy(policy),checklist}));
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
          bytes: byteLengthUtf8(value)
        });
      } else recordMalformed();
    } else {
      recordMalformed();
    }
    lineStart += rawLine.length + 1;
  }
  return { occurrences, malformed };
}

function witnessedClauseReviewFields(body) {
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
  const unboundedBytes = byteLengthUtf8(canonicalJson(projection));
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
      if (byteLengthUtf8(canonicalJson(projection)) <= policy.limits.maxReportBytes) break;
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

function analyzeSpecification(markdown, {
  artifactPath = null, phase = null, generation = null, policy = {}, checklist = STARTER_CHECKLIST,
  previousMarkers = [], answers = [], namespace = null, limits = undefined
} = {}) {
  const resolved = specificationQualityPolicy(policy);
  // `[SPK:REQ-130]`: refused rather than analysed. A document this size is a mistake, and spending
  // the analysis budget proving that helps nobody.
  const bounds = analysisLimits(limits);
  assertWithinLimit(byteLengthUtf8(String(markdown)), 'maxArtifactBytes', {
    limits: bounds, label: `Specification ${artifactPath ?? 'artifact'}`, unit: ' bytes'
  });
  const findings = [];
  const add = (kind, message, detail = {}) => findings.push({ kind, message, ...detail });

  let clauses = [];
  let extracted = true;
  try {
    // `extractClauses` returns the array itself, and names the dependency edge `dependsOn` and the
    // clause text `body`. Reading `.clauses`, `.dependencies` and `.text` produced zero findings on
    // every document — a dead check that looks exactly like a clean one.
    clauses = extractClauses(markdown, { sourcePath: artifactPath, namespace });
  } catch (error) {
    extracted = false;
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
  // A numbered, bold or colon-ended heading read as no section: name the near miss.
  const loose = (text) => String(text).replace(/^[\s#]*/u, '').replace(/^\d+(?:\.\d+)*[.)]?\s+/u, '').replace(/[*_`]+/gu, '')
    .replace(/[:.]\s*$/u, '').trim().toLowerCase();
  for (const section of REQUIRED_SECTIONS) {
    if (present.has(section.toLowerCase())) continue;
    const near = String(markdown).split('\n').find((line) => (/^#{1,6}\s/u.test(line) || /^\s*(?:\*\*|__)/u.test(line))
      && loose(line) === section.toLowerCase());
    add('missing-required-section', `the specification has no '${section}' section${near
      ? `; '${near.trim()}' is not that heading: write it as a heading with exactly '${section}', without numbering, bold or a colon` : ''}`, { section });
  }

  const witnessed = resolved.witnessedClauses
    ? analyzeWitnessedClauses(markdown, clauses, resolved.witnessedClauses)
    : null;
  if (witnessed) findings.push(...witnessed.findings);
  const scenarioCoverage = resolved.scenarioCoverage === 'off' ? null
    // Without extracted clauses every coverage row would read as undeclared: one cause, reported once.
    : inspectSpecificationScenarios(markdown, clauses, { required: resolved.scenarioCoverage === 'required', clausesKnown: extracted });
  if (scenarioCoverage) findings.push(...scenarioCoverage.findings);

  const ordered = findings.sort((left, right) =>
    left.kind.localeCompare(right.kind) || String(left.message).localeCompare(String(right.message)));
  // Capped *and disclosed*: a list of 500 findings that stops at 500 reads exactly like a complete
  // list of 500, and a reader has no way to tell which one they are looking at.
  const capped = capWithDisclosure(ordered, 'maxFacts', { limits: bounds, label: 'findings' });
  const cappedAdvisories = capWithDisclosure(scenarioCoverage?.advisories ?? [], 'maxFacts', { limits: bounds, label: 'scenario advisories' });
  const sorted = capped.items;

  return {
    schemaVersion: SPECIFICATION_ANALYSIS_REPORT_SCHEMA.currentVersion,
    resultType: 'specification-quality-analysis',
    // Bound to exactly what produced it `[SPK:REQ-054]`, so a report cannot be quoted against a
    // different artifact than the one it read.
    binding: {
      artifactPath,
      artifactSha256: sha256Utf8(String(markdown)),
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
    ...(scenarioCoverage ? { scenarioCoverage: {
      declared: scenarioCoverage.declared, scenarioCount: scenarioCoverage.scenarioCount,
      rowCount: scenarioCoverage.rows.length
    }, advisories: cappedAdvisories.items,
    ...(cappedAdvisories.disclosure ? { advisoryTruncation: { dropped: cappedAdvisories.dropped, disclosure: cappedAdvisories.disclosure } } : {}) } : {}),
    findings: sorted,
    ...(capped.disclosure ? { truncated: { dropped: capped.dropped, disclosure: capped.disclosure } } : {}),
    // Said out loud in the report itself, because a clean deterministic run is the moment someone
    // is most likely to read it as "the specification is good" `[SPK:CON-027]`.
    disclaimer: 'Deterministic analysis only. It reports checkable defects and makes no claim that the specification is complete, clear, consistent, or correct.'
  };
}

function evaluateSpecificationQuality(report, { exclude = [] } = {}) {
  const messages = report.findings
    .filter((finding) => !exclude.includes(finding.kind))
    .map((finding) => finding.message);
  if (report.mode === 'off') return { errors: [], warnings: [] };
  const warnings = (report.advisories ?? []).map(finding => finding.message);
  return report.mode === 'enforce' ? { errors: messages, warnings } : { errors: [], warnings: [...messages, ...warnings] };
}

function validateChecklistDecisions(decisions = [], { checklist = STARTER_CHECKLIST, mode = 'enforce' } = {}) {
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
function evaluateApprovalChecklist({
  policy, decisions = [], authorities = null, actor = null, checklist = STARTER_CHECKLIST
} = {}) {
  const resolved = specificationQualityPolicy(policy ?? {});
  if (resolved.approvalChecklist === 'off') {
    return {
      required: false, mode: 'off',
      errors: decisions.length ? ['specification-quality approval checklist is off; article decisions must not be submitted'] : [],
      warnings: [], decisions: []
    };
  }
  if (resolved.mode === 'off') return { required: false, mode: 'off', errors: [], warnings: [], decisions: [] };

  const validated = validateChecklistDecisions(decisions, { checklist, mode: resolved.mode });
  const errors = [...validated.errors];
  const warnings = [...validated.warnings];

  if (resolved.exceptionAuthority) {
    const taken = decisions.filter((entry) => entry.decision && entry.decision !== 'satisfied');
    if (taken.length) {
      // `.authorized`, not truthiness: the matcher always returns an object, and a refusal is a
      // populated `{ authorized: false, reason }` rather than a null. Checking the object meant the
      // authority never gated anything — the same shape of miss this whole module exists to close.
      const matched = matchApprovalAuthority(authorities, { authorities: [resolved.exceptionAuthority] }, actor);
      if (!matched.authorized) {
        const message = `recording ${taken.length === 1 ? 'an exception' : 'exceptions'} on ${taken.map((entry) => `'${entry.article}'`).join(', ')} requires membership of the '${resolved.exceptionAuthority}' authority`;
        (resolved.mode === 'enforce' ? errors : warnings).push(message);
      }
    }
  }

  return {
    required: resolved.mode === 'enforce',
    mode: resolved.mode,
    checklist: checklist.id,
    checklistSha256: policyHash(resolved, checklist),
    errors,
    warnings,
    decisions: decisions.map((entry) => ({
      article: entry.article,
      decision: entry.decision,
      ...(entry.reason ? { reason: String(entry.reason).trim() } : {})
    }))
  };
}
function specificationGateValue(markdown,{artifactPath,phase,generation,policy={},markerMode='off',namespace=null,previousMarkers=[],answers=[]}={}) {
 const quality=specificationQualityPolicy(policy);
 if(markerMode==='off'&&quality.mode==='off')return SPECIFICATION_GATE_EMPTY;
 const report=analyzeSpecification(markdown,{artifactPath,phase,generation,policy:quality,namespace,previousMarkers,answers});
 const markerMessages=report.findings.filter(finding=>MARKER_FINDING_KINDS.includes(finding.kind)).map(finding=>finding.message);
 const qualityVerdict=evaluateSpecificationQuality(report,{exclude:MARKER_FINDING_KINDS});
 return {applies:true,markerMode,qualityMode:quality.mode,checklist:quality.checklist,report,open:report.markers.open,
  errors:[...(markerMode==='block'?markerMessages:[]),...qualityVerdict.errors],warnings:[...(markerMode==='warn'?markerMessages:[]),...qualityVerdict.warnings],
  record:{generation,artifactPath,artifactSha256:report.binding.artifactSha256,policySha256:report.binding.policySha256,markerMode,qualityMode:quality.mode,
   open:report.markers.open,findings:report.findings.length}};
}
return Object.freeze({policyHash,witnessedClauseReviewFields,analyzeSpecification,evaluateSpecificationQuality,validateChecklistDecisions,evaluateApprovalChecklist,specificationGateValue});
}
