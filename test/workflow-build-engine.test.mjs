import { repositoryOwnedWorkflows, requirementsTemplatePlansCode } from './helpers/repository-owned-workflows.mjs';
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
  await requirementsTemplatePlansCode(root);
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
  // Live Copilot run 2026-10-18: the planned-claims refusal spoke of "authoritative clause phases"
  // and a "resolvable mode required topology"; it now says what to add and names the steps.
  assert.equal(unsaveable.details.findings[0].code, 'STUDIO_PLANNED_CLAIMS');
  assert.match(unsaveable.details.findings[0].message, /^A step that writes code needs a step that defines the requirements at or before the step just before it\. Add one the repository has \([^)]*\brequirements\b[^)]*\), as it is or copied with from, before it\. No move declares a workflow without requirements\./u);
  assert.doesNotMatch(unsaveable.details.findings[0].message, /resolvable mode required topology|omits for scope/u);
  const { movesGuide } = await import('../src/workflow-build/moves.mjs');
  const guide = movesGuide();
  assert.match(guide.proposal.evidence, /^\[\{ path, startLine, endLine \}\]/u, 'the proposal shape is in the guide, not only in refusals');
  for (const rule of [/^Moves apply in order/u, /^A step that writes code \(output code\) needs a step that defines the requirements/u, /^action\.add runs an integration target the repository has registered/u]) {
    assert.ok(guide.rules.some((entry) => rule.test(entry)), String(rule));
  }
  const { readWorkflowBuild } = await import('../src/workflow-build/store.mjs');
  assert.deepEqual((await readWorkflowBuild(build.id, engineEnv)).proposals, [], 'refused proposals leave nothing behind');
  // A group the same proposal adds further down can sign off a step above it (Copilot's second try was refused for the order alone).
  const ordered = await refused({ title: 'Group last', why: 'The group is listed after the step it signs off.', moves: [
    { move: 'step.add', id: 'intake' },
    { move: 'step.add', id: 'pay-review', label: 'Review', after: 'intake', agent: 'architect', output: 'document', signOff: { groups: ['pay-late-group'], minimum: 1 } },
    { move: 'group.add', id: 'pay-late-group', label: 'Late group' }
  ] });
  assert.equal(ordered, null, `refused: ${ordered?.message}`);
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
  const preview = json(root, ['workflow', 'build', 'check', '--build', build.id, '--include', 'p-1']);
  assert.deepEqual(preview.including, { id: 'p-1', title: 'Four steps from release-captain', newSteps: ['intake', 'requirements', 'pay-build', 'pay-pci-review'], changedSteps: [], removedSteps: [] });
  assert.equal(preview.ready, false, 'a preview is never ready to finish');
  assert.deepEqual(preview.preview.workflows.map((workflow) => [workflow.id, workflow.readOnly, workflow.phases]), [['payments-release', true, ['intake', 'requirements', 'pay-build', 'pay-pci-review']]]);
  assert.deepEqual(preview.preview.agents.map((agent) => agent.id).sort(), ['architect', 'pay-captain', 'product-owner']);
  assert.ok(preview.preview.groups.some((group) => group.id === 'payments-security'), 'the canvas can name the new group');
  assert.equal(json(root, ['workflow', 'build', 'status', '--build', build.id]).build.proposals[0].status, 'pending', 'previewing accepts nothing');
  const unknown = flow(root, ['workflow', 'build', 'check', '--build', build.id, '--include', 'p-9'], { allowFailure: true });
  assert.match(unknown.stderr + unknown.stdout, /has no pending proposal 'p-9'/u);

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

