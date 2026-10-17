import { repositoryOwnedWorkflows } from './helpers/repository-owned-workflows.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

async function harness() {
  const state = await mkdtemp(path.join(os.tmpdir(), 'sflow-build-engine-'));
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Build Tester', SINGULARITY_FLOW_WORKFLOW_BUILD_STATE: path.join(state, 'builds'),
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(state, 'outbox') };
  const run = (command, args, cwd, { input = '', allowFailure = false } = {}) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, input });
    if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const flow = (cwd, args, options) => run(process.execPath, [bin, ...args], cwd, options);
  const json = (cwd, args, options) => JSON.parse(flow(cwd, [...args, '--json'], options).stdout);
  const engineEnv = { env: { ...process.env, SINGULARITY_FLOW_WORKFLOW_BUILD_STATE: env.SINGULARITY_FLOW_WORKFLOW_BUILD_STATE } };
  return { state, env, run, flow, json, engineEnv };
}

async function repository(run, flow) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-build-engine-repo-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Build Tester'], root); run('git', ['config', 'user.email', 'build@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Build\n');
  flow(root, ['init']);
  await repositoryOwnedWorkflows(root);
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'initialize'], root);
  return root;
}

async function teamFolder() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-build-engine-team-'));
  const files = {
    '.github/agents/release-captain.agent.md': ['---', 'name: release-captain', 'description: Runs a payments release.', '---', '', '1. Intake the change.',
      '2. Build it and run `npm test`.', '3. PCI review: it must be signed off by security.', '4. Release.', ''].join('\n'),
    'docs/runbook.md': ['# Runbook', '```sh', "curl -X POST https://jira.example.com/rest/api/2/issue/$KEY/transitions -d '{}'", '```', ''].join('\n')
  };
  for (const [relative, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  }
  return root;
}

const FIRST = {
  title: 'Four steps from release-captain',
  why: 'release-captain numbers intake, build, PCI review and release; intake and requirements exist here already.',
  moves: [
    { move: 'group.add', id: 'payments-security', label: 'Payments security' },
    { move: 'agent.add', id: 'pay-captain', label: 'Release captain', description: 'Builds and releases payment changes.', from: 'developer' },
    { move: 'step.add', id: 'intake', after: null },
    { move: 'step.add', id: 'requirements', after: 'intake' },
    { move: 'step.add', id: 'pay-build', label: 'Build', after: 'requirements', agent: 'pay-captain', output: 'code', reads: ['requirements'],
      signOff: { groups: ['engineering-reviewers'], minimum: 1 }, purpose: 'Makes the change and runs the payment tests.' },
    { move: 'step.add', id: 'pay-pci-review', label: 'PCI review', after: 'pay-build', agent: 'architect', output: 'document', reads: ['pay-build'],
      signOff: { groups: ['payments-security'], minimum: 1 }, purpose: 'Nothing ships without a PCI check signed off by security.' }
  ],
  evidence: [{ path: '.github/agents/release-captain.agent.md', startLine: 6, endLine: 9 }],
  questions: [{ question: 'Who signs off the PCI review?', choices: ['payments-security', 'platform-leads'], blocking: true }]
};

