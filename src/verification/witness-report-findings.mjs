/**
 * A report that says a criterion has no human visual review while the Story holds a valid one.
 *
 * A release report once wrote that its verdict "does not claim independent human visual acceptance"
 * for a criterion a person had already witnessed (WIT-001, bound to the screenshot's bytes): its
 * author never saw the record. This compares what a conformance or verification report says with
 * the witness decisions the Story recorded and names each contradiction as a non-blocking advisory,
 * so the author can cite the record. It never changes a report's status or blocks publication.
 *
 * Detection is conservative. A finding needs, in one table row or one sentence, both the criterion
 * ID and a phrase saying human visual review or acceptance is absent; a report that cites the
 * record's ID anywhere has seen it and gets no finding; and only a review that satisfies the
 * criterion with its bound file and code candidate unchanged counts.
 */
import { readReviewArtifact } from '../artifact-review-read.mjs';
import { phaseReadsWitnessDecisions, storyWitnessDecisions } from './witness-decisions.mjs';

export const WITNESS_UNREPORTED_CODE = 'conformance.witness-unreported';
const MAXIMUM_FINDINGS = 20;

const MANAGED_METADATA = /^<!-- singularity-flow:(?:initiative-)?metadata\n[\s\S]*?\n-->/u;
const MANAGED_INPUTS = /<!-- singularity-flow:inputs:start -->[\s\S]*?<!-- singularity-flow:inputs:end -->/gu;
const QUALIFIED_CRITERION = /\b[A-Z0-9][A-Z0-9._-]{0,63}:AC-\d{3}\b/giu;
const BARE_CRITERION = /(?<![\w:.-])AC-\d{3}\b/gu;
const WITNESS_ID = /\b(?:WIT-\d{3,}|ARA-WIT-[a-f0-9]{24})\b/gu;

/** Phrases that say a criterion has no human visual review or acceptance. */
export const ABSENT_VISUAL_REVIEW = Object.freeze([
  /\bno\s+(?:independent\s+|separate\s+|recorded\s+)?human[\s-]+visual\b/iu,
  /\bdoes\s+not\s+claim\b.*?\bhuman[\s-]+visual\s+(?:acceptance|review)/iu,
  /\bvisual\s+(?:acceptance|review)s?\s+remains?\b/iu,
  /\bwithout\s+(?:an?\s+)?(?:independent\s+|separate\s+)?human[\s-]+visual\s+(?:acceptance|review)/iu,
  /\bhuman[\s-]+visual\s+(?:acceptance|review)\s+(?:is\s+|was\s+|remains\s+)?(?:not\s+(?:recorded|claimed|performed|established|done)|pending|outstanding|missing|absent)\b/iu
]);

/** The authored text, engine-written blocks blanked so line numbers still match the file. */
function authoredText(markdown) {
  const blank = (text) => text.replace(/[^\n]/gu, '');
  return String(markdown ?? '').replace(MANAGED_METADATA, blank).replace(MANAGED_INPUTS, blank);
}

/** One paragraph split into sentences, each with the line it starts on. */
function sentences(paragraph) {
  const units = [];
  const boundary = /[.!?]+\s+/gu;
  let start = 0;
  const push = (end) => {
    const text = paragraph.text.slice(start, end);
    if (text.trim()) units.push({ line: paragraph.line + (paragraph.text.slice(0, start).match(/\n/gu)?.length ?? 0), text });
  };
  for (const match of paragraph.text.matchAll(boundary)) {
    push(match.index + match[0].length);
    start = match.index + match[0].length;
  }
  push(paragraph.text.length);
  return units;
}

