/**
 * A step name typed by mistake is a usage mistake, not a step to repair. Each refusal for a step the Story does
 * not have names the steps it has and the same command with one of them (a decision on a risk goes to the
 * decision list instead), and never `recover --phase <it>` or `phase show <it>`, which could only fail, nor
 * generic command help. One test per place SFlow refuses such a step; most run the real command on one Story.
 */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import test from 'node:test';

import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';

// One quick-fix Story at its implement step (intake approved), shared: every command here is refused, so none changes it.
const cleanups = [];
after(() => Promise.all(cleanups.map((cleanup) => cleanup())));
let built = null;
const story = () => (built ??= (async () => {
  const repo = await repository({ after: (cleanup) => cleanups.push(cleanup) }, { implementCommands: false });
  await startQuickFix(repo);
  return repo;
})());

const STEPS = 'Its steps: intake, implement, verify.';
const WALKS_INTO_THE_UNKNOWN = /singularity-flow (?:recover\b.*--phase (?:bogus|implemnt)\b|phase show (?:bogus|implemnt)\b|help\b)/u;

/** The real command's refusal, as JSON. */
async function refusal(...args) {
  const { sflowJson } = await story();
  const result = sflowJson(...args);
  assert.notEqual(result.status, 0, `${args.join(' ')} should be refused\n${JSON.stringify(result.value, null, 2)}`);
  assert.equal(result.value.resultType, 'sflow-refusal-plan', JSON.stringify(result.value, null, 2));
  return result.value;
}

/** What every such plan holds: the steps named, the way through first, and nothing that walks into the missing step. */
function assertNamesTheSteps(plan, { code, first, requested = 'bogus', steps = STEPS, also = [] }) {
  const commands = plan.steps.map((entry) => entry.command).filter(Boolean);
  const context = JSON.stringify(plan, null, 2);
  assert.equal(plan.code, code, context);
  assert.equal(plan.context, undefined, `no phase scope for a step that does not exist\n${context}`);
  assert.deepEqual(commands.filter((command) => WALKS_INTO_THE_UNKNOWN.test(command)), [], context);
  assert.ok(plan.steps.every((entry) => !entry.commandRejected), context);
  assert.equal(commands[0], first, context);
  for (const command of also) assert.ok(commands.includes(command), `${command}\n${context}`);
  assert.ok(plan.steps.some((entry) => entry.label.includes(steps)), `the plan names the Story's steps\n${context}`);
  assert.ok(plan.steps.some((entry) => entry.label.includes(`'${requested}'`)), context);
  assert.match(plan.retry.label, /Nothing was changed\. Name a step/u, context);
}

function assertEnvelope(envelope, expected) {
  assert.equal(envelope.error.code, expected.code, JSON.stringify(envelope, null, 2));
  assert.equal(envelope.error.details?.unknownStep?.requested, expected.requested ?? 'bogus', JSON.stringify(envelope.error, null, 2));
  assertNamesTheSteps(envelope.remediationPlan, expected);
}

test('tests run with a step the Story does not have: the same run on its code step (local-test-runs.mjs)', async () => {
  const envelope = await refusal('tests', 'run', '--work-id', 'QF-1', '--phase', 'bogus');
  assertEnvelope(envelope, { code: 'TESTS_PHASE_UNKNOWN', first: 'singularity-flow tests run --work-id QF-1 --phase implement --json' });
  assert.match(envelope.remediationPlan.steps[0].label, /This command takes the code steps, which run tests: implement\./u);
  assert.deepEqual(envelope.error.details.unknownStep.allowed, ['implement']);
});

test('tests summary with a step the Story does not have: the same summary of the current step (commands/tests.mjs)', async () => {
  assertEnvelope(await refusal('tests', 'summary', '--work-id', 'QF-1', '--phase', 'bogus'),
    { code: 'TESTS_PHASE_UNKNOWN', first: 'singularity-flow tests summary --work-id QF-1 --phase implement --json' });
});

test('decision evidence-reuse with a step not on the route: the same decision for a step on it, or the decision list (commands/decision-evidence-reuse.mjs)', async () => {
  assertEnvelope(await refusal('decision', 'evidence-reuse', 'QF-1', '--phase', 'bogus', '--from-attempt', 'TA-00000000000000000001',
    '--reason', 'The earlier step ran the same tests on this code.'), {
    code: 'EVIDENCE_REUSE_INVALID',
    first: "singularity-flow decision evidence-reuse QF-1 --phase implement --from-attempt TA-00000000000000000001 --reason 'The earlier step ran the same tests on this code.' --json",
    also: ['singularity-flow decisions QF-1']
  });
});

