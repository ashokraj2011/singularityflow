/**
 * One evaluator over a Story's evidence graph [E2G-028].
 *
 * Pure: it reads only the graph it is given, so a view (projection mode) and a mutation (decision
 * mode) can never disagree on rules, only on how fresh and authenticated their inputs are. Each
 * requirement or acceptance criterion becomes one row of obligations with six separate facets, and
 * the row's result is the most serious of them; nothing is rounded up into "covered".
 *
 * A criterion's verification joins each of its witnesses to the run of its candidate: an exact
 * witness (the Jest, Vitest or JUnit 5 test a tag sits on) passes only through its own occurrence
 * in the authoritative attempt and reaches exact-local-observed; a witness in a module whose
 * adapter only counts tests passes through its module command and stops at module-observed.
 */
import { approvalRequirementsMet } from '../approval-authority.mjs';
import { qualifiedClauseIds } from '../traceability-ids.mjs';
import { phaseRequiresCodeDelivery } from '../code-delivery-policy.mjs';
import { mergeObservedClaimRecords, mergePlannedClaimRecords, testOnlyClaimEvidence } from '../specifications.mjs';
import { scopeStaleness } from '../scope/revisions.mjs';
import { riskDecisionState, riskEligibility } from './risk-decisions.mjs';
import { applicabilityStatus, endpointTaken } from './applicability.mjs';
import { completionLabel, lifecycleWords, resultCounts } from './labels.mjs';
import {
  DEFAULT_REQUIRED_ASSURANCE, ROW_RESULTS, obligationId, weakestAssurance
} from './vocabulary.mjs';
import { contractResult } from '../verification/contract-results.mjs';
import { effectiveContract, mergedVerificationContracts, witnessMappingCore, witnessMappingSha256 } from '../verification/contracts.mjs';

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

