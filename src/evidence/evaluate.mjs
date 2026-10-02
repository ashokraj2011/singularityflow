/**
 * One evaluator over a Story's evidence graph [E2G-028].
 *
 * Pure: it reads only the graph it is given, so a view (projection mode) and a mutation (decision
 * mode) can never disagree on rules, only on how fresh and authenticated their inputs are. Each
 * requirement or acceptance criterion becomes one row of obligations with six separate facets, and
 * the row's result is the most serious of them; nothing is rounded up into "covered".
 *
 * This first version evaluates what today's records can prove: planned and observed claim maps,
 * test files tagged for a criterion, and module test commands. A passing module command is
 * module-observed assurance; no test-case result is joined to a criterion yet.
 */
import { approvalRequirementsMet } from '../approval-authority.mjs';
import { phaseRequiresCodeDelivery } from '../code-delivery-policy.mjs';
import { mergeObservedClaimRecords, mergePlannedClaimRecords } from '../specifications.mjs';
import { completionLabel, lifecycleWords, resultCounts } from './labels.mjs';
import {
  DEFAULT_REQUIRED_ASSURANCE, ROW_RESULTS, assuranceAtLeast, obligationId, weakestAssurance
} from './vocabulary.mjs';

const BLOCKING_RESULTS = new Set(['failed', 'inconclusive', 'missing', 'pending']);

function finding(code, message, { obligationIds = [], category = 'evidence', blocking = true } = {}) {
  return { code, message, obligationIds, category, blocking };
}

function phaseFinished(phase) {
  return ['approved', 'skipped'].includes(phase?.status);
}

/** How a step's own approval stands under the authoritative rule, as one review facet value. */
export function reviewFacet(phase) {
  if (!phase) return 'pending';
  const policy = phase.approvalPolicy ?? {};
  if (policy.mode === 'none') return 'not-required';
  if (phase.status !== 'approved') return 'pending';
  const active = (phase.approvals ?? []).filter((item) => !item.invalidatedAt && item.decision === 'approved');
  if (!active.length) return policy.mode === 'policy' ? 'policy-approved' : 'approved';
  if (!approvalRequirementsMet(policy, active)) return 'pending';
  return active.every((item) => item.selfApproval) ? 'self-approved' : 'approved';
}

function reviewStatus(facet) {
  if (facet === 'pending') return 'pending';
  if (facet === 'not-required') return 'not-applicable';
  return 'met';
}

/** The test outcome a delivery recorded for one command, from its own receipt. */
function executionOutcome(delivery, commandId) {
  const execution = (delivery?.executions ?? []).find((entry) => entry.commandId === commandId);
  if (!execution) return { outcome: 'unavailable', skipped: 0 };
  if (execution.kind === 'phase-validation-observation') {
    return { outcome: execution.status === 'passed' ? 'passed' : execution.status === 'failed' ? 'failed' : 'unavailable', skipped: 0 };
  }
  const record = execution.record;
  if (!record) return { outcome: 'unavailable', skipped: 0 };
  const tests = record.tests ?? {};
  if (record.status !== 'passed' || Number(tests.failed ?? 0) > 0) return { outcome: 'failed', skipped: Number(tests.skipped ?? 0) };
  if (Number(tests.skipped ?? 0) > 0) return { outcome: 'passed-with-skips', skipped: Number(tests.skipped) };
  return { outcome: 'passed', skipped: 0 };
}

function aggregateOutcome(outcomes) {
  for (const outcome of ['failed', 'unavailable', 'passed-with-skips']) if (outcomes.includes(outcome)) return outcome;
  return outcomes.length ? 'passed' : 'not-run';
}

function rowResult(obligations) {
  const statuses = obligations.map((entry) => entry.status);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('inconclusive')) return 'inconclusive';
  if (statuses.includes('missing') || statuses.includes('partial')) return 'missing';
  if (statuses.includes('pending')) return 'pending';
  if (statuses.includes('excepted')) return 'satisfied-with-exception';
  return 'satisfied';
}

function ordered(records, workflow) {
  const order = workflow.phaseOrder ?? Object.keys(workflow.phases ?? {});
  return [...records].sort((left, right) => order.indexOf(left.phase) - order.indexOf(right.phase));
}