test('an accepted proposal uses what it lists after its moves: a classified item is confirmed, a link it keeps stays a link', async () => {
  const { run, flow, json } = await harness();
  const root = await repository(run, flow);
  const folder = await teamFolder();
  const build = json(root, ['workflow', 'build', 'start', '--folder', folder]).build;
  const of = (kind) => build.items.find((entry) => entry.kind === kind);
  const jira = of('api-call');
  const runbook = of('document');
  const proposal = { ...FIRST, items: build.items.map((entry) => entry.id), moves: [...FIRST.moves,
    { move: 'item.classify', item: jira.id, as: 'command' }, { move: 'item.keepAsLink', item: runbook.id }] };
  json(root, ['workflow', 'build', 'propose', '--build', build.id, '--proposal', '-'], { input: JSON.stringify(proposal) });
  const accepted = json(root, ['workflow', 'build', 'decide', '--build', build.id, '--proposal', 'p-1', '--accept']).build;
  const item = (id) => accepted.items.find((entry) => entry.id === id);
  assert.deepEqual([item(jira.id).status, item(jira.id).kind], ['confirmed', 'command'], 'a classified item the proposal uses is used');
  assert.equal(item(runbook.id).status, 'kept-as-link', 'a move that settles an item wins over the list');
  assert.deepEqual(accepted.items.filter((entry) => entry.status === 'open'), []);
  const result = json(root, ['workflow', 'build', 'check', '--build', build.id]);
  assert.equal(result.findings.find((entry) => entry.code === 'BUILD_ITEMS_OPEN'), undefined, JSON.stringify(result.findings));
});

test('an agent file found as its agent and as its process is one file: a proposal that uses either uses both', async () => {
  const { run, flow, json } = await harness();
  const root = await repository(run, flow);
  const folder = await teamFolder();
  for (const kind of ['process', 'agent']) {
    const build = json(root, ['workflow', 'build', 'start', '--folder', folder]).build;
    const twins = build.items.filter((entry) => entry.evidence[0].path === '.github/agents/release-captain.agent.md' && ['process', 'agent'].includes(entry.kind));
    assert.deepEqual(twins.map((entry) => entry.kind).sort(), ['agent', 'process']);
    json(root, ['workflow', 'build', 'propose', '--build', build.id, '--proposal', '-'],
      { input: JSON.stringify({ ...FIRST, items: [twins.find((entry) => entry.kind === kind).id] }) });
    const accepted = json(root, ['workflow', 'build', 'decide', '--build', build.id, '--proposal', 'p-1', '--accept']).build;
    assert.deepEqual(twins.map((twin) => accepted.items.find((entry) => entry.id === twin.id).status), ['confirmed', 'confirmed'], `using the ${kind} uses both`);
    const open = json(root, ['workflow', 'build', 'check', '--build', build.id]).findings.find((entry) => entry.code === 'BUILD_ITEMS_OPEN');
    assert.doesNotMatch(open.detail, /release-captain/u);
  }
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

  // Your own change is accepted as it is recorded; Copilot's never is.
  const link = final.items.find((entry) => entry.kind === 'document');
  const mine = { title: 'Keep the runbook as a link', why: 'People open it during release.', moves: [{ move: 'item.keepAsLink', item: link.id }] };
  const selfAccepted = flow(root, ['workflow', 'build', 'propose', '--build', build.id, '--proposal', '-', '--accept'], { allowFailure: true, input: JSON.stringify(mine) });
  assert.match(selfAccepted.stderr + selfAccepted.stdout, /Only your own proposal can be accepted as it is recorded/u);
  const own = json(root, ['workflow', 'build', 'propose', '--build', build.id, '--proposal', '-', '--by', 'you', '--accept'], { input: JSON.stringify(mine) }).build;
  assert.deepEqual([own.proposals.at(-1).status, own.proposals.at(-1).by, own.items.find((entry) => entry.id === link.id).status], ['accepted', 'you', 'kept-as-link']);
  assert.deepEqual(own.conversation.slice(-2).map((entry) => [entry.by, entry.kind, entry.text]), [['you', 'proposal', 'Keep the runbook as a link'], ['you', 'decision', 'Accepted Keep the runbook as a link.']]);

  // What evidence points at: the captured file as screened and kept, with line numbers.
  const source = json(root, ['workflow', 'build', 'source', '--build', build.id, '--path', 'docs/runbook.md']);
  assert.deepEqual([source.startLine, source.endLine, source.totalLines, source.lines[0]], [1, 5, 5, '# Runbook']);
  assert.match(flow(root, ['workflow', 'build', 'source', '--build', build.id, '--path', 'docs/runbook.md', '--from', '3']).stdout, /^3 {2}curl -X POST https:\/\/jira\.example\.com/mu);
  const missing = flow(root, ['workflow', 'build', 'source', '--build', build.id, '--path', '../secrets.txt'], { allowFailure: true });
  assert.match(missing.stderr + missing.stdout, /captured no file '\.\.\/secrets\.txt'/u);
});