/** The attempt a witness is judged against: the delivery's bound attempt of its command. */
function attemptFor(delivery, commandId, ready) {
  if (ready) {
    const execution = (delivery.executions ?? []).find((entry) => entry.commandId === commandId);
    if (!execution) return null;
    if (execution.kind === 'phase-validation-observation' || !execution.record) {
      return { attemptId: null, status: execution.status === 'passed' ? 'passed' : execution.status === 'failed' ? 'failed' : 'unavailable', exitCode: execution.status === 'passed' ? 0 : null, terminal: true, tests: {}, occurrences: [] };
    }
    return execution.record;
  }
  return (delivery.preflight ?? []).find((entry) => entry.commandId === commandId)?.record ?? null;
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

/** How many criteria rest on an exact test result, how many on a module command, and how many on neither. */
function testCaseResultWords(rows) {
  const tested = rows.filter((row) => row.type === 'AC' && (row.verification?.witnesses ?? []).length);
  const exact = tested.filter((row) => row.verification.witnesses.every((entry) => entry.identity === 'source-bound')).length;
  // A test in an exact module whose identity cannot be pinned down rests on nothing exact.
  const inexact = tested.filter((row) => row.verification.witnesses.some((entry) => entry.identity !== 'source-bound'
    && entry.requiredAssurance !== 'module-observed')).length;
  return `${exact} criterion row(s) joined to an exact test result; ${tested.length - exact - inexact} rest on a module test command`
    + (inexact ? `; ${inexact} cannot be tied to one exact test` : '');
}

/** Evaluate a loaded evidence graph. `boundary` names the evaluation point; views use `view`. */
/**
 * The Story's latest scope revision [E2G-008] and what it did to the evidence: how many clause rows
 * it made stale and how many it left unaffected. Reassurance is half of it, so both counts are given.
 */
function scopeRevisionSummary(revision, clauseRows) {
  const stale = clauseRows.filter((row) => row.obligations.some((entry) => entry.facets.freshness === 'stale')).length;
  const changes = revision.changes;
  return {
    revision: revision.revision,
    revisionSha256: revision.revisionSha256,
    changes,
    staleRows: stale,
    standingRows: clauseRows.length - stale,
    words: changes
      ? `scope revision ${revision.revision}: ${changes.added.length} added, ${changes.revised.length} revised, ${changes.removed.length} removed; ${stale} row(s) stale, ${clauseRows.length - stale} unaffected`
      : `scope revision ${revision.revision}`
  };
}

/**
 * The accepted scope in three separate states [E2G-007]: every identified statement has a
 * disposition; a person reviewed the interpretation of exactly this inventory; and correctness,
 * which is never claimed. Every surface shows these words rather than composing its own.
 */
function scopeSummary(inventory, review) {
  const statements = inventory.items.length;
  const unresolved = inventory.summary.unresolved;
  return {
    inventorySha256: inventory.inventorySha256,
    statements,
    unresolved,
    structurallyComplete: inventory.structurallyComplete,
    completenessReviewed: Boolean(review),
    completenessReview: review ? { actor: review.actor, authorityGroup: review.authorityGroup, at: review.at } : null,
    correctness: 'never-claimed',
    words: {
      structure: inventory.structurallyComplete ? `structurally complete (${statements} statement${statements === 1 ? '' : 's'})` : `${unresolved} of ${statements} statement(s) unresolved`,
      review: review ? `completeness reviewed by ${review.actor} (${review.authorityGroup})` : 'not reviewed for completeness',
      correctness: 'correctness is never claimed'
    }
  };
}

export function evaluateEvidence(graph, { boundary = 'view', mode = 'projection', requiredAssurance = DEFAULT_REQUIRED_ASSURANCE, at = new Date().toISOString() } = {}) {
  const workflow = graph.workflow;
  const workId = workflow.workItem.id;
  const phases = workflow.phases ?? {};
  const phaseOrder = workflow.phaseOrder ?? Object.keys(phases);
  const records = graph.records ?? {};
  const plannedClaims = mergePlannedClaimRecords(records.planned ?? []);
  const observedClaims = mergeObservedClaimRecords(records.observed ?? [], plannedClaims);
  // A decision may finish after observing existing behavior and skip every Code step. Judge the
  // route actually taken, not an unexecuted repair route; applicability still gates its omissions.
  const codePhaseIds = phaseOrder.filter((id) => phases[id]?.status !== 'skipped' && phaseRequiresCodeDelivery(phases[id]));
  const owners = workflow.resolution?.plannedClaims?.owners ?? {};
  const ownerIds = [...new Set(codePhaseIds.map((id) => owners[id]).filter(Boolean))];
  const deliveries = (graph.deliveries ?? []).filter((delivery) =>
    Number(delivery.generation) === Number(phases[delivery.phaseId]?.generation));

  // Witnesses per criterion: the exact test each tag sits on (or, where the module's adapter only
  // counts tests, the tagged file), each with the attempt it is judged against. A submitted delivery
  // binds its submission attempts; a published one shows its preflight runs, still pending.
  const witnesses = new Map();
  // Tags that sit on no test bind nothing; they are named so the author can move them [E2G-015].
  const unattached = new Map();
  for (const delivery of deliveries) {
    const ready = delivery.receipt?.status === 'ready';
    const bindings = ready ? delivery.receipt.traceability?.bindings ?? [] : delivery.acceptanceCriteria?.bindings ?? [];
    // A delivery that recorded no witness list at all (not an empty one) predates exact reading: its
    // tagged files count only through their module command.
    const declared = (ready ? delivery.receipt.traceability?.witnesses : delivery.acceptanceCriteria?.witnesses)
      ?? bindings.map((binding) => ({
        clauseId: binding.clauseId, testSource: binding.testSource, profile: 'module-counts-v1',
        commandId: binding.commandId ?? null, identity: null, gaps: ['ADAPTER_COUNTS_ONLY']
      }));
    for (const tag of (ready ? delivery.receipt.traceability?.unattachedTags : delivery.acceptanceCriteria?.unattachedTags) ?? []) {
      for (const clauseId of tag.clauseIds ?? []) {
        const key = String(clauseId).toUpperCase();
        unattached.set(key, [...(unattached.get(key) ?? []), `${tag.testSource}${tag.line ? `:${tag.line}` : ''}`]);
      }
    }
    for (const witness of declared) {
      const id = String(witness.clauseId ?? '').toUpperCase();
      if (!id) continue;
      const binding = bindings.find((entry) => String(entry.clauseId ?? '').toUpperCase() === id && entry.testSource === witness.testSource);
      const commandId = (ready ? binding?.commandId : null) ?? witness.commandId ?? binding?.commandId ?? null;
      const entries = witnesses.get(id) ?? [];
      entries.push({
        phaseId: delivery.phaseId, testSource: witness.testSource, commandId: ready ? commandId : null, ready, delivery,
        witness: { ...witness, commandId }, attempt: attemptFor(delivery, commandId, ready)
      });
      witnesses.set(id, entries);
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
  // Which step, at which generation, produced each clause's claims: a later scope revision makes
  // that evidence stale only for the clauses it changed [E2G-008].
  const provenance = (maps) => {
    const from = new Map();
    for (const map of maps) {
      for (const key of Object.keys(map?.claims ?? {})) from.set(key.toUpperCase(), { phaseId: map.phase, generation: map.generation });
    }
    return from;
  };
  const plannedFrom = provenance(records.planned ?? []);
  const observedFrom = provenance(records.observed ?? []);
  const staleness = scopeStaleness(workflow, clauses);
  const atGeneration = (ids) => ids.map((phaseId) => ({ phaseId, generation: phases[phaseId]?.generation ?? 0 }));
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
  const inspections = (graph.inspections ?? []).map(entry => ({ ...entry, clauseIds: qualifiedClauseIds(entry.text) }));
  // How each criterion must be verified [E2G-013], and what reviewers decided about each exact test
  // that witnesses one [E2G-014]: a decision binds the test's exact revision and the criterion's text.
  const contracts = mergedVerificationContracts(records.planned ?? []);
  const clauseBodies = new Map(clauses.map((clause) => [clause.id, clause.bodySha256]));
  const adequacy = new Map();
  for (const phase of Object.values(phases)) {
    for (const approval of (phase.approvals ?? []).filter((entry) => !entry.invalidatedAt)) {
      for (const mapping of approval.witnessMappings ?? []) adequacy.set(mapping.mappingSha256, mapping);
    }
  }
  const adequacyDecision = (entry, id, contract) => {
    if (!entry.witness.identity || (entry.witness.gaps ?? []).length) return null;
    return adequacy.get(witnessMappingSha256(witnessMappingCore(entry.witness, { clauseBodySha256: clauseBodies.get(id), contract }))) ?? null;
  };

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
    const testOnly = testOnlyClaimEvidence(id, planned, observed);
    const testOnlyLinked = testOnlyClaimEvidence(id, planned, observed, { complete: false });
    // A row allocated to some code steps is implemented, reviewed and verified by those steps.
    const allocatedSteps = noCode ? [] : (planned?.steps ?? []).filter((step) => codePhaseIds.includes(step));
    const implementers = allocatedSteps.length ? allocatedSteps : implementSteps;
    const rowSubmitted = allocatedSteps.length
      ? allocatedSteps.every((step) => phaseFinished(phases[step])
        || deliveries.some((delivery) => delivery.phaseId === step && delivery.receipt?.status === 'ready'))
      : submittedCode;
    const implementReview = implementers.length ? reviewFacet(phases[implementers.at(-1)]) : 'not-required';
    let implementStatus;
    if (!implementers.length) implementStatus = 'not-applicable';
    else if (noCode) implementStatus = implementers.every((step) => phaseFinished(phases[step])) ? 'met' : 'pending';
    else if ((observed?.verdict === 'matched' && (planned?.fulfillment !== 'test-only' || testOnly)) || testOnly) implementStatus = 'met';
    else if (observed && ['partial', 'deviated'].includes(observed.verdict)) implementStatus = 'partial';
    else implementStatus = rowSubmitted ? 'missing' : 'pending';
    if (implementStatus === 'partial') {
      rowFindings.push(finding(observed.verdict === 'deviated' ? 'EVIDENCE_IMPLEMENTATION_DEVIATED' : 'EVIDENCE_IMPLEMENTATION_PARTIAL',
        observed.verdict === 'deviated'
          ? `${id} was implemented differently from its plan${observed.deviation ? `: ${observed.deviation}` : ''}.`
          : `${id} changed ${observed.observedPaths?.length ?? 0} of ${planned?.expectedPaths?.length ?? 0} planned path(s).`,
        { obligationIds: [implementId] }));
    }
    if (implementStatus === 'missing') rowFindings.push(finding('EVIDENCE_IMPLEMENTATION_MISSING', `No delivered change implements ${id}.`, { obligationIds: [implementId] }));
    // The binding the implementing step delivered for this row, and the reviewer's decision on it.
    const binding = [...deliveries].reverse().filter((delivery) => implementers.includes(delivery.phaseId))
      .map((delivery) => ({ delivery, entry: delivery.implementationBindings?.bindings?.find((item) => item.clauseId === id) }))
      .find((candidate) => candidate.entry) ?? null;
    const bindingDecision = binding
      ? [...(phases[binding.delivery.phaseId]?.approvals ?? [])].reverse()
        .find((approval) => !approval.invalidatedAt && approval.implementationBindings?.bindingsSha256 === binding.delivery.implementationBindings.bindingsSha256)
        ?.implementationBindings.decisions.find((item) => item.clauseId === id) ?? null
      : null;
    if (bindingDecision?.decision === 'accepted-with-exception' && implementStatus === 'met') implementStatus = 'excepted';
    obligations.push({
      id: implementId, responsibility: 'implement', subject: id, owningSteps: implementers, status: implementStatus,
      fulfillment: noCode ? 'non-code' : planned?.fulfillment ?? (testOnly ? 'test-only' : 'new-or-modified'),
      ...(binding ? { binding: { ...binding.entry, decision: bindingDecision?.decision ?? null, reason: bindingDecision?.reason ?? null } } : {}),
      facets: {
        coverage: observed?.observedPaths?.length || testOnlyLinked ? 'linked' : 'unlinked', execution: 'not-applicable', assurance: 'not-applicable',
        review: implementReview, freshness: 'current',
        exception: observed?.verdict === 'deviated' ? 'deviation' : bindingDecision?.decision === 'accepted-with-exception' ? 'binding-exception' : 'none'
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
      let witnessResults = [];
      let contractSlots = [];
      let identityFacet = tagged.length ? 'declared' : 'none';
      let executionFacet = 'none';
      let requiredLevel = requiredAssurance;
      const contract = noCode ? null : effectiveContract(id, contracts, planned);
      if (noCode) {
        // A reviewer approved verification evidence that cites the criterion; no test proves it.
        inspectedBy = inspections.filter((entry) => entry.clauseIds.has(id) && phaseFinished(phases[entry.phaseId])
          && !['pending', 'not-required'].includes(reviewFacet(phases[entry.phaseId]))).map((entry) => entry.phaseId);
        execution = 'not-applicable';
        assurance = inspectedBy.length ? 'declared' : 'none';
        status = inspectedBy.length ? 'met' : verifySteps.length && verifySteps.every((step) => phaseFinished(phases[step])) ? 'missing' : 'pending';
        if (status === 'missing') rowFindings.push(finding('EVIDENCE_INSPECTION_MISSING', `No approved verification step cites ${id}.`, { obligationIds: [verifyId] }));
      } else if (!contract) {
        status = 'excepted';
        exception = 'not-applicable';
        assurance = 'none';
      } else {
        // The criterion against its verification contract [E2G-013]: each slot judged on its own,
        // each test joined to the authoritative attempt of its own command [E2G-016].
        const result = contractResult(id, contract, tagged, {
          submitted: submitted.length > 0, rowSubmitted, requiredAssurance, at,
          decisionFor: (entry) => adequacyDecision(entry, id, contract),
          unattached: unattached.get(id) ?? [],
          records: graph.witnessRecords ?? [],
          acceptedRisk: submitted.some((entry) => entry.delivery.testRecovery?.disposition === 'accepted-risk')
        });
        ({ status, exception, assurance, witnessResults, skipped } = result);
        contractSlots = result.slots;
        if (witnessResults.length) execution = result.executionWord;
        identityFacet = result.identity;
        executionFacet = result.execution;
        requiredLevel = result.requiredAssurance;
        for (const entry of result.findings) rowFindings.push(finding(entry.code, entry.message, { obligationIds: [verifyId] }));
      }
      verification = {
        association: noCode ? 'inspection' : !tagged.length ? 'none'
          : tagged.every((entry) => entry.witness.identity) ? 'exact-test'
            : tagged.some((entry) => entry.witness.identity) ? 'mixed' : 'test-file-tag',
        inspectedBy,
        tests: [...new Set(tagged.map((entry) => entry.testSource))].sort(),
        commands: [...new Set(submitted.map((entry) => entry.commandId).filter(Boolean))].sort(),
        execution,
        skippedTests: skipped,
        testDisposition: planned?.testDisposition ?? null,
        testReason: planned?.testReason ?? null,
        witnesses: witnessResults.map((entry) => ({
          test: entry.label, testSource: entry.testSource, profile: entry.profile, commandId: entry.commandId,
          attemptId: entry.attemptId, outcome: entry.outcome, status: entry.status, assurance: entry.assurance,
          identity: entry.identity, execution: entry.execution, requiredAssurance: entry.requiredAssurance,
          reasons: entry.reasons ?? []
        })),
        contract: contract ? {
          stated: contract.stated, combination: contract.combination,
          slots: contractSlots.map((entry) => ({
            slot: entry.slot, method: entry.method, role: entry.role, status: entry.status, assurance: entry.assurance,
            requiredAssurance: entry.requiredAssurance, witnesses: entry.results.map((result) => result.label)
          }))
        } : null
      };
      obligations.push({
        id: verifyId, responsibility: 'verify', subject: id, owningSteps: noCode ? inspectedBy : [...new Set(tagged.map((entry) => entry.phaseId))], status,
        // The two assurance facets [E2G-017], kept apart: how the test is tied, how its run was seen.
        assuranceFacets: { identity: noCode ? (inspectedBy.length ? 'declared' : 'none') : identityFacet, execution: noCode ? 'none' : executionFacet },
        requiredAssurance: noCode ? 'declared' : requiredLevel,
        // The exact attempts this criterion's tests ran in, which a risk decision binds [E2G-020].
        ...(witnessResults.length ? { attempts: witnessResults.map((entry) => ({ test: entry.label ?? null, attemptId: entry.attemptId ?? null, outcome: entry.outcome ?? null }))
          .sort((left, right) => `${left.test}\0${left.attemptId}`.localeCompare(`${right.test}\0${right.attemptId}`)) } : {}),
        facets: {
          coverage: tagged.length ? 'linked' : planned?.testDisposition === 'not-applicable' ? 'not-applicable' : 'unlinked',
          execution, assurance, review: implementReview, freshness: 'current', exception
        }
      });
    }

    // Review: the decision of the step that delivered the change.
    const reviewId = obligationId(workId, 'review', id);
    const reviewState = reviewStatus(implementReview);
    if (reviewState === 'pending' && rowSubmitted) rowFindings.push(finding('EVIDENCE_REVIEW_PENDING', `The delivery of ${id} is not approved yet.`, { obligationIds: [reviewId] }));
    obligations.push({
      id: reviewId, responsibility: 'review', subject: id, owningSteps: implementers.slice(-1), status: reviewState,
      facets: { coverage: 'not-applicable', execution: 'not-applicable', assurance: 'not-applicable', review: implementReview, freshness: 'current', exception: 'none' }
    });

    // Evidence produced before a scope revision that changed this clause (or one it depends on)
    // no longer counts: it is shown stale and pending until its step runs again. Every other
    // clause keeps its evidence.
    const sources = {
      plan: planned ? [plannedFrom.get(id)].filter(Boolean) : atGeneration(plannedBy),
      implement: observed ? [observedFrom.get(id)].filter(Boolean) : atGeneration(implementers),
      verify: (witnesses.get(id) ?? []).length
        ? (witnesses.get(id) ?? []).map((entry) => ({ phaseId: entry.phaseId, generation: entry.delivery.generation }))
        : atGeneration(noCode ? verifySteps : implementers),
      review: atGeneration(implementers.slice(-1))
    };
    const stale = new Map();
    for (const [index, obligation] of obligations.entries()) {
      if (obligation.status === 'not-applicable') continue;
      const revision = (sources[obligation.responsibility] ?? [])
        .map((source) => staleness.staleBy(id, source.phaseId, source.generation))
        .filter(Boolean)
        .sort((left, right) => right.revision - left.revision)[0];
      if (!revision) continue;
      stale.set(obligation.id, revision);
      obligations[index] = {
        ...obligation, status: 'pending', staleSince: { revision: revision.revision, revisionSha256: revision.revisionSha256 },
        facets: { ...obligation.facets, freshness: 'stale' }
      };
    }
    if (stale.size) {
      const kept = rowFindings.filter((entry) => !(entry.obligationIds ?? []).length || !entry.obligationIds.every((obligation) => stale.has(obligation)));
      rowFindings.length = 0;
      rowFindings.push(...kept);
      const latest = Math.max(...[...stale.values()].map((revision) => revision.revision));
      const responsibilities = obligations.filter((entry) => stale.has(entry.id)).map((entry) => entry.responsibility);
      rowFindings.push(finding('EVIDENCE_STALE_AFTER_SCOPE_REVISION',
        `${id} changed in scope revision ${latest}; its ${responsibilities.join(', ')} evidence predates that revision and counts again only when its step runs again.`,
        { obligationIds: [...stale.keys()] }));
    }
    // Governed risk acceptance [E2G-025]: an active decision carries an open obligation at the
    // transition it names, and what was observed stays visible. One that expired, was revoked, does
    // not permit the transition or accepted different evidence counts for nothing.
    const riskActions = [];
    for (const [index, obligation] of obligations.entries()) {
      const risk = riskDecisionState(workflow, obligation, { at, transition: 'terminal' });
      if (risk?.state === 'active') {
        obligations[index] = {
          ...obligation, status: 'excepted',
          riskDecision: { id: risk.decision.id, category: risk.decision.category, expiresAt: risk.decision.expiresAt, transitions: risk.decision.transitions },
          facets: { ...obligation.facets, exception: 'accepted-risk' }
        };
        continue;
      }
      if (risk) {
        const why = {
          expired: `expired on ${risk.decision.expiresAt.slice(0, 10)}`, revoked: 'was revoked',
          'out-of-scope': 'does not permit closing the Story', overtaken: 'accepted evidence that has since changed'
        }[risk.state];
        rowFindings.push(finding(`RISK_DECISION_${risk.state.toUpperCase().replace('-', '_')}`,
          `${risk.decision.id} on ${obligation.id} ${why}; renew it or meet the obligation.`, { obligationIds: [obligation.id], blocking: false }));
      }
      if (riskEligibility(obligation, { untrusted: graph.untrusted }).eligible) {
        riskActions.push({ kind: 'accept-risk', command: `singularity-flow decision risk --obligation ${obligation.id} --category <category> --expires <YYYY-MM-DD> --reason "<why>"` });
      }
    }
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
      actions: [{ kind: 'explain', command: `singularity-flow explain --subject clause --id ${id}` }, ...riskActions]
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
    provenance: graph.provenance ?? null,
    lifecycle: { status: workflow.status, words: lifecycleWords(workflow) },
    requiredAssurance: {
      level: requiredAssurance,
      source: noCode ? 'no code step: criteria are verified by inspection of approved verification evidence'
        : 'default: at least module-observed, and for each criterion the strongest its tests\' runner can reach'
    },
    endpoint: endpoint ? { from: endpoint.from, decision: endpoint.decision, route: endpoint.route } : null,
    applicability,
    rows: allRows,
    findings,
    summary: {
      rows: allRows.length,
      results: Object.fromEntries(ROW_RESULTS.map((result) => [result, counts[result] ?? 0])),
      assuranceFloor: weakestAssurance(verified.map((row) => row.assurance)),
      testCaseResults: testCaseResultWords(clauseRows),
      scope: graph.scope ? scopeSummary(graph.scope, graph.completenessReview) : null,
      scopeRevision: workflow.scopeRevisions?.length ? scopeRevisionSummary(workflow.scopeRevisions.at(-1), clauseRows) : null
    },
    decision: { gate, boundary },
    completion: completionLabel({ workflow, rows: allRows, terminal: graph.terminal ?? null, gate })
  };
}
