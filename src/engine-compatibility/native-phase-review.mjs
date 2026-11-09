import {describeWitnessResult} from '../verification/witness-results.mjs';
/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { storyTestScope } from '../code-delivery-policy.mjs';
import { createDocumentReadSession } from '../documents-read.mjs';
import { measureCommandSpan } from '../dx-timing-context.mjs';
import { phaseDocumentVersionMatches, phaseDisplayBinding } from '../review-display.mjs';
import { SingularityFlowError } from '../util.mjs';
import { readRecord } from '../schema-migrations.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { criterionResults, witnessResult } from "../kernel/verification-witnesses.mjs";
import { withReadScope } from '../read-scope.mjs';
import { witnessMappingReview } from '../witness-review-read.mjs';
import { owedDecisions, stepsThrough } from '../owed-decisions.mjs';
import { phaseUpstreamDiscrepancies } from '../phase-upstream-discrepancies.mjs';
import { openUpstreamIssues, upstreamIssueDecideCommand } from '../upstream-issues.mjs';
import { phaseAuthoringSummary } from '../phase-authoring-summary.mjs';

/** This step's evidence-reuse decisions, each with its honest label and whether it applies now; {} when none. */
async function reusedTestEvidence(root, config, workflow, phase) {
  if (!(workflow.evidenceReuses ?? []).some((entry) => !entry.revokes && entry.phase === phase.id)) return {};
  const reuse = await (await import('../evidence-reuse.mjs')).evidenceReuseFor(root, config, workflow, phase.id);
  return { reusedTestEvidence: [...reuse.active, ...reuse.lapsed] };
}

/** What a reviewer must not read as a run of this step or as the whole suite. Absent when neither applies. */
function testRunsReview(workflow, phase) {
  const reused = (phase.checks ?? []).filter((check) => check.reusedFrom).map((check) => ({
    commandId: check.id, attemptId: check.reusedFrom.attemptId, phase: check.reusedFrom.phase, commit: check.reusedFrom.commit, counts: check.reusedFrom.counts ?? null,
    words: `reused: ${check.reusedFrom.attemptId} recorded by ${check.reusedFrom.phase} at ${String(check.reusedFrom.commit).slice(0, 12)}; the code has not changed since, so ${check.id} was not run again` }));
  const scope = storyTestScope(workflow);
  const change = workflow.testScopeChanges?.at(-1);
  const words = scope === 'new-and-changed'
    ? `This Story runs only its new and changed tests${change ? ` (${change.id}, ${change.actor}: ${change.reason})` : ''}. Its existing tests were not run.`
    : change ? `This Story's test scope is ${scope} (${change.id}, ${change.actor}${change.reason ? `: ${change.reason}` : ''}).` : null;
  return { ...(reused.length ? { reusedTestRuns: reused } : {}), ...(words ? { testScope: { scope, words, changes: workflow.testScopeChanges ?? [] } } : {}) };
}

/**
 * SF Guard's labels for the step's current submission (SPEC-SFG-v1 REQ-041), as the verified packet
 * sealed them, or null when it carries none. A packet that cannot be verified reads as unavailable.
 */
async function submittedAttribution(root, config, workflow, phase) {
  const entry = [...(workflow.lineage?.submissions ?? [])].reverse()
    .find((item) => item.phase === phase.id && Number(item.generation) === Number(phase.generation));
  if (!entry?.projection?.attribution) return null;
  const { readStoryReviewPacket } = await import('../story-lineage.mjs');
  const packet = await readStoryReviewPacket(root, config, workflow, entry.packetSha256).catch(() => null);
  return packet?.attribution ?? { status: 'unavailable', reason: 'the submitted packet could not be verified here' };
}

/** The approval check, and the step sheet built on it for the step that is current. */
async function reviewAdvisories(root, config, workflow, phase, includeSheet) {
  const advisories = await (await import('../approval-check.mjs')).approvalAdvisories(root, config, workflow, phase) ?? {};
  if (!includeSheet || phase.id !== workflow.currentPhase) return advisories;
  const sheet = await (await import('../step-sheet.mjs')).readStepSheet(root, config, workflow, { phaseId: phase.id,
    ...(phase.status === 'awaiting_approval' ? { approvalCheck: advisories.approvalCheck ?? null } : {}) });
  return { ...advisories, ...(sheet ? { sheet } : {}) };
}

/** One catalog and one byte-verified read per document, shared by SDK and legacy presentation. */
async function collectNativeReviewDocuments(root,config,workflow,phase) {
  const documentRead = await measureCommandSpan('phase.document-catalog', () => createDocumentReadSession(root, config, workflow));
  const records = documentRead.records
    .filter((record) => ['artifact', 'agent-brief'].includes(record.type)
      && record.phase === phase.id
      && Number(record.generation ?? phase.generation) === Number(phase.generation));
  const documents = [],observations=[];
  for (const record of records) {
    try {
      const viewed = await measureCommandSpan('phase.document-body', () => documentRead.view(record.id));
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
        absolutePath: viewed.absolutePath ?? path.join(root, record.path),
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
      observations.push({record,viewed});
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
      observations.push({record,error});
    }
  }
  return {documents,observations};
}

export async function phaseReview(root,config,workflow,phase,options={}) {
  const collection=await collectNativeReviewDocuments(root,config,workflow,phase);
  return completeNativeReview(root,config,workflow,phase,collection.documents,options);
}