test('a proposal is checked move by move, each finding located, and nothing is recorded until it fits', async () => {
  const { run, flow, json, engineEnv } = await harness();
  const root = await repository(run, flow);
  const folder = await teamFolder();
  const build = json(root, ['workflow', 'build', 'start', '--folder', folder, '--name', 'Payments release']).build;
  const { proposeToBuild } = await import('../src/workflow-build/engine.mjs');
  const refused = (payload) => proposeToBuild(build.id, payload, { root, ...engineEnv }).then(() => null, (error) => error);
  const bad = await refused({ title: 'Bad', why: 'Shows every mistake at once.', moves: [
    { move: 'step.dance', id: 'x' },
    { move: 'step.add', id: 'Pay Build', label: 'Build' },
    { move: 'step.add', id: 'pay-new', label: 'New', agent: 'nobody', signOff: { groups: ['no-such-group'] } },
    { move: 'step.add', id: 'intake', label: 'Renamed intake' },
    { move: 'agent.add', id: 'developer', label: 'Developer', description: 'Exists already.' },
    { move: 'step.change', id: 'missing-step', label: 'x' }
  ], evidence: [{ path: '.github/agents/release-captain.agent.md', startLine: 1, endLine: 99 }, { path: 'not/captured.md', startLine: 1, endLine: 1 }] });
  assert.equal(bad.code, 'WORKFLOW_BUILD_PROPOSAL_INVALID');
  const at = bad.details.findings.map((finding) => [finding.at, finding.code]);
  for (const expected of [
    ['evidence[0]', 'BUILD_EVIDENCE_SPAN'], ['evidence[1].path', 'BUILD_EVIDENCE_UNKNOWN']
  ]) assert.ok(at.some((entry) => entry[0] === expected[0] && entry[1] === expected[1]), `${expected.join(' ')} in ${JSON.stringify(at)}`);
  assert.match(bad.message, /^The proposal cannot be used yet:\n {2}evidence\[0\]: Lines 1-99 are not inside/u);
  const moves = (await refused({ title: 'Bad moves', why: 'Every move mistake.', moves: [
    { move: 'step.dance', id: 'x' },
    { move: 'step.add', id: 'Pay Build', label: 'Build' },
    { move: 'step.add', id: 'pay-new', label: 'New', agent: 'nobody', signOff: { groups: ['no-such-group'] } },
    { move: 'step.add', id: 'intake', label: 'Renamed intake' },
    { move: 'agent.add', id: 'developer', label: 'Developer', description: 'Exists already.' },
    { move: 'step.change', id: 'missing-step', label: 'x' }
  ] })).details.findings.map((finding) => [finding.at, finding.code]);
  assert.deepEqual(moves, [
    ['moves[0].move', 'BUILD_MOVE_UNKNOWN'],
    ['moves[1].id', 'BUILD_MOVE_ID'], ['moves[1].agent', 'BUILD_MOVE_FIELD_MISSING'],
    ['moves[2].agent', 'BUILD_MOVE_REFERENCE'], ['moves[2].signOff', 'BUILD_MOVE_REFERENCE'],
    ['moves[3].id', 'BUILD_MOVE_REUSE'],
    ['moves[4].id', 'BUILD_MOVE_EXISTS'],
    ['moves[5].id', 'BUILD_MOVE_REFERENCE']
  ]);
  const unsaveable = await refused({ title: 'Code without requirements', why: 'A code step needs requirements before it.', moves: [
    { move: 'step.add', id: 'pay-solo', label: 'Build alone', agent: 'developer', output: 'code', signOff: { groups: ['engineering-reviewers'] } }
  ] });
  assert.equal(unsaveable.details.findings[0].at, 'workflow', 'the whole draft must still make a configuration Studio can save');
  const { readWorkflowBuild } = await import('../src/workflow-build/store.mjs');
  assert.deepEqual((await readWorkflowBuild(build.id, engineEnv)).proposals, [], 'refused proposals leave nothing behind');
});

test('propose, accept, answer and check: the workflow as the accepted moves leave it, explained and checked, with nothing written', async () => {
  const { run, flow, json, engineEnv } = await harness();
  const root = await repository(run, flow);
  const folder = await teamFolder();
  const build = json(root, ['workflow', 'build', 'start', '--folder', folder, '--name', 'Payments release']).build;
  const captain = build.items.find((entry) => entry.kind === 'process');
  const proposed = json(root, ['workflow', 'build', 'propose', '--build', build.id, '--proposal', '-'], { input: JSON.stringify({ ...FIRST, items: [captain.id] }) }).build;
  assert.deepEqual(proposed.proposals.map((entry) => [entry.id, entry.status, entry.by]), [['p-1', 'pending', 'copilot']]);
  assert.deepEqual(proposed.questions.map((entry) => [entry.id, entry.question]), [['q-1', 'Who signs off the PCI review?']]);
  assert.deepEqual(proposed.conversation.slice(1).map((entry) => [entry.by, entry.kind, entry.text]), [
    ['copilot', 'proposal', 'Four steps from release-captain'], ['copilot', 'question', 'Who signs off the PCI review?']]);

  const empty = json(root, ['workflow', 'build', 'check', '--build', build.id]);
  assert.deepEqual([empty.draft.workflow.phases, empty.ready, empty.changeSet.changes], [[], false, []], 'a pending proposal changes nothing yet');

  const wrong = flow(root, ['workflow', 'build', 'answer', '--build', build.id, '--question', 'q-1', '--choice', 'everyone'], { allowFailure: true });
  assert.match(wrong.stderr + wrong.stdout, /'everyone' is not one of: 'payments-security', 'platform-leads'/u);
  json(root, ['workflow', 'build', 'answer', '--build', build.id, '--question', 'q-1', '--choice', 'Payments-Security']);
  const accepted = json(root, ['workflow', 'build', 'decide', '--build', build.id, '--proposal', 'p-1', '--accept']).build;
  assert.equal(accepted.proposals[0].status, 'accepted');
  assert.equal(accepted.items.find((entry) => entry.id === captain.id).status, 'confirmed', 'what the proposal used counts as used');
  assert.deepEqual(accepted.questions[0].answer.choice, 'payments-security');
  const again = flow(root, ['workflow', 'build', 'decide', '--build', build.id, '--proposal', 'p-1', '--decline'], { allowFailure: true });
  assert.match(again.stderr + again.stdout, /Proposal p-1 is already accepted\./u);

  const result = json(root, ['workflow', 'build', 'check', '--build', build.id]);
  assert.equal(result.resultType, 'workflow-build-check');
  assert.equal(result.build.workflow, 'payments-release');
  assert.deepEqual(result.draft.workflow.phases, ['intake', 'requirements', 'pay-build', 'pay-pci-review']);
  assert.deepEqual([result.draft.newSteps, result.draft.newAgents, result.draft.newGroups], [['pay-build', 'pay-pci-review'], ['pay-captain'], ['payments-security']]);
  assert.deepEqual(result.changeSet.changes.map((change) => change.op), ['group.create', 'agent.create', 'phase.create', 'phase.create', 'workflow.create']);
  assert.equal(result.plan.valid, true, JSON.stringify(result.plan.problems));
  assert.equal(result.explanation.summary, '4 steps, 4 with a sign-off; changes code in Build.');
  assert.deepEqual(result.explanation.steps.find((step) => step.id === 'pay-pci-review').why, { text: 'Nothing ships without a PCI check signed off by security.', from: 'description' });
  assert.match(result.explanation.steps.find((step) => step.id === 'pay-pci-review').signOff, /^Signed off by one person from Payments security\.$/u);
  const open = result.findings.find((entry) => entry.code === 'BUILD_ITEMS_OPEN');
  assert.equal(open.severity, 'warning');
  assert.match(open.title, /^\d+ things found in the material are not used or left out yet$/u);
  assert.equal(result.ready, true);
  assert.equal(run('git', ['status', '--porcelain'], root).stdout, '', 'checking a build writes nothing in the repository');

  const text = flow(root, ['workflow', 'build', 'check', '--build', build.id]).stdout;
  assert.match(text, /^Payments release \(payments-release\): 4 steps, 4 with a sign-off; changes code in Build\.$/mu);
  assert.match(text, /^ {2}4\. PCI review: Writes a document .* Why: Nothing ships without a PCI check signed off by security\.$/mu);
  assert.match(text, /^Ready to finish: singularity-flow workflow build finish --build wb_[a-f0-9]{16} --propose$/mu);
});

