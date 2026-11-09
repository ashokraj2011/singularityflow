/** One authoring contract for the context packet and the pre-retention format check. */
import { z } from 'zod';

import { currentSchemaVersion } from './schema-migrations.mjs';
import { derivePlannedClaimMap, extractClauses, FULFILLMENT_TYPES } from './specifications.mjs';
import { sourceReviewScenarioIds } from './source-grounded-review.mjs';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u);
const text = (maximum = 4096) => z.string().trim().min(1).max(maximum);
const paths = z.array(text(1024)).max(2000);
const citation = { line: z.number().int().positive(), quote: text(1024) };
const specificationRow = z.discriminatedUnion('outcome', [
  z.strictObject({
    id, sourceId: id, outcome: z.literal('covered'),
    scenarioId: z.string().regex(/^S\d+$/u), clauseIds: z.array(id).min(1).max(2000),
    line: citation.line.optional(), quote: citation.quote.optional(),
    attestation: text(1024).optional().describe('For an actually inspected visual source, name page/region and observation instead of line/quote. Unreadable sources still need a separate human disposition.')
  }),
  z.strictObject({ id, sourceId: id, line: citation.line.optional(), quote: citation.quote.optional(), attestation: text(1024).optional(), outcome: z.literal('excluded'), reason: text() }),
  z.strictObject({ id, sourceId: id, line: citation.line.optional(), quote: citation.quote.optional(), attestation: text(1024).optional(), outcome: z.literal('question'), question: text() })
]);
const planningRow = z.strictObject({
  id: id.optional(),
  clauseId: id.describe('One exact approved clause ID; singular clauseId, not clauseIds.'),
  expectedPaths: paths.describe('Copy from reportTemplate; empty is valid for a pinned test-only claim.'),
  plannedTests: paths.describe('Copy from reportTemplate; the review field is plannedTests, not tests.'),
  testDisposition: z.enum(['applicable', 'unspecified', 'not-applicable', 'non-test']),
  verificationCriterion: id.optional(),
  testReason: text().nullable().optional(),
  fulfillment: z.enum(FULFILLMENT_TYPES).optional(),
  steps: z.array(id).max(2000).optional(),
  observableResult: text().optional(),
  assessment: z.enum(['supported', 'unsupported']).describe('An independent judgment, never a default. Use unsupported and a blocking finding for a real gap.')
});
const reviewerFinding = z.strictObject({
  id, severity: z.enum(['blocking', 'advisory']),
  message: text().describe('Explain the evidence and gap in message; not explanation.'),
  clauseId: id.optional(), sourceId: id.optional(),
  line: citation.line.optional(), quote: citation.quote.optional(), attestation: text(1024).optional(),
  ownerPhase: id.optional().describe('Planning review only: the approved earlier step whose output this finding is about (the specification), never the plan. It is raised there as an upstream issue and then holds only the Story\'s ending, not the plan.')
});

function schema(kind) {
  if (!['specification', 'planning'].includes(kind)) throw new TypeError('Unknown source review kind.');
  return z.strictObject({
    schemaVersion: z.literal(currentSchemaVersion('source-grounded-review')),
    resultType: z.literal('source-grounded-review'), kind: z.literal(kind),
    binding: z.record(z.string(), z.unknown()).describe('Copy the entire exact binding from context; never edit it.'),
    reviewer: z.strictObject({ agentId: id, readOnly: z.literal(true) }),
    sourcesReviewed: z.array(id).max(100),
    visualSourcesReviewed: z.array(z.strictObject({ sourceId: id,
      method: z.enum(['image-tool', 'pdf-tool']), locator: text(1024), observations: text() })).max(100).optional(),
    clarificationsReviewed: z.array(id).max(2).optional().describe('Read and acknowledge every record in context.clarifications. Omit only when none is pinned.'),
    rows: z.array(kind === 'planning' ? planningRow : specificationRow).min(kind === 'planning' ? 0 : 1).max(2000),
    findings: z.array(reviewerFinding).max(500)
  });
}

