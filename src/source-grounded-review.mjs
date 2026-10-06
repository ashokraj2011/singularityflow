/**
 * Independent, source-grounded review of specification and planning artifacts.
 *
 * The reviewer supplies semantic judgments. This module only checks that the review is complete,
 * cites bytes in the pinned sources, covers the structured clauses/plan, and still describes the
 * exact current inputs. A clean result is not a machine claim that the prose is correct.
 */
import { createHash } from 'node:crypto';

import { canonicalJson, recordSha256 } from './records.mjs';
import { readRecord } from './schema-migrations.mjs';
import { derivePlannedClaimMap, extractClauses } from './specifications.mjs';
import { extractNormativeStatements, normalizeStatement } from './scope/extract.mjs';
import { SingularityFlowError } from './util.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_SOURCES = 100;
const MAX_ROWS = 2000;
const MAX_FINDINGS = 500;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const SCENARIO = /^S\d+$/u;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function requiredText(value, label, maximum = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new SingularityFlowError(`${label} must be non-empty text of at most ${maximum} characters.`);
  }
  return value.trim();
}

function requireId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) {
    throw new SingularityFlowError(`${label} must be a stable identifier.`);
  }
  return value;
}

function sourceBinding(source) {
  const id = requireId(source?.id, 'Review source id');
  const path = requiredText(source?.path, `Review source '${id}' path`, 1024);
  if (typeof source?.text !== 'string') {
    throw new SingularityFlowError(`Review source '${id}' needs its exact pinned text.`);
  }
  const textSha256 = sha256(source.text);
  if (source.sha256 != null && (!SHA256.test(source.sha256) || source.sha256 !== textSha256)) {
    throw new SingularityFlowError(`Review source '${id}' SHA-256 does not match its supplied text.`);
  }
  const originalSha256 = source.originalSha256 ?? null;
  if (originalSha256 !== null && !SHA256.test(originalSha256)) {
    throw new SingularityFlowError(`Review source '${id}' original SHA-256 is invalid.`);
  }
  return { id, path, textSha256, ...(originalSha256 ? { originalSha256 } : {}) };
}

function artifactBinding(artifact, label) {
  const path = requiredText(artifact?.path, `${label} path`, 1024);
  if (typeof artifact?.text !== 'string') throw new SingularityFlowError(`${label} needs its exact text.`);
  if (artifact.originalSha256 != null && !SHA256.test(artifact.originalSha256)) {
    throw new SingularityFlowError(`${label} original SHA-256 is invalid.`);
  }
  return { path, sha256: sha256(artifact.text),
    ...(artifact.originalSha256 ? { originalSha256: artifact.originalSha256 } : {}) };
}

const UNREADABLE_CODES = new Set([
  'machine-local-storage', 'external-reference', 'no-text-layer', 'too-large-to-cite', 'empty-text', 'review-budget-exceeded'
]);

/** An attachment the reviewer cannot cite, bound by identity so a later change is noticed. */
function unreadableBinding(entry) {
  const id = requireId(entry?.id, 'Unreadable source id');
  if (!UNREADABLE_CODES.has(entry?.code)) throw new SingularityFlowError(`Unreadable source '${id}' has an unknown reason code.`);
  if (entry.originalSha256 != null && !SHA256.test(entry.originalSha256)) {
    throw new SingularityFlowError(`Unreadable source '${id}' original SHA-256 is invalid.`);
  }
  return { id, code: entry.code, ...(entry.originalSha256 ? { originalSha256: entry.originalSha256 } : {}) };
}