test('later decisions: a step other workflows share is copied, not changed; a proposal an earlier one overtook goes stale; items can be left out', async () => {
  const { run, flow, json, engineEnv } = await harness();
  const root = await repository(run, flow);
  const folder = await teamFolder();
  const build = json(root, ['workflow', 'build', 'start', '--folder', folder]).build;
  json(root, ['workflow', 'build', 'propose', '--build', build.id, '--proposal', '-'], { input: JSON.stringify(FIRST) });
  json(root, ['workflow', 'build', 'decide', '--build', build.id, '--proposal', 'p-1', '--accept']);
  const shared = flow(root, ['workflow', 'build', 'propose', '--build', build.id, '--proposal', '-'], { allowFailure: true,
    input: JSON.stringify({ title: 'Rename intake', why: 'The team calls it triage.', moves: [{ move: 'step.change', id: 'intake', label: 'Triage' }] }) });
  assert.match(shared.stderr + shared.stdout, /moves\[0\]\.id: Step 'intake' is also used by .*Add a copy with step\.add and from: 'intake' instead\./u);
  const copy = { title: 'Triage instead of intake', why: 'The team calls it triage.', moves: [
    { move: 'step.add', id: 'pay-triage', label: 'Triage', from: 'intake', after: null }, { move: 'step.remove', id: 'intake' }] };
  json(root, ['workflow', 'build', 'propose', '--build', build.id, '--proposal', '-'], { input: JSON.stringify(copy) });
  json(root, ['workflow', 'build', 'propose', '--build', build.id, '--proposal', '-'], { input: JSON.stringify({ ...copy, title: 'The same copy, proposed twice' }) });
  json(root, ['workflow', 'build', 'decide', '--build', build.id, '--proposal', 'p-2', '--accept']);
  const stale = flow(root, ['workflow', 'build', 'decide', '--build', build.id, '--proposal', 'p-3', '--accept'], { allowFailure: true });
  assert.match(stale.stderr + stale.stdout, /Proposal p-3 no longer fits what the build has accepted since: Step 'pay-triage' is already in this workflow\./u);
  const runbook = json(root, ['workflow', 'build', 'status', '--build', build.id]).build.items.find((entry) => entry.kind === 'api-call');
  json(root, ['workflow', 'build', 'propose', '--build', build.id, '--proposal', '-'], { input: JSON.stringify({ title: 'Jira stays manual', why: 'The release captain moves the ticket by hand.',
    moves: [{ move: 'item.leaveOut', item: runbook.id, reason: 'The release captain moves the ticket by hand.' }] }) });
  json(root, ['workflow', 'build', 'decide', '--build', build.id, '--proposal', 'p-4', '--decline', '--reason', 'We want it automated later.']);
  json(root, ['workflow', 'build', 'propose', '--build', build.id, '--proposal', '-'], { input: JSON.stringify({ title: 'Jira stays manual for now', why: 'Automation comes later.',
    moves: [{ move: 'item.leaveOut', item: runbook.id, reason: 'Automation comes later.' }] }) });
  const final = json(root, ['workflow', 'build', 'decide', '--build', build.id, '--proposal', 'p-5', '--accept']).build;
  assert.deepEqual(final.proposals.map((entry) => entry.status), ['accepted', 'accepted', 'stale', 'declined', 'accepted']);
  assert.equal(final.proposals[3].reason, 'We want it automated later.');
  assert.deepEqual([final.items.find((entry) => entry.id === runbook.id).status, final.items.find((entry) => entry.id === runbook.id).reason], ['left-out', 'Automation comes later.']);
  const result = json(root, ['workflow', 'build', 'check', '--build', build.id]);
  assert.deepEqual(result.draft.workflow.phases, ['pay-triage', 'requirements', 'pay-build', 'pay-pci-review']);
  assert.equal(result.changeSet.changes.find((change) => change.id === 'pay-triage').copyOf, 'intake');
});

