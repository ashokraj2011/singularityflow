import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, recordSha256 } from '../src/records.mjs';
import { currentSchemaVersion } from '../src/schema-migrations.mjs';
import { normalizeClaimMap } from '../src/specifications.mjs';
import { applyPlanCorrections, planRowCorrections, recordPlanRowCorrection } from '../src/plan-row-corrections.mjs';
import { amendmentPlanCorrection } from '../src/amendment-plan-corrections.mjs';
import { planClauseGaps } from '../src/plan-clause-gaps.mjs';
import { planCorrectionOperations } from '../src/commands/plan-correction.mjs';

const W = 'PRC-STORY';
const AC1 = `${W}:AC-001`;
const AC2 = `${W}:AC-002`;
const AC3 = `${W}:AC-003`;
const clauseIds = [AC1, AC2, AC3];

function subject() {
  const record = { schemaVersion: currentSchemaVersion('specification-claim-map'), kind: 'planned', workId: W,
    phase: 'planning', generation: 1, recordedAt: '2026-10-12T00:00:00.000Z',
    claims: {
      [AC1]: { expectedPaths: ['src/legacy.mjs'], tests: ['test/value.test.mjs'], testDisposition: 'applicable', testReason: null,
        deviation: null, fulfillment: 'modified' },
      [AC2]: { expectedPaths: [], tests: ['test/regression.test.mjs'], testDisposition: 'applicable', testReason: null,
        deviation: null, fulfillment: 'test-only' }
    } };
  const workflow = { workItem: { id: W }, status: 'in_progress', currentPhase: 'implementation',
    phaseOrder: ['planning', 'implementation'],
    phases: {
      planning: { id: 'planning', status: 'approved', generation: 1, approvalPolicy: { authorities: ['plan-reviewers'] },
        claimMaps: { planned: { path: 'x', sha256: recordSha256(record), generation: 1 } } },
      implementation: { id: 'implementation', status: 'in_progress', generation: 1 }
    } };
  return { record, workflow };
}

const normalizeRow = (clauseId, raw) => normalizeClaimMap({ claims: { [clauseId]: raw } }, { kind: 'planned', clauseIds }).claims[clauseId];

function correct(workflow, record, operations, overrides = {}) {
  return recordPlanRowCorrection(workflow, {
    ownerRecord: applyPlanCorrections(record, workflow), ownerMapSha256: workflow.phases.planning.claimMaps.planned.sha256,
    operations, activeClauseIds: clauseIds, normalizeRow, reason: 'The plan named the wrong module for the approved value.',
    actor: 'lead@example.test', authorityGroup: 'plan-reviewers', authorizationId: '7b0c5a52-2f1e-4f7e-9a51-0c6d9f1b2a33',
    at: '2026-10-12T01:00:00.000Z', ...overrides
  });
}

