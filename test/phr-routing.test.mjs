/**
 * Phase responsibility, batch 1 [SPEC-PHR]: a later step that meets a fault in an earlier step's
 * output routes it to the step that owns it, and never strands its own author with a fix they
 * cannot make. Nothing here refuses anything new; each test reads the routes the existing refusals,
 * holds and decisions already carry.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { approvalHold } from '../src/approval-check.mjs';
import { evaluateEvidence } from '../src/evidence/evaluate.mjs';
import { evidenceGraph } from '../src/evidence/graph.mjs';
import { evidenceWaitingOnIssues } from '../src/evidence/terminal.mjs';
import { findingOwnedByPhase, phaseFindingPolicy } from '../src/phase-finding-policy.mjs';
import { phaseResolutionChoices } from '../src/phase-resolution.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { sourceReviewBinding } from '../src/source-grounded-review.mjs';
import { reviewUpstreamRoute, sourceReviewContinuation } from '../src/source-review-continuation.mjs';
import { sourceReviewReportSchema, sourceReviewReportTemplate, validateSourceReviewReport } from '../src/source-review-contract.mjs';
import { checkSourceReviewReport } from '../src/source-review-lifecycle.mjs';
import { compactSourceReviewContext } from '../src/source-review-agent-context.mjs';
import { planCorrectionRoutes, upstreamWaiting, withoutSettledClauses } from '../src/spec-coverage-preview.mjs';
import { settledUpstreamClauses } from '../src/upstream-routes.mjs';
import { SingularityFlowError } from '../src/util.mjs';

/** Code is approved, verification awaits approval and may return to code. */
function story({ rejectTo = ['code', 'verification'] } = {}) {
  const step = (id, status, policy = {}) => ({ id, label: id[0].toUpperCase() + id.slice(1), status, generation: 1, approvals: [],
    generationPolicy: id === 'code' ? { task: 'code' } : undefined, approvalPolicy: { authorities: ['engineering'], minimum: 1, ...policy } });
  return { workItem: { id: 'W-1' }, status: 'in_progress', currentPhase: 'verification', phaseOrder: ['planning', 'code', 'verification'],
    phases: { planning: step('planning', 'approved'), code: step('code', 'approved'), verification: step('verification', 'awaiting_approval', { rejectTo }) },
    resolution: {} };
}
const refusal = (code, details = {}) => new SingularityFlowError(`${code} refused.`, { code, details });