/** Headless inspection omits host prose/advisories; a trusted CLI can request its old presentation. */
export async function inspectNativePhaseReview(root,config,workflow,phase,presentation=null) {
  const collection=await collectNativeReviewDocuments(root,config,workflow,phase);
  if(presentation) {
    const review=await completeNativeReview(root,config,workflow,phase,collection.documents,presentation);
    return {...collection,review,reviewBinding:review.reviewBinding};
  }
  const reviewBinding=phase.id===workflow.currentPhase&&phase.status==='awaiting_approval'
    &&collection.documents.every(document=>!document.error)
    ?await (await import('../choices.mjs')).approvalReviewBinding(root,config,workflow):null;
  return {...collection,review:null,reviewBinding};
}

async function completeNativeReview(root,config,workflow,phase,documents,
  {includeContinuation=false,includeApprovalCheck=true,includeSheet=false}={}) {
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
  // Runs given an environment's values, shown as what they are and never as governed runs [RUN M3].
  const localIntegrationRuns = [...attempts.values()].filter((receipt) => receipt.evidenceClass === 'local-integration');
  const localIntegrationLabels = localIntegrationRuns.length
    ? (await import('../code-delivery-tests.mjs')).attemptLocalIntegrationLabel : null;
  const criteria = criterionResults((phase.deliveryEvidence?.acceptanceCriteria?.witnesses ?? []).map((witness) => {
    const commandId = attempts.has(witness.commandId) ? witness.commandId : covering(witness.testSource);
    return witnessResult({ ...witness, commandId }, attempts.get(commandId) ?? null, { submitted: submittedDelivery });
  }));
  const verifiedCriteria = criteria.filter((entry) => entry.status === 'met');
  const exactCriteria = verifiedCriteria.filter((entry) => entry.identity === 'source-bound').length;
  const unmet = criteria.length - verifiedCriteria.length;
  // Both read the one submitted packet; a read scope verifies it once for the two of them.
  const { witnessReview, reviewBinding, evidenceConsistency, attribution } = await withReadScope(async () => ({
    witnessReview: await witnessMappingReview(root, config, workflow, phase),
    attribution: await submittedAttribution(root, config, workflow, phase),
    // Only an available, current submitted review can be bound by a human approval surface.
    // Drafts, historical phases and unavailable document bodies convey no reusable approval binding.
    reviewBinding: phase.id === workflow.currentPhase && phase.status === 'awaiting_approval'
      && documents.every((document) => !document.error)
      ? await (await import('../choices.mjs')).approvalReviewBinding(root, config, workflow)
      : null,
    evidenceConsistency: await (await import('../evidence-consistency-read.mjs')).readEvidenceConsistency(
      root, config, workflow, phase, { documents })
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
      // Runs a step approver accepted could not execute any test, and narrowed runs one accepted with a
      // reason [TCE:REQ-024], each shown as what it is: acceptedRisks and acceptedNarrowings.
      ...await (await import('../test-narrowing.mjs')).acceptedTestRunDecisions(workflow, phase, submittedDelivery),
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
      notice: 'A criterion is judged by its own tagged test where the runner reports exact cases (Node, Jest, Vitest, JUnit 5); counts-only Node reports cannot verify it. Local observation is not independent attestation.',
      ...(localIntegrationRuns.length ? { localIntegrationRuns: localIntegrationRuns.map((receipt) => ({
        commandId: receipt.commandId, attemptId: receipt.attemptId, environment: receipt.boundEnvironment?.name ?? null,
        ranBy: receipt.ranBy ?? null, commit: receipt.candidate?.commit ?? null, countsForStep: receipt.countsForStep !== false,
        status: receipt.status, label: localIntegrationLabels(receipt)
      })) } : {})
    } : null,
    // Runs an earlier step recorded that this step's approvers decided to reuse, labelled as theirs.
    ...await reusedTestEvidence(root, config, workflow, phase),
    // Runs that stood because the code had not changed, and which tests the Story runs at all [TCE:REQ-083, REQ-094].
    ...testRunsReview(workflow, phase),
    evidenceConsistency,
    witnessReview,
    // What SF Guard recorded about who wrote the work, beside it; a label never refuses (REQ-042).
    ...(attribution ? { attribution, attributionLabels: (await import('../presence/attribution.mjs')).attributionLabels(attribution) } : {}),
    owedDecisions: reviewBinding ? await owedDecisions(root, config, workflow, stepsThrough(workflow, phase.id)) : null,
    // The checklist articles the approver answers, so every surface can ask for them up front.
    ...(reviewBinding ? await import('../specification-gate.mjs').then(({ approvalChecklistPrompt, resolvedSpecificationQualityPolicy }) => {
      const prompt = approvalChecklistPrompt(resolvedSpecificationQualityPolicy(config, workflow, phase));
      return prompt ? { approvalChecklist: prompt } : {};
    }) : {}),
    // Whether approval would pass, and the commits it would refuse for; advisory, the gate decides.
    ...(includeApprovalCheck ? await reviewAdvisories(root, config, workflow, phase, includeSheet) : {}),
    documents,
    upstreamDiscrepancies: phaseUpstreamDiscrepancies(documents, workflow, phase.id),
    upstreamIssues: openUpstreamIssues(workflow).map(({ issue, status, supersededBy }) => ({ id: issue.id, phase: issue.phase, about: issue.about,
      problem: issue.problem, status, supersededBy, decide: upstreamIssueDecideCommand(workflow.workItem.id, issue, supersededBy, workflow) })),
    ...(await phaseAuthoringSummary(root, config, workflow, phase, { documents, includeContinuation }))
  };
}