/** Generated from the same schema used to validate submissions, not a second prose contract. */
export function sourceReviewReportSchema(kind) {
  return z.toJSONSchema(schema(kind));
}

function fieldPath(parts) {
  return parts.reduce((value, part) => typeof part === 'number' ? `${value}[${part}]`
    : `${value}${value ? '.' : ''}${part}`, '') || '$';
}

export function validateSourceReviewReport(report, kind) {
  const result = schema(kind).safeParse(report);
  const findings = result.success ? [] : result.error.issues.map((issue) => ({
    code: 'review-format-invalid', field: fieldPath(issue.path),
    message: issue.code === 'unrecognized_keys'
      ? `Unexpected field(s): ${issue.keys.join(', ')}. Use reportSchema and reportTemplate from review-source context.`
      : issue.message
  }));
  return { status: findings.length ? 'correction-required' : 'ready', findings };
}

/** Copy objective plan metadata only. The independent reviewer must supply every assessment. */
export function sourceReviewReportTemplate(input) {
  let rows = [];
  if (input.kind === 'planning') {
    const clauses = extractClauses(input.upstreamSpec.text, { sourcePath: input.upstreamSpec.path });
    const clauseIds = clauses.map(clause => clause.id);
    const planned = derivePlannedClaimMap(input.artifact.text, { clauseIds, clauses }).claimMap.claims;
    rows = clauseIds.map((clauseId) => {
      const claim = planned[clauseId];
      return { clauseId, expectedPaths: claim?.expectedPaths ?? [], plannedTests: claim?.tests ?? [],
        testDisposition: claim?.testDisposition ?? 'unspecified', testReason: claim?.testReason ?? null,
        ...(claim?.verificationCriterion ? { verificationCriterion: claim.verificationCriterion } : {}),
        ...(claim?.fulfillment ? { fulfillment: claim.fulfillment } : {}),
        ...(claim?.steps ? { steps: claim.steps } : {}),
        ...(claim?.observableResult ? { observableResult: claim.observableResult } : {}),
        assessment: 'unreviewed' };
    });
  }
  return {
    schemaVersion: currentSchemaVersion('source-grounded-review'), resultType: 'source-grounded-review', kind: input.kind,
    binding: input.binding, reviewer: { agentId: input.reviewerAgentId, readOnly: true },
    sourcesReviewed: [...input.sources, ...(input.visualSources ?? [])].map((source) => source.id),
    ...(input.visualSources?.length ? { visualSourcesReviewed: [] } : {}),
    ...(input.clarifications?.length ? { clarificationsReviewed: [] } : {}), rows, findings: []
  };
}

/** Citation mechanics only: never infer coverage, rewrite quotes, or make reviewer judgments. */
export function sourceReviewCitationGuide(input) {
  let clauses = {};
  if (input.kind === 'specification') {
    try { clauses = { clauseIds: extractClauses(input.artifact.text, { sourcePath: input.artifact.path }).map(clause => clause.id) }; }
    catch (error) { clauses = { clauseInventoryError: error.message }; }
  }
  return {
    lineBasis: '1-based lines of sources[].text, not the JSON packet, original attachment, artifact or clarification record. In the agent view, read each source textFile with the native file tool; its line numbers are citation line numbers.',
    quoteRule: 'Copy an exact non-empty substring of that single line, at most 1024 characters. Do not paraphrase, normalize whitespace, include a line-number prefix, or combine lines.',
    ...(input.visualSources?.length ? { visualRule: 'Inspect exact visualSources[].absolutePath with an actual native image/PDF tool. Acknowledge each in visualSourcesReviewed with method, locator and observations. A covered row cites sourceId and attestation naming the page/region and observed behavior; never invent line/quote for pixels.' } : {}),
    ...(input.kind === 'specification' ? {
      scenarioIds: [...sourceReviewScenarioIds(input.artifact.text)],
      ...clauses,
      mappingRule: 'Independently map every scenario and clause, including scenarios refined by pinned answers. Reuse a source line only when it genuinely supports that scenario. Acknowledge the clarification ID separately. If unsupported, retain a blocking finding instead of inventing coverage.'
    } : {})
  };
}