test('the attempt check for a step the Story does not have names the steps on its route (evidence-reuse.mjs)', async () => {
  const { verifyReusableAttempt } = await import('../src/evidence-reuse.mjs');
  const workflow = { workItem: { id: 'QF-1' }, currentPhase: 'implement', phaseOrder: ['intake', 'implement', 'verify'],
    phases: { intake: { status: 'approved' }, implement: { status: 'in_progress' }, verify: { status: 'skipped' } } };
  const error = await verifyReusableAttempt('/nowhere', {}, workflow, { phaseId: 'bogus', attemptId: 'TA-00000000000000000001' }).catch((caught) => caught);
  assert.equal(error.code, 'EVIDENCE_REUSE_INVALID');
  const plan = refusalRemediationPlan(error, ['decision', 'evidence-reuse', 'QF-1', '--phase', 'bogus', '--from-attempt', 'TA-00000000000000000001', '--reason', 'Same run.']);
  assertNamesTheSteps(plan, { code: 'EVIDENCE_REUSE_INVALID',
    first: "singularity-flow decision evidence-reuse QF-1 --phase implement --from-attempt TA-00000000000000000001 --reason 'Same run.'",
    also: ['singularity-flow decisions QF-1'] });
  assert.match(plan.steps[0].label, /This command takes the steps on its route: intake, implement\./u, 'a skipped step is not offered');
});

test('decision finding-risk with a step the Story does not have: the decision list, which names each risk with its step (commands/decision-finding-risk.mjs)', async () => {
  const envelope = await refusal('decision', 'finding-risk', 'QF-1', '--phase', 'bogus', '--finding', 'F-001',
    '--reason', 'Accepted while the scanner is fixed.', '--expires', '2026-12-30');
  assertEnvelope(envelope, { code: 'FINDING_RISK_INVALID', first: 'singularity-flow decisions QF-1' });
  assert.equal(envelope.remediationPlan.steps[0].skill, '/sf-decide');
  assert.ok(envelope.remediationPlan.steps.every((entry) => !entry.command?.includes('finding-risk')), 'a risk is never guessed onto another step');
});

test('decision test-risk with a step the Story does not have: the decision list, which names each risk with its step (commands/decision-test-risk.mjs)', async () => {
  const envelope = await refusal('decision', 'test-risk', 'QF-1', '--phase', 'bogus', '--cause', 'No database here.',
    '--reason', 'CI runs them with a database.', '--expires', '2026-12-30');
  assertEnvelope(envelope, { code: 'TEST_RUN_RISK_INVALID', first: 'singularity-flow decisions QF-1' });
  assert.ok(envelope.remediationPlan.steps.every((entry) => !entry.command?.includes('test-risk')), 'a risk is never guessed onto another step');
});

test('documents readiness with a step the Story does not have: the same readiness of the current step (cli.mjs)', async () => {
  assertEnvelope(await refusal('documents', 'readiness', '--work-id', 'QF-1', '--phase', 'bogus'),
    { code: 'DOCUMENT_PHASES_INVALID', first: 'singularity-flow documents readiness --work-id QF-1 --phase implement --json' });
});

test('documents list with a misspelt step: the same list for the step it is nearest (cli.mjs)', async () => {
  assertEnvelope(await refusal('documents', 'list', 'QF-1', '--phase', 'implemnt'),
    { code: 'DOCUMENT_PHASES_INVALID', requested: 'implemnt', first: 'singularity-flow documents list QF-1 --phase implement --json' });
});

test('a --phases list with a step the Story does not have: the same list without it (document-identity.mjs)', async () => {
  const { normalizeDocumentPhases } = await import('../src/document-identity.mjs');
  const workflow = { workItem: { id: 'QF-1' }, currentPhase: 'implement', phaseOrder: ['intake', 'implement', 'verify'] };
  const error = (() => { try { normalizeDocumentPhases('intake,bogus,nope', workflow); } catch (caught) { return caught; } return null; })();
  assert.equal(error?.code, 'DOCUMENT_PHASES_INVALID');
  const argv = ['documents', 'scope', 'DOC-001', '--phases', 'intake,bogus,nope', '--reason', 'Only intake reads it.'];
  assertNamesTheSteps(refusalRemediationPlan(error, argv), { code: 'DOCUMENT_PHASES_INVALID',
    first: "singularity-flow documents scope DOC-001 --phases intake --reason 'Only intake reads it.'" });
  const none = (() => { try { normalizeDocumentPhases('bogus', workflow); } catch (caught) { return caught; } return null; })();
  assertNamesTheSteps(refusalRemediationPlan(none, ['documents', 'scope', 'DOC-001', '--phases', 'bogus', '--reason', 'Wrong step.']),
    { code: 'DOCUMENT_PHASES_INVALID', first: "singularity-flow documents scope DOC-001 --phases implement --reason 'Wrong step.'" });
});

