import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { confirmNextVersion } from './helpers/next-version-consent.mjs';
import { decisionsSinceRework } from '../src/state.mjs';
import { fallbackAuthorities, riskAuthorities } from '../src/evidence/risk-decisions.mjs';
import { planCorrectionAuthorities } from '../src/plan-row-corrections.mjs';

// Unhappy lifecycle paths from the 2026-10-28 audit: each case was a Story that could not go on.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const ENV = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Lifecycle Tester', SINGULARITY_FLOW_NO_MODEL: '1' };

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: ENV });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** A classic-delivery Story whose intake is approved and whose code step is approved too. */
async function approvedCode(t, W) {
  const AC = `${W}:AC-001`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-lifecycle-unhappy-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const attempt = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root, { allowFailure: true });
  const write = async (relative, contents) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  };
  const testFile = (value) => ["import test from 'node:test';", "import assert from 'node:assert/strict';",
    "import { value } from '../src/value.mjs';", `// @ac:${AC}`, `test('value', () => assert.equal(value, ${value}));`, ''].join('\n');
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Lifecycle Tester'], root);
  run('git', ['config', 'user.email', 'lifecycle@example.test'], root);
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await write('src/value.mjs', 'export const value = 1;\n');
  await write('test/value.test.mjs', testFile(1));
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Not a review test: this fixture's Stories are unreviewed on purpose. Every step's review is walked in
  // review-every-step-cli.test.mjs.
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize the lifecycle fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const readiness = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', readiness.planId, '--json');
  cli('start', W, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Change the value', '--description', 'Return 2.');
  const item = path.join(root, 'singularity/work-items', W);
  const intake = async (note) => writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    `# ${W} — intake`, '', '## Request and outcome', '', `Return the approved value 2 to every caller.${note}`, '',
    '## Scope and constraints', '', 'Change only the value module and its test.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${AC}] | The exported value equals 2. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    `| \`${AC}\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified |`, '',
    '## Initial evidence', '', 'The baseline module and test at the pinned main revision.', ''
  ].join('\n'));
  cli('prepare', 'intake');
  await intake('');
  cli('wm', 'compose', '--phase', 'intake');
  cli('clarification', 'record', 'intake', '--question', 'Is 2 the approved value?', '--answer', 'Yes.');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');
  cli('prepare', 'implementation');
  await write('src/value.mjs', `// @clause:${AC} returns the approved value\nexport const value = 2;\n`);
  await write('test/value.test.mjs', testFile(2));
  const codeArtifact = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(codeArtifact, (await readFile(codeArtifact, 'utf8')).replace(/TODO:[^\n]*/gu, 'The value module returns the approved value.'));
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'implementation');
  cli('approve', 'implementation', '--yes');
  const state = async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  return { root, cli, attempt, state, intake, AC };
}

test('after an upstream return corrects the plan, the unchanged code step publishes its same source again', async (t) => {
  const W = 'LIFE-RETURN';
  const { cli, attempt, state, intake } = await approvedCode(t, W);
  const next = (await state()).currentPhase;
  assert.notEqual(next, 'implementation');
  cli('upstream-issue', 'raise', '--phase', 'intake', '--about', 'Request and outcome', '--problem', 'The intake never says that callers may cache the value.');
  cli('upstream-issue', 'decide', 'UPI-001', '--outcome', 'return', '--reason', 'Intake must state the caching rule; the code stays as it is.');
  assert.equal((await state()).currentPhase, 'intake');
  // Each returned step's version 2 opens on the person's yes [D3, OSA:REQ-030].
  confirmNextVersion(cli, 'intake');
  await intake(' Callers may cache it.');
  cli('wm', 'compose', '--phase', 'intake');
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'intake');
  cli('approve', 'intake', '--yes');
  assert.equal((await state()).currentPhase, 'implementation');
  confirmNextVersion(cli, 'implementation');
  cli('prepare', 'implementation');
  // Nothing in the code changes: the corrected intake owes no new source. This was refused as
  // "no application source or test paths changed" (RG-1).
  const published = attempt('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  assert.equal(published.status, 0, published.stdout + published.stderr);
  cli('submit', 'implementation');
  const after = await state();
  assert.equal(after.phases.implementation.generation, 2);
  assert.equal(after.phases.implementation.status, 'awaiting_approval', 'its tests ran again and it is reviewed again');
});