test('a correction replaces a wrong path, adds a missing row and a test, and every reader sees the corrected plan', () => {
  const { record, workflow } = subject();
  const original = canonicalJson(record);
  const recorded = correct(workflow, record, [
    { op: 'replace-location', clauseId: AC1, from: 'src/legacy.mjs', to: 'src/value.mjs' },
    { op: 'add-row', clauseId: AC3, expectedPaths: ['src/format.mjs'], tests: ['test/format.test.mjs'], fulfillment: 'new' },
    { op: 'add-test', clauseId: AC2, test: 'test/regression-edge.test.mjs' }
  ]);
  assert.equal(recorded.id, 'PRC-001');
  assert.equal(recorded.ownerGeneration, 1);
  assert.equal(recorded.reviewAssurance, 'live-terminal-exact-plan-review');
  assert.equal(recorded.operations[0].previousClaimSha256, recordSha256(record.claims[AC1]));
  const corrected = applyPlanCorrections(record, workflow);
  assert.deepEqual(corrected.claims[AC1].expectedPaths, ['src/value.mjs']);
  assert.deepEqual(corrected.claims[AC3].expectedPaths, ['src/format.mjs']);
  assert.equal(corrected.claims[AC3].fulfillment, 'new');
  assert.deepEqual(corrected.claims[AC2].tests, ['test/regression-edge.test.mjs', 'test/regression.test.mjs']);
  assert.equal(canonicalJson(record), original, 'the approved plan is never rewritten');
  assert.deepEqual(planRowCorrections(workflow, 'planning').map((entry) => entry.id), ['PRC-001']);

  // One refused operation refuses the whole correction: AC-003 is new, so its last path stays.
  assert.throws(() => correct(workflow, record, [{ op: 'add-test', clauseId: AC3, test: 'test/format-more.test.mjs' },
    { op: 'remove-location', clauseId: AC3, path: 'src/format.mjs' }]), { code: 'PLAN_ROW_CORRECTION_INVALID' });
  assert.throws(() => correct(workflow, record, [{ op: 'remove-location', clauseId: AC1, path: 'src/value.mjs' }]),
    { code: 'PLAN_ROW_CORRECTION_INVALID' }, 'the last path of a modified row stays');
  assert.equal(planRowCorrections(workflow).length, 1);
  // A second correction binds the corrected row, so it replays after the first.
  const second = correct(workflow, record, [{ op: 'replace-location', clauseId: AC3, from: 'src/format.mjs', to: 'src/format/index.mjs' }]);
  assert.equal(second.id, 'PRC-002');
  assert.equal(second.operations[0].previousClaimSha256, recordSha256(corrected.claims[AC3]));
  assert.deepEqual(applyPlanCorrections(record, workflow).claims[AC3].expectedPaths, ['src/format/index.mjs']);
});

test('a row planned as a product change becomes test-only when the tests are the whole delivery', () => {
  const { record, workflow } = subject();
  const recorded = correct(workflow, record, [{ op: 'set-fulfillment', clauseId: AC1, fulfillment: 'test-only' }],
    { reason: 'This Story generates tests; the module it names is not changed.' });
  assert.equal(recorded.operations[0].previousClaimSha256, recordSha256(record.claims[AC1]));
  const corrected = applyPlanCorrections(record, workflow).claims[AC1];
  assert.equal(corrected.fulfillment, 'test-only');
  assert.deepEqual(corrected.expectedPaths, [], 'a test-only row names no product path');
  assert.deepEqual(corrected.tests, ['test/value.test.mjs']);
  // Refused where a planner's row would be: already that kind, an unknown kind, or test-only with no test.
  assert.throws(() => correct(workflow, record, [{ op: 'set-fulfillment', clauseId: AC1, fulfillment: 'test-only' }]),
    { code: 'PLAN_ROW_CORRECTION_INVALID' });
  assert.throws(() => correct(workflow, record, [{ op: 'set-fulfillment', clauseId: AC2, fulfillment: 'rewritten' }]),
    { code: 'SPEC_PLANNED_FULFILLMENT_INVALID' });
  const { record: bare, workflow: bareFlow } = subject();
  bare.claims[AC1] = { ...bare.claims[AC1], tests: [], testDisposition: 'not-applicable', testReason: 'Manual check.' };
  bareFlow.phases.planning.claimMaps.planned.sha256 = recordSha256(bare);
  assert.throws(() => correct(bareFlow, bare, [{ op: 'set-fulfillment', clauseId: AC1, fulfillment: 'test-only' }]));
  assert.equal(planRowCorrections(bareFlow).length, 0);
});

