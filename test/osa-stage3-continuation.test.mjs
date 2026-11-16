/**
 * SPEC-OSA v1.1 Stage 3 (plan section 5): durable continuation. A step's task keeps where a check stopped it, every view
 * names that one continuation, a repair runs only within its budget, and a run of decisions that makes no progress is
 * told apart from observing a running task, a declared wait and an idempotent acknowledgement [OSA:REQ-012, REQ-020,
 * REQ-051, AC-012]. Expected results are written out here, never computed by the code under test.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { noProgress, OPERATIONS, REASON_CODES, stepState, TASK_OUTCOMES } from '../src/kernel/step-state.mjs';
import { decisionRoutes, stepDecisionOf, stepSnapshotOf } from '../src/step-decision.mjs';
import { lifecycleMark, outcomeCode, refusalOutcome, taskOutcomeOf } from '../src/workflow-task-outcome.mjs';
import { workflowGuide } from '../src/guide.mjs';
import { workflowNextSteps } from '../src/nextsteps.mjs';
import { submissionReadinessSnapshot } from '../src/submission-readiness.mjs';
import { workflowTaskResume } from '../src/workflow-task.mjs';
import { lifecycleEvent } from '../src/lifecycle-event.mjs';
import { GitPublicationUnitOfWork } from '../src/publication-unit-of-work.mjs';

/** A quick fix at its code step, version 1 open through the opening operation's pointer, as Stage 2 opens it. */
function codeStory() {
  return { schemaVersion: 13, workItem: { id: 'S3-1', createdAt: '2026-11-17T08:00:00.000Z' }, status: 'in_progress', currentPhase: 'implement',
    phaseOrder: ['intake', 'implement', 'verify'], history: [{ at: '2026-11-17T08:00:00.000Z', event: 'phase_approved', phase: 'intake' }],
    phases: {
      intake: { id: 'intake', status: 'approved', generation: 1, generationPolicy: { requirement: 'required', task: 'document' } },
      implement: { id: 'implement', label: 'Implement', status: 'in_progress', generation: 0, writeScope: 'source-and-artifact',
        generationPolicy: { requirement: 'required', task: 'code', defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'] },
        requiredArtifact: { path: 'artifacts/implement/implementation-summary.md' }, repairBudget: { maxAttempts: 2 },
        generationIntent: { id: 'GI-1', status: 'open', generation: 1 } },
      verify: { id: 'verify', status: 'pending', generation: 0, generationPolicy: { requirement: 'required', task: 'document' } }
    }, resolution: {} };
}

/** A task record as workflow-task-store.mjs keeps it, with the fields the outcome reads. */
const record = (workflow, outcome, { used = 0, budget = 2, code = 'CODE_TEST_FAILED', mark = null } = {}) => ({
  id: `WT-${'a'.repeat(64)}`, state: 'blocked', repairConsumed: used, maximumContinuations: budget,
  blockedCode: mark ? `${outcome}:${code}:${mark}` : outcomeCode(outcome, code, workflow) });

test('a task outcome is the kernel\'s wait with its exact continuation; a repair runs only within its budget [§8, OSA:REQ-012]', () => {
  assert.deepEqual([...TASK_OUTCOMES], ['running', 'waiting-input', 'waiting-environment', 'waiting-person', 'repair-required']);
  for (const code of ['TASK_RUNNING', 'TASK_WAITING_INPUT', 'TASK_WAITING_ENVIRONMENT', 'TASK_WAITING_PERSON', 'TASK_REPAIR_REQUIRED', 'TASK_REPAIR_EXHAUSTED']) {
    assert.ok(REASON_CODES.includes(code), code);
  }
  for (const operation of ['repair-version', 'provide-input']) assert.ok(OPERATIONS.includes(operation), operation);
  const workflow = codeStory();
  const phase = workflow.phases.implement;
  const decide = (outcome, options) => stepDecisionOf(workflow, phase, { task: taskOutcomeOf(record(workflow, outcome, options), workflow) });
  // Written out, not derived: state, who acts, the operation, its inputs and the route a person reads.
  const expected = {
    running: ['waiting', 'observe', 'inspect', { task: 'execution' }, 'singularity-flow session current --for-agent --json'],
    'waiting-input': ['waiting', 'person-decision', 'provide-input', { code: 'CODE_TEST_FAILED' }, 'singularity-flow documents readiness --phase implement --work-id S3-1 --json'],
    'waiting-environment': ['waiting', 'person-decision', 'decide', { decision: 'task-outcome', outcome: 'waiting-environment', code: 'CODE_TEST_FAILED' }, 'singularity-flow decisions S3-1'],
    'waiting-person': ['waiting', 'person-decision', 'decide', { decision: 'task-outcome', outcome: 'waiting-person', code: 'CODE_TEST_FAILED' }, 'singularity-flow decisions S3-1'],
    'repair-required': ['waiting', 'agent-work', 'repair-version', { code: 'CODE_TEST_FAILED', attempt: 2, budget: 2 }, 'singularity-flow prepare implement']
  };
  for (const [outcome, [state, kind, operation, inputs, command]] of Object.entries(expected)) {
    const decision = decide(outcome, { used: 1 });
    assert.deepEqual([decision.state, decision.next.kind, decision.next.operation, decision.next.inputs], [state, kind, operation, inputs], outcome);
    assert.equal(decision.task.status, outcome);
    assert.equal(decision.task.continuation, decision.next.actionId);
    assert.equal(decisionRoutes(decision, workflow, phase)[0].command, command, outcome);
    // The kernel never returns a shell string, skill or prompt [AC-009].
    assert.doesNotMatch(JSON.stringify(decision), /singularity-flow|\/sf-/u, outcome);
  }
  // A running execution keeps the version's edits; a wait grants none.
  assert.equal(stepState(stepSnapshotOf({ workflow, phase, task: taskOutcomeOf(record(workflow, 'running'), workflow) })).edit.eligible, true);
  assert.equal(stepState(stepSnapshotOf({ workflow, phase, task: taskOutcomeOf(record(workflow, 'waiting-person'), workflow) })).edit.eligible, false);
  // The budget spent, the same repair is never offered again: a person decides, the evidence of each attempt kept.
  const exhausted = decide('repair-required', { used: 2, budget: 2 });
  assert.deepEqual([exhausted.next.operation, exhausted.next.inputs], ['decide', { decision: 'task-outcome', outcome: 'repair-exhausted', code: 'CODE_TEST_FAILED', attempts: 2 }]);
  assert.ok(exhausted.next.reasonCodes.includes('TASK_REPAIR_EXHAUSTED'));
});

test('an outcome is kept only while the Story stands where it stopped: any lifecycle event since makes the kernel decide again', () => {
  const workflow = codeStory();
  const kept = record(workflow, 'waiting-person');
  assert.match(kept.blockedCode, /^waiting-person:CODE_TEST_FAILED:[a-f0-9]{12}$/u);
  assert.equal(taskOutcomeOf(kept, workflow).outcome, 'waiting-person');
  // The person's decision on the card is a lifecycle event: the wait it answered is no longer read.
  const after = structuredClone(workflow);
  after.history.push({ at: '2026-11-17T09:00:00.000Z', event: 'decision_recorded', phase: 'implement' });
  assert.notEqual(lifecycleMark(after), lifecycleMark(workflow));
  assert.equal(taskOutcomeOf(kept, after), null);
  assert.equal(stepDecisionOf(after, after.phases.implement, { task: taskOutcomeOf(kept, after) }).next.operation, 'author-version');
  // An ordinary blocked task, an older build's code, or a code that is not an outcome is no outcome.
  for (const blockedCode of [null, 'OWNER_REVIEW_REQUIRED', 'waiting-person:CODE_TEST_FAILED', `flying:CODE:${lifecycleMark(workflow)}`]) {
    assert.equal(taskOutcomeOf({ ...kept, blockedCode }, workflow), null, String(blockedCode));
  }
  assert.equal(taskOutcomeOf({ ...kept, state: 'repair-draft' }, workflow), null);
  assert.equal(outcomeCode('waiting-person', 'has spaces', workflow), null);
});

test('a failed required test stops at its own boundary: a Node to pin is a person\'s, the environment\'s is theirs, the rest is repaired', () => {
  assert.equal(refusalOutcome({ code: 'CODE_TEST_FAILED', details: { nodePin: { version: '22' } } }), 'waiting-person');
  assert.equal(refusalOutcome({ code: 'CODE_TEST_FAILED', details: { testRunRisk: { eligible: true } } }), 'waiting-environment');
  assert.equal(refusalOutcome({ code: 'CODE_TEST_FAILED', details: {} }), 'repair-required');
  assert.equal(refusalOutcome({ code: 'GENERATION_INTENT_REQUIRED', details: {} }), null, 'only a check that stops the version is kept');
});

test('every view names the task\'s wait at one basis: next steps, the guide, readiness and the session [OSA:REQ-020, AC-002]', () => {
  const workflow = codeStory();
  const phase = workflow.phases.implement;
  const taskOutcome = taskOutcomeOf(record(workflow, 'waiting-person'), workflow);
  const card = 'singularity-flow decisions S3-1';
  assert.equal(workflowGuide(workflow, { taskOutcome }).nextActions[0].command, card);
  assert.equal(workflowNextSteps(workflow, { taskOutcome, pendingDecisions: null }).find((entry) => entry.timing === 'now').command, card);
  const readiness = submissionReadinessSnapshot(workflow, { taskOutcome });
  assert.deepEqual([readiness.classification, readiness.command, readiness.nextSkill], ['task-waiting', card, '/sf-decide']);
  const resume = workflowTaskResume(workflow, phase, { record: null, progress: null });
  assert.notEqual(resume?.nextAction?.command, card, 'with no record kept, the session has no wait to name');
  // Without the outcome, each names writing the open version, as before.
  assert.equal(workflowGuide(workflow).nextActions[0].command, 'singularity-flow prepare implement');
  assert.equal(submissionReadinessSnapshot(workflow).classification, 'generation-required');
});

test('no progress is told apart from observing, a declared wait and an idempotent acknowledgement [OSA:AC-012]', () => {
  const workflow = codeStory();
  const phase = workflow.phases.implement;
  const writing = stepDecisionOf(workflow, phase);
  const running = stepDecisionOf(workflow, phase, { task: taskOutcomeOf(record(workflow, 'running'), workflow) });
  const waiting = stepDecisionOf(workflow, phase, { task: taskOutcomeOf(record(workflow, 'waiting-person'), workflow) });
  assert.deepEqual(noProgress([{ decision: writing, basisKey: 'b1' }, { decision: writing, basisKey: 'b2' }]), { loop: false }, 'the basis moved: progress');
  assert.deepEqual(noProgress([{ decision: writing, basisKey: 'b1' }, { decision: writing, basisKey: 'b1' }]),
    { loop: true, first: 0, repeated: 1, actionId: 'author-version:implement@1' }, 'the same action on an unchanged basis');
  assert.deepEqual(noProgress([{ decision: running, basisKey: 'b1' }, { decision: running, basisKey: 'b1' }, { decision: running, basisKey: 'b1' }]), { loop: false },
    'observing a running task is its progress');
  assert.deepEqual(noProgress([{ decision: waiting, basisKey: 'b1' }, { decision: waiting, basisKey: 'b1' }]), { loop: false }, 'a declared wait');
  assert.deepEqual(noProgress([{ decision: writing, basisKey: 'b1', acknowledgement: true }, { decision: writing, basisKey: 'b1', acknowledgement: true }]),
    { loop: false }, 'an idempotent acknowledgement');
});

test('with no remote to publish to, publication says so plainly, with its way on, and changes nothing [Stage 2 finding 13]', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-osa-s3-remote-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args) => assert.equal(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status, 0, args.join(' '));
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Stage Three']); git(['config', 'user.email', 'stage3@example.invalid']);
  await writeFile(path.join(root, 'README.md'), '# no remote\n');
  git(['add', '.']); git(['commit', '-qm', 'start']);
  const subject = { kind: 'story', id: 'S3-REMOTE', branch: 'main' };
  await assert.rejects(() => new GitPublicationUnitOfWork(root).execute({
    subject,
    event: lifecycleEvent({ type: 'artifact-generated', subject, phaseId: 'intake', generation: 1 }),
    commit: { message: '[S3-REMOTE] publish' },
    publication: { mode: 'required', branch: 'main', remote: 'origin', authority: Object.freeze({ remote: 'origin', direction: 'push', url: null, fingerprint: null }) },
    allowedPaths: ['story-state.json'],
    state: { write: () => writeFile(path.join(root, 'story-state.json'), '{}\n') }
  }), (error) => {
    assert.equal(error.code, 'PUBLICATION_REMOTE_AUTHORITY_MISSING');
    assert.match(error.message, /has no remote of that name to publish to\. Nothing was changed\./u);
    assert.doesNotMatch(error.message, /changed after its exact push authority/u);
    assert.equal(error.details.nextAction.command, 'git remote add origin <url>');
    return true;
  });
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout, '', 'nothing was written');
});