/** Build the binding expected in the independent report from current, trusted input bytes. */
export function sourceReviewBinding({ kind, workId, phase, generation, sources, artifact, upstreamSpec = null, unreadableSources = [] }) {
  if (!['specification', 'planning'].includes(kind)) throw new SingularityFlowError('Review kind must be specification or planning.');
  requireId(workId, 'Review work ID');
  requireId(phase, 'Review phase');
  if (!Number.isSafeInteger(generation) || generation < 0) throw new SingularityFlowError('Review generation must be a non-negative integer.');
  if (!Array.isArray(sources) || !sources.length || sources.length > MAX_SOURCES) {
    throw new SingularityFlowError(`Review needs 1 to ${MAX_SOURCES} pinned sources.`);
  }
  const boundSources = sources.map(sourceBinding).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(boundSources.map((source) => source.id)).size !== boundSources.length) {
    throw new SingularityFlowError('Review source IDs must be unique.');
  }
  if (kind === 'planning' && !upstreamSpec) throw new SingularityFlowError('Planning review needs the approved specification.');
  const unreadable = (unreadableSources ?? []).map(unreadableBinding).sort((left, right) => left.id.localeCompare(right.id));
  if (unreadable.some((entry) => boundSources.some((source) => source.id === entry.id))) {
    throw new SingularityFlowError('A source cannot be both cited and unreadable.');
  }
  return {
    workId, phase, generation,
    sources: boundSources,
    // Present only when an attachment cannot be cited, so an all-readable review binds as before.
    ...(unreadable.length ? { unreadableSources: unreadable } : {}),
    artifact: artifactBinding(artifact, 'Review artifact'),
    ...(kind === 'planning' ? { upstreamSpec: artifactBinding(upstreamSpec, 'Approved specification') } : {})
  };
}

function finding(code, message, details = {}) {
  return { code, message, ...details };
}

function citedSource(row, sources, findings, label) {
  const source = sources.get(row?.sourceId);
  if (!source) {
    findings.push(finding('source-unknown', `${label} cites unknown source '${row?.sourceId ?? ''}'.`));
    return null;
  }
  const lines = source.text.split(/\r?\n/u);
  if (!Number.isSafeInteger(row?.line) || row.line < 1 || row.line > lines.length) {
    findings.push(finding('citation-line-invalid', `${label} has no valid line in source '${source.id}'.`));
    return source;
  }
  if (typeof row.quote !== 'string' || !row.quote.trim() || row.quote.length > 1024
      || !lines[row.line - 1].includes(row.quote)) {
    findings.push(finding('citation-quote-invalid', `${label} quote does not occur on ${source.id}:${row.line}.`));
  }
  return source;
}

/** Whether a review row stands for one requirement statement: it cites its line or quotes it. */
function rowCitesStatement(row, statement) {
  if (Number.isSafeInteger(row?.line) && row.line === statement.line) return true;
  const quote = normalizeStatement(row?.quote ?? '');
  const wanted = normalizeStatement(statement.text);
  if (!quote || !wanted) return false;
  const shorter = quote.length < wanted.length ? quote : wanted;
  return shorter.length >= 12 && (quote.includes(wanted) || wanted.includes(quote));
}

