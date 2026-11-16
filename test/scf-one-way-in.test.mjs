/**
 * SPEC-SCF stage 3: one way in [SCF:REQ-004, REQ-010 to REQ-013, D4, D5].
 *
 * Each scenario is a finding of the edit-and-review analysis: Story-start enrollment added back someone a
 * reviewed change had removed, as a direct push (ER-F3); configuration changes had no second-person policy
 * and no record of self-approval (ER-F4); a workflow `workflow validate` calls invalid could be activated
 * (ER-F7). Enrollment is now a people proposal, approved in the same step by the starter where policy
 * allows (D5), and every approval follows approvalSecurity.allowSelfApproval (D4).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import YAML from 'yaml';
import { run } from '../src/util.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { proposeConfigurationChange, activateWorkflowConfigurationProposal, inspectWorkflowConfigurationProposal,
  listWorkflowConfigurationProposals } from '../src/configuration-proposal.mjs';
import { publishCurrentIdentityToConfiguration, enrollmentPendingNotice } from '../src/configuration-people.mjs';
import { CONFIGURATION_STATE_PATH } from '../src/configuration-state-contract.mjs';

const WORKFLOW = 'singularity/workflow.yml';
const PEOPLE = [['alice', 'Alice Example', 'alice@example.test'], ['bob', 'Bob Example', 'bob@example.test'],
  ['carol', 'Carol Example', 'carol@example.test']];

async function fixture({ security = {}, reviewers = ['bob@example.test'] } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-scf3-'));
  const seed = path.join(base, 'seed'), remote = path.join(base, 'remote.git');
  run('git', ['init', '-q', '-b', 'main', seed]);
  run('git', ['config', 'user.name', 'Seed Author'], { cwd: seed });
  run('git', ['config', 'user.email', 'seed@example.test'], { cwd: seed });
  await initializeDefinition(seed);
  const file = path.join(seed, WORKFLOW);
  const definition = YAML.parse(await readFile(file, 'utf8'));
  definition.approvalSecurity = { ...definition.approvalSecurity, ...security };
  definition.approvalAuthorities['engineering-reviewers'].members = reviewers.map((email) => ({ email }));
  await writeFile(file, YAML.stringify(definition));
  run('git', ['add', '-A'], { cwd: seed });
  run('git', ['commit', '-qm', 'baseline'], { cwd: seed });
  run('git', ['init', '-q', '--bare', remote]);
  run('git', ['--git-dir', remote, 'config', 'uploadpack.allowFilter', 'true']);
  run('git', ['--git-dir', remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);
  run('git', ['remote', 'add', 'origin', remote], { cwd: seed });
  run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config'], { cwd: seed });
  const clones = {};
  for (const [key, name, email] of PEOPLE) {
    clones[key] = path.join(base, key);
    run('git', ['clone', '-q', '-b', 'sflow/config', remote, clones[key]]);
    run('git', ['config', 'user.name', name], { cwd: clones[key] });
    run('git', ['config', 'user.email', email], { cwd: clones[key] });
  }
  const previous = process.env.SINGULARITY_FLOW_TRANSPORT_OUTBOX;
  process.env.SINGULARITY_FLOW_TRANSPORT_OUTBOX = path.join(base, 'outbox');
  return { base, remote, ...clones, async done() {
    if (previous == null) delete process.env.SINGULARITY_FLOW_TRANSPORT_OUTBOX;
    else process.env.SINGULARITY_FLOW_TRANSPORT_OUTBOX = previous;
    await rm(base, { recursive: true, force: true });
  } };
}

const approved = (f) => YAML.parse(run('git', ['--git-dir', f.remote, 'show', `sflow/config:${WORKFLOW}`]).stdout);
const tip = (f, ref = 'sflow/config') => run('git', ['--git-dir', f.remote, 'rev-parse', ref]).stdout.trim();
const message = (f, ref = 'sflow/config') => run('git', ['--git-dir', f.remote, 'log', '-1', '--format=%B', ref]).stdout;
const reviewersOf = (f) => approved(f).approvalAuthorities['engineering-reviewers'].members.map((member) => member.email);
const branches = (f, prefix) => run('git', ['--git-dir', f.remote, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`]).stdout
  .split('\n').filter(Boolean);

function propose(checkout, subject, edit) {
  return proposeConfigurationChange(checkout, { operation: 'edit-workflow', subject,
    async mutate(root) {
      const file = path.join(root, WORKFLOW);
      const definition = YAML.parse(await readFile(file, 'utf8'));
      edit(definition);
      await writeFile(file, YAML.stringify(definition));
      return { id: subject };
    } });
}
const approve = (checkout, branch, commit) => activateWorkflowConfigurationProposal(checkout, branch,
  { confirm: commit, acknowledgeUnprotected: true });

test('a newcomer approves their own enrollment at Story start, recorded as a self-approval in one approval commit (D5)', async () => {
  const f = await fixture();
  try {
    const before = tip(f);
    const enrolled = await publishCurrentIdentityToConfiguration(f.alice, { target: '*', automatic: true });
    assert.equal(enrolled.changed, true);
    assert.equal(enrolled.pushed, true, 'the approval landed on sflow/config');
    assert.equal(enrolled.selfApproved, true);
    assert.match(enrolled.proposal.branch, /^sflow\/config-change\/people\/enroll-by[0-9a-f]{8}-/u);
    assert.equal(tip(f), enrolled.commit);
    const parents = run('git', ['--git-dir', f.remote, 'rev-parse', `${enrolled.commit}^1`, `${enrolled.commit}^2`]).stdout.trim().split('\n');
    assert.deepEqual(parents, [before, enrolled.proposal.commit], 'sflow/config first, the people proposal second');
    const text = message(f);
    assert.match(text, /Proposed-by: Alice Example <alice@example\.test>/u);
    assert.match(text, /Approved-by: Alice Example <alice@example\.test>/u);
    assert.match(text, /Self-approved: yes/u);
    assert.ok(reviewersOf(f).includes('alice@example.test'));
    assert.equal(branches(f, 'sflow/config-change/people/').length, 0, 'an approval at Story start leaves no waiting proposal');
  } finally { await f.done(); }
});

test('Story-start enrollment never adds back someone a reviewed change removed (ER-F3)', async () => {
  const f = await fixture();
  try {
    await publishCurrentIdentityToConfiguration(f.alice, { target: '*', automatic: true });
    assert.ok(reviewersOf(f).includes('alice@example.test'));
    // Bob proposes and approves removing Alice from Engineering reviewers.
    const removal = await propose(f.bob, 'remove-alice', (definition) => {
      const group = definition.approvalAuthorities['engineering-reviewers'];
      group.members = group.members.filter((member) => member.email !== 'alice@example.test');
    });
    assert.equal((await approve(f.bob, removal.branch, removal.commit)).activated, true);
    assert.deepEqual(reviewersOf(f), ['bob@example.test']);
    const removedAt = tip(f);

    // Alice starts another Story: she is not added back, and nothing is pushed.
    const again = await publishCurrentIdentityToConfiguration(f.alice, { target: '*', automatic: true });
    assert.equal(again.changed, false);
    assert.deepEqual(again.keptOut, [{ id: 'engineering-reviewers', scope: 'story' }]);
    assert.equal(tip(f), removedAt, 'sflow/config did not move');
    assert.deepEqual(reviewersOf(f), ['bob@example.test']);

    // Asking explicitly is a people proposal that someone else must approve.
    const asked = await publishCurrentIdentityToConfiguration(f.alice, { target: 'story:engineering-reviewers' });
    assert.equal(asked.pushed, false);
    assert.equal(asked.proposed, true);
    assert.deepEqual(asked.previouslyRemoved, ['story:engineering-reviewers']);
    assert.match(asked.proposal.branch, /^sflow\/config-change\/people\/add-identity-/u);
    const listed = (await listWorkflowConfigurationProposals(f.bob)).find((entry) => entry.branch === asked.proposal.branch);
    assert.equal(listed?.kind, 'people', 'the one list shows people proposals');
    assert.equal(listed?.proposer?.email, 'alice@example.test');
    await assert.rejects(approve(f.alice, asked.proposal.branch, asked.proposal.commit), { code: 'CONFIGURATION_SELF_READMISSION_REFUSED' });
    assert.equal(tip(f), removedAt);
    const readmitted = await approve(f.bob, asked.proposal.branch, asked.proposal.commit);
    assert.equal(readmitted.activated, true);
    assert.equal(readmitted.approval.selfApproved, false);
    assert.ok(reviewersOf(f).includes('alice@example.test'), 'another person may add her back');
  } finally { await f.done(); }
});

test('with self-approval off, a configuration change needs a second person, and enrollment waits as a people proposal (D4)', async () => {
  const f = await fixture({ security: { allowSelfApproval: false } });
  try {
    const receiptBefore = run('git', ['--git-dir', f.remote, 'show', `sflow/config:${CONFIGURATION_STATE_PATH}`], { allowFailure: true }).stdout;
    const change = await propose(f.alice, 'label', (definition) => { definition.workTypes.feature.label = 'Feature, reviewed twice'; });
    const shown = await inspectWorkflowConfigurationProposal(f.alice, change.branch);
    assert.equal(shown.approvalPolicy.allowSelfApproval, false);
    const { proposalViewLines } = await import('../src/configuration-approval-view.mjs');
    assert.ok(proposalViewLines(shown, { approver: { email: 'alice@example.test' } }).some((line) => /needs another person to approve/u.test(line)),
      'the approve view says so before anyone is asked');
    await assert.rejects(approve(f.alice, change.branch, change.commit), { code: 'CONFIGURATION_SELF_APPROVAL_REFUSED' });
    const landed = await approve(f.bob, change.branch, change.commit);
    assert.equal(landed.activated, true);
    assert.equal(landed.approval.selfApproved, false);
    assert.equal(run('git', ['--git-dir', f.remote, 'log', '-1', '--format=%an|%cn', 'sflow/config']).stdout.trim(), 'Alice Example|Bob Example');
    assert.equal(approved(f).workTypes.feature.label, 'Feature, reviewed twice');

    // Carol's first Story start may not approve her own enrollment: it waits, once.
    const atStart = tip(f);
    const enrolled = await publishCurrentIdentityToConfiguration(f.carol, { target: '*', automatic: true });
    assert.equal(enrolled.pushed, false);
    assert.equal(enrolled.proposed, true);
    assert.equal(enrolled.selfApproved, false);
    assert.equal(tip(f), atStart, 'the Story starts without her as an approver');
    assert.match(enrollmentPendingNotice(enrolled).message, /waits for approval as people proposal .*another person/u);
    const second = await publishCurrentIdentityToConfiguration(f.carol, { target: '*', automatic: true });
    assert.equal(second.proposal.existing, true, 'a later Story start does not propose it again');
    assert.equal(branches(f, 'sflow/config-change/people/').length, 1);
    await assert.rejects(approve(f.carol, enrolled.proposal.branch, enrolled.proposal.commit), { code: 'CONFIGURATION_SELF_APPROVAL_REFUSED' });
    const receiptMid = run('git', ['--git-dir', f.remote, 'show', `sflow/config:${CONFIGURATION_STATE_PATH}`]).stdout;
    const people = await approve(f.bob, enrolled.proposal.branch, enrolled.proposal.commit);
    assert.equal(people.activated, true);
    assert.ok(reviewersOf(f).includes('carol@example.test'));
    assert.match(message(f), /Sflow-Proposal: sflow\/config-change\/people\//u);
    assert.equal(run('git', ['--git-dir', f.remote, 'show', `sflow/config:${CONFIGURATION_STATE_PATH}`]).stdout, receiptMid,
      'a people approval leaves the receipt older builds check untouched');
    assert.notEqual(receiptMid, receiptBefore, 'the workflow approval was recorded in it');
  } finally { await f.done(); }
});

test('a workflow that workflow validate calls invalid cannot be approved (ER-F7)', async () => {
  const f = await fixture();
  try {
    const thin = await propose(f.alice, 'thin-flow', (definition) => {
      definition.workTypes['thin-flow'] = { label: 'Thin flow', phases: ['requirements', 'implementation'] };
    });
    const before = tip(f);
    await assert.rejects(approve(f.alice, thin.branch, thin.commit), (error) => {
      assert.equal(error.code, 'WORKFLOW_PROPOSAL_PROBLEMS');
      assert.ok(error.details.problems.every((problem) => problem.workflow === 'thin-flow'));
      assert.match(error.details.nextAction.command, /workflow fix thin-flow/u);
      return true;
    });
    assert.equal(tip(f), before, 'nothing landed');
    // A change that adds no problem still lands.
    const label = await propose(f.alice, 'label', (definition) => { definition.workTypes.feature.label = 'Feature, relabelled'; });
    assert.equal((await approve(f.alice, label.branch, label.commit)).activated, true);
  } finally { await f.done(); }
});
