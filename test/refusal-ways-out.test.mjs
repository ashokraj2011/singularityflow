import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { refusalEnvelope, refusalRemediationPlan, renderRefusalPlan } from '../src/refusal-remediation.mjs';
import { agentAct, observeAgentLoop } from '../src/agent-output.mjs';
import { skillForCommandLine } from '../src/command-skills.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { testOnlyCorrection } from '../src/evidence/evaluate.mjs';
import { SingularityFlowError } from '../src/util.mjs';

// Refusals whose way out existed but was never named, or was cut, or pointed back at the turn that
// refused (second unhappy-path sweep, 2026-10-29).
const refusal = (code, message, details = {}) => new SingularityFlowError(message, { code, details });
const commands = (plan) => plan.steps.map((entry) => entry.command);

test('a rewritten Story history names the person\'s Git steps first, never recover, and asks the person', () => {
  const error = refusal('STORY_HISTORY_REWRITTEN', 'The history of W-1 was rewritten.', {
    actions: [{ label: 'Put W-1 back on the history SFlow recorded: git reset --keep abc123' },
      { label: 'If the rewritten history was pushed, put the remote back: git push --force-with-lease origin W-1' },
      { label: 'Once no step is waiting for approval, bring main in with git merge origin/main.' }]
  });
  const plan = refusalRemediationPlan(error, ['approve', 'implementation', '--work-id', 'W-1']);
  assert.deepEqual(plan.steps.map((entry) => entry.id), ['restore-recorded-history-1', 'restore-recorded-history-2', 'restore-recorded-history-3']);
  assert.match(plan.steps[0].label, /git reset --keep abc123/u);
  assert.ok(!commands(plan).some((command) => /\brecover\b/u.test(command ?? '')), JSON.stringify(commands(plan)));
  const act = agentAct({ error: { code: error.code, message: error.message }, remediationPlan: plan });
  assert.equal(act.state, 'ask-person');
  assert.equal(act.do, null);
});

test('refusals that had only help, doctor and nextsteps name their own way out', () => {
  const first = (code, argv, details = {}) => refusalRemediationPlan(refusal(code, 'Refused.', details), argv).steps[0];
  assert.equal(first('APR_PUBLICATION_PENDING', ['story', 'approvers', 'refresh', 'W-1']).command, 'singularity-flow sync W-1');
  assert.match(first('APR_NOTHING_TO_ADD', ['story', 'approvers', 'refresh', 'W-1']).command, /configuration add-current-identity --target story:<GROUP>/u);
  assert.match(first('REWORK_ROLL_FORWARD_SUPERSEDED', ['story', 'rework', 'roll-forward', '--work-id', 'W-1']).command, /^singularity-flow nextsteps W-1/u);
  assert.match(first('STORY_PUBLICATION_IN_PROGRESS', ['submit']).command, /result last --wait/u);
  assert.match(first('PUBLICATION_SET_ASIDE_REFUSED', ['sync', 'W-1', '--set-aside'], { reason: 'commits-after-it', commit: 'a'.repeat(40) }).label, /git reset --keep a{40}/u);
  assert.match(first('WITNESS_EXCEPTION_STORY_CLOSED', ['decision', 'witness-exception', 'W-1']).command, /^singularity-flow reopen W-1 --to/u);
  assert.match(first('WITNESS_EXCEPTION_UNKNOWN', ['decision', 'witness-exception', 'W-1']).command, /^singularity-flow decisions W-1/u);
});

test('generic help is the help read every turn admits, not <command> --help', () => {
  const plan = refusalRemediationPlan(refusal('SOME_UNKNOWN_REFUSAL', 'Refused.'), ['sync', 'W-1']);
  assert.ok(commands(plan).includes('singularity-flow help sync'), JSON.stringify(commands(plan)));
  assert.ok(!commands(plan).some((command) => /--help\b/u.test(command ?? '')));
});

test('an upstream issue raised from a refusal keeps the Story and the clause the person named', () => {
  const plan = refusalRemediationPlan(refusal('UPSTREAM_ISSUE_AUTHORITY_UNAVAILABLE', 'No approvers.', { decidableStep: 'planning' }),
    ['upstream-issue', 'raise', '--work-id', 'W-1', '--phase', 'intake', '--about', 'W-1:REQ-001', '--problem', 'Tests are the whole delivery.']);
  assert.match(plan.steps[0].command, /--work-id W-1 --phase planning --about W-1:REQ-001 /u);
});

