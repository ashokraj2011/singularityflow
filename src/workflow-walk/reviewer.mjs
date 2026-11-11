/**
 * The walk's stand-in for a step's independent reviewer. A real review is model-backed (the step's
 * reviewer agent reads the review packet and writes a report); the walk records that as the step's
 * expected review, then writes the report a reviewer would for the walk's own small change, in the
 * shape the packet's template and citation guide ask for, and retains it through the same
 * `review-source stage | check | submit` route a reviewer uses. The CLI's own checks decide whether it
 * is ready; nothing here bypasses them.
 */
import { extractNormativeStatements } from '../scope/extract.mjs';

const firstLine = (source) => {
  const lines = String(source.text ?? '').split(/\r?\n/u);
  const index = lines.findIndex((line) => line.trim());
  return index < 0 ? null : { line: index + 1, quote: lines[index].trim() };
};

function citeIn(source, needle) {
  const lines = String(source.text ?? '').split(/\r?\n/u);
  const index = lines.findIndex((line) => line.includes(needle));
  return index < 0 ? { sourceId: source.id, ...firstLine(source) } : { sourceId: source.id, line: index + 1, quote: needle };
}

function documentReport(packet) {
  return {
    ...packet.reportTemplate,
    rows: [
      ...(packet.sources ?? []).map((source, index) => ({ id: `source-${index + 1}`, sourceId: source.id, ...firstLine(source), outcome: 'consistent' }))
        .filter((row) => row.line),
      ...(packet.visualSources ?? []).map((source, index) => ({ id: `visual-${index + 1}`, sourceId: source.id,
        attestation: 'Whole image: the screen the Story describes.', outcome: 'consistent' }))
    ],
    ...(packet.visualSources?.length ? { visualSourcesReviewed: packet.visualSources.map((source) => ({ sourceId: source.id, method: 'image-tool',
      locator: 'whole image', observations: 'The screen the Story describes.' })) } : {}),
    ...(packet.clarifications?.length ? { clarificationsReviewed: packet.clarifications.map((entry) => entry.id) } : {}),
    findings: []
  };
}

function codeReport(packet) {
  const byPath = new Map((packet.sources ?? []).map((source) => [source.path, source]));
  const planned = packet.code?.planned ?? {};
  const passed = packet.code?.passedTests ?? [];
  const rows = (packet.reportTemplate?.rows ?? []).map((row) => {
    const claim = planned[row.clauseId] ?? {};
    // The planned path first; else the changed source that carries the clause's tag.
    const product = (claim.expectedPaths ?? []).map((relative) => byPath.get(relative)).find(Boolean)
      ?? (packet.sources ?? []).find((source) => !passed.includes(source.path) && !/(^|\/)test/u.test(source.path ?? '') && String(source.text ?? '').includes(row.clauseId));
    const test = (claim.tests ?? []).map((relative) => byPath.get(relative)).find(Boolean)
      ?? (packet.sources ?? []).find((source) => passed.includes(source.path) && String(source.text ?? '').includes(row.clauseId));
    const tested = row.testAssessment !== 'not-applicable';
    return { clauseId: row.clauseId, implementation: product ? [citeIn(product, row.clauseId)] : [],
      tests: tested && test ? [citeIn(test, row.clauseId)] : [], assessment: 'implemented', testAssessment: tested ? 'proves' : 'not-applicable' };
  });
  return {
    ...packet.reportTemplate, rows,
    unplannedPaths: (packet.reportTemplate?.unplannedPaths ?? []).map((entry) => ({ ...entry, assessment: 'supporting', note: 'Supports the planned change.' })),
    qualityReviewed: (packet.code?.quality ?? []).map((entry) => entry.id),
    ...(packet.clarifications?.length ? { clarificationsReviewed: packet.clarifications.map((entry) => entry.id) } : {}),
    findings: []
  };
}

function specificationReport(packet) {
  const scenarios = packet.citationGuide?.scenarioIds ?? [];
  const clauseIds = packet.citationGuide?.clauseIds ?? [];
  const rows = [];
  for (const source of packet.sources ?? []) {
    const lines = String(source.text ?? '').split(/\r?\n/u);
    const cited = [...new Set(extractNormativeStatements(source.text ?? '', { sourceId: source.id }).map((statement) => statement.line))];
    const at = cited.length ? cited.map((line) => ({ line, quote: lines[line - 1].trim() })) : [firstLine(source)].filter(Boolean);
    for (const [index, citation] of at.entries()) for (const scenarioId of scenarios) {
      rows.push({ id: `${String(source.id).replace(/[^A-Za-z0-9._-]/gu, '-')}-${index + 1}-${scenarioId}`, sourceId: source.id, ...citation, outcome: 'covered', scenarioId, clauseIds });
    }
  }
  return { ...packet.reportTemplate, rows,
    ...(packet.clarifications?.length ? { clarificationsReviewed: packet.clarifications.map((entry) => entry.id) } : {}), findings: [] };
}

function planningReport(packet) {
  return { ...packet.reportTemplate, rows: (packet.reportTemplate?.rows ?? []).map((row) => ({ ...row, assessment: 'supported' })),
    ...(packet.clarifications?.length ? { clarificationsReviewed: packet.clarifications.map((entry) => entry.id) } : {}), findings: [] };
}

const REPORTS = { document: documentReport, code: codeReport, specification: specificationReport, planning: planningReport };

/** The report a reviewer would retain for this packet, or null for a kind the walk cannot review. */
export function reviewReport(packet) {
  return REPORTS[packet?.kind]?.(packet) ?? null;
}