test('[PHR:REQ-004] a hold takes the refusal\'s own repair, its owner step or its gate\'s actions before a return to itself', () => {
  const workflow = story();
  const verification = workflow.phases.verification;
  // Changed code after its approved tests: the refusal names the return to code; the hold used to return verification to itself.
  const stale = approvalHold(refusal('PRIOR_CODE_TEST_EVIDENCE_STALE', { phase: 'verification', sourcePhase: 'code', changedPaths: ['src/a.mjs'],
    repairCommand: 'singularity-flow reject verification --to code --reason <REASON>',
    gate: { actions: [{ command: 'singularity-flow decision plan --add-location <clause>=<path> --reason <reason>' },
      { command: 'singularity-flow reject verification --to code --reason <REASON>' }] } }), workflow, verification);
  assert.equal(stale.action.command, 'singularity-flow reject verification --to code --reason <REASON>');
  assert.match(stale.action.label, /returns verification to code, which owns what this refusal names/u);
  assert.equal(stale.action.skill, '/sf-reject');
  assert.doesNotMatch(JSON.stringify(stale), /--fetch/u, 'never a return of verification to itself');

  // Only the gate's actions: the first is the route.
  const gated = approvalHold(refusal('PRIOR_CODE_TEST_EVIDENCE_STALE', { phase: 'verification',
    gate: { actions: [{ command: 'singularity-flow reject verification --to code --reason <REASON>' }] } }), workflow, verification);
  assert.equal(gated.action.command, 'singularity-flow reject verification --to code --reason <REASON>');

  // Only the owner step: a return there, when this step may make it.
  const owned = approvalHold(refusal('STORY_REVIEW_SOURCE_CHANGED', { phase: 'verification', upstreamPhase: 'code' }), workflow, verification);
  assert.equal(owned.action.command, 'singularity-flow reject verification --work-id W-1 --to code --reason <REASON>');
  assert.match(owned.action.label, /code's author repairs it there/u);
  // A step that may not return there keeps the old route: nothing offers a return the CLI refuses.
  const barred = story({ rejectTo: ['verification'] });
  const kept = approvalHold(refusal('STORY_REVIEW_SOURCE_CHANGED', { phase: 'verification', upstreamPhase: 'code' }), barred, barred.phases.verification);
  assert.equal(kept.action.command, 'singularity-flow reject verification --work-id W-1 --fetch --reason <REASON>');
  // A refusal that names nothing still returns the step for changes, as before.
  const plain = approvalHold(refusal('STORY_REVIEW_SOURCE_CHANGED'), workflow, verification);
  assert.equal(plain.action.command, 'singularity-flow reject verification --work-id W-1 --fetch --reason <REASON>');
});

test('[PHR:REQ-003] the repository\'s own tests failing at verification approval return it to the code step, in the refusal and the hold', () => {
  const workflow = story();
  const back = 'singularity-flow reject verification --work-id W-1 --to code --reason <REASON>';
  const error = refusal('PHASE_VALIDATION_FAILED', { phase: 'verification', ownerPhase: 'code', upstreamPhase: 'code', repositoryTests: 'failed', repairCommand: back });
  const plan = refusalRemediationPlan(error, ['approve', 'verification', '--work-id', 'W-1']);
  assert.equal(plan.steps[0].command, back, 'the owner\'s return leads the approval turn\'s plan');
  assert.equal(plan.steps[0].skill, '/sf-reject');
  assert.ok(plan.steps.some((entry) => entry.id === 'leave-approval-turn'), 'the approval turn still ends');
  const hold = approvalHold(error, workflow, workflow.phases.verification);
  assert.equal(hold.action.command, back);
  assert.equal(hold.owner, 'author-repairs');
  // Without the owner, an approval refusal keeps the plan it always had.
  const own = refusalRemediationPlan(refusal('PHASE_VALIDATION_FAILED'), ['approve', 'verification', '--work-id', 'W-1']);
  assert.equal(own.steps[0].id, 'inspect-current-phase');
});

/** The specification is approved and planning is being written. */
function planningStory() {
  const step = (id, status) => ({ id, label: id, status, generation: 1, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1, rejectTo: [id] } });
  return { workItem: { id: 'W-2' }, status: 'in_progress', currentPhase: 'planning', phaseOrder: ['specification', 'planning', 'code'],
    phases: { specification: step('specification', 'approved'), planning: step('planning', 'in_progress'), code: { ...step('code', 'not_started'), generation: 0 } },
    resolution: { plannedClaims: { mode: 'required', clausePhases: ['specification'] } } };
}

test('[PHR:REQ-001] no clauses before planning is the specification\'s to fix: planning routes it there and keeps its draft', () => {
  const workflow = planningStory();
  const planning = workflow.phases.planning;
  const finding = { code: 'specification.clause-source-required', category: 'planning-table', path: 'plan.md',
    message: 'No authoritative specification clauses exist.', details: { clausePhases: ['specification'], ownerPhase: 'specification', upstreamPhase: 'specification' } };
  assert.equal(findingOwnedByPhase(workflow, planning, finding), false, 'never the planner\'s same-turn repair');
  const resolution = phaseResolutionChoices(workflow, planning, finding);
  assert.equal(resolution.affectedPhase, 'specification');
  assert.equal(resolution.policy.repairableByProducer, false);
  assert.equal(resolution.choices[0].kind, 'upstream-owner');
  assert.equal(resolution.choices[0].owner, 'specification-approval-authority');
  assert.match(resolution.choices[0].command, /^singularity-flow upstream-issue raise --work-id W-2 --phase specification /u);
  // The planner's own row errors stay the planner's.
  const own = { code: 'specification.planned-test-missing', category: 'planning-table', path: 'plan.md', message: 'Clause W-2:REQ-001 has no planned test.',
    details: { clauseId: 'W-2:REQ-001', ownerPhase: 'planning', repairScope: 'current-draft' } };
  assert.equal(findingOwnedByPhase(workflow, planning, own), true);
  assert.equal(phaseFindingPolicy(own).repairableByProducer, true);
  assert.notEqual(phaseResolutionChoices(workflow, planning, own).choices[0].kind, 'upstream-owner');
});

/** Planning approved, implementation the last code step being submitted, with the Story's upstream issues. */
function codeStory(issues = [], decisions = []) {
  const step = (id, status, generation = 1) => ({ id, label: id, status, generation, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1, rejectTo: [id] } });
  return { workItem: { id: 'US-1' }, status: 'in_progress', currentPhase: 'implementation', phaseOrder: ['planning', 'implementation', 'verification'],
    phases: { planning: step('planning', 'approved'), implementation: { ...step('implementation', 'in_progress'), generationPolicy: { task: 'code' } },
      verification: step('verification', 'not_started', 0) },
    upstreamIssues: issues, upstreamIssueDecisions: decisions, resolution: {} };
}