test('the set-aside preview is a read with no skill; confirming it stays the person\'s mutation', () => {
  const op = (options) => resolveOperation({ requestedCommand: 'sync', positionals: ['sync', 'W-1'], options });
  assert.equal(op({ 'set-aside': true }).classification, 'read');
  assert.equal(op({ 'set-aside': true, confirm: 'a'.repeat(40) }).classification, 'mutation');
  assert.equal(skillForCommandLine('singularity-flow sync W-1 --set-aside'), null);
  assert.equal(skillForCommandLine('singularity-flow sync W-1'), 'sf-next');
  // An Epic's or Initiative's preview is the same read; /sf-initiative-next would sync it into the refusal.
  const initiative = (options) => resolveOperation({ requestedCommand: 'initiative', positionals: ['initiative', 'sync', 'EPIC-1'], options });
  assert.equal(initiative({ 'set-aside': true }).classification, 'read');
  assert.equal(initiative({ 'set-aside': true, confirm: 'a'.repeat(40) }).classification, 'mutation');
  assert.equal(skillForCommandLine('singularity-flow initiative sync EPIC-1 --set-aside'), null);
  // A refusal that names either preview keeps it in its plan, as a Shell command with no skill.
  for (const command of ['singularity-flow sync W-1 --set-aside', 'singularity-flow initiative sync EPIC-1 --set-aside']) {
    const plan = refusalRemediationPlan(refusal('PUBLICATION_PUSH_FAILED', 'Refused.', { recoveryCommands: [{ command, label: 'Inspect it.' }] }), ['sync']);
    assert.equal(plan.steps[0].command, command, JSON.stringify(commands(plan)));
    assert.equal(plan.steps[0].skill, null);
  }
});

test('an Epic\'s refused set-aside names its own branch and sync, never the Story\'s', () => {
  const first = (reason) => refusalRemediationPlan(refusal('PUBLICATION_SET_ASIDE_REFUSED', 'Refused.',
    { reason, commit: 'a'.repeat(40), kind: 'initiative', workId: 'EPIC-1' }), ['initiative', 'sync', 'EPIC-1', '--set-aside']).steps[0];
  assert.match(first('not-checked-out').label, /git switch EPIC-1/u);
  assert.equal(first('no-pending-publication').command, 'singularity-flow initiative sync EPIC-1');
  const story = refusalRemediationPlan(refusal('PUBLICATION_SET_ASIDE_REFUSED', 'Refused.', { reason: 'no-pending-publication' }), ['sync', 'W-1', '--set-aside']);
  assert.equal(story.steps[0].command, 'singularity-flow sync');
});

test('a step that says it has no Copilot route keeps none', () => {
  const plan = { steps: [{ id: 'approve-with-yes', label: 'The person adds --yes.', command: 'singularity-flow approve implementation --work-id W-1 --yes',
    copilotCommand: null, kind: 'remediation' }] };
  const act = agentAct({ error: { code: 'APPROVAL_CONFIRMATION_REQUIRED', message: 'Refused.' }, remediationPlan: plan });
  assert.equal(act.do?.copilot ?? null, null);
});

test('a prepublish correction a person or a returned repair clears is routed, not left to recheck', () => {
  for (const [kind, state] of [['code-rework', 'next'], ['human-context', 'ask-person'], ['upstream-issue', 'ask-person']]) {
    const act = agentAct({ resultType: 'sflow-phase-prepublish', status: 'correction-required', findings: [{ code: 'X', message: 'y' }],
      correction: { class: kind, sameTurn: false, guidance: 'Take the route.' }, commands: { next: 'singularity-flow nextsteps W-1 --json' } });
    assert.equal(act.state, state, kind);
    assert.equal(act.do?.shell, 'singularity-flow nextsteps W-1 --json', kind);
  }
});

test('the same correction findings coming back unchanged count as a loop', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-correct-loop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', root]);
  const result = { resultType: 'sflow-phase-prepublish', status: 'correction-required', workId: 'W-1', phase: 'intake', head: 'a'.repeat(40),
    findings: [{ code: 'SPEC_PLANNED_TABLE_INVALID', message: 'Same message.', line: 4 }] };
  let act = null;
  for (let round = 0; round < 3; round += 1) act = observeAgentLoop(root, result, agentAct(result), { now: 1_000 + round });
  assert.equal(act.loop?.repeated, 3);
  assert.match(act.loop.instruction, /findings have come back 3 times unchanged/u);
});

test('a test-only correction names the one test the step delivered', () => {
  assert.match(testOnlyCorrection('W-1', 'planning', 'W-1:REQ-001', { tests: [] }, ['test/orders.test.js']),
    /--add-test W-1:REQ-001=test\/orders\.test\.js /u);
  assert.match(testOnlyCorrection('W-1', 'planning', 'W-1:REQ-001', { tests: [] }, ['test/a.test.js', 'test/b.test.js']),
    /--add-test W-1:REQ-001=<TEST-PATH> /u);
});

test('story approvers with no verb is the refresh preview, in the registry as in the CLI', async () => {
  assert.equal(resolveOperation({ requestedCommand: 'story', positionals: ['story', 'approvers'], options: {} }).classification, 'read');
  const source = await (await import('node:fs/promises')).readFile(new URL('../src/commands/story.mjs', import.meta.url), 'utf8');
  assert.match(source, /positionals\[2\] \?\? 'refresh'\) !== 'refresh'/u, 'the CLI takes no verb as refresh too');
});