test('comprehension with a step the Story does not have: the same read of the current step (comprehension/context.mjs)', async () => {
  assertEnvelope(await refusal('comprehension', 'regions', '--work-id', 'QF-1', '--phase', 'bogus'),
    { code: 'CMP_PHASE_UNKNOWN', first: 'singularity-flow comprehension regions --work-id QF-1 --phase implement --json' });
});

test('an impact exposure for a step the Story does not have is refused before any record, with its steps (cli.mjs impact exposure)', async () => {
  assertEnvelope(await refusal('impact', 'exposure', 'attest', 'QF-1', '--phase', 'bogus', '--level', 'none', '--assurance', 'self-reported'), {
    code: 'IMPACT_EXPOSURE_PHASE_UNKNOWN',
    first: 'singularity-flow impact exposure attest QF-1 --phase implement --level none --assurance self-reported --json'
  });
});

test('spec dependencies of a step the Story does not have: the same read of the current step (commands/spec-dependencies.mjs)', async () => {
  assertEnvelope(await refusal('spec', 'dependencies', 'bogus', '--work-id', 'QF-1'),
    { code: 'SPEC_DEPENDENCIES_STEP_UNKNOWN', first: 'singularity-flow spec dependencies implement --work-id QF-1 --json' });
});

test('decision test-narrowing with a step the Story does not have: the same decision for the current step, or the decision list (commands/decision-test-narrowing.mjs)', async () => {
  assertEnvelope(await refusal('decision', 'test-narrowing', 'QF-1', '--phase', 'bogus', '--reason', 'Only the payment tests changed.'), {
    code: 'TEST_NARROWING_INVALID',
    first: "singularity-flow decision test-narrowing QF-1 --phase implement --reason 'Only the payment tests changed.' --json",
    also: ['singularity-flow decisions QF-1']
  });
});

test('decision test-command with a step the Story does not have: the same request for its code step (commands/decision-test-command.mjs)', async () => {
  assertEnvelope(await refusal('decision', 'test-command', 'QF-1', '--phase', 'bogus', '--use', 'node-tests', '--reason', 'The package has its own test script.'), {
    code: 'TEST_COMMAND_DECISION_INVALID',
    first: "singularity-flow decision test-command QF-1 --phase implement --use node-tests --reason 'The package has its own test script.' --json",
    also: ['singularity-flow decisions QF-1']
  });
});

test('a Story-only test command request for a step the Story does not have names its steps (story-test-commands.mjs)', async () => {
  const { recordStoryTestCommandRequest } = await import('../src/story-test-commands.mjs');
  const workflow = { workItem: { id: 'QF-1' }, currentPhase: 'implement', phaseOrder: ['intake', 'implement', 'verify'],
    phases: { intake: { status: 'approved' }, implement: { status: 'in_progress' }, verify: { status: 'not_started' } } };
  const error = (() => { try { recordStoryTestCommandRequest(workflow, { phaseId: 'bogus', command: { id: 'node-tests', kind: 'test' }, reason: 'x', actor: 'a', at: 'b' }); }
  catch (caught) { return caught; } return null; })();
  assert.equal(error?.code, 'TEST_COMMAND_DECISION_INVALID');
  assertNamesTheSteps(refusalRemediationPlan(error, ['decision', 'test-command', 'QF-1', '--phase', 'bogus', '--use', 'node-tests', '--reason', 'Own script.']), {
    code: 'TEST_COMMAND_DECISION_INVALID',
    first: "singularity-flow decision test-command QF-1 --phase implement --use node-tests --reason 'Own script.'",
    also: ['singularity-flow decisions QF-1']
  });
});

test('inputs restore for a step the Story does not have: the same restore for the current step (commands/input-restore.mjs)', async () => {
  assertEnvelope(await refusal('inputs', 'restore', 'bogus'),
    { code: 'INPUT_RESTORE_PHASE_UNKNOWN', first: 'singularity-flow inputs restore implement --json' });
});

test('an upstream issue about a step the Story does not have: the same issue about an earlier step that ran (upstream-issues.mjs)', async () => {
  const envelope = await refusal('upstream-issue', 'raise', '--work-id', 'QF-1', '--phase', 'bogus', '--about', 'QF-1:AC-001',
    '--problem', 'The criterion names no observable result.');
  assertEnvelope(envelope, { code: 'UPSTREAM_ISSUE_INVALID',
    first: "singularity-flow upstream-issue raise --work-id QF-1 --phase intake --about QF-1:AC-001 --problem 'The criterion names no observable result.' --json" });
  assert.match(envelope.remediationPlan.steps[0].label, /This command takes the earlier steps that have run: intake\./u);
});