test('[PHR:REQ-003] a coverage gap at code submission and approval: a decided issue settles its clause, an open one waits, and the plan\'s corrections are named', () => {
  const issue = { id: 'UPI-001', phase: 'planning', about: 'US-1:REQ-002', problem: 'The plan puts it in the wrong module.' };
  const later = '2999-01-01T00:00:00.000Z';
  // Decided: accept-risk (unexpired) or dismiss settles the clause it names; nothing else.
  for (const outcome of ['accept-risk', 'dismiss']) {
    const workflow = codeStory([issue], [{ issue: 'UPI-001', outcome, ...(outcome === 'accept-risk' ? { expiresAt: later } : {}) }]);
    assert.deepEqual(settledUpstreamClauses(workflow, 'implementation', ['US-1:REQ-001', 'US-1:REQ-002']).map((entry) => [entry.clauseId, entry.issue, entry.outcome]),
      [['US-1:REQ-002', 'UPI-001', outcome]]);
  }
  // An expired risk, a return or an open issue settles nothing; nor does an issue against a later step.
  assert.deepEqual(settledUpstreamClauses(codeStory([issue], [{ issue: 'UPI-001', outcome: 'accept-risk', expiresAt: '2000-01-01T00:00:00.000Z' }]), 'implementation', ['US-1:REQ-002']), []);
  assert.deepEqual(settledUpstreamClauses(codeStory([issue], [{ issue: 'UPI-001', outcome: 'return' }]), 'implementation', ['US-1:REQ-002']), []);
  assert.deepEqual(settledUpstreamClauses(codeStory([issue]), 'implementation', ['US-1:REQ-002']), []);
  assert.deepEqual(settledUpstreamClauses(codeStory([{ ...issue, phase: 'verification' }], [{ issue: 'UPI-001', outcome: 'dismiss' }]), 'implementation', ['US-1:REQ-002']), []);

  // The settled clause leaves the coverage the refusal reads; with nothing else open it is complete.
  const coverage = { unimplemented: ['US-1:REQ-002'], unclaimedChangedPaths: [], withdrawnButClaimed: [], invalidEvidence: [], complete: false, severity: 'error' };
  const settled = withoutSettledClauses(coverage, [{ clauseId: 'US-1:REQ-002', issue: 'UPI-001', outcome: 'dismiss' }]);
  assert.deepEqual([settled.complete, settled.severity, settled.unimplemented], [true, 'pass', []]);
  assert.equal(withoutSettledClauses({ ...coverage, unimplemented: ['US-1:REQ-001', 'US-1:REQ-002'] }, [{ clauseId: 'US-1:REQ-002' }]).complete, false);

  // Open: the same waiting words and decision-list action publication carries.
  const waiting = upstreamWaiting(codeStory([issue]), { issues: [{ id: 'UPI-001', phase: 'planning', clauses: ['US-1:REQ-002'] }], complete: true });
  assert.match(waiting.text, /every clause listed here waits on that decision by planning's approvers, not on this step's code/u);
  assert.equal(waiting.details.nextAction.command, 'singularity-flow decisions US-1 --json');

  // Neither: the plan's own corrections and the upstream issue to its approvers, beside the delivery.
  const corrections = planCorrectionRoutes(codeStory(), 'planning', 'implementation', ['US-1:REQ-002'], { 'US-1:REQ-002': { expectedPaths: ['src/a.mjs'], tests: ['test/a.test.mjs'] } });
  assert.deepEqual(corrections.routes.map((entry) => entry.command), [
    'singularity-flow decision plan US-1 --replace-location US-1:REQ-002=src/a.mjs:<NEW-PATH> --reason <why>',
    'singularity-flow decision plan US-1 --remove-location US-1:REQ-002=src/a.mjs --reason <why>',
    'singularity-flow decision plan US-1 --replace-test US-1:REQ-002=test/a.test.mjs:<NEW-TEST> --reason <why>',
    'singularity-flow upstream-issue raise --work-id US-1 --phase planning --about US-1:REQ-002 --problem <what-is-wrong>']);
  assert.match(corrections.text, /an approver of planning corrects the row in their own terminal/u);
  const details = { workId: 'US-1', phase: 'implementation', planningOwner: 'planning', coverage: { unimplemented: ['US-1:REQ-002'] },
    diagnosticCommand: 'singularity-flow recover US-1 --phase implementation --json', planCorrections: corrections.routes };
  const plan = refusalRemediationPlan(refusal('SPEC_COVERAGE_INCOMPLETE', details), ['submit', 'implementation', '--work-id', 'US-1']);
  const ids = plan.steps.map((entry) => entry.id);
  assert.ok(ids.includes('correct-plan-row') && ids.includes('raise-upstream-issue'), JSON.stringify(ids));
  assert.ok(ids.indexOf('deliver-missing-clauses') < ids.indexOf('correct-plan-row'), 'delivery stays first');
  const choices = phaseResolutionChoices(codeStory(), codeStory().phases.implementation, { code: 'SPEC_COVERAGE_INCOMPLETE', details }).choices;
  assert.deepEqual(choices.filter((entry) => ['plan-correction', 'upstream-issue'].includes(entry.kind)).map((entry) => [entry.kind, entry.owner, entry.command]), [
    ['plan-correction', 'planning-approval-authority', corrections.routes[0].command], ['upstream-issue', 'planning-approval-authority', corrections.routes[3].command]]);
});