function scenarioIds(markdown) {
  return new Set(String(markdown).split(/\r?\n/u)
    .map((line) => line.match(/^\s{0,3}#{2,6}\s+(S\d+)\b/u)?.[1])
    .filter(Boolean));
}

function reviewedSourceSet(report, binding, findings) {
  const reviewed = report.sourcesReviewed;
  if (!Array.isArray(reviewed) || reviewed.some((id) => typeof id !== 'string')
      || new Set(reviewed).size !== reviewed.length) {
    findings.push(finding('sources-reviewed-invalid', 'The report must list each reviewed source ID once.'));
    return;
  }
  const expected = binding.sources.map((source) => source.id);
  const missing = expected.filter((id) => !reviewed.includes(id));
  const unknown = reviewed.filter((id) => !expected.includes(id));
  if (missing.length || unknown.length) findings.push(finding('sources-not-all-reviewed',
    `Review source inventory differs from the pinned set; missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'}.`,
    { missing, unknown }));
}

function evaluateSpecificationRows(report, context, binding, findings, pendingDispositions) {
  const rows = report.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS) {
    findings.push(finding('rows-invalid', `Specification review needs 1 to ${MAX_ROWS} source mapping rows.`));
    return;
  }
  const sources = new Map(context.sources.map((source) => [source.id, source]));
  const unreadable = new Map((context.unreadableSources ?? []).map((entry) => [entry.id, entry]));
  const scenarios = scenarioIds(context.artifact.text);
  const clauses = extractClauses(context.artifact.text, { sourcePath: context.artifact.path });
  const authoritative = new Set(clauses.map((clause) => clause.id));
  const mappedScenarios = new Set();
  const mappedClauses = new Set();
  const mappedSources = new Set();
  const rowIds = new Set();
  for (const [index, row] of rows.entries()) {
    const label = `Review row ${index + 1}`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      findings.push(finding('row-invalid', `${label} must be an object.`));
      continue;
    }
    if (!ID.test(String(row.id ?? '')) || rowIds.has(row.id)) {
      findings.push(finding('row-id-invalid', `${label} needs a unique stable id.`));
    } else rowIds.add(row.id);
    const uncitable = unreadable.get(row.sourceId);
    if (uncitable) {
      // A clause grounded in a PDF, image, link or machine-local file cannot be quoted. The reviewer
      // says where in the document it is; a person then attests it, as with an exclusion.
      if (row.outcome !== 'covered' || typeof row.attestation !== 'string' || !row.attestation.trim()
          || row.attestation.length > 1024) {
        findings.push(finding('attestation-invalid', `${label} cites unreadable source '${uncitable.id}'; only a covered row that says where in it the scenario is grounded may do so.`));
      } else pendingDispositions.push({ id: `attested:${row.id}`, kind: 'attested-coverage', rowId: row.id,
        documentId: uncitable.id, reason: row.attestation.trim() });
    } else {
      const source = citedSource(row, sources, findings, label);
      if (source) mappedSources.add(source.id);
    }
    if (row.outcome === 'covered') {
      if (!SCENARIO.test(String(row.scenarioId ?? '')) || !scenarios.has(row.scenarioId)) {
        findings.push(finding('scenario-unknown', `${label} names scenario '${row.scenarioId ?? ''}' absent from the specification.`));
      } else mappedScenarios.add(row.scenarioId);
      if (!Array.isArray(row.clauseIds) || !row.clauseIds.length || new Set(row.clauseIds).size !== row.clauseIds.length) {
        findings.push(finding('clause-list-invalid', `${label} needs distinct clause IDs.`));
      } else for (const id of row.clauseIds) {
        if (!authoritative.has(id)) findings.push(finding('clause-unknown', `${label} names unknown clause '${id}'.`));
        else mappedClauses.add(id);
      }
    } else if (row.outcome === 'excluded') {
      if (!String(row.reason ?? '').trim()) findings.push(finding('exclusion-reason-missing', `${label} needs a concrete proposed exclusion reason.`));
      pendingDispositions.push({ id: `exclusion:${row.id}`, kind: 'exclusion', rowId: row.id, reason: row.reason ?? null });
    } else if (row.outcome === 'question') {
      findings.push(finding('source-question-unresolved', `${label} asks a material source question that must be answered in a new specification and review.`,
        { rowId: row.id }));
      if (!String(row.question ?? '').trim()) findings.push(finding('question-text-missing', `${label} needs the unresolved question.`));
    } else findings.push(finding('row-outcome-invalid', `${label} outcome must be covered, excluded, or question.`));
  }
  for (const source of binding.sources) if (!mappedSources.has(source.id)) findings.push(finding('source-unmapped',
    `Pinned source '${source.id}' has no cited mapping or proposed exclusion.`));
  // D-14: a source counts as reviewed only when every requirement statement in it has a row. One row
  // on one line of a document never stands for the rest of it [E2G-006].
  const MAX_LISTED = 25;
  for (const source of context.sources) {
    const cited = rows.filter((row) => row && typeof row === 'object' && row.sourceId === source.id);
    const uncovered = extractNormativeStatements(source.text, { sourceId: source.id })
      .filter((statement) => !cited.some((row) => rowCitesStatement(row, statement)));
    for (const statement of uncovered.slice(0, MAX_LISTED)) findings.push(finding('source-statement-unmapped',
      `Source '${source.id}' line ${statement.line} states a requirement no row maps: "${statement.text.slice(0, 200)}".`,
      { sourceId: source.id, line: statement.line, statementSha256: statement.statementSha256 }));
    if (uncovered.length > MAX_LISTED) findings.push(finding('source-statements-unmapped',
      `${uncovered.length - MAX_LISTED} more requirement statements in '${source.id}' have no row.`, { sourceId: source.id }));
  }
  for (const scenario of scenarios) if (!mappedScenarios.has(scenario)) findings.push(finding('scenario-unmapped',
    `Scenario '${scenario}' has no cited source-to-clause mapping.`));
  for (const clause of authoritative) if (!mappedClauses.has(clause)) findings.push(finding('clause-unmapped',
    `Clause '${clause}' has no cited source-to-scenario mapping.`));
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function evaluatePlanningRows(report, context, findings, pendingDispositions) {
  const rows = report.rows;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) {
    findings.push(finding('rows-invalid', `Planning review needs at most ${MAX_ROWS} clause mapping rows.`));
    return;
  }
  const clauses = extractClauses(context.upstreamSpec.text, { sourcePath: context.upstreamSpec.path });
  const ids = clauses.map((clause) => clause.id);
  const planned = derivePlannedClaimMap(context.artifact.text, { clauseIds: ids });
  const byId = new Map();
  for (const [index, row] of rows.entries()) {
    const label = `Review row ${index + 1}`;
    if (!row || typeof row !== 'object' || Array.isArray(row) || !ids.includes(row.clauseId)
        || byId.has(row.clauseId)) {
      findings.push(finding('clause-row-invalid', `${label} needs one unique approved clause ID.`));
      continue;
    }
    byId.set(row.clauseId, row);
    const actual = planned.claimMap.claims[row.clauseId];
    if (!actual) {
      findings.push(finding('plan-clause-missing', `Plan has no structured row for '${row.clauseId}'.`));
      continue;
    }
    const expectedPaths = [...actual.expectedPaths].sort();
    const plannedTests = [...actual.tests].sort();
    const mismatches = [];
    for (const [field, expected] of Object.entries({ expectedPaths, plannedTests })) {
      if (!Array.isArray(row[field]) || !sameArray([...row[field]].sort(), expected)) mismatches.push({ field, expected, received: row[field] ?? null });
    }
    for (const field of ['testDisposition', 'testReason', 'fulfillment', 'observableResult']) {
      // Older reports omitted the optional obligation metadata. When supplied, it must match too.
      if (['fulfillment', 'observableResult'].includes(field) && !Object.hasOwn(row, field)) continue;
      if ((row[field] ?? null) !== (actual[field] ?? null)) mismatches.push({ field, expected: actual[field] ?? null, received: row[field] ?? null });
    }
    if (Object.hasOwn(row, 'steps') && (!Array.isArray(row.steps) || !sameArray([...row.steps].sort(), [...(actual.steps ?? [])].sort()))) {
      mismatches.push({ field: 'steps', expected: actual.steps ?? [], received: row.steps });
    }
    for (const mismatch of mismatches) findings.push(finding('plan-row-mismatch',
      `${label} ${mismatch.field} does not match the structured plan for '${row.clauseId}'. Copy the pinned reportTemplate field.`,
      { ...mismatch, field: `rows[${index}].${mismatch.field}`, clauseId: row.clauseId }));
    // Only the authoritatively parsed plan can declare test-only; the reviewer cannot waive paths.
    if (!expectedPaths.length && actual.fulfillment !== 'test-only') findings.push(finding('plan-path-missing', `Clause '${row.clauseId}' has no exact expected source path.`));
    if (!plannedTests.length && actual.testDisposition !== 'not-applicable') {
      findings.push(finding('plan-test-missing', `Clause '${row.clauseId}' has no exact planned test path.`));
    }
    if (row.assessment !== 'supported') {
      findings.push(finding('plan-assessment-gap', `${label} was not independently assessed as supported.`));
    }
    if (actual.testDisposition === 'not-applicable') pendingDispositions.push({
      id: `not-applicable:${row.clauseId}`, kind: 'not-applicable', clauseId: row.clauseId,
      reason: actual.testReason
    });
  }
  for (const id of ids) if (!byId.has(id)) findings.push(finding('clause-unreviewed',
    `Approved clause '${id}' has no independent plan review row.`));
}