// Tests delivered under other names than planned could only be renamed back or the plan returned.
test('a planned test is replaced or removed, never leaving a row without one', () => {
  const { record, workflow } = subject();
  record.claims[AC2].tests = ['test/regression.test.mjs', 'test/regression-old.test.mjs'];
  workflow.phases.planning.claimMaps.planned.sha256 = recordSha256(record);
  correct(workflow, record, [
    { op: 'replace-test', clauseId: AC1, from: 'test/value.test.mjs', to: 'test/value.spec.mjs' },
    { op: 'remove-test', clauseId: AC2, test: 'test/regression-old.test.mjs' }
  ]);
  const corrected = applyPlanCorrections(record, workflow).claims;
  assert.deepEqual(corrected[AC1].tests, ['test/value.spec.mjs']);
  assert.deepEqual(corrected[AC2].tests, ['test/regression.test.mjs']);
  assert.throws(() => correct(workflow, record, [{ op: 'remove-test', clauseId: AC2, test: 'test/regression.test.mjs' }]),
    { code: 'PLAN_ROW_CORRECTION_INVALID' }, 'the last test is replaced, not removed');
  assert.throws(() => correct(workflow, record, [{ op: 'remove-test', clauseId: AC1, test: 'test/missing.test.mjs' }]),
    { code: 'PLAN_ROW_CORRECTION_INVALID' });
  assert.deepEqual(planCorrectionOperations({ 'replace-test': `${AC1}=test/a.mjs:test/b.mjs`, 'remove-test': `${AC2}=test/c.mjs` }), [
    { op: 'remove-test', clauseId: AC2, test: 'test/c.mjs' },
    { op: 'replace-test', clauseId: AC1, from: 'test/a.mjs', to: 'test/b.mjs' }
  ]);
});

test('a later approved plan supersedes its corrections, and another plan is untouched', () => {
  const { record, workflow } = subject();
  correct(workflow, record, [{ op: 'add-test', clauseId: AC1, test: 'test/value-more.test.mjs' }]);
  const successor = { ...record, generation: 2 };
  assert.equal(applyPlanCorrections(successor, workflow), successor);
  const other = { ...record, phase: 'design' };
  assert.equal(applyPlanCorrections(other, workflow), other);
  const amendment = { kind: 'planned', amendment: true, phase: 'planning', generation: 1, claims: {} };
  assert.equal(applyPlanCorrections(amendment, workflow), amendment, 'the merged narrow-amendment record is not a plan');
});

test('a correction that no longer binds its plan, row or authority is an integrity failure', () => {
  const { record, workflow } = subject();
  correct(workflow, record, [{ op: 'add-test', clauseId: AC1, test: 'test/value-more.test.mjs' }]);
  const rebound = structuredClone(workflow);
  rebound.phases.planning.claimMaps.planned.sha256 = 'f'.repeat(64);
  assert.throws(() => applyPlanCorrections(record, rebound), { code: 'PLAN_ROW_CORRECTION_INTEGRITY' });
  const edited = structuredClone(record);
  edited.claims[AC1].tests.push('test/other.test.mjs');
  assert.throws(() => applyPlanCorrections(edited, workflow), { code: 'PLAN_ROW_CORRECTION_INTEGRITY' });
  const usurped = structuredClone(workflow);
  usurped.planAmendments[0].authorityGroup = 'implementation-reviewers';
  assert.throws(() => applyPlanCorrections(record, usurped), { code: 'PLAN_ROW_CORRECTION_INTEGRITY' });
  const malformed = structuredClone(workflow);
  malformed.planAmendments[0].operations[0].op = 'rewrite-row';
  assert.throws(() => applyPlanCorrections(record, malformed), { code: 'PLAN_ROW_CORRECTION_INTEGRITY' });
});

