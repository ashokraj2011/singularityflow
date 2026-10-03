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
import { applicabilityStatus, endpointTaken } from './applicability.mjs';
import { completionLabel, lifecycleWords, resultCounts } from './labels.mjs';
import {
  DEFAULT_REQUIRED_ASSURANCE, ROW_RESULTS, assuranceAtLeast, obligationId, weakestAssurance
} from './vocabulary.mjs';

const BLOCKING_RESULTS = new Set(['failed', 'inconclusive', 'missing', 'pending']);
const STORY_RESPONSIBILITIES = Object.freeze(['scope', 'plan', 'implement', 'verify', 'review']);

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
  if (statuses.length && statuses.every((status) => status === 'not-applicable')) return 'not-applicable';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('inconclusive')) return 'inconclusive';
  if (statuses.includes('missing') || statuses.includes('partial')) return 'missing';
  if (statuses.includes('pending')) return 'pending';
  if (statuses.includes('excepted')) return 'satisfied-with-exception';
  return 'satisfied';
}

/** The steps of the route that hold a responsibility, from the graph the Story pinned. */
function holders(workflow, responsibility) {
  return (workflow.resolution?.obligationGraph?.nodes ?? [])
    .filter((node) => node.responsibilities.includes(responsibility))
    .map((node) => node.id)
    .filter((id) => workflow.phases?.[id] && workflow.phases[id].status !== 'skipped');
}

