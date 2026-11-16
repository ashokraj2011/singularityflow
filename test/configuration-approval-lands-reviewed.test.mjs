/**
 * SPEC-SCF stage 2: approval lands exactly what was reviewed [SCF:REQ-005 to REQ-009, REQ-018].
 *
 * Each scenario is one of the ways a proposal's change used to differ from what landed (finding
 * ER-F1): a second commit on the proposal, the Git host's "Update branch" merge, `sflow/config`
 * moving after the proposal was made, and a field both sides changed. Separate proposers get separate
 * proposal IDs (ER-F9), and the approve view shows the values that land (ER-F6).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import YAML from 'yaml';
import { run } from '../src/util.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { proposeConfigurationChange, activateWorkflowConfigurationProposal, inspectWorkflowConfigurationProposal,
  listWorkflowConfigurationProposals, removeRejectedConfigurationProposal } from '../src/configuration-proposal.mjs';
import { configurationRejectionRecord } from '../src/configuration-rejection.mjs';
import { CONFIGURATION_STATE_PATH, readConfigurationState } from '../src/configuration-state-contract.mjs';
import { remoteFingerprint } from '../src/git-remote-diagnostics.mjs';
import { approveProposal, rejectProposal } from '../src/configuration-drafts.mjs';

const WORKFLOW = 'singularity/workflow.yml';

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-scf2-'));
  const seed = path.join(base, 'seed'), remote = path.join(base, 'remote.git'), story = path.join(base, 'story'), other = path.join(base, 'other');
  run('git', ['init', '-q', '-b', 'main', seed]);
  run('git', ['config', 'user.name', 'Config Author'], { cwd: seed });
  run('git', ['config', 'user.email', 'config@example.test'], { cwd: seed });
  await initializeDefinition(seed);
  run('git', ['add', '-A'], { cwd: seed });
  run('git', ['commit', '-qm', 'baseline'], { cwd: seed });
  run('git', ['init', '-q', '--bare', remote]);
  run('git', ['--git-dir', remote, 'config', 'uploadpack.allowFilter', 'true']);
  run('git', ['--git-dir', remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);
  run('git', ['remote', 'add', 'origin', remote], { cwd: seed });
  run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config'], { cwd: seed });
  for (const [clone, name, email] of [[story, 'Config Author', 'config@example.test'], [other, 'Second Author', 'second@example.test']]) {
    run('git', ['clone', '-q', '-b', 'sflow/config', remote, clone]);
    run('git', ['config', 'user.name', name], { cwd: clone });
    run('git', ['config', 'user.email', email], { cwd: clone });
  }
  const env = { ...process.env, NODE_ENV: 'test', NO_COLOR: '1',
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json') };
  return { base, seed, remote, story, other, env };
}

/** One proposal from `checkout` that edits the workflow definition through `edit(definition)`. */
function propose(f, checkout, subject, edit, { expectedAuthority = null } = {}) {
  return proposeConfigurationChange(checkout, { operation: 'edit-workflow', subject, expectedAuthority,
    async mutate(root) {
      const file = path.join(root, WORKFLOW);
      const definition = YAML.parse(await readFile(file, 'utf8'));
      edit(definition);
      await writeFile(file, YAML.stringify(definition));
      return { id: subject };
    }
  }, { env: f.env });
}
const approved = (f) => YAML.parse(run('git', ['--git-dir', f.remote, 'show', `sflow/config:${WORKFLOW}`]).stdout);
const tip = (f, ref) => run('git', ['--git-dir', f.remote, 'rev-parse', ref]).stdout.trim();
const activate = (f, branch, commit, choices = null) => activateWorkflowConfigurationProposal(f.story, branch,
  { confirm: commit, acknowledgeUnprotected: true, ...(choices ? { choices } : {}) });

/** A commit pushed onto `branch` from a working clone, as a teammate or a reviewer's suggestion on the Git host would. */
async function pushOnto(f, branch, edit, message) {
  const work = path.join(f.base, `work-${Math.random().toString(16).slice(2)}`);
  run('git', ['clone', '-q', '-b', branch, f.remote, work]);
  run('git', ['config', 'user.name', 'Branch Helper'], { cwd: work });
  run('git', ['config', 'user.email', 'helper@example.test'], { cwd: work });
  const file = path.join(work, WORKFLOW);
  const definition = YAML.parse(await readFile(file, 'utf8'));
  edit(definition);
  await writeFile(file, YAML.stringify(definition));
  run('git', ['commit', '-qam', message], { cwd: work });
  run('git', ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: work });
  return run('git', ['rev-parse', 'HEAD'], { cwd: work }).stdout.trim();
}

