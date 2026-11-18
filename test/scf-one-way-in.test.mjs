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
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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

const rejectBranch = (f, branch) => run('git', ['--git-dir', f.remote, 'update-ref', '-d', `refs/heads/${branch}`]);

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

test('a repository whose groups name nobody else never turns self-approval off, and a refused self-approval names who else may (review 11-17)', async () => {
  const f = await fixture({ reviewers: [] });
  try {
    const before = tip(f);
    // Alone, turning it off would leave every later configuration change, the one turning it back on included, waiting forever.
    await assert.rejects(publishCurrentIdentityToConfiguration(f.alice, { target: '*', allowSelfApproval: false }), (error) => {
      assert.equal(error.code, 'CONFIGURATION_SELF_APPROVAL_NO_SECOND_PERSON');
      assert.match(error.message, /^Self-approval stays on: the approval groups name only you \(Alice Example <alice@example\.test>\)/u);
      assert.match(error.message, /Nothing was proposed/u);
      assert.equal(error.details.nextAction.command, 'singularity-flow configuration add-current-identity');
      return true;
    });
    assert.equal(tip(f), before);
    assert.equal(branches(f, 'sflow/config-change/people/').length, 0, 'nothing was proposed');
    // The same change made another way (by hand, or by an older build) is refused at approval when its proposer approves it.
    const byHand = await propose(f.alice, 'self-approval-off', (definition) => { definition.approvalSecurity = { ...definition.approvalSecurity, allowSelfApproval: false }; });
    await assert.rejects(approve(f.alice, byHand.branch, byHand.commit), (error) => {
      assert.equal(error.code, 'CONFIGURATION_SELF_APPROVAL_NO_SECOND_PERSON');
      assert.match(error.message, /yourself would turn self-approval off with nobody named, so nobody could approve a later change\. Nothing was changed\./u);
      assert.equal(error.details.nextAction.label, 'Another person approves it');
      return true;
    });
    assert.equal(tip(f), before);
    await rejectBranch(f, byHand.branch);
    // The route works: Bob adds himself, Alice approves that, then she may turn self-approval off.
    const bob = await publishCurrentIdentityToConfiguration(f.bob, { target: 'story:engineering-reviewers' });
    assert.equal(bob.proposed, true);
    assert.equal((await approve(f.alice, bob.proposal.branch, bob.proposal.commit)).activated, true);
    const off = await publishCurrentIdentityToConfiguration(f.alice, { target: '*', allowSelfApproval: false });
    assert.equal(off.proposed, true);
    assert.equal((await approve(f.alice, off.proposal.branch, off.proposal.commit)).activated, true);
    assert.equal(approved(f).approvalSecurity.allowSelfApproval, false);
    // Her own change now waits for someone else, and the refusal names who.
    const change = await propose(f.alice, 'label', (definition) => { definition.workTypes.feature.label = 'Feature, reviewed twice'; });
    await assert.rejects(approve(f.alice, change.branch, change.commit), (error) => {
      assert.equal(error.code, 'CONFIGURATION_SELF_APPROVAL_REFUSED');
      assert.match(error.message, /The approval groups name Bob Example <bob@example\.test>; any of them can approve it\./u);
      return true;
    });
    assert.equal((await approve(f.bob, change.branch, change.commit)).activated, true);
  } finally { await f.done(); }
});

/** A proposal that adds a workflow, as an import makes it, and may also name its proposer in Engineering reviewers. */
function proposeNewWorkflow(checkout, id, { addMe = null, edit = () => {} } = {}) {
  return proposeConfigurationChange(checkout, { operation: 'import-workflows', subject: id,
    async mutate(root) {
      const file = path.join(root, WORKFLOW);
      const definition = YAML.parse(await readFile(file, 'utf8'));
      definition.workTypes[id] = { ...structuredClone(definition.workTypes.feature), label: `Imported ${id}` };
      if (addMe) definition.approvalAuthorities['engineering-reviewers'].members.push({ email: addMe });
      edit(definition);
      await writeFile(file, YAML.stringify(definition));
      return { id };
    } });
}

async function removeAlice(f) {
  const removal = await propose(f.bob, `remove-alice-${Date.now()}`, (definition) => {
    const group = definition.approvalAuthorities['engineering-reviewers'];
    group.members = group.members.filter((member) => member.email !== 'alice@example.test');
  });
  assert.equal((await approve(f.bob, removal.branch, removal.commit)).activated, true);
}