/** The strongest single review word across the steps that review: self-approval is never hidden. */
function combinedReview(facets) {
  if (!facets.length) return 'not-required';
  for (const facet of ['pending', 'self-approved', 'policy-approved']) if (facets.includes(facet)) return facet;
  return facets.every((facet) => facet === 'not-required') ? 'not-required' : 'approved';
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

  // The end this Story reached, or will reach, and what that end declared it leaves undone. A
  // recorded applicability decision makes those obligations not applicable; until then they wait.
  const endpoint = endpointTaken(workflow);
  const applicability = applicabilityStatus(workflow, endpoint);
  const omitted = new Map(applicability.map((entry) => [entry.responsibility, entry]));
  const applyOmission = (obligation) => {
    const omission = omitted.get(obligation.responsibility);
    if (!omission) return obligation;
    return {
      ...obligation, status: omission.satisfied ? 'not-applicable' : 'pending',
      facets: { ...obligation.facets, exception: omission.satisfied ? 'not-applicable' : 'pending-decision' },
      omittedBy: omission
    };
  };
  // Without a code step there are no claims to observe: the steps that implement are judged as a
  // whole, and a criterion is verified by inspection when an approved verification step cites it.
  const noCode = codePhaseIds.length === 0;
  const implementSteps = noCode ? holders(workflow, 'implement') : codePhaseIds;
  const claimsPlanned = workflow.resolution?.plannedClaims?.mode === 'required';
  const planSteps = holders(workflow, 'plan');
  const verifySteps = holders(workflow, 'verify');
  const inspections = graph.inspections ?? [];

  const rows = clauses.map((clause) => {
    const id = clause.id;
    const planned = plannedClaims[id] ?? null;
    const observed = observedClaims[id] ?? null;
    const rowFindings = [];
    const obligations = [];

    // Plan: the approved plan names where the criterion lands and how it is tested. Without
    // planned claims (a work type with no code step) the steps that hold the plan plan it.
    const planId = obligationId(workId, 'plan', id);
    const plannedBy = claimsPlanned ? (ownerIds.length ? ownerIds : [clause.definedIn])
      : planSteps.length ? planSteps : [clause.definedIn];
    const planReview = reviewFacet(phases[plannedBy[0]]);
    const plannersFinished = plannedBy.every((owner) => phaseFinished(phases[owner]));
    const planStatus = planned ? 'met' : !claimsPlanned ? (plannersFinished ? 'met' : 'pending') : plannersFinished ? 'missing' : 'pending';
    if (planStatus === 'missing') rowFindings.push(finding('EVIDENCE_PLAN_MISSING', `${id} is not in the approved plan.`, { obligationIds: [planId] }));
    obligations.push({
      id: planId, responsibility: 'plan', subject: id, owningSteps: plannedBy, status: planStatus,
      facets: { coverage: planned ? 'linked' : 'unlinked', execution: 'not-applicable', assurance: 'not-applicable', review: planReview, freshness: 'current', exception: 'none' }
    });

    // Implement: the code phase's observed claim for this clause.
    const implementId = obligationId(workId, 'implement', id);
    const testOnly = clause.type === 'AC' && planned && !(planned.expectedPaths ?? []).length
      && (planned.tests ?? []).length > 0 && (observed?.testResults ?? []).length === planned.tests.length;
    const implementers = implementSteps;
    const implementReview = implementers.length ? reviewFacet(phases[implementers.at(-1)]) : 'not-required';
    let implementStatus;
    if (!implementers.length) implementStatus = 'not-applicable';
    else if (noCode) implementStatus = implementers.every((step) => phaseFinished(phases[step])) ? 'met' : 'pending';
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
      fulfillment: noCode ? 'non-code' : testOnly ? 'test-only' : 'new-or-modified',
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
      let inspectedBy = [];
      if (noCode) {
        // A reviewer approved verification evidence that cites the criterion; no test proves it.
        inspectedBy = inspections.filter((entry) => entry.text.includes(id) && phaseFinished(phases[entry.phaseId])
          && !['pending', 'not-required'].includes(reviewFacet(phases[entry.phaseId]))).map((entry) => entry.phaseId);
        execution = 'not-applicable';
        assurance = inspectedBy.length ? 'declared' : 'none';
        status = inspectedBy.length ? 'met' : verifySteps.length && verifySteps.every((step) => phaseFinished(phases[step])) ? 'missing' : 'pending';
        if (status === 'missing') rowFindings.push(finding('EVIDENCE_INSPECTION_MISSING', `No approved verification step cites ${id}.`, { obligationIds: [verifyId] }));
      } else if (planned?.testDisposition === 'not-applicable') {
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
        association: noCode ? 'inspection' : submitted.length || tagged.length ? 'test-file-tag' : 'none',
        inspectedBy,
        tests: [...new Set(tagged.map((entry) => entry.testSource))].sort(),
        commands: [...new Set(submitted.map((entry) => entry.commandId).filter(Boolean))].sort(),
        execution,
        skippedTests: skipped,
        testDisposition: planned?.testDisposition ?? null,
        testReason: planned?.testReason ?? null
      };
      obligations.push({
        id: verifyId, responsibility: 'verify', subject: id, owningSteps: noCode ? inspectedBy : [...new Set(tagged.map((entry) => entry.phaseId))], status,
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

    const judged = obligations.map(applyOmission);
    const result = graph.untrusted ? 'inconclusive' : rowResult(judged);
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
      obligations: judged,
      findings: rowFindings,
      actions: [{ kind: 'explain', command: `singularity-flow explain --subject clause --id ${id}` }]
    };
  });

  // Story-level rows: every responsibility the end omits, and, when no clause carries them, the
  // responsibilities the route holds, so a Story without clauses still owes something visible.
  const storyRow = (responsibility, obligation, extra = {}) => ({
    id: `story:${responsibility}`, type: 'STORY', definedIn: null, source: null, statementSha256: null,
    result: graph.untrusted ? 'inconclusive' : rowResult([obligation]), assurance: obligation.facets.assurance,
    plan: null, implementation: null, verification: null, obligations: [obligation], findings: [], actions: [], ...extra
  });
  const storyRows = [];
  for (const responsibility of STORY_RESPONSIBILITIES) {
    const omission = omitted.get(responsibility);
    const id = obligationId(workId, responsibility, 'story');
    if (omission) {
      const row = storyRow(responsibility, {
        id, responsibility, subject: 'story', owningSteps: [], status: omission.satisfied ? 'not-applicable' : 'pending',
        facets: { coverage: 'not-applicable', execution: 'not-applicable', assurance: 'not-applicable', review: omission.satisfied ? 'decided' : 'pending', freshness: 'current', exception: 'not-applicable' }
      }, {
        applicability: omission,
        // A recorded decision is not offered again: deciding anew would replace it and change the inputs.
        actions: omission.satisfied ? [] : [{ kind: 'decide', command: `singularity-flow decision applicability --responsibility ${responsibility} --reason "<why it does not apply>"` }]
      });
      if (!omission.satisfied) {
        row.findings.push(finding('APPLICABILITY_DECISION_REQUIRED',
          `This Story ends without ${responsibility}; someone in ${omission.authority} must record why it does not apply.`, { obligationIds: [id] }));
      }
      storyRows.push(row);
      continue;
    }
    if (rows.length || responsibility === 'scope') continue;
    const steps = holders(workflow, responsibility);
    let status = !steps.length ? 'missing' : steps.every((step) => phaseFinished(phases[step])) ? 'met' : 'pending';
    let execution = 'not-applicable';
    let assurance = 'not-applicable';
    let exception = 'none';
    if (responsibility === 'implement' && codePhaseIds.length) {
      status = codePhaseIds.every((step) => phaseFinished(phases[step]) && deliveries.some((delivery) => delivery.phaseId === step && delivery.receipt?.status === 'ready'))
        ? 'met' : 'pending';
    }
    if (responsibility === 'verify' && codePhaseIds.length) {
      const ready = deliveries.filter((delivery) => delivery.receipt?.status === 'ready');
      const outcomes = ready.flatMap((delivery) => (delivery.executions ?? []).map((entry) => executionOutcome(delivery, entry.commandId).outcome));
      execution = aggregateOutcome(outcomes);
      const accepted = ready.some((delivery) => delivery.testRecovery?.disposition === 'accepted-risk');
      if (execution === 'passed') { status = 'met'; assurance = 'module-observed'; }
      else if (['failed', 'unavailable'].includes(execution) && accepted) { status = 'excepted'; assurance = 'declared'; exception = 'accepted-risk'; }
      else if (execution === 'failed') status = 'failed';
      else if (execution === 'not-run') status = 'pending';
      else status = 'inconclusive';
    }
    const row = storyRow(responsibility, {
      id, responsibility, subject: 'story', owningSteps: steps, status,
      facets: { coverage: 'not-applicable', execution, assurance, review: combinedReview(steps.map((step) => reviewFacet(phases[step]))), freshness: 'current', exception }
    });
    if (status === 'missing') row.findings.push(finding('EVIDENCE_RESPONSIBILITY_UNHELD', `No step on this Story's route holds ${responsibility}.`, { obligationIds: [id] }));
    if (status === 'failed') row.findings.push(finding('EVIDENCE_TEST_FAILED', 'A test command of this Story failed.', { obligationIds: [id] }));
    if (status === 'inconclusive') row.findings.push(finding('EVIDENCE_TEST_UNAVAILABLE', 'A test command of this Story passed with skipped tests or produced no usable result.', { obligationIds: [id] }));
    storyRows.push(row);
  }
  for (const row of storyRows) findings.push(...row.findings);

  // The accepted-scope inventory [E2G-006]. An included or existing statement is carried by its
  // clauses' rows. Every other item is a row: a scope decision (excluded, deferred, informative,
  // duplicate, superseded) is shown as not applicable, never as an exception, and a statement
  // nobody has dispositioned is pending and blocks.
  const scopeRows = [];
  for (const item of graph.scope?.items ?? []) {
    if (item.disposition === 'included' || item.disposition === 'existing') continue;
    const unresolved = item.disposition === 'unresolved';
    const obligation = {
      id: obligationId(workId, 'scope', item.id), responsibility: 'scope', subject: item.id,
      owningSteps: holders(workflow, 'scope'), status: unresolved ? 'pending' : 'not-applicable',
      facets: {
        coverage: unresolved ? 'unlinked' : 'not-applicable', execution: 'not-applicable', assurance: 'not-applicable',
        review: unresolved ? 'pending' : 'decided', freshness: item.staleDecision ? 'stale' : 'current', exception: 'not-applicable'
      }
    };
    scopeRows.push({
      id: item.id, type: 'SCOPE', definedIn: item.sourceId, source: item.line ? `${item.sourceId}:${item.line}` : item.sourceId,
      statementSha256: item.statementSha256, result: unresolved ? 'pending' : 'not-applicable', assurance: 'not-applicable',
      plan: null, implementation: null, verification: null, obligations: [obligation], findings: [],
      actions: unresolved ? [{ kind: 'decide', command: `singularity-flow decision scope --item ${item.id} --as <included|existing|excluded|deferred|informative|duplicate|superseded> --reason "<why>"` }] : [],
      scope: { kind: item.kind, text: item.text, disposition: item.disposition, clauseIds: item.clauseIds, duplicateOf: item.duplicateOf ?? null, coveredBy: item.coveredBy ?? null }
    });
  }
  const unresolvedScope = scopeRows.filter((row) => row.result === 'pending');
  if (unresolvedScope.length) {
    findings.push(finding('SCOPE_ITEMS_UNRESOLVED',
      `${unresolvedScope.length} requirement statement(s) in this Story's sources have no disposition (the first: ${unresolvedScope[0].id}). Link each to its clauses or record a scope decision.`,
      { obligationIds: unresolvedScope.map((row) => row.obligations[0].id) }));
  }

  const scopeMissing = !rows.length && !omitted.has('scope');
  if (scopeMissing) {
    findings.push(finding('EVIDENCE_NO_CRITERIA', 'No requirement or acceptance criterion is indexed for this Story, so nothing can be shown as satisfied.'));
  }
  const clauseRows = rows;
  const allRows = [...clauseRows, ...scopeRows, ...storyRows];
  const counts = resultCounts(allRows);
  const blocked = scopeMissing || allRows.some((row) => BLOCKING_RESULTS.has(row.result))
    || findings.some((entry) => entry.blocking && entry.category === 'records');
  const gate = blocked ? 'block' : allRows.some((row) => row.result === 'satisfied-with-exception') ? 'allow-with-risk' : 'allow';
  const verified = allRows.filter((row) => (row.type === 'AC' || row.id === 'story:verify')
    && ['satisfied', 'satisfied-with-exception'].includes(row.result));
  return {
    schemaVersion: 1, // schema-transient: computed evaluation, never persisted by this version
    workId,
    title: workflow.workItem.title ?? null,
    boundary,
    mode,
    inputSha256: graph.inputSha256 ?? null,
    lifecycle: { status: workflow.status, words: lifecycleWords(workflow) },
    requiredAssurance: {
      level: requiredAssurance,
      source: noCode ? 'no code step: criteria are verified by inspection of approved verification evidence'
        : 'default; the repository capability profile is not computed yet'
    },
    endpoint: endpoint ? { from: endpoint.from, decision: endpoint.decision, route: endpoint.route } : null,
    applicability,
    rows: allRows,
    findings,
    summary: {
      rows: allRows.length,
      results: Object.fromEntries(ROW_RESULTS.map((result) => [result, counts[result] ?? 0])),
      assuranceFloor: weakestAssurance(verified.map((row) => row.assurance)),
      testCaseResults: 'not joined to criteria yet'
    },
    decision: { gate, boundary },
    completion: completionLabel({ workflow, rows: allRows, terminal: graph.terminal ?? null, gate })
  };
}