/** The Git host's "Update branch": sflow/config merged into the proposal branch. */
function hostUpdateBranch(f, branch) {
  const work = path.join(f.base, `merge-${Math.random().toString(16).slice(2)}`);
  run('git', ['clone', '-q', '-b', branch, f.remote, work]);
  run('git', ['config', 'user.name', 'Git Host'], { cwd: work });
  run('git', ['config', 'user.email', 'host@example.test'], { cwd: work });
  run('git', ['fetch', '-q', 'origin', 'sflow/config'], { cwd: work });
  run('git', ['merge', '-q', '--no-edit', '--no-ff', 'FETCH_HEAD', '-m', "Merge branch 'sflow/config' into proposal"], { cwd: work });
  run('git', ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`], { cwd: work });
  return run('git', ['rev-parse', 'HEAD'], { cwd: work }).stdout.trim();
}

test('a proposal with a second commit lands both commits, exactly as reviewed from its merge base', async () => {
  const f = await fixture();
  try {
    const first = await propose(f, f.story, 'team-flow', (definition) => {
      definition.workTypes['team-flow'] = { ...definition.workTypes.feature, label: 'Team flow' };
    });
    const second = await pushOnto(f, first.branch, (definition) => { definition.workTypes.feature.label = 'Feature, reviewed'; }, 'second commit');
    const reviewed = await inspectWorkflowConfigurationProposal(f.story, first.branch);
    assert.equal(reviewed.proposalCommit, second);
    assert.equal(reviewed.proposalBase, reviewed.mergeBase, 'the change is read from the merge base, not the tip\'s parent');
    assert.equal(reviewed.valid, true);
    assert.deepEqual(reviewed.workflows.map((row) => row.id).sort(), ['feature', 'team-flow']);
    assert.equal(reviewed.proposer.email, 'config@example.test', 'the first own commit names the proposer');
    const outcome = await activate(f, first.branch, second);
    assert.equal(outcome.activated, true);
    const definition = approved(f);
    assert.equal(definition.workTypes['team-flow']?.label, 'Team flow', 'the first commit landed');
    assert.equal(definition.workTypes.feature.label, 'Feature, reviewed', 'the second commit landed');
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('the Git host\'s "Update branch" merge keeps a proposal valid, and approval lands only its own change', async () => {
  const f = await fixture();
  try {
    const mine = await propose(f, f.story, 'team-flow', (definition) => {
      definition.workTypes['team-flow'] = { ...definition.workTypes.feature, label: 'Team flow' };
    });
    // Another proposal (a new skill, so the host's text merge is clean) is approved first: sflow/config
    // moves and gains a new receipt.
    const theirs = await proposeConfigurationChange(f.other, { operation: 'add-skill', subject: 'theirs',
      async mutate(root) {
        await mkdir(path.join(root, 'singularity/skill-library/theirs'), { recursive: true });
        await writeFile(path.join(root, 'singularity/skill-library/theirs/SKILL.md'),
          '---\nname: theirs\ndescription: Approved before the host merge.\n---\n\nCheck the change.\n');
        return { id: 'theirs' };
      } }, { env: f.env });
    assert.equal((await activate(f, theirs.branch, theirs.commit)).activated, true);
    const merged = hostUpdateBranch(f, mine.branch);
    const reviewed = await inspectWorkflowConfigurationProposal(f.story, mine.branch);
    assert.equal(reviewed.proposalCommit, merged);
    assert.equal(reviewed.valid, true, `${reviewed.failure?.message ?? ''} ${reviewed.invalidFiles}`);
    assert.equal(reviewed.state, 'proposed');
    assert.deepEqual(reviewed.workflows.map((row) => row.id), ['team-flow'], 'the merged-in configuration is not the proposal\'s change');
    assert.equal(reviewed.changedFiles.some((entry) => entry.paths.includes(CONFIGURATION_STATE_PATH)), false);
    const listed = (await listWorkflowConfigurationProposals(f.story)).find((row) => row.branch === mine.branch);
    assert.equal(listed.valid, true, 'the list and approval agree');
    const outcome = await activate(f, mine.branch, merged);
    assert.equal(outcome.activated, true);
    const definition = approved(f);
    assert.equal(definition.workTypes['team-flow'].label, 'Team flow');
    assert.match(run('git', ['--git-dir', f.remote, 'ls-tree', '-r', '--name-only', 'sflow/config']).stdout,
      /singularity\/skill-library\/theirs\/SKILL\.md/u, 'the earlier approval is kept');
    assert.equal(readConfigurationState(run('git', ['--git-dir', f.remote, 'show', `sflow/config:${CONFIGURATION_STATE_PATH}`]).stdout).revision, 2);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('when sflow/config moved after the proposal, approval re-applies its field edits on top and keeps the newer values', async () => {
  const f = await fixture();
  try {
    const mine = await propose(f, f.story, 'feature', (definition) => { definition.workTypes.feature.label = 'Feature, mine'; });
    const theirs = await propose(f, f.other, 'chore', (definition) => { definition.workTypes.chore.label = 'Chore, theirs'; });
    assert.equal((await activate(f, theirs.branch, theirs.commit)).activated, true);
    const reviewed = await inspectWorkflowConfigurationProposal(f.story, mine.branch);
    assert.equal(reviewed.state, 'proposed');
    const landed = reviewed.lands.fields.find((file) => file.path === WORKFLOW).values;
    assert.deepEqual(landed.map((change) => change.pointer), ['/workTypes/feature/label'], 'only the proposal\'s own field lands');
    assert.deepEqual(landed[0].after, { value: 'Feature, mine' });
    assert.ok(reviewed.viewLines.some((line) => line.includes('workTypes › feature › label:') && line.includes('"Feature, mine"')), reviewed.viewLines.join('\n'));
    assert.equal((await activate(f, mine.branch, mine.commit)).activated, true);
    const definition = approved(f);
    assert.equal(definition.workTypes.feature.label, 'Feature, mine');
    assert.equal(definition.workTypes.chore.label, 'Chore, theirs', 'the newer approved value stays');
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('a field both sides changed is the approver\'s pick: refused without one, landed with it, and recorded', async () => {
  const f = await fixture();
  try {
    const mine = await propose(f, f.story, 'feature', (definition) => { definition.workTypes.feature.label = 'Feature, mine'; });
    const theirs = await propose(f, f.other, 'feature', (definition) => {
      definition.workTypes.feature.label = 'Feature, theirs';
      definition.workTypes.feature.description = 'Theirs, unrelated';
    });
    assert.equal((await activate(f, theirs.branch, theirs.commit)).activated, true);
    const key = `${WORKFLOW}#/workTypes/feature/label`;
    const reviewed = await inspectWorkflowConfigurationProposal(f.story, mine.branch);
    assert.equal(reviewed.state, 'needs-choice');
    assert.equal(reviewed.lands.clashes.length, 1);
    assert.deepEqual(reviewed.lands.clashes[0], { key, path: WORKFLOW, kind: 'value', pointer: '/workTypes/feature/label',
      base: { value: approvedLabel(f, reviewed.mergeBase) }, proposal: { value: 'Feature, mine' }, current: { value: 'Feature, theirs' } });
    assert.ok(reviewed.viewLines.some((line) => line.includes(`--pick '${key}=proposal'`)), reviewed.viewLines.join('\n'));
    assert.match(reviewed.activation.command, /--pick '.*#\/workTypes\/feature\/label=<proposal\|current>'/u);
    await assert.rejects(() => activate(f, mine.branch, mine.commit), (error) => error.code === 'CONFIGURATION_ENTITY_CONFLICT'
      && error.details.clashes[0].key === key && /--pick/u.test(error.details.nextAction.command)
      && !/recreate-sync/u.test(JSON.stringify(error.details)));
    assert.equal(approved(f).workTypes.feature.label, 'Feature, theirs', 'nothing landed without a pick');
    await assert.rejects(() => activate(f, mine.branch, mine.commit, new Map([[`${WORKFLOW}#/workTypes/chore/label`, 'proposal']])),
      (error) => error.code === 'CONFIGURATION_CHOICE_STALE', 'a pick for a field that is not a clash is refused');
    const picked = await activate(f, mine.branch, mine.commit, new Map([[key, 'proposal']]));
    assert.equal(picked.activated, true);
    assert.deepEqual(picked.approval.picked, [{ key, pick: 'proposal' }]);
    assert.equal(picked.approval.selfApproved, true, 'the proposer approved it');
    const definition = approved(f);
    assert.equal(definition.workTypes.feature.label, 'Feature, mine');
    assert.equal(definition.workTypes.feature.description, 'Theirs, unrelated', 'the field nobody clashed on keeps the newer value');
    const message = run('git', ['--git-dir', f.remote, 'log', '-1', '--format=%an <%ae>%n%cn <%ce>%n%B', 'sflow/config']).stdout;
    assert.match(message, /^Config Author <config@example\.test>\nConfig Author <config@example\.test>\n\[configuration\] activate cft-/u);
    assert.match(message, /^Proposed-by: Config Author <config@example\.test>$/mu);
    assert.match(message, /^Approved-by: Config Author <config@example\.test>$/mu);
    assert.match(message, /^Self-approved: yes$/mu);
    assert.match(message, new RegExp(`^Sflow-Picked: proposal ${key.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')}$`, 'mu'));
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

function approvedLabel(f, commit) {
  return YAML.parse(run('git', ['--git-dir', f.remote, 'show', `${commit}:${WORKFLOW}`]).stdout).workTypes.feature.label;
}

test('keeping sflow/config\'s value is a pick too; another person\'s approval names both people', async () => {
  const f = await fixture();
  try {
    const mine = await propose(f, f.story, 'feature', (definition) => {
      definition.workTypes.feature.label = 'Feature, mine';
      definition.workTypes.chore.label = 'Chore, mine';
    });
    const theirs = await propose(f, f.other, 'feature', (definition) => { definition.workTypes.feature.label = 'Feature, theirs'; });
    assert.equal((await activate(f, theirs.branch, theirs.commit)).activated, true);
    const outcome = await activateWorkflowConfigurationProposal(f.other, mine.branch, { confirm: mine.commit, acknowledgeUnprotected: true,
      choices: new Map([[`${WORKFLOW}#/workTypes/feature/label`, 'current']]) });
    assert.equal(outcome.activated, true);
    assert.equal(outcome.approval.selfApproved, false);
    const definition = approved(f);
    assert.equal(definition.workTypes.feature.label, 'Feature, theirs');
    assert.equal(definition.workTypes.chore.label, 'Chore, mine');
    const message = run('git', ['--git-dir', f.remote, 'log', '-1', '--format=%an <%ae>|%cn <%ce>%n%B', 'sflow/config']).stdout;
    assert.match(message, /^Config Author <config@example\.test>\|Second Author <second@example\.test>/u, 'author: the proposer; committer: the approver');
    assert.match(message, /^Proposed-by: Config Author <config@example\.test>$/mu);
    assert.match(message, /^Approved-by: Second Author <second@example\.test>$/mu);
    assert.doesNotMatch(message, /Self-approved/u);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('separate proposers get separate proposal IDs; one proposer\'s new save is a revision of theirs', async () => {
  const f = await fixture();
  try {
    const alice = await propose(f, f.story, 'feature', (definition) => { definition.workTypes.feature.label = 'One'; });
    const again = await propose(f, f.story, 'feature', (definition) => { definition.workTypes.feature.label = 'Two'; });
    const bob = await propose(f, f.other, 'feature', (definition) => { definition.workTypes.feature.label = 'Three'; });
    assert.equal(alice.proposalId, again.proposalId, 'a new save by the same person is a revision');
    assert.notEqual(alice.proposalId, bob.proposalId, 'another person\'s proposal is its own');
    assert.notEqual(alice.branch.replace(/-[0-9a-f]{8}-[0-9a-f]{12}$/u, ''), bob.branch.replace(/-[0-9a-f]{8}-[0-9a-f]{12}$/u, ''));
    const rows = await listWorkflowConfigurationProposals(f.story);
    assert.equal(new Set(rows.map((row) => row.proposalId)).size, 2);
    assert.deepEqual(rows.map((row) => row.proposer?.email).sort(), ['config@example.test', 'config@example.test', 'second@example.test']);
    assert.doesNotMatch(bob.branch, /second@example/u, 'the branch name carries no address');
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('a proposal is made on the sflow/config commit its author read, and approval re-applies it on the newer one', async () => {
  const f = await fixture();
  try {
    const read = tip(f, 'sflow/config');
    const theirs = await propose(f, f.other, 'chore', (definition) => { definition.workTypes.chore.label = 'Chore, theirs'; });
    assert.equal((await activate(f, theirs.branch, theirs.commit)).activated, true);
    const mine = await propose(f, f.story, 'feature', (definition) => {
      assert.notEqual(definition.workTypes.chore.label, 'Chore, theirs', 'the edit is made on what the author read');
      definition.workTypes.feature.label = 'Feature, mine';
    }, { expectedAuthority: { kind: 'approved-configuration-ref', commit: read, sourceCommit: read, remoteFingerprint: remoteFingerprint(f.remote) } });
    assert.equal(run('git', ['--git-dir', f.remote, 'rev-parse', `${mine.branch}^`]).stdout.trim(), read, 'its parent is the commit its author read');
    assert.equal((await activate(f, mine.branch, mine.commit)).activated, true);
    const definition = approved(f);
    assert.equal(definition.workTypes.feature.label, 'Feature, mine');
    assert.equal(definition.workTypes.chore.label, 'Chore, theirs', 'a kept draft cannot revert a newer value');
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('configuration approve binds the revision shown: --yes approves only it, and a moved proposal is shown again', async () => {
  const f = await fixture();
  try {
    const mine = await propose(f, f.story, 'feature', (definition) => { definition.workTypes.feature.label = 'Feature, shown'; });
    const printed = [];
    const activations = [];
    const deps = { print: (line) => printed.push(line), list: async () => [], inspect: inspectWorkflowConfigurationProposal,
      activate: async (root, branch, options) => { activations.push(options); return activateWorkflowConfigurationProposal(root, branch, options); },
      identity: () => ({ name: 'Config Author', email: 'config@example.test' }) };
    await assert.rejects(() => approveProposal(f.story, mine.branch, { ...deps, yes: true }),
      (error) => error.code === 'CONFIGURATION_APPROVE_CONFIRMATION_REQUIRED' && error.details.nextAction.includes(`--confirm ${mine.commit}`));
    assert.ok(printed.some((line) => line.includes('workTypes › feature › label:') && line.includes('"Feature, shown"')), printed.join('\n'));
    assert.ok(printed.some((line) => /self-approval/u.test(line)), 'approving one\'s own proposal is disclosed');
    // A teammate's commit lands on the proposal after it was shown.
    const moved = await pushOnto(f, mine.branch, (definition) => { definition.workTypes.feature.description = 'Not shown'; }, 'after the view');
    await assert.rejects(() => approveProposal(f.story, mine.branch, { ...deps, yes: true }),
      (error) => error.code === 'CONFIGURATION_APPROVE_PROPOSAL_MOVED' && error.details.shown === moved);
    await assert.rejects(() => approveProposal(f.story, mine.branch, { ...deps, confirm: mine.commit }),
      (error) => error.code === 'CONFIGURATION_APPROVE_PROPOSAL_MOVED');
    assert.deepEqual(activations, [], 'nothing was approved');
    assert.notEqual(approved(f).workTypes.feature.label, 'Feature, shown');
    const result = await approveProposal(f.story, mine.branch, { ...deps, yes: true });
    assert.equal(result.activated, true);
    assert.equal(activations[0].confirm, moved, '--yes approved exactly the revision shown last');
    assert.equal(approved(f).workTypes.feature.label, 'Feature, shown');
    assert.equal(approved(f).workTypes.feature.description, 'Not shown');
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('a person rejects a proposal with a reason, its author withdraws one: bound to the revision shown, recorded, and never by an agent', async () => {
  const f = await fixture();
  try {
    const mine = await propose(f, f.story, 'feature', (definition) => { definition.workTypes.feature.label = 'Feature, mine'; });
    const recorded = [];
    const deps = (checkout, email, name) => ({ print: () => {}, inspect: inspectWorkflowConfigurationProposal, remove: removeRejectedConfigurationProposal,
      identity: () => ({ name, email }), record: async (_root, fields) => { recorded.push(configurationRejectionRecord(fields)); return { status: 'published' }; } });
    const exists = (branch) => run('git', ['--git-dir', f.remote, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true }).status === 0;
    const reviewer = deps(f.other, 'second@example.test', 'Second Author');
    await assert.rejects(() => rejectProposal(f.other, mine.branch, { ...reviewer, reason: 'Not now' }),
      (error) => error.code === 'CONFIGURATION_APPROVE_CONFIRMATION_REQUIRED' && error.details.nextAction.includes(`--confirm ${mine.commit}`));
    await assert.rejects(() => rejectProposal(f.other, mine.branch, { ...reviewer, confirm: mine.commit, reason: 'Not now', agent: () => true }),
      (error) => error.code === 'PSS_CARD_NOT_SHOWN', 'an agent cannot reject');
    const moved = await pushOnto(f, mine.branch, (definition) => { definition.workTypes.feature.description = 'Later'; }, 'after the view');
    await assert.rejects(() => rejectProposal(f.other, mine.branch, { ...reviewer, confirm: mine.commit, reason: 'Not now' }),
      (error) => error.code === 'CONFIGURATION_APPROVE_PROPOSAL_MOVED');
    assert.equal(exists(mine.branch), true, 'nothing was removed');
    assert.deepEqual(recorded, []);
    const rejected = await rejectProposal(f.other, mine.branch, { ...reviewer, confirm: moved, reason: 'Not now' });
    assert.equal(rejected.status, 'rejected');
    assert.equal(exists(mine.branch), false);
    assert.deepEqual([recorded[0].withdrawn, recorded[0].reason, recorded[0].proposalCommit, recorded[0].rejectedBy.email, recorded[0].proposer.email],
      [false, 'Not now', moved, 'second@example.test', 'config@example.test']);
    const again = await propose(f, f.story, 'chore', (definition) => { definition.workTypes.chore.label = 'Chore, mine'; });
    const withdrawn = await rejectProposal(f.story, again.branch, { ...deps(f.story, 'config@example.test', 'Config Author'), confirm: again.commit });
    assert.equal(withdrawn.status, 'withdrawn', 'a rejection by its own author is a withdrawal');
    assert.equal(recorded[1].withdrawn, true);
    assert.equal(exists(again.branch), false);
    assert.equal(approved(f).workTypes.feature.label !== 'Feature, mine' && approved(f).workTypes.chore.label !== 'Chore, mine', true, 'nothing landed');
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('two versions of a file that is not YAML or JSON: the approver keeps one whole file', async () => {
  const f = await fixture();
  const SKILL = 'singularity/skill-library/house-style/SKILL.md';
  const skill = (checkout, body) => proposeConfigurationChange(checkout, { operation: 'edit-skill', subject: 'house-style',
    async mutate(root) {
      await mkdir(path.join(root, path.dirname(SKILL)), { recursive: true });
      await writeFile(path.join(root, SKILL), `---\nname: house-style\ndescription: How we write.\n---\n\n${body}\n`);
      return { id: 'house-style' };
    } }, { env: f.env });
  try {
    const created = await skill(f.story, 'Write plainly.');
    assert.equal((await activate(f, created.branch, created.commit)).activated, true);
    run('git', ['pull', '-q', '--ff-only', 'origin', 'sflow/config'], { cwd: f.story });
    run('git', ['pull', '-q', '--ff-only', 'origin', 'sflow/config'], { cwd: f.other });
    const mine = await skill(f.story, 'Write plainly, and name the line.');
    const theirs = await skill(f.other, 'Write plainly, in short sentences.');
    assert.equal((await activate(f, theirs.branch, theirs.commit)).activated, true);
    const key = `${SKILL}#/`;
    const reviewed = await inspectWorkflowConfigurationProposal(f.story, mine.branch);
    assert.deepEqual(reviewed.lands.clashes.map((clash) => [clash.key, clash.kind]), [[key, 'file']]);
    assert.match(reviewed.lands.clashes[0].proposal.value, /name the line/u);
    assert.match(reviewed.lands.clashes[0].current.value, /short sentences/u);
    assert.equal((await activate(f, mine.branch, mine.commit, new Map([[key, 'current']]))).activated, true);
    assert.match(run('git', ['--git-dir', f.remote, 'show', `sflow/config:${SKILL}`]).stdout, /short sentences/u);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});