test('a workflow\'s creator approves its import in full, even where it puts them back in a group they were removed from (owner, 2026-11-18)', async () => {
  const f = await fixture();
  try {
    await publishCurrentIdentityToConfiguration(f.alice, { target: '*', automatic: true });
    await removeAlice(f);
    assert.deepEqual(reviewersOf(f), ['bob@example.test']);
    // The office case: her import's bundle names her in the group again.
    const imported = await proposeNewWorkflow(f.alice, 'qa-flow', { addMe: 'alice@example.test' });
    const shown = await inspectWorkflowConfigurationProposal(f.alice, imported.branch);
    const { proposalViewLines } = await import('../src/configuration-approval-view.mjs');
    assert.ok(proposalViewLines(shown, { approver: { name: 'Alice Example', email: 'alice@example.test' } }).includes(
      'This also puts you in engineering-reviewers. If an earlier approved change removed you, you may still approve it yourself as the workflow\'s creator; the approval commit records that it put you back.'),
    'the approve view says so before anyone confirms');
    const landed = await approve(f.alice, imported.branch, imported.commit);
    assert.equal(landed.activated, true);
    assert.equal(landed.approval.selfApproved, true);
    assert.deepEqual(landed.approval.readmitted, [{ scope: 'story', id: 'engineering-reviewers' }]);
    assert.match(message(f), /^Sflow-Readmitted: Alice Example <alice@example\.test> to story:engineering-reviewers$/mu, 'the approval commit records it');
    assert.match(message(f), /^Self-approved: yes$/mu);
    assert.ok(reviewersOf(f).includes('alice@example.test'));
    assert.ok(approved(f).workTypes['qa-flow']);

    // An edit of an existing workflow that puts her back is still someone else's to approve.
    await removeAlice(f);
    const edited = await propose(f.alice, 'relabel', (definition) => {
      definition.workTypes.feature.label = 'Feature, relabelled';
      definition.approvalAuthorities['engineering-reviewers'].members.push({ email: 'alice@example.test' });
    });
    const before = tip(f);
    await assert.rejects(approve(f.alice, edited.branch, edited.commit), (error) => {
      assert.equal(error.code, 'CONFIGURATION_SELF_READMISSION_REFUSED');
      assert.equal(error.message, 'This approval would add you back to engineering-reviewers, which an approved change removed you from. Someone else must approve it; nothing was changed.');
      return true;
    });
    assert.equal(tip(f), before);
  } finally { await f.done(); }
});

test('a workflow\'s creator still cannot turn self-approval off with nobody else named, nor approve where self-approval is off (owner, 2026-11-18)', async () => {
  const solo = await fixture({ reviewers: [] });
  try {
    const off = await proposeNewWorkflow(solo.alice, 'solo-flow', { edit: (definition) => {
      definition.approvalSecurity = { ...definition.approvalSecurity, allowSelfApproval: false };
    } });
    await assert.rejects(approve(solo.alice, off.branch, off.commit), (error) => {
      assert.equal(error.code, 'CONFIGURATION_SELF_APPROVAL_NO_SECOND_PERSON');
      assert.match(error.message, /yourself would turn self-approval off with nobody named, so nobody could approve a later change\. Nothing was changed\./u);
      return true;
    });
  } finally { await solo.done(); }
  const strict = await fixture({ security: { allowSelfApproval: false } });
  try {
    const imported = await proposeNewWorkflow(strict.alice, 'strict-flow');
    await assert.rejects(approve(strict.alice, imported.branch, imported.commit), (error) => {
      assert.equal(error.code, 'CONFIGURATION_SELF_APPROVAL_REFUSED');
      assert.match(error.message, /^You proposed \S+, and this repository needs another person to approve it \(allowSelfApproval is false\)\. Nothing was changed\./u);
      return true;
    });
    assert.equal((await approve(strict.bob, imported.branch, imported.commit)).activated, true, 'another person approves it');
  } finally { await strict.done(); }
});