test('two issues about one step sent back together are one return: the second joins it, never refused (d-story 2026-11-23)', async (t) => {
  const W = 'LIFE-JOIN';
  const { root, cli, state } = await approvedCode(t, W);
  for (const problem of ['The intake never says that callers may cache the value.', 'The intake never names who approved the value.',
    'The intake never says what callers do with an old value.']) {
    cli('upstream-issue', 'raise', '--phase', 'intake', '--about', 'Request and outcome', '--problem', problem);
  }
  const list = JSON.parse(cli('decisions', W, '--json').stdout).data;
  const itemOf = (packet, issue) => packet.items.find((item) => item.details?.issue === issue);
  const [first, second] = [itemOf(list, 'UPI-001'), itemOf(list, 'UPI-002')];
  // "Return the work to Intake for both", as the Decide card records it: on d-story the first returned and the second
  // was refused, and the card then offered only accepting it as a risk or dismissing it.
  const answers = path.join(root, '.git', 'answers.json');
  const reason = 'Intake must state these rules before the code is checked again.';
  await writeFile(answers, JSON.stringify({ choose: { [first.id]: 'return', [second.id]: 'return' }, reason: { [first.id]: reason, [second.id]: reason },
    confirm: list.packetSha256 }));
  const recorded = JSON.parse(cli('decisions', 'record', W, '--answers', answers, '--json').stdout).data;
  assert.equal(recorded.recorded.length, 2, JSON.stringify(recorded.recorded));
  let after = await state();
  assert.equal(after.currentPhase, 'intake');
  assert.deepEqual(after.changeRequests.map((request) => [request.id, request.targetPhase, request.status]), [['CR-001', 'intake', 'open']], 'one return, not two');
  assert.deepEqual(after.upstreamIssueDecisions.map((entry) => [entry.issue, entry.outcome, entry.link]), [['UPI-001', 'return', 'CR-001'], ['UPI-002', 'return', 'CR-001']]);
  // The third, decided afterwards: its return joins the open one on the list and in the terminal.
  const later = itemOf(JSON.parse(cli('decisions', W, '--json').stdout).data, 'UPI-003');
  const join = later.options.find((option) => option.id === 'return');
  assert.ok(join, `the list offers the return: ${later.options.map((option) => option.id).join(', ')}`);
  assert.equal(join.label, 'Fix it in the redo of Intake already under way');
  assert.match(join.does, /^Joins the return already open \(CR-001\): Intake is being redone and fixes this too; nothing is sent back again\.$/u);
  assert.deepEqual(join.effects.map((effect) => [effect.issue, effect.outcome, effect.joins]), [['UPI-003', 'return', 'CR-001']]);
  assert.match(later.details.commands[0], /--outcome plan-correction\|amend\|return\|accept-risk\|dismiss/u);
  assert.match(later.recommended.words, /^Recommended: Return the work if the reported problem is real/u);
  const decided = cli('upstream-issue', 'decide', 'UPI-003', '--outcome', 'return', '--reason', 'The redo of Intake states this rule too.');
  assert.match(decided.stdout, /UPI-003 joins CR-001: the work already goes back through intake, which corrects this too\. Nothing else was returned\./u);
  after = await state();
  assert.equal(after.changeRequests.length, 1);
  assert.deepEqual(after.upstreamIssueDecisions.at(-1).link, 'CR-001');
  assert.match(after.history.at(-1).detail, /^UPI-003: return \(CR-001\), joining the return to intake already open\./u);
});

test('cancel needs no agent session: the Git identity cancels, as reject does', async (t) => {
  const W = 'LIFE-CANCEL';
  const { root, cli, state } = await approvedCode(t, W);
  // A step SFlow runs itself ends the agent session; cancel then said "No active agent session" (L5).
  const session = path.join(root, '.git/singularity-flow/session.json');
  await readFile(session);
  await unlink(session);
  cli('cancel', '--reason', 'The request was withdrawn by its owner.', '--confirm', W);
  const after = await state();
  assert.equal(after.status, 'cancelled');
  assert.ok(after.cancellation.cancelledBy, 'the Git identity cancelled');
});