/**
 * Evaluate an independently produced report. Human dispositions must come from the caller's
 * authenticated approval path, never from a field in the reviewer-authored report.
 */
export function evaluateSourceGroundedReview(report, context) {
  const binding = sourceReviewBinding(context);
  if (report == null) return { status: 'missing', binding, reportSha256: null,
    findings: [finding('review-missing', 'No independent source-grounded review report exists.')], pendingDispositions: [] };
  const reportSha256 = recordSha256(report);
  const findings = [];
  const pendingDispositions = [];
  let versionReadable = true;
  try { readRecord('source-grounded-review', Buffer.from(JSON.stringify(report))); }
  catch { versionReadable = false; }
  if (!report || typeof report !== 'object' || Array.isArray(report)
      || !versionReadable || report.resultType !== 'source-grounded-review'
      || report.kind !== context.kind) {
    findings.push(finding('review-contract-invalid', 'The report is not a source-grounded review for this phase.'));
  }
  if (Object.hasOwn(report, 'humanDispositions') || Object.hasOwn(report, 'dispositions')) {
    findings.push(finding('review-self-disposition', 'Human dispositions cannot be supplied in the reviewer report.'));
  }
  if (canonicalJson(report.binding) !== canonicalJson(binding)) {
    return { status: 'stale', binding, reportSha256,
      findings: [finding('review-binding-stale', 'Pinned sources, approved upstream specification, artifact, phase, or generation changed after review.')],
      pendingDispositions: [] };
  }
  const reviewer = report.reviewer;
  if (!context.reviewerAgentId || !context.authorAgentId || context.reviewerReadOnly !== true
      || reviewer?.agentId !== context.reviewerAgentId || reviewer?.readOnly !== true
      || context.reviewerAgentId === context.authorAgentId) {
    findings.push(finding('reviewer-not-independent', 'A trusted, read-only reviewer distinct from the artifact author is required.'));
  }
  reviewedSourceSet(report, binding, findings);
  // The reviewer cannot cite these; a person records that the phase proceeds without them.
  for (const entry of context.unreadableSources ?? []) pendingDispositions.push({
    id: `unreadable:${entry.id}`, kind: 'unreadable-source', documentId: entry.id, code: entry.code,
    reason: `${entry.id} (${entry.name ?? entry.id}) cannot be cited: ${entry.reason ?? entry.code}.`
  });
  try {
    if (context.kind === 'specification') evaluateSpecificationRows(report, context, binding, findings, pendingDispositions);
    else evaluatePlanningRows(report, context, findings, pendingDispositions);
  } catch (error) {
    findings.push(finding('review-structure-invalid', error.message));
  }
  if (!Array.isArray(report.findings) || report.findings.length > MAX_FINDINGS) {
    findings.push(finding('review-findings-invalid', `Reviewer findings must be an array of at most ${MAX_FINDINGS} entries.`));
  } else {
    const ids = new Set();
    for (const entry of report.findings) {
      if (!ID.test(String(entry?.id ?? '')) || ids.has(entry.id)
          || !['blocking', 'advisory'].includes(entry.severity)
          || !String(entry.message ?? '').trim()) {
        findings.push(finding('review-finding-invalid', 'Reviewer findings need a unique id, severity "blocking" or "advisory", and non-empty message (not explanation).'));
        continue;
      }
      ids.add(entry.id);
      if (entry.sourceId) citedSource(entry, new Map(context.sources.map((source) => [source.id, source])), findings,
        `Reviewer finding '${entry.id}'`);
      if (entry.severity === 'blocking') findings.push(finding('reviewer-blocker',
        `Reviewer finding '${entry.id}': ${entry.message}`, { reviewFindingId: entry.id }));
    }
  }
  const dispositions = context.humanDispositions ?? [];
  const accepted = new Set();
  if (Array.isArray(dispositions)) for (const entry of dispositions) {
    if (entry?.reportSha256 === reportSha256 && entry?.decision === 'accepted'
        && typeof entry.reason === 'string' && entry.reason.trim()
        && typeof entry.actor === 'string' && entry.actor.trim()) accepted.add(entry.id);
  }
  const unresolved = pendingDispositions.filter((entry) => !accepted.has(entry.id));
  for (const entry of unresolved) findings.push(finding('human-disposition-required',
    `Human disposition is required for ${entry.id} on review ${reportSha256.slice(0, 12)}.`,
    { dispositionId: entry.id }));
  return {
    status: findings.length ? 'correction-required' : 'ready',
    binding, reportSha256, findings, pendingDispositions: unresolved,
    disclaimer: 'A ready result verifies review structure, citations, bindings, and recorded dispositions; semantic correctness remains a reviewer judgment.'
  };
}