test('a lock only a person can end: its reviewed release is the person\'s first step on every surface, then the read', () => {
  // SUBJECT_LOCK_BUSY, the reset barrier, registry, selection, transport and Authority Store leases carry
  // their release as details.releaseCommand; the plan was recover/phase show or help/doctor (E5/D2).
  const token = '3f2c1a9e-8b7d-4e6f-9a0b-1c2d3e4f5a6b';
  const owner = { pid: 4242, host: 'other-laptop.example', machineId: '0a1b2c3d-0000-4000-8000-000000000000',
    acquiredAt: '2026-10-30T10:00:00.000Z', lockToken: token };
  const liveness = { state: 'unknown', reason: 'other-machine', heartbeat: 'stale', lastHeartbeatAt: '2026-10-30T10:01:00.000Z' };
  const lease = '/home/someone/.singularity-flow/active-workspace.json.lock';
  const cases = [
    ['SUBJECT_LOCK_BUSY', ['phase', 'publish', 'build', '--work-id', 'PMC-1'], `singularity-flow lock release story PMC-1 --confirm ${token}`,
      'singularity-flow lock show story PMC-1'],
    ['FACTORY_RESET_IN_PROGRESS', ['start', 'PMC-1'], `singularity-flow lock release factory-reset-barrier repository --confirm ${token}`,
      'singularity-flow lock show factory-reset-barrier repository'],
    ['STORY_PUBLICATION_IN_PROGRESS', ['submit'], `singularity-flow lock release story PMC-1 --confirm ${token}`,
      'singularity-flow lock show story PMC-1'],
    ['TRANSPORT_INTENT_BUSY', ['sync', 'ti-1'], `singularity-flow lock release transport-intent ti-1 --confirm ${token}`,
      'singularity-flow lock show transport-intent ti-1'],
    ['ACTIVE_WORKSPACE_SELECTION_BUSY', ['workspace', 'use', 'x'], `singularity-flow lock release-file ${JSON.stringify(lease)} --confirm ${token}`,
      `singularity-flow lock show-file ${lease}`],
    ['SGOS_AUTHORITY_STORE_BUSY', ['authority-store', 'status'], `singularity-flow lock release-file "/r/.git/x/.transaction-lock" --confirm ${token}`,
      'singularity-flow lock show-file /r/.git/x/.transaction-lock']
  ];
  for (const [code, argv, release, show] of cases) {
    const error = refusal(code, `Held by PID 4242 on other-laptop.example. Release exactly that lease with: ${release}`,
      { lock: '/r/.git/singularity-flow/locks/story--PMC-1.lock', owner, liveness, releaseCommand: release });
    const envelope = refusalEnvelope(error, argv);
    const [first, second, ...rest] = envelope.remediationPlan.steps;
    assert.deepEqual([first.id, first.command, first.skill, first.copilotCommand], ['release-reviewed-lock', release, null, null], code);
    assert.equal(second.command, show, code);
    assert.deepEqual(rest, [], `${code}: no help, doctor, recover or wait step meets the same lock again`);
    assert.equal(envelope.remediationPlan.context, undefined, code);
    assert.match(envelope.remediationPlan.retry.label, /once the lock is released/u, code);
    assert.deepEqual(envelope.error.details.holder, { pid: 4242, host: 'other-laptop.example', machine: '0a1b2c3d',
      since: '2026-10-30T10:00:00.000Z', liveness: 'unknown', reason: 'other-machine', heartbeat: 'stale',
      lastHeartbeatAt: '2026-10-30T10:01:00.000Z' }, code);
    assert.equal(envelope.error.details.releaseCommand, release, code);
    const act = agentAct(envelope);
    assert.deepEqual([act.state, act.do.shell, act.do.copilot], ['confirm-in-terminal', release, null], code);
    const text = renderRefusalPlan(envelope.remediationPlan);
    assert.ok(text.includes(release) && text.includes(show), code);
  }
  // A live owner here that still renews its lock carries no release: waiting is still right.
  const live = refusalRemediationPlan(refusal('STORY_PUBLICATION_IN_PROGRESS', 'Publishing now.', { pid: 7 }), ['submit']);
  assert.match(live.steps[0].command, /result last --wait/u);
  // A release that is not a lock release, or a forged skill route, never becomes the person's step.
  for (const releaseCommand of ['singularity-flow sync PMC-1', 'singularity-flow lock show story PMC-1', 'rm -rf .git/singularity-flow/locks']) {
    const plan = refusalRemediationPlan(refusal('SUBJECT_LOCK_BUSY', 'Held.', { releaseCommand }), ['sync']);
    assert.ok(!plan.steps.some((entry) => entry.id === 'release-reviewed-lock'), releaseCommand);
  }
});