test('a reused step keeps its send-back targets; the check names the one move that repoints them, and the build is ready after it', async () => {
  const { run, flow, json, engineEnv } = await harness();
  const root = await repository(run, flow);
  const build = json(root, ['workflow', 'build', 'start', '--describe', 'A short payments release', '--name', 'Payments release']).build;
  const mine = (title, moves) => json(root, ['workflow', 'build', 'propose', '--build', build.id, '--proposal', '-', '--by', 'you', '--accept'], { input: JSON.stringify({ title, why: 'The team asked for it.', moves }) });
  // Live Copilot run 2026-10-18: the stock Release sends rejected work back to steps this workflow does not have.
  mine('Four steps the repository has', [{ move: 'step.add', id: 'intake', after: null }, { move: 'step.add', id: 'requirements' }, { move: 'step.add', id: 'implementation' }, { move: 'step.add', id: 'release' }]);
  const stuck = json(root, ['workflow', 'build', 'check', '--build', build.id]);
  assert.deepEqual(stuck.draft.workflow.phases, ['intake', 'requirements', 'implementation', 'release']);
  assert.equal(stuck.ready, false);
  const targets = stuck.findings.filter((entry) => entry.severity === 'problem');
  assert.deepEqual(targets.map((entry) => [entry.code, entry.subject.step, entry.detail.match(/returns to '([^']+)'/u)[1]]),
    ['specification', 'planning', 'convergence', 'verification'].map((target) => ['WORKFLOW_REJECTION_TARGET', 'release', target]));
  const fix = { move: 'step.change', id: 'release', signOff: { groups: ['quality-reviewers'], minimum: 1, sendBackTo: ['implementation', 'release'] } };
  for (const entry of targets) {
    assert.deepEqual(entry.fix.move, fix, 'the targets that still fit, with the sign-off as this workflow runs it');
    assert.equal(entry.fix.text, 'Send rejected work back to Implementation or Release instead, with one move: step.change release with signOff { groups: [quality-reviewers], minimum: 1, sendBackTo: [implementation, release] }.');
  }

  // sendBackTo names the step itself or steps before it in this workflow; one an earlier move adds counts.
  const { proposeToBuild } = await import('../src/workflow-build/engine.mjs');
  const refused = async (moves) => (await proposeToBuild(build.id, { title: 'Send back', why: 'Wrong targets.', moves }, { root, ...engineEnv })
    .then(() => assert.fail('recorded'), (error) => error)).details.findings.map((entry) => [entry.at, entry.code]);
  const gate = { move: 'step.add', id: 'pay-gate', label: 'Payment gate', after: 'implementation', agent: 'architect', output: 'document',
    signOff: { groups: ['quality-reviewers'], minimum: 1, sendBackTo: ['implementation', 'pay-gate'] } };
  const repoint = (sendBackTo, extra = {}) => ({ ...fix, signOff: { ...fix.signOff, sendBackTo, ...extra } });
  assert.deepEqual(await refused([{ ...repoint(['release']), id: 'requirements' }]), [['moves[0].signOff.sendBackTo', 'BUILD_MOVE_SEND_BACK']]);
  assert.deepEqual(await refused([repoint(['nowhere'])]), [['moves[0].signOff.sendBackTo', 'BUILD_MOVE_REFERENCE']]);
  assert.deepEqual(await refused([repoint([])]), [['moves[0].signOff.sendBackTo', 'BUILD_MOVE_SIGNOFF']]);
  assert.deepEqual(await refused([repoint(['release'], { rejectTo: ['release'] })]), [['moves[0].signOff.rejectTo', 'BUILD_MOVE_SIGNOFF']]);
  assert.deepEqual(await refused([repoint(['pay-gate']), gate]), [['moves[0].signOff.sendBackTo', 'BUILD_MOVE_REFERENCE']], 'a step a later move adds is not in the workflow yet');
  const pending = json(root, ['workflow', 'build', 'propose', '--build', build.id, '--proposal', '-'], { input: JSON.stringify({ title: 'A gate before release', why: 'Rejected releases go back to the gate.', moves: [gate, repoint(['pay-gate', 'release'])] }) }).build.proposals.at(-1);
  const included = json(root, ['workflow', 'build', 'check', '--build', build.id, '--include', pending.id]);
  assert.deepEqual(included.changeSet.changes.find((change) => change.op === 'phase.create' && change.id === 'pay-gate').approval, { groups: ['quality-reviewers'], minimum: 1, rejectTo: ['implementation', 'pay-gate'] });
  assert.deepEqual(included.changeSet.changes.find((change) => change.op === 'phase.update' && change.id === 'release').approval.rejectTo, ['pay-gate', 'release']);
  json(root, ['workflow', 'build', 'decide', '--build', build.id, '--proposal', pending.id, '--decline']);

  // The fix's move, as it is: one move, and the build is ready. The step itself is untouched; the setting is this workflow's own.
  mine('Release sends rejected work back here', [targets[0].fix.move]);
  const ready = json(root, ['workflow', 'build', 'check', '--build', build.id]);
  assert.deepEqual([ready.ready, ready.counts.problem], [true, 0], JSON.stringify(ready.findings.filter((entry) => entry.severity === 'problem')));
  assert.deepEqual(ready.changeSet.changes.filter((change) => change.op === 'phase.update'),
    [{ op: 'phase.update', id: 'release', workflow: 'payments-release', approval: { groups: ['quality-reviewers'], minimum: 1, rejectTo: ['implementation', 'release'] } }]);
  assert.ok(ready.plan.summary.includes('Release: sign-off and send-back targets changed for Payments release only.'), ready.plan.summary.join('\n'));
  // A later sign-off change that does not name them keeps them, as Studio does.
  mine('Two approvals for a release', [{ move: 'step.change', id: 'release', signOff: { groups: ['quality-reviewers'], minimum: 2 } }]);
  const kept = json(root, ['workflow', 'build', 'check', '--build', build.id]);
  assert.deepEqual(kept.changeSet.changes.find((change) => change.op === 'phase.update').approval, { groups: ['quality-reviewers'], minimum: 2, rejectTo: ['implementation', 'release'] });
  assert.equal(kept.ready, true);
  assert.equal(run('git', ['status', '--porcelain'], root).stdout, '');

  const { movesGuide } = await import('../src/workflow-build/moves.mjs');
  const guide = movesGuide();
  assert.match(guide.values.signOff, /sendBackTo: \[step IDs\]/u);
  assert.ok(guide.rules.some((rule) => /^signOff\.sendBackTo .*the step itself or steps before it in this workflow/u.test(rule)));
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
  const listed = json(seed, ['workflow', 'build', 'status']).builds.find((entry) => entry.id === build.id);
  assert.deepEqual([listed.finished.kind, /^\d+ steps, \d+ agents?/u.test(listed.found)], ['proposal', true], 'the list says what a build holds in words, and that it is finished');

  // Once the approved configuration has the workflow, the build is done: its check is that workflow, and changing it is a new build.
  const merged = run('git', ['--git-dir', remote, 'rev-parse', proposal.branch], base).stdout.trim();
  run('git', ['--git-dir', remote, 'update-ref', 'refs/heads/sflow/config', merged, approved], base);
  run('git', ['fetch', '-q', 'origin'], seed);
  const landed = json(seed, ['workflow', 'build', 'check', '--build', build.id]);
  assert.deepEqual([landed.landed.workflow, landed.landed.label, landed.ready, landed.changeSet.changes, landed.plan.problems], ['chore-with-notes', 'Chore with notes', false, [], []]);
  assert.equal(landed.draft.workflow.phases.at(-1), 'chore-notes');
  assert.match(landed.explanation.summary, /steps/u);
  assert.match(flow(seed, ['workflow', 'build', 'check', '--build', build.id]).stdout, /^Finished: Chore with notes is in the approved configuration\. To change it: singularity-flow workflow build start --from-workflow chore-with-notes$/mu);
  for (const args of [['finish', '--build', build.id, '--propose'], ['propose', '--build', build.id, '--proposal', '-']]) {
    const refused = flow(seed, ['workflow', 'build', ...args], { allowFailure: true, input: JSON.stringify({ title: 'More', why: 'More.', moves: [{ move: 'step.remove', id: 'chore-notes' }] }) });
    assert.match(refused.stderr + refused.stdout, /is finished: Chore with notes is in the approved configuration\. To change it, start a new build from it/u);
  }
});