test('a correction is refused where a planner row would be, and nothing is recorded', () => {
  const { record, workflow } = subject();
  const refuse = (operations, overrides) => assert.throws(() => correct(workflow, record, operations, overrides),
    { code: /PLAN_ROW_CORRECTION_INVALID|SPEC_PLANNED_FULFILLMENT_INVALID/u });
  refuse([{ op: 'add-row', clauseId: `${W}:AC-009`, expectedPaths: ['src/x.mjs'] }]);
  refuse([{ op: 'add-row', clauseId: AC1, expectedPaths: ['src/x.mjs'] }]);
  refuse([{ op: 'add-row', clauseId: AC3, expectedPaths: [], tests: [] }]);
  refuse([{ op: 'add-row', clauseId: AC3, expectedPaths: ['src/x.mjs'], fulfillment: 'test-only', tests: ['test/x.test.mjs'] }]);
  refuse([{ op: 'add-test', clauseId: AC3, test: 'test/x.test.mjs' }]);
  refuse([{ op: 'add-test', clauseId: AC1, test: 'test/value.test.mjs' }]);
  refuse([{ op: 'replace-location', clauseId: AC1, from: 'src/missing.mjs', to: 'src/value.mjs' }]);
  refuse([{ op: 'replace-location', clauseId: AC1, from: 'src/legacy.mjs', to: '../outside.mjs' }]);
  refuse([{ op: 'replace-location', clauseId: AC1, from: 'src/legacy.mjs', to: 'src/*.mjs' }]);
  refuse([{ op: 'add-test', clauseId: AC1, test: 'test/new.test.mjs' }], { reason: 'too short' });
  refuse([]);
  const nonTest = structuredClone(record);
  nonTest.claims[AC1] = { expectedPaths: ['src/legacy.mjs'], tests: [], testDisposition: 'non-test', testReason: null,
    verificationCriterion: AC1, deviation: null, fulfillment: 'modified' };
  assert.throws(() => recordPlanRowCorrection(workflow, { ownerRecord: nonTest, ownerMapSha256: 'a'.repeat(64),
    operations: [{ op: 'add-test', clauseId: AC1, test: 'test/x.test.mjs' }], activeClauseIds: clauseIds, normalizeRow,
    reason: 'The criterion needs an automated check as well.', actor: 'a', authorityGroup: 'plan-reviewers',
    authorizationId: '7b0c5a52-2f1e-4f7e-9a51-0c6d9f1b2a33', at: '2026-10-12T01:00:00.000Z' }), { code: 'PLAN_ROW_CORRECTION_INVALID' });
  assert.equal(workflow.planAmendments?.length ?? 0, 0);
});

test('evidence and row corrections replay in the order they were decided', () => {
  const { record, workflow } = subject();
  correct(workflow, record, [{ op: 'replace-location', clauseId: AC1, from: 'src/legacy.mjs', to: 'src/value.mjs' }]);
  const rowCorrected = applyPlanCorrections(record, workflow).claims[AC1];
  const evidencePath = `team/stories/${W}/evidence/screen.png`;
  // An evidence correction decided afterwards binds the row as the readers showed it then.
  workflow.planAmendments.push({ id: `PEA-${'a'.repeat(24)}`, kind: 'evidence-contract-correction', ownerPhase: 'planning',
    ownerGeneration: 1, ownerMapSha256: workflow.phases.planning.claimMaps.planned.sha256, clauseId: AC1,
    previousClaimSha256: recordSha256(rowCorrected), path: evidencePath, method: 'visual',
    reason: 'The approved screenshot obligation was typed as product source.', actor: 'lead@example.test',
    authorityGroup: 'plan-reviewers', authorizationId: 'authorization-1', reviewAssurance: 'live-terminal-exact-evidence-review',
    at: '2026-10-12T02:00:00.000Z', recordPath: `team/stories/${W}/appeals/evidence/PEA-${'a'.repeat(24)}.json`,
    reviewedFile: { sha256: 'b'.repeat(64), size: 1 }, testsWaived: false, phaseApproved: false });
  const corrected = applyPlanCorrections(record, workflow);
  assert.equal(corrected.claims[AC1].fulfillment, 'evidence');
  assert.deepEqual(corrected.claims[AC1].expectedPaths, [evidencePath]);
  // Replaying them out of order would not bind: the evidence correction names the corrected row.
  const reversed = { ...workflow, planAmendments: [...workflow.planAmendments].reverse() };
  assert.throws(() => applyPlanCorrections(record, reversed), { code: 'PLAN_EVIDENCE_AMENDMENT_INTEGRITY' });
});

