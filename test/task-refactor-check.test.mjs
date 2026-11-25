/**
 * Intent to work, refactoring (docs/SPEC-ITW-INTENT-TO-WORK-v1.1.md REQ-015, A13): a refactor's test step compares its run
 * with the run before the change that `task.before` kept. A check that passed before and fails after is a behaviour change:
 * the step stops and names it, and the person keeps the old behaviour (back to the code) or accepts the new one (back to
 * the plan, and the task becomes a change); a check that already failed before stays a finding.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { afterCheckOf, checkNames, refactorHold } from '../src/failing-tests-return.mjs';
import { assertTaskChangeScope, stableTaskStepState, taskChangeDigest, taskChangePolicyDigest } from '../src/task-change-contracts.mjs';
import { journeyRepository, storyRecord } from './helpers/route-follower.mjs';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const ITEM = 'singularity/work-items/TASK-1';
const json = (text) => JSON.parse(text);

test('ITW REQ-015: a test that passed before and fails after is a behaviour change; one that failed before too stays a finding', () => {
  const facts = new Map([
    ['unit', { status: 'checked', verdict: 'partly-on-base', onlyHere: ['orders errors by code'], alsoOnBase: ['flaky clock'] }],
    ['api', { status: 'checked', verdict: 'passes-on-base', onlyHere: [], alsoOnBase: [] }],
    ['e2e', { status: 'checked', verdict: 'fails-on-base', onlyHere: [], alsoOnBase: [] }],
    ['lint-tests', { status: 'unknown', stale: true }],
    ['other-node', { status: 'checked', verdict: 'other-node', onlyHere: ['x'], alsoOnBase: [] }]
  ]);
  const check = afterCheckOf(['unit', 'api', 'e2e', 'lint-tests', 'other-node', 'missing'], facts);
  assert.deepEqual(check.changed, [{ command: 'unit', tests: ['orders errors by code'] }, { command: 'api', tests: [] }]);
  assert.deepEqual(check.before, [{ command: 'unit', tests: ['flaky clock'] }, { command: 'e2e', tests: [] }]);
  assert.deepEqual(check.unknown, ['lint-tests', 'other-node', 'missing'], 'no run before the change kept, or one on another Node, cannot be told');
  assert.deepEqual(checkNames(check.changed), ['\'orders errors by code\'', 'the test command api']);
});

function refactorStory() {
  const steps = [{ id: 'intake', intent: 'intake', label: 'Intake' }, { id: 'implementation-spec', intent: 'plan', label: 'Plan: what must not change' },
    { id: 'implementation', intent: 'code', label: 'Code' }, { id: 'verification', intent: 'test', label: 'Tests' }];
  const workflow = { workItem: { id: 'TASK-7' }, currentPhase: 'verification', phaseOrder: steps.map((step) => step.id),
    phases: Object.fromEntries(steps.map((step) => [step.id, { id: step.id, label: step.label, status: step.id === 'verification' ? 'awaiting_approval' : 'approved', generation: 1 }])),
    resolution: { composition: { kind: 'refactor', steps } } };
  workflow.phases.verification.approvalPolicy = { rejectTo: steps.map((step) => step.id) };
  const dispute = { id: 'dispute', label: 'Dispute it: run Tests\'s tests again', command: 'singularity-flow reject verification --to verification', skill: '/sf-approve' };
  return { workflow, test: workflow.phases.verification, code: workflow.phases.implementation, choices: [{ id: 'another-version', label: 'x', command: 'y' }, dispute] };
}

test('ITW REQ-015, A13: a behaviour change stops the test step, names it, and gives the person two filled choices', () => {
  const { workflow, test: step, code, choices } = refactorStory();
  const held = refactorHold(workflow, step, code, { changed: [{ command: 'unit', tests: ['errors come in code order'] }], before: [], unknown: [] }, choices);
  assert.equal(held.reason, 'behaviour-change');
  assert.match(held.words, /^The refactor changed behaviour: 'errors come in code order' passed before the change and fails after it\. Keep the old behaviour \(.+\), or accept the new one \(.+\)\.$/u);
  assert.deepEqual(held.choices.map((choice) => choice.id), ['keep-behaviour', 'accept-behaviour', 'dispute']);
  const [keep, accept] = held.choices;
  assert.match(keep.command, /--to implementation\b/u, 'keeping the old behaviour goes back to the code step');
  assert.match(accept.command, /--to implementation-spec\b/u, 'accepting the new behaviour goes back to the plan, which is revised');
  assert.match(accept.label, /the task becomes a change/u);
  for (const choice of held.choices) assert.doesNotMatch(choice.command, /<[^>]+>/u, `${choice.id} is a complete command`);
  // A check that already failed before stays a finding; with no run before kept, the checks run on the base first.
  const old = refactorHold(workflow, step, code, { changed: [], before: [{ command: 'unit', tests: ['flaky clock'] }], unknown: [] }, choices);
  assert.equal(old.reason, 'failed-before');
  assert.match(old.words, /^'flaky clock' already failed before the change: a finding the refactor does not approve\./u);
  assert.deepEqual(old.choices, choices);
  const blind = refactorHold(workflow, step, code, { changed: [], before: [], unknown: ['unit'] }, choices);
  assert.equal(blind.reason, 'no-before');
  assert.equal(blind.choices[0].command, 'singularity-flow tests base --work-id TASK-7 --phase verification --within 600 --json');
  assert.equal(refactorHold(workflow, step, code, null, choices), null, 'not a refactor: the test step\'s own brake');
});

test('ITW REQ-015: a refactor whose new behaviour is accepted becomes a change in one revision that keeps every step', async (t) => {
  const story = await journeyRepository(t);
  Object.assign(story, { workId: 'TASK-1', item: ITEM });
  const started = json(story.cli('work', 'tidy the value module', '--kind', 'refactor', '--start', '--json'));
  assert.match(started.data?.task?.before ?? started.task?.before ?? JSON.stringify(started), /tests base --work-id TASK-1 --phase verification/u);
  const before = storyRecord(story);
  const because = 'A person accepted the new behaviour: \'errors come in code order\' behave differently after the change.';
  const script = `
    const { loadAcceptedStoryExecution } = await import(${JSON.stringify(path.join(SOURCE, 'accepted-story-execution.mjs'))});
    const { changeTaskKind } = await import(${JSON.stringify(path.join(SOURCE, 'task-amendment.mjs'))});
    const loaded = await loadAcceptedStoryExecution(process.cwd(), 'TASK-1');
    console.log(JSON.stringify(await changeTaskKind(process.cwd(), loaded.config, loaded.workflow,
      { from: 'refactor', to: 'change', because: ${JSON.stringify(because)}, checks: ['errors come in code order'], changeRequest: 'CR-001' })));`;
  const ran = story.spawn(process.execPath, ['--input-type=module', '-e', script]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(json(ran.stdout.slice(ran.stdout.indexOf('{'))).changeId, 'TSC-001');
  const record = storyRecord(story);
  assert.equal(record.resolution.composition.kind, 'change');
  assert.deepEqual(record.resolution.composition.steps, before.resolution.composition.steps, 'the steps stay');
  assert.deepEqual(record.resolution.phases, before.resolution.phases, 'every pinned step stays');
  for (const id of record.phaseOrder) assert.deepEqual(stableTaskStepState(record.phases[id]), stableTaskStepState(before.phases[id]), `${id}'s state stays`);
  const change = record.resolution.composition.changes.at(-1);
  assert.deepEqual({ change: change.change, from: change.from, to: change.to, checks: change.checks, changeRequest: change.changeRequest },
    { change: 'grow', from: 'refactor', to: 'change', checks: ['errors come in code order'], changeRequest: 'CR-001' });
  assert.equal(record.taskChanges.at(-1).change, 'kind');
  assert.equal(record.workflowSnapshot.revision, 2);
  assert.equal(record.history.at(-1).event, 'task_kind_changed');
  assert.equal(story.git('status', '--porcelain'), '', 'the change is committed whole');
  json(story.cli('status', '--json'));
  const work = json(story.cli('work', 'status', '--json'));
  assert.equal(work.kind, 'change');
  // The contract: a kind change keeps the steps; one that also moved a step is refused.
  const decision = json(readFileSync(path.join(story.root, record.taskChanges[0].decisionPath), 'utf8'));
  assertTaskChangeScope(before.resolution, record.resolution, decision);
  const moved = structuredClone(record.resolution);
  moved.phases = [...moved.phases].reverse();
  moved.policySha256 = taskChangePolicyDigest(moved);
  const forged = { ...structuredClone(decision), to: { ...decision.to, policySha256: moved.policySha256, compositionSha256: taskChangeDigest(moved.composition) } };
  assert.throws(() => assertTaskChangeScope(before.resolution, moved, forged), /A kind change changed the Story's steps/u);
  const otherKind = structuredClone(decision);
  otherKind.change = { ...otherKind.change, from: 'fix' };
  assert.throws(() => assertTaskChangeScope(before.resolution, record.resolution, otherKind), /malformed|kind/u);
});