test('rolling a rework forward over a newer amendment or plan correction is refused', () => {
  const request = { id: 'CR-001', requestedAt: '2026-10-28T10:00:00.000Z' };
  const checkpoint = { state: { affectedPhaseIds: ['implementation', 'testing'] } };
  const workflow = {
    phases: { intake: { id: 'intake', status: 'approved', approvedAt: '2026-10-28T09:00:00.000Z' } },
    intentAmendments: [{ id: 'IAM-001', status: 'approved', decidedAt: '2026-10-28T11:00:00.000Z' }],
    upstreamIssueDecisions: [
      { issue: 'UPI-001', outcome: 'dismiss', at: '2026-10-28T11:00:00.000Z' },
      { issue: 'UPI-002', outcome: 'plan-correction', at: '2026-10-28T11:30:00.000Z' },
      { issue: 'UPI-003', outcome: 'amend', at: '2026-10-28T09:30:00.000Z' }
    ]
  };
  assert.deepEqual(decisionsSinceRework(workflow, request, checkpoint), ['intent amendment IAM-001', 'upstream issue UPI-002 (plan-correction)']);
  assert.deepEqual(decisionsSinceRework({ phases: {} }, request, checkpoint), []);
});

test('a step with no approval group is decided by the nearest step that has one, from its policies alone', () => {
  const groups = (names) => ({ approvalPolicy: { authorities: names, requiredAuthorities: [] } });
  const workflow = {
    phaseOrder: ['intake', 'implement', 'verify'],
    phases: { intake: groups(['product']), implement: { approvalPolicy: { mode: 'none' } }, verify: groups(['quality']) }
  };
  assert.deepEqual(riskAuthorities(workflow, { owningSteps: ['implement'] }), ['quality'], 'the step that reviews it next');
  assert.deepEqual(riskAuthorities(workflow, { owningSteps: [] }), ['quality'], 'an obligation no step owns: the last step with approvers');
  assert.deepEqual(riskAuthorities(workflow, { owningSteps: ['intake'] }), ['product'], 'a step with approvers keeps its own');
  workflow.phases.verify = { approvalPolicy: { mode: 'none' } };
  assert.deepEqual(fallbackAuthorities(workflow, ['implement']), ['product'], 'else the nearest step before it');
  assert.deepEqual(planCorrectionAuthorities(workflow, 'implement'), ['product']);
  assert.deepEqual(fallbackAuthorities({ phaseOrder: ['a'], phases: { a: {} } }, ['a']), []);
});

test('an upstream issue\'s decide command lists return only when a return can run', async () => {
  const { upstreamIssueDecideCommand } = await import('../src/upstream-issues.mjs');
  const workflow = { workItem: { id: 'W' }, currentPhase: 'testing', phaseOrder: ['intake', 'implementation', 'testing'],
    phases: { intake: {}, implementation: {}, testing: { id: 'testing', status: 'in_progress' } } };
  const outcomes = (issue) => upstreamIssueDecideCommand('W', { id: 'UPI-001', phase: issue }, null, workflow).match(/--outcome (\S+)/u)[1];
  assert.equal(outcomes('intake'), 'plan-correction|amend|return|accept-risk|dismiss');
  // A pending decision leaves the deciding step approved: a return is refused (L10).
  workflow.phases.testing.status = 'approved';
  assert.equal(outcomes('intake'), 'plan-correction|amend|accept-risk|dismiss');
  // Another return already went back to (or past) the issue's step (L11).
  workflow.phases.testing.status = 'in_progress';
  workflow.currentPhase = 'intake';
  workflow.phases.intake = { id: 'intake', status: 'in_progress' };
  assert.equal(outcomes('intake'), 'plan-correction|amend|accept-risk|dismiss');
  // An open return made after the issue was raised, through its step: the return joins it (d-story, 2026-11-23).
  workflow.status = 'in_progress';
  workflow.changeRequests = [{ id: 'CR-001', status: 'open', targetPhase: 'intake', requestedAt: '2026-11-23T10:00:00.000Z' }];
  const outcomesAt = (at) => upstreamIssueDecideCommand('W', { id: 'UPI-001', phase: 'intake', at }, null, workflow).match(/--outcome (\S+)/u)[1];
  assert.equal(outcomesAt('2026-11-23T09:00:00.000Z'), 'plan-correction|amend|return|accept-risk|dismiss');
  assert.equal(outcomesAt('2026-11-23T11:00:00.000Z'), 'plan-correction|amend|accept-risk|dismiss', 'a return made before the issue never fixes it');
  workflow.changeRequests[0].status = 'resolved';
  assert.equal(outcomesAt('2026-11-23T09:00:00.000Z'), 'plan-correction|amend|accept-risk|dismiss', 'a resolved return is no redo under way');
});