test('liveness, authorization and acceptance stay apart: a running task renews none of them [OSA:REQ-051, AC-021]', () => {
  const workflow = codeStory();
  const phase = workflow.phases.implement;
  const running = taskOutcomeOf(record(workflow, 'running'), workflow);
  // A heartbeat keeps the execution observed; a revoked permission still stops the step first.
  const revoked = stepState(stepSnapshotOf({ workflow, phase, task: running, revoked: true }));
  assert.deepEqual([revoked.state, revoked.next.operation, revoked.edit.eligible], ['held', 'refresh-authority', false]);
  assert.ok(revoked.next.reasonCodes.includes('PERMISSION_REVOKED'));
  // An opening whose shared acceptance is not confirmed grants nothing, however live its execution.
  const operated = structuredClone(workflow);
  operated.phases.implement.versionOpening = { operationId: `vo-${'b'.repeat(32)}`, version: 1, highWatermark: 1, writer: { fence: 1 } };
  const pending = stepState(stepSnapshotOf({ workflow: operated, phase: operated.phases.implement, task: running,
    opening: { acceptance: 'pending', writer: 'current' } }));
  assert.deepEqual([pending.state, pending.next.operation, pending.edit.eligible], ['waiting', 'recover-operation', false]);
  assert.ok(pending.next.reasonCodes.includes('OPENING_PENDING'));
  // Another checkout's writer fence holds whatever this one runs.
  const fenced = stepState(stepSnapshotOf({ workflow: operated, phase: operated.phases.implement, task: running,
    opening: { acceptance: 'confirmed', writer: 'other' } }));
  assert.deepEqual([fenced.next.operation, fenced.edit.eligible], ['takeover-writer', false]);
  // A running task on an accepted opening is observed, and keeps the version's writes; the turn's own window is the guard's.
  const live = stepState(stepSnapshotOf({ workflow: operated, phase: operated.phases.implement, task: running,
    opening: { acceptance: 'confirmed', writer: 'current' } }));
  assert.deepEqual([live.state, live.next.operation, live.edit.eligible], ['waiting', 'inspect', true]);
});