test('the command line names each correction exactly', () => {
  assert.deepEqual(planCorrectionOperations({
    'add-row': `${AC3}=src/a.mjs,src/b.mjs`, test: ['test/a.test.mjs'], fulfillment: 'new', steps: 'implementation',
    'add-test': [`${AC1}=test/x.test.mjs`], 'remove-location': `${AC1}=src/legacy.mjs`, 'replace-location': `${AC1}=src/a.mjs:src/b.mjs`,
    'set-fulfillment': `${AC2}=existing`
  }), [
    { op: 'add-row', clauseId: AC3, expectedPaths: ['src/a.mjs', 'src/b.mjs'], tests: ['test/a.test.mjs'], fulfillment: 'new',
      steps: ['implementation'], observableResult: undefined },
    { op: 'set-fulfillment', clauseId: AC2, fulfillment: 'existing' },
    { op: 'add-test', clauseId: AC1, test: 'test/x.test.mjs' },
    { op: 'remove-location', clauseId: AC1, path: 'src/legacy.mjs' },
    { op: 'replace-location', clauseId: AC1, from: 'src/a.mjs', to: 'src/b.mjs' }
  ]);
  assert.throws(() => planCorrectionOperations({ 'add-row': [AC1, AC3], test: 'test/a.test.mjs' }), { code: 'PLAN_ROW_CORRECTION_INVALID' });
  assert.throws(() => planCorrectionOperations({ 'replace-location': `${AC1}=src/a.mjs` }), { code: 'PLAN_ROW_CORRECTION_INVALID' });
  assert.throws(() => planCorrectionOperations({ 'add-test': 'test/x.test.mjs' }), { code: 'PLAN_ROW_CORRECTION_INVALID' });
});

test('[PHR:REQ-002] finding 15: a plan\'s parting from the amended clauses is named with its corrections, and a row for a removed clause is removed in place', () => {
  const { record, workflow } = subject();
  // The amendment removed AC-002 and added AC-003: the plan has a row for one and none for the other.
  const amended = [AC1, AC3];
  const gap = planClauseGaps(workflow, 'planning', record.claims, amended);
  assert.deepEqual([gap.unplanned, gap.removed], [[AC3], [AC2]]);
  assert.deepEqual(gap.routes.map((entry) => entry.command), [
    `singularity-flow decision plan ${W} --owner planning --add-row ${AC3}=<PATH> --test <TEST> --reason <why>`,
    `singularity-flow decision plan ${W} --owner planning --remove-row ${AC2} --reason <why>`]);
  assert.deepEqual(planClauseGaps(workflow, 'planning', record.claims, [AC1, AC2]).routes, [], 'a plan that plans every clause and no other');
  assert.deepEqual(planCorrectionOperations({ 'remove-row': AC2 }), [{ op: 'remove-row', clauseId: AC2 }]);

  // Its approvers remove the row of the clause the specification no longer holds; every reader sees it gone.
  const removal = (overrides) => correct(workflow, record, [{ op: 'remove-row', clauseId: AC2 }], { activeClauseIds: amended, ...overrides });
  const recorded = removal();
  assert.deepEqual(recorded.operations, [{ op: 'remove-row', clauseId: AC2, previousClaimSha256: recordSha256(record.claims[AC2]) }]);
  assert.deepEqual(Object.keys(applyPlanCorrections(record, workflow).claims), [AC1]);
  assert.deepEqual(planClauseGaps(workflow, 'planning', applyPlanCorrections(record, workflow).claims, amended).removed, []);
  // A row of a clause the specification still holds stays: it is corrected, never removed.
  const fresh = subject();
  assert.throws(() => correct(fresh.workflow, fresh.record, [{ op: 'remove-row', clauseId: AC2 }]),
    (error) => error.code === 'PLAN_ROW_CORRECTION_INVALID' && /still an approved clause/u.test(error.message));
});