/**
 * The ending of a Story whose code step delivered REQ-001 and AC-001 but not AC-002 (and, with
 * `bothMissing`, not AC-001 either), with the Story's upstream issues and their decisions.
 */
function ending({ issues = [], decisions = [], bothMissing = false } = {}) {
  const W = 'END-1';
  const [REQ, AC1, AC2] = [`${W}:REQ-001`, `${W}:AC-001`, `${W}:AC-002`];
  const policy = { mode: 'required', minimum: 1, authorities: ['reviewers'], requiredAuthorities: [] };
  const approval = { decision: 'approved', actor: { login: 'reviewer' }, authorityGroup: 'reviewers', at: '2026-11-09T00:00:00Z' };
  const step = (id, extra = {}) => ({ id, status: 'approved', generation: 1, approvalPolicy: policy, approvals: [approval], ...extra });
  const workflow = { workItem: { id: W }, status: 'in_progress', currentPhase: 'testing', phaseOrder: ['intake', 'implementation', 'testing'],
    resolution: { plannedClaims: { mode: 'required', clausePhases: ['intake'], owners: { implementation: 'intake' } } },
    phases: { intake: step('intake', { requiredArtifact: { kind: 'requirements' } }),
      implementation: step('implementation', { generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' } }),
      testing: step('testing', { status: 'in_progress', approvals: [], requiredArtifact: { kind: 'test-evidence' } }) },
    upstreamIssues: issues, upstreamIssueDecisions: decisions };
  const clause = (id, type, line, dependsOn = []) => ({ id, type, source: { path: 'intake.md', line }, bodySha256: String(line).repeat(64).slice(0, 64), dependsOn });
  const claim = { expectedPaths: ['src/value.mjs'], tests: [], testDisposition: 'unspecified', testReason: null };
  const delivered = { observedPaths: ['src/value.mjs'], commits: [], verdict: 'matched' };
  const missing = { observedPaths: [], testResults: [], commits: [], verdict: 'missing' };
  const evaluation = evaluateEvidence(evidenceGraph({ workflow,
    records: { indexes: [{ workId: W, phase: 'intake', generation: 1, clauses: [clause(REQ, 'REQ', 3), clause(AC1, 'AC', 5, [REQ]), clause(AC2, 'AC', 6)] }],
      planned: [{ workId: W, phase: 'intake', generation: 1, kind: 'planned', claims: { [REQ]: claim,
        [AC1]: { ...claim, tests: ['test/one.test.mjs'], testDisposition: 'applicable' }, [AC2]: { ...claim, tests: ['test/two.test.mjs'], testDisposition: 'applicable' } } }],
      observed: [{ workId: W, phase: 'implementation', generation: 1, kind: 'observed', claims: { [REQ]: { ...delivered, testResults: [] },
        [AC1]: bothMissing ? missing : { ...delivered, testResults: ['test/one.test.mjs'] }, [AC2]: missing } }], acceptance: [] },
    deliveries: [{ phaseId: 'implementation', generation: 1, status: 'ready', testRecovery: null,
      acceptanceCriteria: { bindings: [{ clauseId: AC1, testSource: 'test/one.test.mjs' }, { clauseId: AC2, testSource: 'test/two.test.mjs' }] },
      receipt: { status: 'ready', traceability: { bindings: [{ clauseId: AC1, testSource: 'test/one.test.mjs', commandId: 'unit' }, { clauseId: AC2, testSource: 'test/two.test.mjs', commandId: 'unit' }] } },
      executions: [{ commandId: 'unit', kind: 'test-execution', status: 'passed', record: { status: 'passed', tests: { discovered: 2, passed: 2, failed: 0, skipped: 0 } } }] }] }),
  { boundary: 'terminal', mode: 'decision' });
  return { workflow, evaluation, row: (id) => evaluation.rows.find((entry) => entry.id === id), AC1, AC2 };
}

test('[PHR:REQ-003] at the end of the Story a decided upstream issue settles its row, and an open one naming every blocking row is someone\'s decision', async () => {
  const issue = { id: 'UPI-001', phase: 'intake', about: 'END-1:AC-002', problem: 'AC-002 cannot be delivered in this repository.' };
  // No issue: the missing implementation blocks, as before.
  const plain = ending();
  assert.equal(plain.evaluation.decision.gate, 'block');
  assert.equal(plain.row(plain.AC2).obligations.find((entry) => entry.responsibility === 'implement').status, 'missing');
  // Decided (dismiss, or an unexpired accepted risk): the row is settled, shown as that decision, never as met.
  for (const decision of [{ issue: 'UPI-001', outcome: 'dismiss' }, { issue: 'UPI-001', outcome: 'accept-risk', expiresAt: '2999-01-01T00:00:00.000Z' }]) {
    const decided = ending({ issues: [issue], decisions: [decision] });
    const implement = decided.row(decided.AC2).obligations.find((entry) => entry.responsibility === 'implement');
    assert.deepEqual([implement.status, implement.facets.exception, implement.upstreamDecision.issue, implement.upstreamDecision.outcome],
      ['excepted', 'upstream-decision', 'UPI-001', decision.outcome]);
    assert.notEqual(decided.evaluation.decision.gate, 'block');
  }
  // An expired risk, a return, or an issue that names another clause settles nothing.
  assert.equal(ending({ issues: [issue], decisions: [{ issue: 'UPI-001', outcome: 'accept-risk', expiresAt: '2000-01-01T00:00:00.000Z' }] }).evaluation.decision.gate, 'block');
  assert.equal(ending({ issues: [issue], decisions: [{ issue: 'UPI-001', outcome: 'return' }] }).evaluation.decision.gate, 'block');
  assert.equal(ending({ issues: [{ ...issue, about: 'END-1:AC-001', problem: 'The first criterion is worded loosely.' }], decisions: [{ issue: 'UPI-001', outcome: 'dismiss' }] }).evaluation.decision.gate, 'block');

  // Open, naming every blocking row: those blockers wait on its decision, so the last step's submission defers them.
  const open = ending({ issues: [issue] });
  const waiting = await evidenceWaitingOnIssues(open.workflow, open.evaluation);
  assert.ok(waiting.length > 0 && waiting.every((message) => /AC-002/u.test(message)), waiting.join('\n'));
  // A blocking row no issue names is still the author's: nothing is deferred.
  const partial = ending({ issues: [issue], bothMissing: true });
  assert.deepEqual(await evidenceWaitingOnIssues(partial.workflow, partial.evaluation), []);
  assert.deepEqual(await evidenceWaitingOnIssues(plain.workflow, plain.evaluation), []);
});

/** A planning review of an approved specification, with the Story's upstream issues against it. */
function planningReview(issues = []) {
  const context = { kind: 'planning', workId: 'REVIEW-1', phase: 'planning', generation: 1,
    authorAgentId: 'architect', reviewerAgentId: 'source-reviewer', reviewerAgentSha256: 'a'.repeat(64),
    sources: [{ id: 'story', path: 'USER-STORY.md', text: 'The existing behavior must be verified.' }],
    upstreamSpec: { path: 'spec.md', text: '# Requirements\n- Verify existing behavior. [REVIEW-1:REQ-001]\n- Show both success and error screenshots. [REVIEW-1:AC-001]\n' },
    artifact: { path: 'plan.md', text: `# Plan
| Clause | Expected paths | Planned tests | Fulfillment | Steps | Observable result |
|---|---|---|---|---|---|
| \`REVIEW-1:REQ-001\` | - | \`test/app.test.mjs\` | test-only | verification | Existing behavior verified |
| \`REVIEW-1:AC-001\` | \`docs/screenshots.md\` | not-applicable: manual screenshot inspection | document | implementation | Success screenshot |
` }, upstreamSpecPhase: 'specification', upstreamIssues: issues };
  return { ...context, binding: sourceReviewBinding(context) };
}

test('[PHR:REQ-003] a planning review finding about the approved specification is raised there and then does not hold planning', () => {
  const report = (findings) => {
    const packet = sourceReviewReportTemplate(planningReview());
    for (const row of packet.rows) row.assessment = 'supported';
    return { ...packet, findings };
  };
  const aboutSpec = { id: 'spec-gap', severity: 'blocking', clauseId: 'REVIEW-1:AC-001', ownerPhase: 'specification',
    message: 'The specification never says what the error screenshot shows.' };
  assert.equal(validateSourceReviewReport(report([aboutSpec]), 'planning').status, 'ready', 'the report schema admits ownerPhase');
  assert.match(JSON.stringify(sourceReviewReportSchema('planning')), /ownerPhase/u);
  // The reviewer is told which step to name.
  const ctx = planningReview();
  const guide = compactSourceReviewContext({ canReview: true, kind: 'planning', binding: ctx.binding, sources: ctx.sources, upstreamSpec: ctx.upstreamSpec,
    upstreamSpecPhase: 'specification', artifact: ctx.artifact, reportTemplate: sourceReviewReportTemplate(ctx), reportSchema: sourceReviewReportSchema('planning') },
  { workId: ctx.workId, ready: true }).reviewGuide;
  assert.match(guide.upstreamFindings, /names ownerPhase "specification"/u);

  // Not raised yet: it still holds planning, and its way on is the raise to the specification's approvers.
  const held = checkSourceReviewReport(report([aboutSpec]), planningReview()).evaluation;
  assert.equal(held.status, 'correction-required');
  const [blocker] = held.findings.filter((entry) => entry.code === 'reviewer-blocker');
  assert.deepEqual([blocker.ownerPhase, blocker.upstreamPhase, blocker.about], ['specification', 'specification', 'REVIEW-1:AC-001']);
  const step = (id, status, generation = 1) => ({ id, status, generation, approvals: [], approvalPolicy: { authorities: ['reviewers'], minimum: 1 } });
  const workflow = { workItem: { id: 'REVIEW-1' }, status: 'in_progress', currentPhase: 'planning', phaseOrder: ['specification', 'planning', 'code'],
    phases: { specification: step('specification', 'approved'), planning: step('planning', 'in_progress'), code: step('code', 'not_started', 0) }, resolution: {} };
  const route = reviewUpstreamRoute(workflow, workflow.phases.planning, held);
  assert.equal(route.command, 'singularity-flow upstream-issue raise --work-id REVIEW-1 --phase specification --about REVIEW-1:AC-001 --problem <what-is-wrong>');
  assert.equal(route.skill, '/sf-decide');
  const continuation = sourceReviewContinuation(workflow, workflow.phases.planning, held);
  assert.equal(continuation.classification, 'upstream-issue-required', 'never a successor of the plan, which would meet it again');
  assert.equal(continuation.nextCommand, route.command);

  // Raised (open or decided): it no longer holds planning, and the review says where it went.
  for (const status of ['open', 'decided']) {
    const raised = checkSourceReviewReport(report([aboutSpec]), planningReview([{ id: 'UPI-001', about: 'REVIEW-1:AC-001', problem: 'No error screenshot.', status }])).evaluation;
    // Only the fixture's own not-applicable row still waits for a person; nothing of the reviewer's holds the plan.
    assert.deepEqual(raised.findings.map((entry) => entry.code), ['human-disposition-required']);
    assert.equal(sourceReviewContinuation(workflow, workflow.phases.planning, raised).classification, 'human-disposition-required');
    assert.deepEqual(raised.upstreamFindings.map((entry) => [entry.id, entry.issue, entry.ownerPhase]), [['spec-gap', 'UPI-001', 'specification']]);
  }
  // A finding about the plan itself, or naming a step that is not the approved specification, holds as before.
  const own = checkSourceReviewReport(report([{ ...aboutSpec, ownerPhase: undefined }]), planningReview()).evaluation;
  assert.equal(own.findings.find((entry) => entry.code === 'reviewer-blocker').upstreamPhase, undefined);
  assert.equal(reviewUpstreamRoute(workflow, workflow.phases.planning, own), null);
  assert.equal(checkSourceReviewReport(report([{ ...aboutSpec, ownerPhase: 'intake' }]), planningReview()).evaluation
    .findings.find((entry) => entry.code === 'reviewer-blocker').upstreamPhase, undefined);
});