test('a workflow that workflow validate calls invalid cannot be approved (ER-F7)', async () => {
  const f = await fixture();
  try {
    const thin = await propose(f.alice, 'thin-flow', (definition) => {
      definition.workTypes['thin-flow'] = { label: 'Thin flow', phases: ['requirements', 'implementation'] };
    });
    const before = tip(f);
    // The named fix route: the fix is made in the proposal, so its proposer withdraws it and anyone else rejects it
    // with the problems as its reason, bound to the revision refused. This proposal was made in one step, with no
    // drafts saved on this machine, so its proposer withdraws the proposal itself: no drafts come back.
    await assert.rejects(approve(f.alice, thin.branch, thin.commit), (error) => {
      assert.equal(error.code, 'WORKFLOW_PROPOSAL_PROBLEMS');
      assert.ok(error.details.problems.every((problem) => problem.workflow === 'thin-flow'));
      assert.equal(error.details.nextAction.command,
        `singularity-flow configuration reject ${thin.branch} --confirm ${thin.commit} --reason "workflow validate reports ${error.details.problems.length === 1 ? 'a problem' : 'problems'} in thin-flow"`);
      // Made again the way it was made: every way of making a workflow now repairs or refuses before proposing.
      assert.equal(error.details.nextAction.label, 'Withdraw your proposal, then make the change again');
      assert.match(error.message, /Withdraw your proposal, then make the change again: that now repairs or refuses it first\./u);
      assert.doesNotMatch(`${error.message} ${error.details.nextAction.label}`, /drafts|without them/u);
      return true;
    });
    // An import is imported again: its preview now adds what a template lacks and shows any other problem with its fix.
    const imported = await proposeConfigurationChange(f.alice, { operation: 'import-workflows', subject: 'thin-import',
      async mutate(root) {
        const file = path.join(root, WORKFLOW);
        const definition = YAML.parse(await readFile(file, 'utf8'));
        definition.workTypes['thin-import'] = { label: 'Thin import', phases: ['requirements', 'implementation'] };
        await writeFile(file, YAML.stringify(definition));
        return { id: 'thin-import' };
      } });
    await assert.rejects(approve(f.alice, imported.branch, imported.commit), (error) => {
      assert.equal(error.code, 'WORKFLOW_PROPOSAL_PROBLEMS');
      assert.equal(error.details.nextAction.label, 'Withdraw your proposal, then import the bundle again');
      assert.match(error.message, /Withdraw your proposal, then import the bundle again: that now repairs or refuses it first\./u);
      return true;
    });
    await rejectBranch(f, imported.branch);
    // A proposal recorded on this machine that held no saved drafts gives none back: it names the Studio edits to make
    // again instead (review 11-17, finding 7).
    const { draftsDirectory, PROPOSED_SCHEMA } = await import('../src/configuration-drafts.mjs');
    await mkdir(draftsDirectory(f.alice), { recursive: true });
    const recordProposed = (proposed) => writeFile(path.join(draftsDirectory(f.alice), 'proposed.json'),
      `${JSON.stringify({ schema: PROPOSED_SCHEMA, revision: 1, proposed: { branch: thin.branch, ...proposed } }, null, 2)}\n`);
    await recordProposed({ draftIds: [], changes: ['Create workflow thin-flow'], held: [] });
    await assert.rejects(approve(f.alice, thin.branch, thin.commit), (error) => {
      assert.equal(error.code, 'WORKFLOW_PROPOSAL_PROBLEMS');
      assert.equal(error.details.nextAction.label, 'Withdraw your proposal, then make the change again');
      assert.match(error.message, /Withdraw it; it held no drafts, so redo in Workflow Studio: Create workflow thin-flow\./u);
      assert.doesNotMatch(error.message, /drafts come back/u);
      assert.deepEqual(error.details.redo, ['Create workflow thin-flow']);
      return true;
    });
    // A proposal of drafts saved on this machine gives them back when it is withdrawn (rejectProposal): that one says so.
    await recordProposed({ draftIds: ['d-1'], changes: ['Create workflow thin-flow'], held: [{ draftId: 'd-1', description: 'Create workflow thin-flow' }] });
    await assert.rejects(approve(f.alice, thin.branch, thin.commit), (error) => {
      assert.equal(error.code, 'WORKFLOW_PROPOSAL_PROBLEMS');
      assert.equal(error.details.nextAction.label, 'Withdraw it, fix your drafts, then propose again');
      assert.match(error.message, /Withdraw it: your drafts come back to fix, then propose them again\./u);
      return true;
    });
    await assert.rejects(approve(f.bob, thin.branch, thin.commit), (error) => {
      assert.equal(error.code, 'WORKFLOW_PROPOSAL_PROBLEMS');
      assert.match(error.details.nextAction.label, /Reject it, so its proposer fixes it/u);
      assert.match(error.details.nextAction.command, /^singularity-flow configuration reject .* --reason "workflow validate reports/u);
      return true;
    });
    assert.equal(tip(f), before, 'nothing landed');
    // A change that adds no problem still lands.
    const label = await propose(f.alice, 'label', (definition) => { definition.workTypes.feature.label = 'Feature, relabelled'; });
    assert.equal((await approve(f.alice, label.branch, label.commit)).activated, true);
  } finally { await f.done(); }
});