/** Evaluate a loaded evidence graph. `boundary` names the evaluation point; views use `view`. */
export function evaluateEvidence(graph, { boundary = 'view', mode = 'projection', requiredAssurance = DEFAULT_REQUIRED_ASSURANCE } = {}) {
  const workflow = graph.workflow;
  const workId = workflow.workItem.id;
  const phases = workflow.phases ?? {};
  const phaseOrder = workflow.phaseOrder ?? Object.keys(phases);
  const records = graph.records ?? {};
  const plannedClaims = mergePlannedClaimRecords(records.planned ?? []);
  const observedClaims = mergeObservedClaimRecords(records.observed ?? [], plannedClaims);
  const codePhaseIds = phaseOrder.filter((id) => phaseRequiresCodeDelivery(phases[id]));
  const owners = workflow.resolution?.plannedClaims?.owners ?? {};
  const ownerIds = [...new Set(codePhaseIds.map((id) => owners[id]).filter(Boolean))];
  const deliveries = (graph.deliveries ?? []).filter((delivery) =>
    Number(delivery.generation) === Number(phases[delivery.phaseId]?.generation));

  // Tagged tests per criterion: submitted deliveries carry the command that covered each test;
  // a published delivery not yet submitted carries only the tag.
  const witnesses = new Map();
  for (const delivery of deliveries) {
    const ready = delivery.receipt?.status === 'ready';
    const bindings = ready ? delivery.receipt.traceability?.bindings ?? [] : delivery.acceptanceCriteria?.bindings ?? [];
    for (const binding of bindings) {
      const id = String(binding.clauseId ?? '').toUpperCase();
      if (!id) continue;
      const list = witnesses.get(id) ?? [];
      list.push({ phaseId: delivery.phaseId, testSource: binding.testSource, commandId: ready ? binding.commandId ?? null : null, ready, delivery });
      witnesses.set(id, list);
    }
  }

  const clauses = ordered(records.indexes ?? [], workflow).flatMap((index) =>
    (index.clauses ?? []).map((clause) => ({ ...clause, definedIn: index.phase })));
  const dependents = new Map();
  for (const clause of clauses) {
    for (const dependency of clause.dependsOn ?? []) {
      if (clause.type !== 'AC') continue;
      const list = dependents.get(dependency) ?? [];
      list.push(clause.id);
      dependents.set(dependency, list);
    }
  }
  const submittedCode = codePhaseIds.length > 0 && codePhaseIds.every((id) =>
    phaseFinished(phases[id]) || deliveries.some((delivery) => delivery.phaseId === id && delivery.receipt?.status === 'ready'));
  const findings = [...(graph.findings ?? [])];

  const rows = clauses.map((clause) => {
    const id = clause.id;
    const planned = plannedClaims[id] ?? null;
    const observed = observedClaims[id] ?? null;
    const rowFindings = [];
    const obligations = [];

    // Plan: the approved plan names where the criterion lands and how it is tested.
    const planId = obligationId(workId, 'plan', id);
    const plannedBy = ownerIds.length ? ownerIds : [clause.definedIn];
    const planReview = reviewFacet(phases[plannedBy[0]]);
    const planStatus = planned ? 'met' : plannedBy.every((owner) => phaseFinished(phases[owner])) ? 'missing' : 'pending';
    if (planStatus === 'missing') rowFindings.push(finding('EVIDENCE_PLAN_MISSING', `${id} is not in the approved plan.`, { obligationIds: [planId] }));
    obligations.push({
      id: planId, responsibility: 'plan', subject: id, owningSteps: plannedBy, status: planStatus,
      facets: { coverage: planned ? 'linked' : 'unlinked', execution: 'not-applicable', assurance: 'not-applicable', review: planReview, freshness: 'current', exception: 'none' }
    });

    // Implement: the code phase's observed claim for this clause.
    const implementId = obligationId(workId, 'implement', id);
    const testOnly = clause.type === 'AC' && planned && !(planned.expectedPaths ?? []).length
      && (planned.tests ?? []).length > 0 && (observed?.testResults ?? []).length === planned.tests.length;
    const implementers = codePhaseIds.length ? codePhaseIds : [];
    const implementReview = implementers.length ? reviewFacet(phases[implementers.at(-1)]) : 'not-required';
    let implementStatus;
    if (!implementers.length) implementStatus = 'not-applicable';
    else if (observed?.verdict === 'matched' || testOnly) implementStatus = 'met';
    else if (observed && ['partial', 'deviated'].includes(observed.verdict)) implementStatus = 'partial';
    else implementStatus = submittedCode ? 'missing' : 'pending';
    if (implementStatus === 'partial') {
      rowFindings.push(finding(observed.verdict === 'deviated' ? 'EVIDENCE_IMPLEMENTATION_DEVIATED' : 'EVIDENCE_IMPLEMENTATION_PARTIAL',
        observed.verdict === 'deviated'
          ? `${id} was implemented differently from its plan${observed.deviation ? `: ${observed.deviation}` : ''}.`
          : `${id} changed ${observed.observedPaths?.length ?? 0} of ${planned?.expectedPaths?.length ?? 0} planned path(s).`,
        { obligationIds: [implementId] }));
    }
    if (implementStatus === 'missing') rowFindings.push(finding('EVIDENCE_IMPLEMENTATION_MISSING', `No delivered change implements ${id}.`, { obligationIds: [implementId] }));
    obligations.push({
      id: implementId, responsibility: 'implement', subject: id, owningSteps: implementers, status: implementStatus,
      fulfillment: testOnly ? 'test-only' : 'new-or-modified',
      facets: {
        coverage: observed?.observedPaths?.length || testOnly ? 'linked' : 'unlinked', execution: 'not-applicable', assurance: 'not-applicable',
        review: implementReview, freshness: 'current', exception: observed?.verdict === 'deviated' ? 'deviation' : 'none'
      }
    });

    // Verify: acceptance criteria are verified by tests; other clause types through the criteria
    // that depend on them.
    let verification = { association: 'through-criteria', criteria: dependents.get(id) ?? [] };
    let assurance = 'not-applicable';
    if (clause.type === 'AC') {
      const verifyId = obligationId(workId, 'verify', id);
      const tagged = witnesses.get(id) ?? [];
      const submitted = tagged.filter((entry) => entry.ready);
      let status;
      let execution = 'not-run';
      let exception = 'none';
      let skipped = 0;
      if (planned?.testDisposition === 'not-applicable') {
        status = 'excepted';
        exception = 'not-applicable';
        assurance = 'none';
      } else if (!submitted.length) {
        status = submittedCode ? 'missing' : 'pending';
        assurance = tagged.length ? 'declared' : 'none';
        if (status === 'missing') rowFindings.push(finding('EVIDENCE_WITNESS_MISSING', `No submitted test is tagged for ${id}.`, { obligationIds: [verifyId] }));
      } else {
        const outcomes = submitted.map((entry) => executionOutcome(entry.delivery, entry.commandId));
        skipped = outcomes.reduce((sum, entry) => sum + entry.skipped, 0);
        execution = aggregateOutcome(outcomes.map((entry) => entry.outcome));
        const accepted = submitted.some((entry) => entry.delivery.testRecovery?.disposition === 'accepted-risk');
        if (execution === 'passed') {
          assurance = 'module-observed';
          status = assuranceAtLeast(assurance, requiredAssurance) ? 'met' : 'inconclusive';
          if (status !== 'met') rowFindings.push(finding('EVIDENCE_ASSURANCE_SHORTFALL', `${id} reached ${assurance}; ${requiredAssurance} is required.`, { obligationIds: [verifyId] }));
        } else if (['failed', 'unavailable'].includes(execution) && accepted) {
          assurance = 'declared';
          status = 'excepted';
          exception = 'accepted-risk';
        } else if (execution === 'failed') {
          assurance = 'declared';
          status = 'failed';
          rowFindings.push(finding('EVIDENCE_TEST_FAILED', `The test command covering ${id} failed.`, { obligationIds: [verifyId] }));
        } else if (execution === 'unavailable') {
          assurance = 'declared';
          status = 'inconclusive';
          rowFindings.push(finding('EVIDENCE_TEST_UNAVAILABLE', `The test command covering ${id} produced no usable result.`, { obligationIds: [verifyId] }));
        } else {
          assurance = 'declared';
          status = 'inconclusive';
          rowFindings.push(finding('EVIDENCE_TESTS_SKIPPED',
            `The test command covering ${id} passed with ${skipped} skipped test(s); which test was skipped is not joined to the criterion.`,
            { obligationIds: [verifyId] }));
        }
      }
      verification = {
        association: submitted.length || tagged.length ? 'test-file-tag' : 'none',
        tests: [...new Set(tagged.map((entry) => entry.testSource))].sort(),
        commands: [...new Set(submitted.map((entry) => entry.commandId).filter(Boolean))].sort(),
        execution,
        skippedTests: skipped,
        testDisposition: planned?.testDisposition ?? null,
        testReason: planned?.testReason ?? null
      };
      obligations.push({
        id: verifyId, responsibility: 'verify', subject: id, owningSteps: [...new Set(tagged.map((entry) => entry.phaseId))], status,
        facets: {
          coverage: tagged.length ? 'linked' : planned?.testDisposition === 'not-applicable' ? 'not-applicable' : 'unlinked',
          execution, assurance, review: implementReview, freshness: 'current', exception
        }
      });
    }

    // Review: the decision of the step that delivered the change.
    const reviewId = obligationId(workId, 'review', id);
    const reviewState = reviewStatus(implementReview);
    if (reviewState === 'pending' && submittedCode) rowFindings.push(finding('EVIDENCE_REVIEW_PENDING', `The delivery of ${id} is not approved yet.`, { obligationIds: [reviewId] }));
    obligations.push({
      id: reviewId, responsibility: 'review', subject: id, owningSteps: implementers.slice(-1), status: reviewState,
      facets: { coverage: 'not-applicable', execution: 'not-applicable', assurance: 'not-applicable', review: implementReview, freshness: 'current', exception: 'none' }
    });

    const result = graph.untrusted ? 'inconclusive' : rowResult(obligations);
    findings.push(...rowFindings);
    return {
      id, type: clause.type, definedIn: clause.definedIn,
      source: `${clause.source?.path ?? 'unknown'}:${clause.source?.line ?? 0}`,
      statementSha256: clause.bodySha256 ?? null,
      result, assurance,
      plan: planned ? {
        expectedPaths: planned.expectedPaths ?? [], tests: planned.tests ?? [],
        testDisposition: planned.testDisposition ?? null, testReason: planned.testReason ?? null
      } : null,
      implementation: observed ? { verdict: observed.verdict, observedPaths: observed.observedPaths ?? [], testResults: observed.testResults ?? [] } : null,
      verification,
      obligations,
      findings: rowFindings,
      actions: [{ kind: 'explain', command: `singularity-flow explain --subject clause --id ${id}` }]
    };
  });

  if (!rows.length) {
    findings.push(finding('EVIDENCE_NO_CRITERIA', 'No requirement or acceptance criterion is indexed for this Story, so nothing can be shown as satisfied.'));
  }
  const counts = resultCounts(rows);
  const blocked = !rows.length || rows.some((row) => BLOCKING_RESULTS.has(row.result))
    || findings.some((entry) => entry.blocking && entry.category === 'records');
  const gate = blocked ? 'block' : rows.some((row) => row.result === 'satisfied-with-exception') ? 'allow-with-risk' : 'allow';
  const verified = rows.filter((row) => row.type === 'AC' && ['satisfied', 'satisfied-with-exception'].includes(row.result));
  return {
    schemaVersion: 1, // schema-transient: computed evaluation, never persisted by this version
    workId,
    title: workflow.workItem.title ?? null,
    boundary,
    mode,
    inputSha256: graph.inputSha256 ?? null,
    lifecycle: { status: workflow.status, words: lifecycleWords(workflow) },
    requiredAssurance: { level: requiredAssurance, source: 'default; the repository capability profile is not computed yet' },
    rows,
    findings,
    summary: {
      rows: rows.length,
      results: Object.fromEntries(ROW_RESULTS.map((result) => [result, counts[result] ?? 0])),
      assuranceFloor: weakestAssurance(verified.map((row) => row.assurance)),
      testCaseResults: 'not joined to criteria yet'
    },
    decision: { gate, boundary },
    completion: completionLabel({ workflow, rows, terminal: graph.terminal ?? null })
  };
}