test('[PHR:REQ-008] owner decision 4: the rows an intent amendment carries are in force once it is approved, never before', () => {
  const { record, workflow } = subject();
  // The rows as the proposal carried them, proved against the plan the way decision plan proves its own.
  const carried = correct(structuredClone(workflow), record, [{ op: 'add-row', clauseId: AC3, expectedPaths: ['src/format.mjs'],
    tests: ['test/format.test.mjs'], fulfillment: 'new' }]);
  const sign = (overrides = {}) => amendmentPlanCorrection(workflow, { carried: { ownerPhase: 'planning', ownerGeneration: 1,
    ownerMapSha256: carried.ownerMapSha256, operations: carried.operations, ...overrides },
  reason: 'Intent amendment AMD-001: each read shows the value once.', actor: 'lead@example.test', authorityGroup: 'plan-reviewers',
  at: '2026-10-12T02:00:00.000Z', intentAmendment: 'AMD-001' });
  const row = sign();
  assert.deepEqual([row.id, row.reviewAssurance, row.authorizationId, row.intentAmendment], ['PRC-001', 'intent-amendment-decision', null, 'AMD-001']);
  workflow.planAmendments = [row];
  workflow.intentAmendments = [{ id: 'AMD-001', status: 'proposed' }];
  assert.equal(applyPlanCorrections(record, workflow).claims[AC3], undefined, 'not before the amendment is approved');
  assert.deepEqual(planRowCorrections(workflow), []);
  workflow.intentAmendments[0].status = 'approved';
  assert.deepEqual(applyPlanCorrections(record, workflow).claims[AC3].expectedPaths, ['src/format.mjs']);
  assert.deepEqual(planRowCorrections(workflow).map((entry) => entry.id), ['PRC-001']);
  workflow.intentAmendments[0].status = 'rejected';
  assert.equal(applyPlanCorrections(record, workflow).claims[AC3], undefined, 'a rejected amendment carries nothing');
  // An amendment carries only rows it adds or removes; any other correction is decision plan's, reviewed in a terminal.
  assert.throws(() => sign({ operations: [{ op: 'add-test', clauseId: AC1, test: 'test/more.test.mjs', previousClaimSha256: recordSha256(record.claims[AC1]) }] }),
    { code: 'PLAN_ROW_CORRECTION_INVALID' });
  assert.throws(() => correct(subject().workflow, record, [{ op: 'add-test', clauseId: AC1, test: 'test/more.test.mjs' }], { authorizationId: null }),
    { code: 'PLAN_ROW_CORRECTION_INVALID' }, 'a terminal-reviewed correction keeps its authorization');
});

test('[PHR:REQ-008] several new rows each name their tests with --test <clause>=<test>', () => {
  assert.deepEqual(planCorrectionOperations({ 'add-row': [`${AC2}=src/a.mjs`, `${AC3}=src/b.mjs`], test: [`${AC2}=test/a.test.mjs`, `${AC3}=test/b.test.mjs`] })
    .map((operation) => [operation.clauseId, operation.expectedPaths, operation.tests]),
  [[AC2, ['src/a.mjs'], ['test/a.test.mjs']], [AC3, ['src/b.mjs'], ['test/b.test.mjs']]]);
  assert.throws(() => planCorrectionOperations({ 'add-row': [`${AC2}=src/a.mjs`, `${AC3}=src/b.mjs`], test: [`${AC1}=test/a.test.mjs`] }),
    { code: 'PLAN_ROW_CORRECTION_INVALID' }, 'a test for a row this command does not add');
  // One row keeps its plain --test, as before.
  assert.deepEqual(planCorrectionOperations({ 'add-row': `${AC3}=src/b.mjs`, test: 'test/b.test.mjs' })[0].tests, ['test/b.test.mjs']);
});
