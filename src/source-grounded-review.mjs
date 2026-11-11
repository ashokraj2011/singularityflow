/**
 * Independent, source-grounded review of every authored step's artifact: a specification, a plan, any other
 * document ('document'), and a code step's change ('code', [review level 2]).
 *
 * The reviewer supplies semantic judgments. This module only checks that the review is complete,
 * cites bytes in the pinned sources, covers the structured clauses/plan, and still describes the
 * exact current inputs. A clean result is not a machine claim that the prose is correct.
 */
import { createHash } from 'node:crypto';

import { canonicalJson, recordSha256 } from './records.mjs';
import { readRecord } from './schema-migrations.mjs';
import { derivePlannedClaimMap, extractClauses } from './specifications.mjs';
import { nonTestVerification } from './verification/intent.mjs';
import { extractNormativeStatements, normalizeStatement } from './scope/extract.mjs';
import { issueNamesClause } from './upstream-routes.mjs';
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
export const SOURCE_REVIEW_KINDS = Object.freeze(['specification', 'planning', 'document', 'code']);

/** A changed file's source ID in a code review: its path, as an ID. */
export function codeSourceId(relative) {
  const id = `code:${String(relative).replace(/[^A-Za-z0-9._-]/gu, ':')}`;
  return ID.test(id) ? id : `code:${sha256(String(relative)).slice(0, 32)}`;
}