test('starting from a workflow copies it; finishing writes a bundle that imports, or one reviewed proposal on the approved configuration', async () => {
  const { run, flow, json } = await harness();
  const { initializeDefinition } = await import('../src/config.mjs');
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-build-finish-'));
  const seed = path.join(base, 'seed'); const remote = path.join(base, 'application.git');
  run('git', ['init', '-q', '-b', 'main', seed], base);
  run('git', ['config', 'user.name', 'Build Tester'], seed); run('git', ['config', 'user.email', 'build@example.com'], seed);
  await initializeDefinition(seed);
  await writeFile(path.join(seed, 'README.md'), '# Application\n');
  run('git', ['add', '-A'], seed); run('git', ['commit', '-qm', 'baseline'], seed);
  run('git', ['init', '-q', '--bare', '--initial-branch=main', remote], base);
  run('git', ['remote', 'add', 'origin', remote], seed); run('git', ['push', '-q', '-u', 'origin', 'main'], seed);
  run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config'], seed);
  const approved = run('git', ['rev-parse', 'HEAD'], seed).stdout.trim();

  const build = json(seed, ['workflow', 'build', 'start', '--from-workflow', 'chore', '--name', 'Chore with notes']).build;
  const start = json(seed, ['workflow', 'build', 'check', '--build', build.id]);
  assert.deepEqual(start.changeSet.changes.map((change) => [change.op, change.copyOf ?? null]), [['workflow.create', 'chore']], 'a copy of the workflow it starts from');
  const steps = start.draft.workflow.phases;
  json(seed, ['workflow', 'build', 'propose', '--build', build.id, '--proposal', '-'], { input: JSON.stringify({ title: 'Release notes at the end', why: 'The team writes release notes after every chore.',
    moves: [{ move: 'step.add', id: 'chore-notes', label: 'Release notes', after: steps.at(-1), agent: 'product-owner', output: 'document', reads: [steps.at(-1)],
      signOff: { groups: ['product-approvers'] }, purpose: 'Tells users what changed.' }] }) });
  json(seed, ['workflow', 'build', 'decide', '--build', build.id, '--proposal', 'p-1', '--accept']);

  const out = path.join(base, 'chore-with-notes.sflow-workflows.json');
  const bundle = json(seed, ['workflow', 'build', 'finish', '--build', build.id, '--out', out]);
  assert.deepEqual([bundle.resultType, bundle.kind, bundle.path], ['workflow-build-finish', 'bundle', out]);
  const { readWorkflowBundle } = await import('../src/workflow-transfer.mjs');
  const read = await readWorkflowBundle(out);
  assert.equal(read.bundleSha256, bundle.bundleSha256);
  assert.equal(run('git', ['status', '--porcelain'], seed).stdout, '', 'a bundle is written outside the repository only');

  const proposal = json(seed, ['workflow', 'build', 'finish', '--build', build.id, '--propose']);
  assert.equal(proposal.reviewRequired, true, JSON.stringify(proposal));
  assert.match(proposal.branch, /^sflow\/config-change\/workflow\/studio-/);
  assert.match(run('git', ['--git-dir', remote, 'show', `${proposal.branch}:singularity/workflow.yml`], base).stdout, /chore-with-notes:/u);
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/sflow/config'], base).stdout.trim(), approved, 'nothing is approved until review');
  const finished = json(seed, ['workflow', 'build', 'status', '--build', build.id]).build;
  assert.match(finished.conversation.at(-1).text, /^Created one configuration proposal from this build\./u);
});