test('a review of a step the Story does not have says so, not that the workflow has no steps (review.mjs)', async () => {
  const envelope = await refusal('review', 'bogus');
  assert.match(envelope.error.message, /Story QF-1 has no step 'bogus'/u);
  assertEnvelope(envelope, { code: 'REVIEW_PHASE_UNKNOWN', first: 'singularity-flow review implement --json' });
});

test('an assignment to a step the Story does not have is refused before any record, with its steps (cli.mjs assign)', async () => {
  assertEnvelope(await refusal('assign', 'bogus', 'reviewer@example.test'),
    { code: 'ASSIGN_PHASE_UNKNOWN', first: 'singularity-flow assign implement reviewer@example.test --json' });
});

// The step verbs an agent types most. Each answered `recover --phase bogus` and `phase show bogus`, and the same
// refusal three times over was taken for a finding that keeps returning, escalated to explain findings.
test('submit of a step the Story does not have: the same submit of the current step (commands/submit.mjs)', async () => {
  assertEnvelope(await refusal('submit', 'bogus'), { code: 'PHASE_UNKNOWN', first: 'singularity-flow submit implement --json' });
});

test('prepare of a step the Story does not have: the same prepare of the current step (commands/prepare.mjs)', async () => {
  assertEnvelope(await refusal('prepare', 'bogus'), { code: 'PHASE_UNKNOWN', first: 'singularity-flow prepare implement --json' });
});

test('each phase verb on a step the Story does not have: the same verb on the current step, never escalated as a repeated finding (commands/phase-lifecycle.mjs)', async () => {
  for (const [args, first] of [
    [['phase', 'rollover', 'bogus'], 'singularity-flow phase rollover implement --json'],
    [['phase', 'begin', 'bogus'], 'singularity-flow phase begin implement --json'],
    [['phase', 'prepublish', 'bogus', '--for-agent'], 'singularity-flow phase prepublish implement --for-agent --json'],
    [['phase', 'draft-check', 'bogus'], 'singularity-flow phase draft-check implement --json'],
    [['phase', 'publish', 'bogus', '--authored', 'human', '--channel', 'manual-in-place'],
      'singularity-flow phase publish implement --authored human --channel manual-in-place --json']
  ]) {
    const envelope = await refusal(...args);
    assertEnvelope(envelope, { code: 'PHASE_UNKNOWN', first });
    assert.ok(envelope.remediationPlan.steps.every((entry) => !entry.command?.includes('explain findings')), JSON.stringify(envelope.remediationPlan, null, 2));
  }
});

test('phase show of a step the Story does not have: the same read of the current step (commands/phase-show.mjs)', async () => {
  assertEnvelope(await refusal('phase', 'show', 'bogus'), { code: 'PHASE_UNKNOWN', first: 'singularity-flow phase show implement --json' });
});

test('clarification status of a step the Story does not have: the same read of the current step (cli.mjs clarification)', async () => {
  assertEnvelope(await refusal('clarification', 'status', 'bogus'), { code: 'PHASE_UNKNOWN', first: 'singularity-flow clarification status implement --json' });
});

test('approve or reject of a step the Story does not have: the same decision on the current step (story-decision-context.mjs)', async () => {
  assertEnvelope(await refusal('approve', 'bogus', '--yes'), { code: 'PHASE_UNKNOWN', first: 'singularity-flow approve implement --yes --json' });
  assertEnvelope(await refusal('reject', 'bogus', '--reason', 'The tests do not cover the rounding.'),
    { code: 'PHASE_UNKNOWN', first: "singularity-flow reject implement --reason 'The tests do not cover the rounding.' --json" });
});

test('the decision list for a misspelt step: the same list for the step it is nearest, not the Story\'s next action (decision-list-facts.mjs)', async () => {
  const envelope = await refusal('decisions', 'QF-1', '--phase', 'implemnt');
  assertEnvelope(envelope, { code: 'DECISIONS_PHASE_UNKNOWN', requested: 'implemnt', first: 'singularity-flow decisions QF-1 --phase implement --json' });
});

test('recover of a step the Story does not have: the same recovery of the current step (collaboration.mjs)', async () => {
  assertEnvelope(await refusal('recover', 'QF-1', '--phase', 'bogus'), { code: 'RECOVERY_PHASE_UNKNOWN', first: 'singularity-flow recover QF-1 --phase implement --json' });
});
