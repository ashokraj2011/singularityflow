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

import { extractMarkers, evaluateMarkerPolicy, markerPolicy, reconcileMarkers } from './clarification-markers.mjs';
import { extractClauses } from './specifications.mjs';
import { canonicalJson } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

export const SPECIFICATION_QUALITY_MODES = Object.freeze(['off', 'warn', 'enforce']);

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
  return Object.freeze({
    mode,
    checklist,
    // Assisted analysis is opt-in and never the default; the deterministic path must stand alone.
    assisted: Boolean(value?.assisted ?? false)
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

/**
 * Deterministic specification analysis `[SPK:REQ-054]` `[SPK:REQ-055]`.
 *
 * Pure over its inputs and free of a clock, so the same artifact bytes always produce the same
 * findings `[SPK:REQ-056]` — the observation timestamp is the caller's to add.
 */
export function analyzeSpecification(markdown, {
  artifactPath = null, phase = null, generation = null, policy = {}, checklist = STARTER_CHECKLIST,
  previousMarkers = [], answers = [], namespace = null
} = {}) {
  const resolved = specificationQualityPolicy(policy);
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

  const sorted = findings.sort((left, right) =>
    left.kind.localeCompare(right.kind) || String(left.message).localeCompare(String(right.message)));

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
    markerCount: markers.length,
    findings: sorted,
    // Said out loud in the report itself, because a clean deterministic run is the moment someone
    // is most likely to read it as "the specification is good" `[SPK:CON-027]`.
    disclaimer: 'Deterministic analysis only. It reports checkable defects and makes no claim that the specification is complete, clear, consistent, or correct.'
  };
}

/** Apply the policy to a report: `enforce` blocks, `warn` reports, `off` is silent. */
export function evaluateSpecificationQuality(report) {
  const messages = report.findings.map((finding) => finding.message);
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