/** Table rows, headings and sentences: the spans a criterion and a claim about it must share. */
export function reportUnits(markdown) {
  const units = [];
  let paragraph = null;
  let fenced = false;
  const flush = () => { if (paragraph) units.push(...sentences(paragraph)); paragraph = null; };
  authoredText(markdown).split(/\r?\n/u).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (/^(?:```|~~~)/u.test(trimmed)) { flush(); fenced = !fenced; return; }
    if (fenced) return;
    if (!trimmed) { flush(); return; }
    if (trimmed.startsWith('|')) {
      flush();
      if (!/^[\s|:-]+$/u.test(trimmed)) units.push({ line, text: trimmed });
      return;
    }
    if (/^#{1,6}\s/u.test(trimmed)) { flush(); units.push({ line, text: trimmed }); return; }
    if (/^(?:[-*+]|\d+[.)])\s+/u.test(trimmed)) flush();
    paragraph = paragraph ? { line: paragraph.line, text: `${paragraph.text}\n${raw}` } : { line, text: raw };
  });
  flush();
  return units;
}

function criteriaIn(text, bySuffix) {
  const found = new Set([...text.matchAll(QUALIFIED_CRITERION)].map((match) => match[0].toUpperCase()));
  for (const match of text.matchAll(BARE_CRITERION)) {
    const owners = bySuffix.get(match[0]) ?? [];
    if (owners.length === 1) found.add(owners[0]);
  }
  return found;
}

/**
 * Advisories for each report span that says a criterion lacks human visual review while `witnesses`
 * (from storyWitnessDecisions) hold a valid review of it that the report never cites. Pure.
 */
export function witnessReportFindings(markdown, witnesses = []) {
  const valid = (witnesses ?? []).filter((entry) => entry?.valid && entry.decision === 'satisfies');
  if (!valid.length) return [];
  const text = authoredText(markdown);
  const cited = new Set([...text.matchAll(WITNESS_ID)].map((match) => match[0]));
  const uncited = valid.filter((entry) => !cited.has(entry.id));
  if (!uncited.length) return [];
  const bySuffix = new Map();
  for (const clauseId of new Set(uncited.map((entry) => String(entry.clauseId).toUpperCase()))) {
    const suffix = clauseId.slice(clauseId.lastIndexOf(':') + 1);
    bySuffix.set(suffix, [...(bySuffix.get(suffix) ?? []), clauseId]);
  }
  const findings = [];
  const seen = new Set();
  for (const unit of reportUnits(markdown)) {
    if (!ABSENT_VISUAL_REVIEW.some((pattern) => pattern.test(unit.text))) continue;
    const criteria = criteriaIn(unit.text, bySuffix);
    for (const witness of uncited.filter((entry) => criteria.has(String(entry.clauseId).toUpperCase()))) {
      const key = `${witness.id}\u0000${unit.line}`;
      if (seen.has(key) || findings.length >= MAXIMUM_FINDINGS) continue;
      seen.add(key);
      const recorded = [witness.actor ? `by ${witness.actor}` : null, witness.at ? `at ${witness.at}` : null].filter(Boolean).join(' ');
      findings.push(Object.freeze({
        code: WITNESS_UNREPORTED_CODE, category: 'evidence', blocking: false, requiredBefore: null,
        path: null, line: unit.line, value: witness.clauseId, clauseId: witness.clauseId, record: witness.id,
        message: `Line ${unit.line} says ${witness.clauseId} has no human visual review, but ${witness.id} recorded a ${witness.method} review of ${witness.file} (slot ${witness.slot})${recorded ? ` ${recorded}` : ''} that satisfies it, and its bound file is unchanged. Cite ${witness.id} and report what it covers. Advisory only.`
      }));
    }
  }
  return findings;
}

/**
 * The draft check's advisories for one step's primary report: empty unless the Story recorded a
 * witness and the step reports on visual evidence. Never throws.
 */
export async function witnessReportAdvisories(root, workflow, phase, artifact) {
  try {
    if (!workflow?.witnessRecords?.length && !workflow?.applicationAcceptanceRecords?.length || !artifact?.exists || !phaseReadsWitnessDecisions(workflow, phase)) return [];
    const markdown = await readReviewArtifact(root, artifact.path, 'Required phase artifact');
    if (markdown == null) return [];
    return witnessReportFindings(markdown, await storyWitnessDecisions(root, workflow))
      .map((finding) => Object.freeze({ ...finding, path: artifact.path }));
  } catch {
    return [];
  }
}
