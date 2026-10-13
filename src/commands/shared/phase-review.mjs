/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { documentCatalog, viewDocument } from '../../documents.mjs';
import { phaseDocumentVersionMatches, phaseDisplayBinding } from '../../review-display.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { pathForDisplay } from './path-for-display.mjs';
import { readRecord } from '../../schema-migrations.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { criterionResults, witnessResult, describeWitnessResult } from '../../verification/witness-results.mjs';
import { withReadScope } from '../../read-scope.mjs';
import { witnessMappingReview } from '../../review.mjs';
import { approvalReviewBinding } from '../../choices.mjs';
import { owedDecisions, stepsThrough } from '../../owed-decisions.mjs';
import { phaseUpstreamDiscrepancies } from '../../phase-upstream-discrepancies.mjs';
import { openUpstreamIssues, upstreamIssueDecideCommand } from '../../upstream-issues.mjs';
import { phaseAuthoringSummary } from '../../phase-authoring-summary.mjs';

export async function phaseReview(root, config, workflow, phase, { includeContinuation = false } = {}) {
  const records = (await documentCatalog(root, config, workflow))
    .filter((record) => ['artifact', 'agent-brief'].includes(record.type)
      && record.phase === phase.id
      && Number(record.generation ?? phase.generation) === Number(phase.generation));
  const documents = [];
  for (const record of records) {
    try {
      const viewed = await viewDocument(root, config, workflow, record.id);
      if (!phaseDocumentVersionMatches(record, viewed)) {
        throw new SingularityFlowError(`Document '${record.id}' changed while reading this review. Read the current phase again.`, {
          code: 'DOCUMENT_REVIEW_CHANGED'
        });
      }
      const source = ['code', 'test'].includes(record.kind) && viewed.content != null;
      const previewBytes = workflow.resolution?.codeDelivery?.display?.previewBytes ?? 4096;
      const fullDocumentMaximumBytes = workflow.resolution?.codeDelivery?.display?.fullDocumentMaximumBytes ?? 65536;
      const sourceBytes = source && viewed.content != null ? Buffer.from(viewed.content) : null;
      documents.push({
        id: record.id,
        label: record.label,
        kind: record.kind,
        path: record.path,
        mimeType: record.mimeType,
        size: record.size,
        sha256: record.sha256,
        generation: record.generation ?? phase.generation,
        binary: viewed.binary,
        previewBytes: viewed.previewBytes,
        truncated: viewed.truncated,
        absolutePath: viewed.absolutePath ?? pathForDisplay(root, record.path),
        ...(source ? {
          display: {
            mode: 'reference-preview',
            preview: sourceBytes.subarray(0, previewBytes).toString('utf8'),
            previewBytes: Math.min(sourceBytes.length, previewBytes),
            truncated: sourceBytes.length > previewBytes,
            full: sourceBytes.length <= fullDocumentMaximumBytes ? viewed.content : null,
            fullDocumentMaximumBytes,
            reference: `sfref://generation/${encodeURIComponent(workflow.workItem.id)}/${encodeURIComponent(phase.id)}/${phase.generation}/${record.path.split('/').map(encodeURIComponent).join('/')}`
          }
        } : { content: viewed.content })
      });
    } catch (error) {
      documents.push({
        id: record.id,
        label: record.label,
        kind: record.kind,
        path: record.path,
        mimeType: record.mimeType,
        size: record.size,
        sha256: record.sha256,
        generation: record.generation ?? phase.generation,
        error: error?.message ?? String(error)
      });
    }
  }
  // Each criterion witness of this delivery, judged against the attempt its command bound [E2G-016];
  // a delivery published but not yet submitted shows what its preflight run observed.
  const attempts = new Map();
  let skippedTests = 0;
  const submittedDelivery = phase.deliveryEvidence?.status === 'ready';
  const boundAttempts = submittedDelivery ? phase.deliveryEvidence?.testExecutions : phase.deliveryEvidence?.preflightAttempts;
  for (const execution of boundAttempts ?? []) {
    if (execution.kind === 'phase-validation-observation') continue;
    try {
      const receipt = readRecord('test-execution', await readFile(path.join(root, execution.receiptPath))).record;
      skippedTests += Math.max(0, Number(receipt.tests?.skipped ?? 0) || 0);
      attempts.set(execution.commandId, receipt);
    } catch {
      attempts.set(execution.commandId, { attemptId: null, status: 'unavailable', terminal: false, tests: {}, occurrences: [] });
    }
  }
  const covering = (testSource) => (boundAttempts ?? []).find((execution) =>
    (execution.affectedRoots ?? []).some((affected) => affected === '.' || testSource === affected
      || testSource.startsWith(`${affected.replace(/\/$/u, '')}/`)))?.commandId ?? null;
  const criteria = criterionResults((phase.deliveryEvidence?.acceptanceCriteria?.witnesses ?? []).map((witness) => {
    const commandId = attempts.has(witness.commandId) ? witness.commandId : covering(witness.testSource);
    return witnessResult({ ...witness, commandId }, attempts.get(commandId) ?? null, { submitted: submittedDelivery });
  }));
  const verifiedCriteria = criteria.filter((entry) => entry.status === 'met');
  const exactCriteria = verifiedCriteria.filter((entry) => entry.identity === 'source-bound').length;
  const unmet = criteria.length - verifiedCriteria.length;
  // Both read the one submitted packet; a read scope verifies it once for the two of them.
  const { witnessReview, reviewBinding } = await withReadScope(async () => ({
    witnessReview: await witnessMappingReview(root, config, workflow, phase),
    // Only an available, current submitted review can be bound by a human approval surface.
    // Drafts, historical phases and unavailable document bodies convey no reusable approval binding.
    reviewBinding: phase.id === workflow.currentPhase && phase.status === 'awaiting_approval'
      && documents.every((document) => !document.error)
      ? await approvalReviewBinding(root, config, workflow)
      : null
  }));
  return {
    schemaVersion: 1,
    workId: workflow.workItem.id,
    phase: phase.id,
    phaseLabel: phase.label,
    status: phase.status,
    generation: phase.generation,
    reviewBinding,
    displayBinding: phaseDisplayBinding(root, workflow.workItem.id, phase, documents),
    testEvidence: phase.deliveryEvidence ? {
      status: phase.deliveryEvidence.status ?? 'unavailable',
      executions: phase.deliveryEvidence.testExecutions?.length ?? 0,
      attempts: phase.deliveryEvidence.attemptHistory?.length ?? 0,
      // What the approver is shown about acceptance criteria, stated at its real strength [E2G-017].
      acceptance: {
        criteria: criteria.map((entry) => ({
          clauseId: entry.clauseId, status: entry.status, assurance: entry.assurance, identity: entry.identity, execution: entry.execution,
          witnesses: entry.witnesses.map((result) => ({
            test: result.label, testSource: result.testSource, profile: result.profile, commandId: result.commandId,
            attemptId: result.attemptId, outcome: result.outcome, status: result.status, assurance: result.assurance,
            requiredAssurance: result.requiredAssurance, reasons: result.reasons ?? [], words: describeWitnessResult(result)
          }))
        })),
        unattachedTags: phase.deliveryEvidence.acceptanceCriteria?.unattachedTags ?? [],
        skippedTests,
        statement: criteria.length
          ? `${submittedDelivery ? '' : 'In the preflight run, '}${verifiedCriteria.length} of ${criteria.length} acceptance criteria verified (${exactCriteria} by their own test result, ${verifiedCriteria.length - exactCriteria} by a module test command)${unmet ? `; ${unmet} not verified yet` : ''}${submittedDelivery ? '.' : '; submission runs the tests again.'}`
          : 'No acceptance criterion is tagged on a test in this delivery.'
      },
      notice: 'A criterion is judged by its own tagged test where the runner reports exact cases (Node, Jest, Vitest, JUnit 5); counts-only Node reports cannot verify it. Local observation is not independent attestation.'
    } : null,
    witnessReview,
    owedDecisions: reviewBinding ? await owedDecisions(root, config, workflow, stepsThrough(workflow, phase.id)) : null,
    documents,
    upstreamDiscrepancies: phaseUpstreamDiscrepancies(documents, workflow, phase.id),
    upstreamIssues: openUpstreamIssues(workflow).map(({ issue, status }) => ({ id: issue.id, phase: issue.phase, about: issue.about,
      problem: issue.problem, status, decide: upstreamIssueDecideCommand(workflow.workItem.id, issue) })),
    ...(await phaseAuthoringSummary(root, config, workflow, phase, { documents, includeContinuation }))
  };
}
