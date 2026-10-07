/** One authoring contract for the context packet and the pre-retention format check. */
import { z } from 'zod';

import { currentSchemaVersion } from './schema-migrations.mjs';
import { derivePlannedClaimMap, extractClauses, FULFILLMENT_TYPES } from './specifications.mjs';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u);
const text = (maximum = 4096) => z.string().trim().min(1).max(maximum);
const paths = z.array(text(1024)).max(2000);
const citation = { line: z.number().int().positive(), quote: text(1024) };
const specificationRow = z.discriminatedUnion('outcome', [
  z.strictObject({
    id, sourceId: id, outcome: z.literal('covered'),
    scenarioId: z.string().regex(/^S\d+$/u), clauseIds: z.array(id).min(1).max(2000),
    line: citation.line.optional(), quote: citation.quote.optional(),
    attestation: text(1024).optional().describe('Only for unreadableSources: name the page, section or frame instead of line/quote.')
  }),
  z.strictObject({ id, sourceId: id, ...citation, outcome: z.literal('excluded'), reason: text() }),
  z.strictObject({ id, sourceId: id, ...citation, outcome: z.literal('question'), question: text() })
]);
const planningRow = z.strictObject({
  id: id.optional(),
  clauseId: id.describe('One exact approved clause ID; singular clauseId, not clauseIds.'),
  expectedPaths: paths.describe('Copy from reportTemplate; empty is valid for a pinned test-only claim.'),
  plannedTests: paths.describe('Copy from reportTemplate; the review field is plannedTests, not tests.'),
  testDisposition: z.enum(['applicable', 'unspecified', 'not-applicable']),
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
  line: citation.line.optional(), quote: citation.quote.optional()
});

function schema(kind) {
  if (!['specification', 'planning'].includes(kind)) throw new TypeError('Unknown source review kind.');
  return z.strictObject({
    schemaVersion: z.literal(currentSchemaVersion('source-grounded-review')),
    resultType: z.literal('source-grounded-review'), kind: z.literal(kind),
    binding: z.record(z.string(), z.unknown()).describe('Copy the entire exact binding from context; never edit it.'),
    reviewer: z.strictObject({ agentId: id, readOnly: z.literal(true) }),
    sourcesReviewed: z.array(id).max(100),
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
    const clauseIds = extractClauses(input.upstreamSpec.text, { sourcePath: input.upstreamSpec.path }).map((clause) => clause.id);
    const planned = derivePlannedClaimMap(input.artifact.text, { clauseIds }).claimMap.claims;
    rows = clauseIds.map((clauseId) => {
      const claim = planned[clauseId];
      return { clauseId, expectedPaths: claim?.expectedPaths ?? [], plannedTests: claim?.tests ?? [],
        testDisposition: claim?.testDisposition ?? 'unspecified', testReason: claim?.testReason ?? null,
        ...(claim?.fulfillment ? { fulfillment: claim.fulfillment } : {}),
        ...(claim?.steps ? { steps: claim.steps } : {}),
        ...(claim?.observableResult ? { observableResult: claim.observableResult } : {}),
        assessment: 'unreviewed' };
    });
  }
  return {
    schemaVersion: currentSchemaVersion('source-grounded-review'), resultType: 'source-grounded-review', kind: input.kind,
    binding: input.binding, reviewer: { agentId: input.reviewerAgentId, readOnly: true },
    sourcesReviewed: input.sources.map((source) => source.id),
    ...(input.clarifications?.length ? { clarificationsReviewed: [] } : {}), rows, findings: []
  };
}