export function sourceReviewBinding({ kind, workId, phase, generation, sources, visualSources = [], artifact, upstreamSpec = null, plan = null, code = null, unreadableSources = [], clarifications = [] }) {
  if (!SOURCE_REVIEW_KINDS.includes(kind)) throw new SingularityFlowError(`Review kind must be one of ${SOURCE_REVIEW_KINDS.join(', ')}.`);
  if (kind === 'code' && (!code || typeof code !== 'object')) throw new SingularityFlowError('A code review needs the step\'s delivery evidence.');
  requireId(workId, 'Review work ID');
  requireId(phase, 'Review phase');
  if (!Number.isSafeInteger(generation) || generation < 0) throw new SingularityFlowError('Review generation must be a non-negative integer.');
  if (!Array.isArray(sources) || !sources.length || sources.length > MAX_SOURCES) {
    throw new SingularityFlowError(`Review needs 1 to ${MAX_SOURCES} pinned sources.`);
  }
  const boundSources = sources.map(sourceBinding).sort((left, right) => left.id.localeCompare(right.id));
  if (!Array.isArray(visualSources) || sources.length + visualSources.length > MAX_SOURCES) throw new SingularityFlowError('Review source inventory exceeds its bound.');
  const visual = visualSources.map(entry => {
    const id = requireId(entry.id, 'Visual source id');
    if (!SHA256.test(entry.originalSha256 ?? '') || !(entry.mimeType?.startsWith('image/') || entry.mimeType === 'application/pdf')) {
      throw new SingularityFlowError(`Visual source '${id}' needs exact image/PDF identity.`);
    }
    return { id, path: requiredText(entry.path, 'Visual source path', 1024), originalSha256: entry.originalSha256, mimeType: entry.mimeType };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set([...boundSources, ...visual].map(entry => entry.id)).size !== boundSources.length + visual.length) throw new SingularityFlowError('Review source IDs must be unique.');
  if (kind === 'planning' && !upstreamSpec) throw new SingularityFlowError('Planning review needs the approved specification.');
  const unreadable = (unreadableSources ?? []).map(unreadableBinding).sort((left, right) => left.id.localeCompare(right.id));
  if (unreadable.some((entry) => [...boundSources, ...visual].some((source) => source.id === entry.id))) {
    throw new SingularityFlowError('A source cannot be both cited and unreadable.');
  }
  if (!Array.isArray(clarifications) || clarifications.length > 2) throw new SingularityFlowError('Review admits only its current and approved-scope clarification records.');
  const boundClarifications = clarifications.map((entry) => {
    const id = requireId(entry?.id, 'Review clarification id');
    requireId(entry?.phase, 'Review clarification phase');
    if (!Number.isSafeInteger(entry?.generation) || entry.generation < 1 || !SHA256.test(String(entry?.sha256 ?? ''))) {
      throw new SingularityFlowError(`Review clarification '${id}' has no valid published generation or SHA-256.`);
    }
    return { id, phase: entry.phase, generation: entry.generation,
      path: requiredText(entry.path, 'Review clarification path', 1024), sha256: entry.sha256 };
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(boundClarifications.map((entry) => entry.id)).size !== boundClarifications.length) {
    throw new SingularityFlowError('Review clarification IDs must be unique.');
  }
  return {
    workId, phase, generation,
    sources: boundSources,
    ...(visual.length ? { visualSources: visual } : {}),
    // Present only when an attachment cannot be cited, so an all-readable review binds as before.
    ...(unreadable.length ? { unreadableSources: unreadable } : {}),
    ...(boundClarifications.length ? { clarifications: boundClarifications } : {}),
    artifact: artifactBinding(artifact, 'Review artifact'),
    ...(kind === 'planning' ? { upstreamSpec: artifactBinding(upstreamSpec, 'Approved specification') } : {}),
    // A code review is bound to the approved plan it checks against and to the delivery evidence it reads.
    ...(kind === 'code' && plan ? { plan: artifactBinding(plan, 'Approved plan') } : {}),
    ...(kind === 'code' ? { evidenceSha256: recordSha256(code) } : {})
  };
}

function reviewedClarificationSet(report, binding, findings) {
  const expected = (binding.clarifications ?? []).map((entry) => entry.id);
  const reviewed = report.clarificationsReviewed ?? [];
  if (!Array.isArray(reviewed) || reviewed.some((id) => typeof id !== 'string')
      || new Set(reviewed).size !== reviewed.length) {
    findings.push(finding('clarifications-reviewed-invalid', 'List each reviewed clarification record ID once.'));
    return;
  }
  const missing = expected.filter((id) => !reviewed.includes(id));
  const unknown = reviewed.filter((id) => !expected.includes(id));
  if (missing.length || unknown.length) findings.push(finding('clarifications-not-all-reviewed',
    'The review must read and acknowledge the exact publication-bound human clarification records.', { missing, unknown }));
}

function finding(code, message, details = {}) {
  return { code, message, ...details };
}

/** Whether an upstream issue names a reviewer finding: by its clause, else by the finding's own id. */
function reviewFindingRaised(issue, entry) {
  const text = `${issue.about ?? ''} ${issue.problem ?? ''}`;
  if (entry.clauseId) return issueNamesClause(text, entry.clauseId);
  const id = String(entry.id).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9._:-])${id}(?![A-Za-z0-9_:-])`, 'u').test(text);
}

/**
 * A specification may write an anchor in any case (`[acct-7:req-002]`); extraction reads it as
 * `ACCT-7:REQ-002`, and review rows are compared with that exact form. A reviewer that copied the
 * anchor as written was told only "unknown clause", so name the exact ID to use.
 */
function clauseCaseHint(id, known) {
  const wanted = String(id ?? '').toUpperCase();
  const canonical = [...known].find((clause) => clause.toUpperCase() === wanted);
  return canonical && canonical !== id ? canonical : null;
}

function citedSource(row, sources, findings, label, field) {
  const source = sources.get(row?.sourceId);
  if (!source) {
    findings.push(finding('source-unknown', `${label} cites unknown source '${row?.sourceId ?? ''}'.`, { field: `${field}.sourceId` }));
    return null;
  }
  const lines = source.text.split(/\r?\n/u);
  if (!Number.isSafeInteger(row?.line) || row.line < 1 || row.line > lines.length) {
    findings.push(finding('citation-line-invalid', `${label} has no valid line in source '${source.id}'.`, { field, sourceId: source.id }));
    return source;
  }
  if (typeof row.quote !== 'string' || !row.quote.trim() || row.quote.length > 1024
      || !lines[row.line - 1].includes(row.quote)) {
    findings.push(finding('citation-quote-invalid', `${label} quote does not occur on ${source.id}:${row.line}.`, { field, sourceId: source.id }));
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

export function sourceReviewScenarioIds(markdown) {
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
  const expected = [...binding.sources, ...(binding.visualSources ?? [])].map((source) => source.id);
  const missing = expected.filter((id) => !reviewed.includes(id));
  const unknown = reviewed.filter((id) => !expected.includes(id));
  if (missing.length || unknown.length) findings.push(finding('sources-not-all-reviewed',
    `Review source inventory differs from the pinned set; missing: ${missing.join(', ') || 'none'}; unknown: ${unknown.join(', ') || 'none'}.`,
    { missing, unknown }));
}

function reviewedVisualSet(report, binding, findings) {
  const expected = binding.visualSources ?? [];
  const receipts = report.visualSourcesReviewed ?? [];
  if (!Array.isArray(receipts) || receipts.some(entry => !entry || typeof entry !== 'object')
      || receipts.length !== expected.length || new Set(receipts.map(entry => entry.sourceId)).size !== receipts.length) {
    findings.push(finding('visual-sources-not-reviewed', 'Inspect and acknowledge each exact image/PDF once; metadata alone is not reading.'));
    return;
  }
  for (const receipt of receipts) {
    const source = expected.find(entry => entry.id === receipt.sourceId);
    const requiredMethod = source?.mimeType === 'application/pdf' ? 'pdf-tool' : 'image-tool';
    if (!source || receipt.method !== requiredMethod || !String(receipt.locator ?? '').trim()
        || !String(receipt.observations ?? '').trim()) findings.push(finding('visual-inspection-invalid',
      'Visual review needs the actual tool method, inspected page/region and concrete observations.', { sourceId: receipt.sourceId }));
  }
}

function evaluateSpecificationRows(report, context, binding, findings, pendingDispositions) {
  const rows = report.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS) {
    findings.push(finding('rows-invalid', `Specification review needs 1 to ${MAX_ROWS} source mapping rows.`));
    return;
  }
  const sources = new Map(context.sources.map((source) => [source.id, source]));
  const unreadable = new Map((context.unreadableSources ?? []).map((entry) => [entry.id, entry]));
  const visuals = new Map((context.visualSources ?? []).map(entry => [entry.id, entry]));
  const scenarios = sourceReviewScenarioIds(context.artifact.text);
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
    if (visuals.has(row.sourceId)) {
      if (typeof row.attestation !== 'string' || !row.attestation.trim() || row.attestation.length > 1024) {
        findings.push(finding('visual-citation-invalid', `${label} must cite the inspected page or image region and observation.`));
      } else mappedSources.add(row.sourceId);
    } else if (uncitable) {
      // Unsupported sources and older retained readability contracts still need a person's
      // attestation; current text and native visual sources use their own exact read receipts.
      if (row.outcome !== 'covered' || typeof row.attestation !== 'string' || !row.attestation.trim()
          || row.attestation.length > 1024) {
        findings.push(finding('attestation-invalid', `${label} cites unreadable source '${uncitable.id}'; only a covered row that says where in it the scenario is grounded may do so.`));
      } else pendingDispositions.push({ id: `attested:${row.id}`, kind: 'attested-coverage', rowId: row.id,
        documentId: uncitable.id, reason: row.attestation.trim() });
    } else {
      const source = citedSource(row, sources, findings, label, `rows[${index}]`);
      if (source) mappedSources.add(source.id);
    }
    if (row.outcome === 'covered') {
      if (!SCENARIO.test(String(row.scenarioId ?? '')) || !scenarios.has(row.scenarioId)) {
        findings.push(finding('scenario-unknown', `${label} names scenario '${row.scenarioId ?? ''}' absent from the specification.`));
      } else mappedScenarios.add(row.scenarioId);
      if (!Array.isArray(row.clauseIds) || !row.clauseIds.length || new Set(row.clauseIds).size !== row.clauseIds.length) {
        findings.push(finding('clause-list-invalid', `${label} needs distinct clause IDs.`));
      } else for (const id of row.clauseIds) {
        const canonical = authoritative.has(id) ? null : clauseCaseHint(id, authoritative);
        if (canonical) findings.push(finding('clause-unknown', `${label} names clause '${id}'; write it exactly as '${canonical}' (clause IDs are compared in their canonical form).`, { canonical }));
        else if (!authoritative.has(id)) findings.push(finding('clause-unknown', `${label} names unknown clause '${id}'.`));
        else mappedClauses.add(id);
      }
    } else if (row.outcome === 'excluded') {
      if (!String(row.reason ?? '').trim()) findings.push(finding('exclusion-reason-missing', `${label} needs a concrete proposed exclusion reason.`));
      pendingDispositions.push({ id: `exclusion:${row.id}`, kind: 'exclusion', rowId: row.id, reason: row.reason ?? null });
    } else if (row.outcome === 'question') {
      findings.push(finding('source-question-unresolved', `${label} asks a material source question. Reconcile it with pinned human clarifications first: correct this review if the published artifact already follows an answered clarification; otherwise clarify and publish a corrected successor. A reviewer blocker is not a human-disposition exception.`,
        { rowId: row.id }));
      if (!String(row.question ?? '').trim()) findings.push(finding('question-text-missing', `${label} needs the unresolved question.`));
    } else findings.push(finding('row-outcome-invalid', `${label} outcome must be covered, excluded, or question.`));
  }
  for (const source of [...binding.sources, ...(binding.visualSources ?? [])]) if (!mappedSources.has(source.id)) findings.push(finding('source-unmapped',
    `Pinned source '${source.id}' has no cited mapping or proposed exclusion.`, { sourceId: source.id }));
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
    `Scenario '${scenario}' has no cited source-to-clause mapping. Add a covered row citing the source line it refines, also when a clarification answer shaped it (acknowledge that record in clarificationsReviewed; never edit it). If no source line supports it, it is new scope: report a blocking finding.`, { scenarioId: scenario }));
  for (const clause of authoritative) if (!mappedClauses.has(clause)) findings.push(finding('clause-unmapped',
    `Clause '${clause}' has no cited source-to-scenario mapping.`, { clauseId: clause }));
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
  const planned = derivePlannedClaimMap(context.artifact.text, { clauseIds: ids, clauses });
  const contracts = new Map((planned.claimMap.verificationContracts ?? []).map(contract => [contract.clauseId, contract]));
  const byId = new Map();
  for (const [index, row] of rows.entries()) {
    const label = `Review row ${index + 1}`;
    if (!row || typeof row !== 'object' || Array.isArray(row) || !ids.includes(row.clauseId)
        || byId.has(row.clauseId)) {
      const canonical = row && typeof row === 'object' && !ids.includes(row.clauseId) ? clauseCaseHint(row.clauseId, ids) : null;
      findings.push(canonical
        ? finding('clause-row-invalid', `${label} names clause '${row.clauseId}'; write it exactly as '${canonical}' (clause IDs are compared in their canonical form).`, { canonical })
        : finding('clause-row-invalid', `${label} needs one unique approved clause ID.`));
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
    for (const field of ['testDisposition', 'testReason', 'verificationCriterion', 'fulfillment', 'observableResult']) {
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
    if (!plannedTests.length && !['not-applicable', 'non-test'].includes(actual.testDisposition)) {
      findings.push(finding('plan-test-missing', `Clause '${row.clauseId}' has no exact planned test path.`));
    }
    if (row.assessment !== 'supported') {
      findings.push(finding('plan-assessment-gap', `${label} was not independently assessed as supported.`));
    }
    if (actual.testDisposition === 'not-applicable'
        && !nonTestVerification(row.clauseId, actual, contracts, clauses.find(clause => clause.id === row.clauseId)?.verification)) pendingDispositions.push({
      id: `not-applicable:${row.clauseId}`, kind: 'not-applicable', clauseId: row.clauseId,
      reason: actual.testReason
    });
  }
  for (const id of ids) if (!byId.has(id)) findings.push(finding('clause-unreviewed',
    `Approved clause '${id}' has no independent plan review row.`, { clauseId: id }));
}

/**
 * Any other authored document, reviewed against what it read [review level 2]: each pinned source (the Story and
 * its documents, and the approved inputs the step reads) has cited rows saying the document is consistent with it,
 * or not, or asks a question. An inconsistency or open question holds the step until its author corrects it.
 */
function evaluateDocumentRows(report, context, binding, findings) {
  const rows = report.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS) {
    findings.push(finding('rows-invalid', `A document review needs 1 to ${MAX_ROWS} cited rows.`));
    return;
  }
  const sources = new Map(context.sources.map((source) => [source.id, source]));
  const visuals = new Map((context.visualSources ?? []).map((entry) => [entry.id, entry]));
  const mapped = new Set();
  const rowIds = new Set();
  for (const [index, row] of rows.entries()) {
    const label = `Review row ${index + 1}`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) { findings.push(finding('row-invalid', `${label} must be an object.`)); continue; }
    if (!ID.test(String(row.id ?? '')) || rowIds.has(row.id)) findings.push(finding('row-id-invalid', `${label} needs a unique stable id.`));
    else rowIds.add(row.id);
    if (visuals.has(row.sourceId)) {
      if (typeof row.attestation !== 'string' || !row.attestation.trim()) findings.push(finding('visual-citation-invalid', `${label} must cite the inspected page or image region and observation.`));
      else mapped.add(row.sourceId);
    } else {
      const source = citedSource(row, sources, findings, label, `rows[${index}]`);
      if (source) mapped.add(source.id);
    }
    if (row.outcome === 'inconsistent') findings.push(finding('document-inconsistent',
      `${label}: the document is not consistent with ${row.sourceId}:${row.line ?? '?'}. ${String(row.note ?? '').trim()}`.trim(), { rowId: row.id }));
    else if (row.outcome === 'question') findings.push(finding('source-question-unresolved',
      `${label} asks a material question about ${row.sourceId}: ${String(row.note ?? '').trim() || 'see the row'}`, { rowId: row.id }));
    else if (row.outcome !== 'consistent') findings.push(finding('row-outcome-invalid', `${label} outcome must be consistent, inconsistent, or question.`));
  }
  for (const source of [...binding.sources, ...(binding.visualSources ?? [])]) if (!mapped.has(source.id)) findings.push(finding('source-unmapped',
    `Pinned source '${source.id}' has no cited row saying whether the document is consistent with it.`, { sourceId: source.id }));
}

/**
 * A code step's change, reviewed against its approved plan and the evidence its delivery recorded [review level 2]:
 *   (a) each clause the step delivers is implemented where the plan says, and every changed path is planned or
 *       reviewed as a supporting change;
 *   (b) each delivered clause has its own test, planned, that ran and passed, and that the reviewer says proves it;
 *   (c) every unresolved quality, security or secret-scan result is reviewed;
 *   (d) readability and design are the reviewer's judgement: blocking only for a named maintainability defect.
 * Every citation is a changed file's exact line (file:line), and every finding names its check.
 */
function evaluateCodeRows(report, context, findings) {
  const code = context.code ?? {};
  const sources = new Map(context.sources.map((source) => [source.id, source]));
  const byPath = new Map(context.sources.map((source) => [source.path, source]));
  const planned = code.planned ?? null;
  const delivered = code.deliveredClauses ?? [];
  const passed = new Set(code.passedTests ?? []);
  const rows = report.rows;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) {
    findings.push(finding('rows-invalid', `A code review needs at most ${MAX_ROWS} clause rows.`));
    return;
  }
  const byClause = new Map();
  const cite = (entry, label, field) => {
    const source = citedSource(entry, sources, findings, label, field);
    return source ? source.path : null;
  };
  for (const [index, row] of rows.entries()) {
    const label = `Review row ${index + 1}`;
    if (!row || typeof row !== 'object' || Array.isArray(row) || !delivered.includes(row.clauseId) || byClause.has(row.clauseId)) {
      const canonical = row && typeof row === 'object' && !delivered.includes(row.clauseId) ? clauseCaseHint(row.clauseId, delivered) : null;
      findings.push(canonical ? finding('clause-row-invalid', `${label} names clause '${row.clauseId}'; write it exactly as '${canonical}'.`, { canonical })
        : finding('clause-row-invalid', `${label} needs one unique clause this step delivers.`));
      continue;
    }
    byClause.set(row.clauseId, row);
    const claim = planned?.[row.clauseId] ?? null;
    // (a) Implemented where the plan says.
    const implementation = Array.isArray(row.implementation) ? row.implementation : [];
    for (const [at, entry] of implementation.entries()) {
      const where = cite(entry, `${label} implementation ${at + 1}`, `rows[${index}].implementation[${at}]`);
      if (where && claim && !(claim.expectedPaths ?? []).includes(where)) findings.push(finding('implementation-outside-plan',
        `${row.clauseId} is implemented in ${where}, which its plan row does not name (planned: ${(claim.expectedPaths ?? []).join(', ') || 'none'}).`,
        { clauseId: row.clauseId, check: 'plan', path: where }));
    }
    if (row.assessment !== 'implemented') findings.push(finding('clause-not-implemented',
      `${row.clauseId} is not implemented as the approved ${planned ? 'plan' : 'scope'} says.`, { clauseId: row.clauseId, check: 'plan' }));
    else if (!implementation.length && claim?.fulfillment !== 'test-only') findings.push(finding('clause-implementation-uncited',
      `${row.clauseId} is marked implemented without a cited file:line.`, { clauseId: row.clauseId, check: 'plan' }));
    // (b) Its own test, planned, run and passed, and proving it.
    const tested = !claim || !['not-applicable', 'non-test'].includes(claim.testDisposition);
    const tests = Array.isArray(row.tests) ? row.tests : [];
    if (tested && !tests.length) findings.push(finding('clause-test-uncited', `${row.clauseId} has no cited test that proves it.`, { clauseId: row.clauseId, check: 'tests' }));
    for (const [at, entry] of tests.entries()) {
      const where = cite(entry, `${label} test ${at + 1}`, `rows[${index}].tests[${at}]`);
      if (!where) continue;
      if (claim && (claim.tests ?? []).length && !claim.tests.includes(where)) findings.push(finding('test-outside-plan',
        `${row.clauseId}'s test ${where} is not the planned test (${claim.tests.join(', ')}).`, { clauseId: row.clauseId, check: 'tests', path: where }));
      if (!passed.has(where)) findings.push(finding('clause-test-not-run',
        `${row.clauseId}'s test ${where} has no passing run recorded for this generation.`, { clauseId: row.clauseId, check: 'tests', path: where }));
    }
    if (tested && row.testAssessment !== 'proves') findings.push(finding('clause-test-not-proving',
      `${row.clauseId}'s test does not prove the behaviour the clause states.`, { clauseId: row.clauseId, check: 'tests' }));
  }
  for (const id of delivered) if (!byClause.has(id)) findings.push(finding('clause-unreviewed',
    `Delivered clause '${id}' has no code review row.`, { clauseId: id }));
  // (a) Every changed path is planned, or the reviewer says it supports the plan.
  const plannedPaths = new Set(Object.values(planned ?? {}).flatMap((claim) => [...(claim.expectedPaths ?? []), ...(claim.tests ?? [])]));
  const unplanned = planned ? (code.changedPaths ?? []).filter((relative) => !plannedPaths.has(relative)) : [];
  const reviewed = new Map((Array.isArray(report.unplannedPaths) ? report.unplannedPaths : [])
    .map((entry) => [sources.get(entry?.sourceId)?.path ?? null, entry]));
  for (const relative of unplanned) {
    const entry = reviewed.get(relative);
    if (!entry) findings.push(finding('unplanned-path-unreviewed', `Changed path ${relative} is in no plan row; review it as supporting or out of scope.`,
      { sourceId: byPath.get(relative)?.id ?? null, check: 'plan', path: relative }));
    else if (entry.assessment === 'out-of-scope') findings.push(finding('unplanned-change',
      `Changed path ${relative} is outside the approved plan: ${String(entry.note ?? '').trim()}`, { check: 'plan', path: relative }));
  }
  // (c) Every unresolved quality, security or secret-scan result is reviewed.
  const acknowledged = new Set(Array.isArray(report.qualityReviewed) ? report.qualityReviewed : []);
  for (const item of code.quality ?? []) if (!acknowledged.has(item.id)) findings.push(finding('quality-not-reviewed',
    `Quality result '${item.id}' (${item.summary}) is not reviewed.`, { check: 'quality', qualityId: item.id }));
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
  const upstreamFindings = [];
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
      findings: [finding('review-binding-stale', 'Pinned sources, human clarifications, approved upstream specification, artifact, phase, or generation changed after review.')],
      pendingDispositions: [] };
  }
  const reviewer = report.reviewer;
  if (!context.reviewerAgentId || !context.authorAgentId || context.reviewerReadOnly !== true
      || reviewer?.agentId !== context.reviewerAgentId || reviewer?.readOnly !== true
      || context.reviewerAgentId === context.authorAgentId) {
    findings.push(finding('reviewer-not-independent', 'A trusted, read-only reviewer distinct from the artifact author is required.'));
  }
  reviewedSourceSet(report, binding, findings);
  reviewedVisualSet(report, binding, findings);
  reviewedClarificationSet(report, binding, findings);
  // The reviewer cannot cite these; a person records that the phase proceeds without them.
  for (const entry of context.unreadableSources ?? []) pendingDispositions.push({
    id: `unreadable:${entry.id}`, kind: 'unreadable-source', documentId: entry.id, code: entry.code,
    reason: `${entry.id} (${entry.name ?? entry.id}) cannot be cited: ${entry.reason ?? entry.code}.`
  });
  try {
    if (context.kind === 'specification') evaluateSpecificationRows(report, context, binding, findings, pendingDispositions);
    else if (context.kind === 'document') evaluateDocumentRows(report, context, binding, findings);
    else if (context.kind === 'code') evaluateCodeRows(report, context, findings);
    else evaluatePlanningRows(report, context, findings, pendingDispositions);
  } catch (error) {
    findings.push(finding('review-structure-invalid', error.message));
  }
  if (!Array.isArray(report.findings) || report.findings.length > MAX_FINDINGS) {
    findings.push(finding('review-findings-invalid', `Reviewer findings must be an array of at most ${MAX_FINDINGS} entries.`));
  } else {
    const ids = new Set();
    for (const [index, entry] of report.findings.entries()) {
      if (!ID.test(String(entry?.id ?? '')) || ids.has(entry.id)
          || !['blocking', 'advisory'].includes(entry.severity)
          || !String(entry.message ?? '').trim()) {
        findings.push(finding('review-finding-invalid', 'Reviewer findings need a unique id, severity "blocking" or "advisory", and non-empty message (not explanation).'));
        continue;
      }
      ids.add(entry.id);
      // A code finding names its check and cites a changed file's line; design blocks only for a named defect.
      if (context.kind === 'code') {
        if (!['plan', 'tests', 'quality', 'design'].includes(entry.check) || !entry.sourceId || !Number.isSafeInteger(entry.line) || !entry.quote) {
          findings.push(finding('finding-citation-missing', `Reviewer finding '${entry.id}' needs its check (plan, tests, quality or design) and a cited file:line.`, { field: `findings[${index}]` }));
        }
        if (entry.check === 'design' && entry.severity === 'blocking' && !String(entry.defect ?? '').trim()) {
          findings.push(finding('design-blocking-without-defect', `Design finding '${entry.id}' blocks only for a real maintainability defect: name it in defect, or make it advisory.`, { field: `findings[${index}]` }));
        }
      }
      if (entry.sourceId) {
        if (context.visualSources?.some(source => source.id === entry.sourceId)) {
          if (!String(entry.attestation ?? '').trim()) findings.push(finding('visual-citation-invalid',
            'A visual finding must identify its inspected page/region and observation.', { sourceId: entry.sourceId }));
        } else citedSource(entry, new Map(context.sources.map((source) => [source.id, source])), findings,
          `Reviewer finding '${entry.id}'`, `findings[${index}]`);
      }
      // A planning finding about the approved specification is that step's to correct: once raised there
      // it holds only the Story's ending, never the plan; until then its route is the raise [PHR:REQ-003].
      const owner = entry.severity === 'blocking' && context.kind === 'planning' && entry.ownerPhase
        && entry.ownerPhase === context.upstreamSpecPhase ? entry.ownerPhase : null;
      const raised = owner ? (context.upstreamIssues ?? []).find((issue) => reviewFindingRaised(issue, entry)) : null;
      if (raised) upstreamFindings.push({ id: entry.id, ownerPhase: owner, issue: raised.id, status: raised.status, message: entry.message });
      else if (owner) findings.push(finding('reviewer-blocker',
        `Reviewer finding '${entry.id}' is about ${owner}'s approved output: ${entry.message} Raise it to ${owner}'s approvers as an upstream issue; then it holds only the Story's ending, not ${context.phase}.`,
        { reviewFindingId: entry.id, ownerPhase: owner, upstreamPhase: owner, about: entry.clauseId ?? entry.id }));
      else if (entry.severity === 'blocking') findings.push(finding('reviewer-blocker',
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
    ...(upstreamFindings.length ? { upstreamFindings } : {}),
    disclaimer: 'A ready result verifies review structure, citations, bindings, and recorded dispositions; semantic correctness remains a reviewer judgment.'
  };
}