/** Bounded proposals bound to the already checked input/report; no bytes or assessments change. */
export function sourceReviewRepairGuide(report, input, checked) {
  if (checked.evaluation?.status === 'stale') return {
    status: 'reload-context', instruction: 'Inputs changed. Read a fresh context and independently review it; do not transplant citations or judgments from the stale packet.',
    citations: [], mappingTasks: []
  };
  const sources = new Map(input.sources.map(source => [source.id, source]));
  const candidates = (checked.findings ?? []).filter(entry => ['citation-line-invalid', 'citation-quote-invalid'].includes(entry.code));
  const citations = candidates.slice(0, 25).map(entry => {
    const match = /^(rows|findings)\[(\d+)\]$/u.exec(entry.field ?? '');
    const row = match ? report?.[match[1]]?.[Number(match[2])] : null;
    const source = sources.get(entry.sourceId);
    const lines = source.text.split(/\r?\n/u);
    const quote = row?.quote;
    const validQuote = typeof quote === 'string' && Boolean(quote.trim()) && quote.length <= 1024;
    const matches = [];
    let matchCount = 0;
    if (validQuote) for (let index = 0; index < lines.length; index++) {
      if (lines[index].includes(quote)) {
        matchCount++;
        if (matches.length < 10) matches.push(index + 1);
      }
    }
    const current = Number.isSafeInteger(row?.line) ? lines[row.line - 1] : undefined;
    return { field: entry.field, sourceId: source.id, textSha256: checked.evaluation.binding.sources.find(bound => bound.id === source.id).textSha256,
      matchCount, matchingLines: matches,
      ...(matchCount === 1 ? { proposedEdit: { field: `${entry.field}.line`, value: matches[0] },
        instruction: 'The unchanged quote occurs on one exact pinned source line. Verify it, change only this line field, then check the changed packet.' }
        : { instruction: matchCount > 1
          ? 'The quote occurs on multiple lines. Independently select the supporting line; no automatic choice is safe.'
          : 'No exact single-line match. Read the pinned source and independently recite it; no paraphrase or fuzzy replacement is allowed.' }),
      ...(current !== undefined ? { suppliedLineText: current.slice(0, 1024), suppliedLineTruncated: current.length > 1024 } : {}) };
  });
  const mappingTasks = (checked.evaluation?.findings ?? []).filter(entry => [
    'scenario-unmapped', 'clause-unmapped', 'source-unmapped', 'source-statement-unmapped', 'source-statements-unmapped', 'clause-unreviewed'
  ].includes(entry.code));
  return { status: checked.retentionReady ? 'retain' : 'repair-packet',
    reportSha256: checked.evaluation?.reportSha256 ?? null,
    instruction: checked.retentionReady
      ? mappingTasks.length
        ? 'Independently resolve the listed missing mappings now: add genuinely supported rows and recheck changed bytes within the repair budget, or retain already-reviewed genuine gaps with blocking findings. Never invent coverage or require an author successor for a reviewer mapping omission. Retention is not approval.'
        : 'Retain this valid packet, including honest semantic gaps. Correction-required is not a packet failure or approval; the retained review routes real gaps to the author.'
      : 'Repair this private packet in the same review turn, then check it. At most two changed-packet repair attempts; never retry unchanged bytes. Preserve binding, sources, judgments and human decisions.',
    citations, omittedCitations: Math.max(0, candidates.length - citations.length),
    mappingTasks: mappingTasks.slice(0, 25), omittedMappingTasks: Math.max(0, mappingTasks.length - 25),
    mappingRule: 'Add a covered row only when the pinned source genuinely supports the scenario/clause, reconciling pinned answers. Otherwise retain a blocking finding; an unmapped scenario alone does not prevent retention. Never mark a gap supported to pass.' };
}
