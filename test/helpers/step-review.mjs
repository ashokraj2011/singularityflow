/**
 * The independent reviewer's part in a walk with reviews on [review level 2]: read the step's review packet, write
 * a report in the shape the packet's template and citation guide ask for (specification, planning, document or code), then stage, check and retain it through
 * the CLI. A test that walks a workflow with reviews on uses this for every reviewed step; the report is honest for
 * the walk's own small fixtures (each source agrees with the document; each delivered clause is implemented and
 * tested where its plan row says), and the CLI's checks decide whether it is ready, never this helper.
 */
import assert from 'node:assert/strict';

import { extractNormativeStatements } from '../../src/scope/extract.mjs';

const firstLine = (source) => {
  const lines = source.text.split(/\r?\n/u);
  const index = lines.findIndex((line) => line.trim());
  assert.ok(index >= 0, `source ${source.id} has no text to cite`);
  return { line: index + 1, quote: lines[index].trim() };
};

/** The first line of a changed file that names `needle`, else its first line: a file:line citation. */
function citeIn(source, needle) {
  const lines = source.text.split(/\r?\n/u);
  const index = lines.findIndex((line) => line.includes(needle));
  return index < 0 ? { sourceId: source.id, ...firstLine(source) } : { sourceId: source.id, line: index + 1, quote: needle };
}

/** Each pinned source agrees with the document: one cited row each; every pinned answer acknowledged. */
export function documentReport(packet) {
  return {
    ...packet.reportTemplate,
    rows: [
      ...packet.sources.map((source, index) => ({ id: `source-${index + 1}`, sourceId: source.id, ...firstLine(source), outcome: 'consistent' })),
      ...(packet.visualSources ?? []).map((source, index) => ({ id: `visual-${index + 1}`, sourceId: source.id,
        attestation: 'Whole image: the screen the Story describes.', outcome: 'consistent' }))
    ],
    ...(packet.visualSources?.length ? { visualSourcesReviewed: packet.visualSources.map((source) => ({ sourceId: source.id, method: 'image-tool',
      locator: 'whole image', observations: 'The screen the Story describes.' })) } : {}),
    ...(packet.clarifications?.length ? { clarificationsReviewed: packet.clarifications.map((entry) => entry.id) } : {}),
    findings: []
  };
}

/**
 * (a) each delivered clause implemented in its planned path, every unplanned path supporting; (b) its planned
 * test, which ran, proves it; (c) every quality result reviewed. `findings` adds the reviewer's own findings.
 */
export function codeReport(packet, { findings = [] } = {}) {
  const byPath = new Map(packet.sources.map((source) => [source.path, source]));
  const planned = packet.code.planned ?? {};
  const rows = packet.reportTemplate.rows.map((row) => {
    const claim = planned[row.clauseId] ?? {};
    const product = (claim.expectedPaths ?? []).map((relative) => byPath.get(relative)).find(Boolean);
    const test = (claim.tests ?? []).map((relative) => byPath.get(relative)).find(Boolean)
      ?? packet.sources.find((source) => packet.code.passedTests.includes(source.path) && source.text.includes(row.clauseId));
    const tested = row.testAssessment !== 'not-applicable';
    return { clauseId: row.clauseId, implementation: product ? [citeIn(product, row.clauseId)] : [],
      tests: tested && test ? [citeIn(test, row.clauseId)] : [], assessment: 'implemented', testAssessment: tested ? 'proves' : 'not-applicable' };
  });
  return {
    ...packet.reportTemplate, rows,
    unplannedPaths: packet.reportTemplate.unplannedPaths.map((entry) => ({ ...entry, assessment: 'supporting', note: 'Supports the planned change.' })),
    qualityReviewed: packet.code.quality.map((entry) => entry.id),
    findings
  };
}

/**
 * A specification read against the Story: every requirement statement in each source, and each source itself, is
 * covered by the specification's scenarios and clauses (one walk's small Story states one behaviour).
 */
export function specificationReport(packet) {
  const scenarios = packet.citationGuide.scenarioIds ?? [];
  const clauseIds = packet.citationGuide.clauseIds ?? [];
  assert.ok(scenarios.length && clauseIds.length, 'the specification names its scenarios and clauses');
  const rows = [];
  for (const source of packet.sources) {
    const lines = source.text.split(/\r?\n/u);
    const cited = [...new Set(extractNormativeStatements(source.text, { sourceId: source.id }).map((statement) => statement.line))];
    const at = cited.length ? cited.map((line) => ({ line, quote: lines[line - 1].trim() })) : [firstLine(source)];
    for (const [index, citation] of at.entries()) for (const scenarioId of scenarios) {
      rows.push({ id: `${source.id.replace(/[^A-Za-z0-9._-]/gu, '-')}-${index + 1}-${scenarioId}`, sourceId: source.id, ...citation, outcome: 'covered', scenarioId, clauseIds });
    }
  }
  return { ...packet.reportTemplate, rows,
    ...(packet.clarifications?.length ? { clarificationsReviewed: packet.clarifications.map((entry) => entry.id) } : {}), findings: [] };
}

/** A plan whose every clause row could deliver and prove its clause: each prefilled row supported. */
export function planningReport(packet) {
  return { ...packet.reportTemplate, rows: packet.reportTemplate.rows.map((row) => ({ ...row, assessment: 'supported' })),
    ...(packet.clarifications?.length ? { clarificationsReviewed: packet.clarifications.map((entry) => entry.id) } : {}), findings: [] };
}

const REPORTS = { document: documentReport, code: (packet) => codeReport(packet), specification: specificationReport, planning: planningReport };

/** Stage, check and retain `report` for `phase`; returns the retained review's status. `json(args)` runs the CLI and parses its JSON. */
export function retainStepReview(json, phase, report) {
  const staged = json(['review-source', 'stage', phase, '--report-json', JSON.stringify(report), '--json']);
  const checked = json(['review-source', 'check', phase, '--report-file', staged.stagingPath, '--json']);
  assert.equal(checked.retentionReady, true, `${phase} review is not ready to retain: ${JSON.stringify(checked.findings ?? checked).slice(0, 3000)}`);
  json(['review-source', 'submit', phase, '--report-file', staged.stagingPath, '--json']);
  return json(['review-source', 'status', phase, '--json']);
}

/** Review a published step as its independent reviewer would, and expect it ready. */
export function reviewStep(json, phase) {
  const packet = json(['review-source', 'context', phase, '--json']);
  assert.ok(REPORTS[packet.kind], `${phase} is reviewed as ${packet.kind}: ${JSON.stringify(packet.continuation ?? packet.reason ?? null).slice(0, 1000)}`);
  const status = retainStepReview(json, phase, REPORTS[packet.kind](packet));
  assert.equal(status.status, 'ready', `${phase} review: ${JSON.stringify(status.findings ?? status).slice(0, 3000)}`);
  return { packet, status };
}
