/**
 * A failing test goes back to the code step on its own (owner, 2026-11-20, step intents D1): the pure rules of
 * src/failing-tests-return.mjs. Which steps it covers and for which Stories, which failures count, which code step gets
 * them, the workflow's review brake, the person's filled choices, and the test step's run again. The whole path through
 * the CLI is walked by its routes in test/journey-stories.test.mjs (journeys T and U).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { autoReturnStep, codeStepOf, failingTestChecks, failingTestsHold, heldChoices, testsRerunDue } from '../src/failing-tests-return.mjs';
import { OWNER_STEP_CHECKS, phaseResponsibilityPin } from '../src/phase-roles.mjs';
import { plainSettled } from '../src/decision-plain.mjs';
import { recordSettledDecision, reraisedRoute, settledDecisions, settlementMatters } from '../src/settled-decisions.mjs';
import { settledOpening } from '../src/story-version-opening.mjs';

const W = 'D1-1';
const code = (overrides = {}) => ({ id: 'implementation', label: 'Implementation', status: 'approved', generation: 1, generationPolicy: { task: 'code' },
  writeScope: 'source-and-artifact', requiredArtifact: { kind: 'implementation-summary' }, approvalPolicy: { mode: 'required', rejectTo: ['implementation'] }, ...overrides });
const testing = (overrides = {}) => ({ id: 'verification', label: 'Verification', status: 'awaiting_approval', generation: 1, writeScope: 'artifact-only',
  requiredArtifact: { kind: 'test-evidence' }, validationVerdict: 'failed',
  approvalPolicy: { mode: 'required', rejectTo: ['implementation', 'verification'] },
  checks: [{ id: 'value-check', kind: 'test', command: 'node checks/value-check.mjs', status: 'failed', exitCode: 1, stderr: 'AssertionError: expected 2, got 1' }], ...overrides });
const story = ({ steps = {}, settled = [], resolution = {} } = {}) => {
  const phases = { implementation: code(steps.implementation), verification: testing(steps.verification) };
  return { workItem: { id: W }, status: 'in_progress', currentPhase: 'verification', phaseOrder: ['implementation', 'verification'], phases,
    settledDecisions: settled, changeRequests: [], resolution: { phaseResponsibility: phaseResponsibilityPin(), phases: [], sourceReview: { mode: 'enforce' }, ...resolution } };
};
const start = (id, toGeneration, overrides = {}) => ({ id, kind: 'failing-tests', by: 'sflow', phase: 'implementation', subject: `s-${id}`, answer: 'Started it',
  evidence: [{ what: 'a test failed', where: 'verification test run' }], at: '2026-11-21T00:00:00.000Z',
  effect: { generation: toGeneration - 1, toGeneration, testPhase: 'verification', testGeneration: 1, tests: ['command:value-check'], changeRequest: 'CR-001', round: 1 }, ...overrides });

test('D1 applies to a test step that changes no source code, in a Story that pinned owner-step checks level 4', () => {
  assert.equal(OWNER_STEP_CHECKS >= 4, true);
  const workflow = story();
  assert.equal(autoReturnStep(workflow, workflow.phases.verification), true);
  // A Story already running keeps what it started with.
  assert.equal(autoReturnStep({ ...workflow, resolution: { ...workflow.resolution, phaseResponsibility: { ownerStepChecks: 3 } } }, workflow.phases.verification), false);
  // A test step that may still change source files is unchanged: its approvers return it, or it repairs itself.
  assert.equal(autoReturnStep(workflow, testing({ writeScope: 'source-and-artifact' })), false);
  assert.equal(autoReturnStep(workflow, testing({ requiredArtifact: { kind: 'conformance-report' } })), false, 'a review step is not a test step');
  assert.equal(autoReturnStep(workflow, testing({ approvalPolicy: { mode: 'none' } })), false, 'nothing reviews a step nobody approves');
  assert.equal(autoReturnStep(workflow, code()), false, 'a code step repairs its own tests');
});

test('only failing tests count: a failed lint or a missing tool stays with the step\'s people', () => {
  assert.deepEqual(failingTestChecks(testing()).map((check) => check.id), ['value-check']);
  assert.equal(failingTestChecks(testing({ checks: [{ id: 'suite', source: 'repository-tests', status: 'failed' }] })).length, 1);
  assert.equal(failingTestChecks(testing({ checks: [{ id: 'lint', kind: 'lint', status: 'failed' }, { id: 'suite', kind: 'test', status: 'failed' }] })), null);
  assert.equal(failingTestChecks(testing({ checks: [{ id: 'suite', kind: 'test', status: 'failed' }, { id: 'e2e', kind: 'test', status: 'unavailable' }] })), null);
  assert.equal(failingTestChecks(testing({ checks: [{ id: 'suite', kind: 'test', status: 'passed' }] })), null);
  // A run a person accepted as a risk carries the step; it is not returned.
  assert.equal(failingTestChecks(testing({ checks: [{ id: 'suite', kind: 'test', status: 'failed', testRunRisk: { id: 'TRR-001' } }] })), null);
});

test('the code step is the one the test step cites, else the nearest approved code step it may return to', () => {
  const workflow = story();
  assert.equal(codeStepOf(workflow, workflow.phases.verification)?.id, 'implementation');
  const pinned = story({ resolution: { phases: [{ id: 'verification', testEvidenceFrom: 'implementation' }] } });
  assert.equal(codeStepOf(pinned, pinned.phases.verification)?.id, 'implementation');
  const unreachable = story({ steps: { verification: { approvalPolicy: { mode: 'required', rejectTo: ['verification'] } } } });
  assert.equal(codeStepOf(unreachable, unreachable.phases.verification), null, 'a step that may not return work there leaves it to people');
  const open = story({ steps: { implementation: { status: 'in_progress' } } });
  assert.equal(codeStepOf(open, open.phases.verification), null);
});

test('the review brake: 2 returns in a row unless the workflow says otherwise, then the person decides', () => {
  const keys = ['command:value-check'];
  const first = story();
  assert.equal(failingTestsHold(first, first.phases.verification, first.phases.implementation, keys), null, 'nothing returned yet');
  // One return before, for another test: the second in a row is still SFlow's.
  const once = story({ steps: { implementation: { generation: 2, versionOpening: { version: 2, consent: { settled: 'STL-001', surface: 'settled' } } } },
    settled: [start('STL-001', 2, { effect: { ...start('STL-001', 2).effect, tests: ['test:suite:another'] } })] });
  assert.equal(failingTestsHold(once, once.phases.verification, once.phases.implementation, keys), null);
  // The same test failed again after SFlow's fix: asked at once.
  const back = story({ steps: { implementation: { generation: 2, versionOpening: { version: 2, consent: { settled: 'STL-001', surface: 'settled' } } } },
    settled: [start('STL-001', 2)] });
  const repeated = failingTestsHold(back, back.phases.verification, back.phases.implementation, keys);
  assert.equal(repeated.reason, 'repeated');
  assert.match(repeated.words, /^The test command value-check failed again after SFlow's fix\.$/u);
  // Two in a row: the third is the person's.
  const twice = story({ steps: { implementation: { generation: 3, versionOpening: { version: 3, consent: { settled: 'STL-002', surface: 'settled' } } } },
    settled: [start('STL-001', 2, { effect: { ...start('STL-001', 2).effect, tests: ['test:a:one'] } }), start('STL-002', 3, { effect: { ...start('STL-002', 3).effect, tests: ['test:a:two'] } })] });
  const rounds = failingTestsHold(twice, twice.phases.verification, twice.phases.implementation, keys);
  assert.equal(rounds.reason, 'rounds');
  assert.match(rounds.words, /failed 3 times in a row/u);
  // A person's own start breaks the run, as a person's yes does for a review's findings.
  const yes = story({ steps: { implementation: { generation: 3, versionOpening: { version: 3, consent: { receiptId: 'VC-1', surface: 'terminal' } } } },
    settled: [start('STL-001', 2, { effect: { ...start('STL-001', 2).effect, tests: ['test:a:one'] } })] });
  assert.equal(failingTestsHold(yes, yes.phases.verification, yes.phases.implementation, keys), null);
  // The workflow's own number: 0 asks every time.
  const zero = story({ resolution: { sourceReview: { mode: 'enforce', autoFixVersions: 0 } } });
  assert.equal(failingTestsHold(zero, zero.phases.verification, zero.phases.implementation, keys).reason, 'setting');
  const byStep = story({ resolution: { sourceReview: { mode: 'enforce', autoFixVersions: 5, autoFixVersionsByStep: { implementation: 0 } } } });
  assert.equal(failingTestsHold(byStep, byStep.phases.verification, byStep.phases.implementation, keys).reason, 'setting', 'the code step\'s own number');
  // A Story that takes people's signatures, and an undo, keep the return a person's.
  const signed = story({ resolution: { presence: { required: true } } });
  assert.equal(failingTestsHold(signed, signed.phases.verification, signed.phases.implementation, keys).reason, 'signatures');
  const undone = story({ settled: [start('STL-001', 2), { id: 'STL-002', undoes: 'STL-001', actor: 'a person', at: '2026-11-21T00:00:01.000Z' }] });
  assert.equal(failingTestsHold(undone, undone.phases.verification, undone.phases.implementation, keys).reason, 'undone');
});

test('at the brake every choice is filled: nothing is typed, and the risk is offered only where SFlow\'s rules allow one', () => {
  const workflow = story();
  const facts = { keys: ['command:value-check'] };
  const choices = heldChoices(workflow, workflow.phases.verification, workflow.phases.implementation, facts);
  assert.deepEqual(choices.map((choice) => choice.id), ['another-version', 'dispute']);
  for (const choice of choices) {
    assert.doesNotMatch(choice.command, /<[A-Za-z-]+>/u, choice.command);
    assert.match(choice.command, /^singularity-flow reject verification --work-id D1-1 --fetch --to (?:implementation|verification) --reason "[^"]+"$/u);
  }
  assert.match(choices[0].command, /--to implementation --reason "The tests Verification version 1 ran failed: The test command value-check\. Fix them in Implementation's next version\."$/u);
  assert.match(choices[1].command, /--to verification /u, 'a dispute runs the tests again in the test step itself');
  const risky = heldChoices(workflow, workflow.phases.verification, workflow.phases.implementation, facts, { riskEligible: true });
  assert.deepEqual(risky.map((choice) => choice.id), ['another-version', 'accept-risk', 'dispute']);
  assert.equal(risky[1].command, 'singularity-flow decisions D1-1');
});

test('the test step runs again on its own once the code step\'s fixed version is approved', () => {
  const due = (overrides) => {
    const workflow = story({ steps: { implementation: { generation: 2 }, verification: { status: 'in_progress', generation: 1 } }, settled: [start('STL-001', 2)], ...overrides });
    workflow.changeRequests = [{ id: 'CR-001', sourcePhase: 'verification', sourceGeneration: 1, targetPhase: 'implementation', automatic: { kind: 'failing-tests' } }];
    return workflow;
  };
  const workflow = due();
  assert.equal(testsRerunDue(workflow, workflow.phases.verification)?.code.id, 'implementation');
  // Not before the fix is approved, not twice, and not once a person undid it.
  const unfixed = due({ steps: { implementation: { generation: 1 }, verification: { status: 'in_progress', generation: 1 } } });
  assert.equal(testsRerunDue(unfixed, unfixed.phases.verification), null);
  const opened = due();
  opened.phases.verification.versionOpening = { version: 2 };
  assert.equal(testsRerunDue(opened, opened.phases.verification), null);
  const undone = due({ settled: [start('STL-001', 2), { id: 'STL-002', undoes: 'STL-001', actor: 'a person', at: '2026-11-21T00:00:01.000Z' }] });
  assert.equal(testsRerunDue(undone, undone.phases.verification), null);
});

test('both starts are settled decisions with an undo that only makes SFlow ask first next time', () => {
  const workflow = story({ steps: { implementation: { status: 'in_progress', generation: 1, versionOpening: { version: 2 } } } });
  workflow.currentPhase = 'implementation';
  const entry = recordSettledDecision(workflow, { kind: 'failing-tests', by: 'sflow', phase: 'implementation', subject: 'implementation version 1: the failing tests of verification version 1',
    answer: 'Returned Verification version 1\'s failing tests to Implementation and started its version 2 to fix them', at: '2026-11-21T00:00:00.000Z',
    evidence: [{ what: 'a test failed', where: 'verification test run (value-check)' }], effect: { generation: 1, toGeneration: 2, testPhase: 'verification', testGeneration: 1 } });
  assert.equal(settledDecisions(workflow)[0].kind, 'failing-tests');
  assert.equal(settlementMatters(workflow, entry), true);
  assert.match(reraisedRoute(workflow, entry).words, /^From now on SFlow asks you before it returns verification's failing tests to implementation again\. An undo does not withdraw/u);
  assert.match(plainSettled(workflow, entry), /^SFlow started version 2 of Implementation to fix the tests Verification found failing, because Verification changes no code\. Undo only makes SFlow ask you first next time; version 2 stays open\.$/u);
  const rerun = { id: 'STL-009', kind: 'tests-rerun', by: 'sflow', phase: 'verification', effect: { generation: 1, toGeneration: 2, codePhase: 'implementation', codeGeneration: 2 } };
  assert.match(plainSettled(workflow, rerun), /^SFlow started version 2 of Verification to run its tests again because Implementation version 2 fixed them\./u);
  assert.match(reraisedRoute(workflow, rerun).words, /runs verification's tests again after a fix/u);
});

test('the opening settles only its own kinds and reasons; every other successor still needs the person\'s yes', () => {
  const proposal = (reason) => ({ reason });
  assert.equal(settledOpening({ kind: 'failing-tests', settlement: {} }, proposal('rework')), true);
  assert.equal(settledOpening({ kind: 'tests-rerun', settlement: {} }, proposal('rework')), true);
  assert.equal(settledOpening({ kind: 'review-corrections', settlement: {} }, proposal('review-corrections')), true);
  assert.equal(settledOpening({ kind: 'review-corrections', settlement: {} }, proposal('rework')), false);
  assert.equal(settledOpening({ kind: 'failing-tests', settlement: {} }, proposal('requested-change')), false);
  assert.equal(settledOpening({ kind: 'failing-tests' }, proposal('rework')), false, 'no settlement, no opening');
  assert.equal(settledOpening(null, proposal('rework')), false);
});
