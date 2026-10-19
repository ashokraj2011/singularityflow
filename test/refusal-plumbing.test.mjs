/**
 * Every refusal on a Story's path carries the route its producer named, keeps the routes to
 * someone other than the author, and never answers "who decides" with "reject the work".
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { eligibleApprovers, requireApprovalAuthority } from '../src/approval-authority.mjs';
import { completionRecoveryActions } from '../src/completion-verdict.mjs';
import { refusalEnvelope, refusalRemediationPlan, renderRefusalPlan } from '../src/refusal-remediation.mjs';
import { appendLedgerIntent, createLedgerIntent } from '../src/ledger.mjs';
import { blockingUnavailableStories, stateStorySubjectIndex } from '../src/session-story-discovery.mjs';
import { resolveContext } from '../src/repository-subject-index.mjs';
import { storyLifecycleProgress } from '../src/session-roster.mjs';
import { createSessionListingFixture } from '../scripts/session-listing-benchmark.mjs';

const refusal = (code, details = {}, message = code) => Object.assign(new Error(message), { code, details });
const commands = (plan) => plan.steps.map((entry) => entry.command);
const source = (relative) => readFile(new URL(`../src/${relative}`, import.meta.url), 'utf8');

test('a producer\'s nextCommand and each finding\'s own recovery become plan steps', () => {
  const attach = refusalRemediationPlan(refusal('ACTIVE_SUBJECT_MISMATCH', {
    expectedWorkId: 'W-1', actualWorkId: 'W-2', nextCommand: 'singularity-flow session attach W-1 --json'
  }), ['session', 'status', '--json']);
  assert.equal(attach.steps[0].command, 'singularity-flow session attach W-1 --json');

  // finalize: the final Flow Gate's findings name their own recoveries, then the gate is rerun.
  const verdict = { verified: false, errors: ['an acceptance criterion has no passing test'], findings: [
    { code: 'gate.acceptance.untested', recovery: { command: 'singularity-flow evidence matrix W-1 --json', detail: 'See which criterion lacks a passing test.' } }
  ] };
  const final = refusalRemediationPlan(refusal('STORY_FINAL_CHECK_FAILED', {
    findings: verdict.findings, recoveryCommands: completionRecoveryActions(verdict)
  }), ['finalize']);
  assert.deepEqual(commands(final).slice(0, 2), ['singularity-flow evidence matrix W-1 --json', 'singularity-flow gate --terminal']);

  // A gate refusal that carries only findings still reaches each finding's recovery.
  const gate = refusalRemediationPlan(refusal('GOVERNANCE_GATE_FAILED', { findings: [
    { code: 'gate.publication.remote-missing', recovery: { command: 'singularity-flow sync', detail: 'Publish the retained commit.' } },
    { code: 'gate.no-route', recovery: { command: null } }
  ] }), ['gate']);
  assert.equal(gate.steps[0].command, 'singularity-flow sync');
  assert.equal(gate.steps[0].label, 'Publish the retained commit.');
});

test('a capability branch left unpublished at Story start names sync as structured data', async () => {
  for (const relative of ['story-start.mjs', 'commands/start.mjs']) {
    const text = await source(relative);
    const at = text.indexOf("code: 'STORY_CAPABILITY_PUBLICATION_PENDING'");
    assert.ok(at > 0, relative);
    assert.match(text.slice(at, at + 400), /recoveryCommand: \{ command: 'singularity-flow sync'/u, relative);
  }
  const plan = refusalRemediationPlan(refusal('STORY_CAPABILITY_PUBLICATION_PENDING', { workId: 'W-1',
    recoveryCommand: { command: 'singularity-flow sync', label: 'Publish the retained capability branches.' } }),
  ['start', 'W-1', '--from-branch', 'main', '--title', 'T']);
  assert.equal(plan.steps[0].command, 'singularity-flow sync');
});

test('the test-run risk and upstream-issue routes survive the three-step plan', () => {
  const testRunRisk = { eligible: true, phase: 'implement', commandId: 'module-tests',
    command: 'singularity-flow decision test-risk W-1 --phase implement --command module-tests --cause <cause> --reason <reason> --expires <YYYY-MM-DD>' };
  for (const argv of [['submit', 'implement', '--work-id', 'W-1'], ['approve', 'implement', '--work-id', 'W-1']]) {
    const plan = refusalRemediationPlan(refusal('CODE_TEST_ZERO_DISCOVERED', { workId: 'W-1', phase: 'implement', testRunRisk }), argv);
    const ids = plan.steps.map((entry) => entry.id);
    assert.ok(ids.includes('accept-test-run-risk'), `${argv[0]}: ${ids.join(', ')}`);
    assert.equal(plan.steps.length, 4, argv[0]);
    assert.match(renderRefusalPlan(plan), /a person who approves implement can accept the risk in their own terminal; an agent cannot/u);
  }
  // Without an eligible route nothing is added: the plan is the same three steps as before.
  const plain = refusalRemediationPlan(refusal('CODE_TEST_ZERO_DISCOVERED', { workId: 'W-1', phase: 'implement' }),
    ['submit', 'implement', '--work-id', 'W-1']);
  assert.equal(plain.steps.length, 3);
  assert.ok(!plain.steps.some((entry) => entry.id === 'accept-test-run-risk'));

  const upstream = refusalRemediationPlan(refusal('PHASE_INPUTS_NOT_READY', {
    workId: 'W-1', currentPhase: 'planning', upstreamPhases: ['specification'], restorable: true,
    routes: [
      { kind: 'return', label: 'An approver returns planning to specification.', command: 'singularity-flow reject planning --work-id W-1 --to specification --reason <reason>' },
      { kind: 'upstream-issue', label: 'Record the defect for specification\'s approvers.', command: 'singularity-flow upstream-issue raise --work-id W-1 --phase specification --about <clause-or-section> --problem <what-is-wrong>' }
    ]
  }), ['inputs', 'planning']);
  assert.deepEqual(upstream.steps.map((entry) => entry.id),
    ['inspect-upstream-inputs', 'restore-approved-inputs', 'return-or-amend-upstream', 'raise-upstream-issue']);
});

test('an identity outside the approval groups is told who may decide and how to check its Git identity, never to reject', () => {
  const authorities = {
    'quality-reviewers': { label: 'Quality', members: [{ email: 'quality@example.test' }, { githubLogin: 'qa-lead' }] },
    'engineering-reviewers': { label: 'Engineering', members: [{ email: 'engineering@example.test' }] }
  };
  const policy = { authorities: ['quality-reviewers', 'engineering-reviewers'] };
  let refused;
  try { requireApprovalAuthority(authorities, policy, { email: 'Developer@Example.test' }); }
  catch (error) { refused = error; }
  assert.equal(refused.code, 'APPROVAL_IDENTITY_NOT_AUTHORIZED');
  assert.match(refused.message, /^Identity 'developer@example\.test' is not a member of: quality-reviewers, engineering-reviewers\.$/u);
  assert.deepEqual(refused.details.authorities, ['quality-reviewers', 'engineering-reviewers']);
  assert.deepEqual(refused.details.eligibleApprovers, ['quality@example.test', 'github:qa-lead', 'engineering@example.test']);
  assert.deepEqual(eligibleApprovers(authorities, policy, { exclude: 'QUALITY@example.test' }).eligibleApprovers,
    ['github:qa-lead', 'engineering@example.test'], 'the refused or already-recorded identity is never suggested');

  assert.throws(() => requireApprovalAuthority(authorities, policy, { name: 'No identity' }), { code: 'APPROVAL_IDENTITY_MISSING' });

  for (const code of ['APPROVAL_IDENTITY_NOT_AUTHORIZED', 'APPROVAL_IDENTITY_MISSING',
    'APPROVAL_SELF_APPROVAL_PROHIBITED', 'APPROVAL_IDENTITY_ALREADY_RECORDED']) {
    const error = refusal(code, { ...refused.details, phase: 'specification', workId: 'W-1' }, refused.message);
    const plan = refusalRemediationPlan(error, ['approve', 'specification', '--work-id', 'W-1']);
    const text = JSON.stringify(plan);
    assert.doesNotMatch(text, /sf-reject|singularity-flow reject|leave-approval-turn|doctor --json|recommend --json/u, code);
    assert.match(text, /git config user\.email/u, code);
    assert.match(text, /quality-reviewers, engineering-reviewers \(/u, code);
    assert.match(text, /do not reject or resubmit it/u, code);
    assert.equal(plan.context.strategy, 'approval-identity', code);
    assert.equal(plan.context.turn, 'current-turn', code);
    assert.equal(plan.retry.command, null, code);
    const rendered = renderRefusalPlan(plan);
    assert.doesNotMatch(rendered, /Turn boundary|repair in place/u, code);
    assert.match(rendered, /who decides, not what is decided/u, code);
  }
  const self = refusalRemediationPlan(refusal('APPROVAL_SELF_APPROVAL_PROHIBITED',
    { phase: 'specification', authorities: ['quality-reviewers'], eligibleApprovers: ['quality@example.test'] }), ['approve', 'specification']);
  assert.equal(self.steps[0].id, 'ask-other-approver');
  assert.match(self.steps[0].label, /does not let the author of this generation approve specification/u);
});

test('the self-approval and distinct-identity refusals are coded where approval records them', async () => {
  const text = await source('state.mjs');
  for (const code of ['APPROVAL_SELF_APPROVAL_PROHIBITED', 'APPROVAL_IDENTITY_ALREADY_RECORDED']) {
    const at = text.indexOf(`code: '${code}'`);
    assert.ok(at > 0, code);
    assert.match(text.slice(at, at + 300), /eligibleApprovers\(/u, code);
  }
});

test('a clarification answer from an approver is routed to the author\'s checkout, never self-recorded', async () => {
  const plan = refusalRemediationPlan(refusal('CLARIFICATION_AUTHORITY_REQUIRED', {
    phase: 'requirements', workId: 'W-1', authorities: ['product-owners'], eligibleApprovers: ['owner@example.test']
  }), ['clarification', 'record', 'requirements', '--response-file', 'answers.json', '--json']);
  assert.equal(plan.steps[0].id, 'record-answer-in-author-checkout');
  assert.match(plan.steps[0].label, /must be recorded in this checkout/u);
  assert.match(plan.steps[0].label, /a record made in another clone is never seen/u);
  assert.match(plan.steps[0].label, /singularity-flow resume W-1/u);
  assert.match(plan.steps[0].label, /Never record the answer under the author's identity/u);
  assert.match(plan.steps[0].label, /product-owners \(owner@example\.test\)/u);
  assert.equal(plan.steps[1].command, 'singularity-flow clarification status requirements --json');
  const cli = await source('cli.mjs');
  assert.doesNotMatch(cli, /Ask one of them to record the answer\./u);
  assert.match(cli, /One of them records the answer in this checkout, under their own Git identity/u);
});

async function twoStoryFixture(t) {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
  const stories = [];
  for (const [id, schemaVersion] of [['READABLE-1', 11], ['NEWER-1', 999]]) {
    const branch = `team/${id.toLowerCase()}`;
    const state = { schemaVersion, workItem: { id, title: `Story ${id}`, branch, workType: 'feature', createdAt: '2026-10-18T00:00:00Z' },
      lineage: { canonicalBranch: branch }, status: 'in_progress', currentPhase: 'specification', phaseOrder: ['specification'],
      phases: { specification: { id: 'specification', label: 'Specification', status: 'in_progress', generation: 0, artifacts: [],
        checks: [], approvals: [], approvalPolicy: { minimum: 1, authorities: ['quality-reviewers'] } } },
      resolution: { phases: [{ id: 'specification', label: 'Specification' }] }, history: [] };
    f.git(f.source, 'switch', '--quiet', '-c', branch, 'main');
    const file = path.join(f.source, f.definition.workItemRoot, id, 'workflow.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(state));
    f.git(f.source, 'add', '.'); f.git(f.source, 'commit', '--quiet', '-m', `retain ${id}`);
    f.git(f.source, 'push', '--quiet', 'origin', branch);
    const commit = f.git(f.source, 'rev-parse', 'HEAD');
    // The ledger summary is withheld so discovery proves each Story from its committed state.
    await appendLedgerIntent(f.source, { ...f.definition.ledger, pinTransport: 'none' }, createLedgerIntent({
      eventType: 'binding', capabilityId: 'fixture', actor: { name: 'Fixture', email: 'fixture@example.invalid' },
      subject: { kind: 'story', workId: id, branch, workType: 'feature', title: state.workItem.title, status: state.status,
        currentPhase: state.currentPhase, progress: storyLifecycleProgress({ ...state, schemaVersion: 11 }) }
    }), commit);
    stories.push({ id, branch, commit });
  }
  return { ...f, stories };
}

test('one Story written by a newer build blocks only a lookup that may be that Story, with its upgrade route', async (t) => {
  const f = await twoStoryFixture(t);
  const index = await stateStorySubjectIndex(f.original, f.definition, { fetch: true, reference: 'READABLE-1' });
  assert.equal(resolveContext(index, { reference: 'READABLE-1', kind: 'story' }).canonicalBranch, 'team/readable-1');
  const byBranch = await stateStorySubjectIndex(f.original, f.definition, { fetch: true, reference: 'team/readable-1' });
  assert.equal(resolveContext(byBranch, { reference: 'team/readable-1', kind: 'story' }).id, 'READABLE-1');
  for (const reference of ['NEWER-1', 'an-unknown-alias', null]) {
    await assert.rejects(stateStorySubjectIndex(f.original, f.definition, { fetch: true, reference }), (error) => {
      assert.equal(error.code, 'SCHEMA_VERSION_FUTURE', `${reference}: ${error.code} ${JSON.stringify(error.details)}`);
      assert.deepEqual(error.details.workIds, ['NEWER-1']);
      assert.equal(error.details.unavailable[0].code, 'SESSION_STORY_INVALID');
      assert.equal(error.details.unavailable[0].sourceCode, 'SCHEMA_VERSION_FUTURE');
      assert.match(error.message, /written by a newer sflow/u);
      const plan = refusalEnvelope(error, ['resume', 'NEWER-1']).remediationPlan;
      assert.equal(plan.steps[0].command, 'singularity-flow product status');
      return true;
    });
  }
});

test('only the requested Story, or every Story when the reference is unknown, can block a lookup', () => {
  const roster = {
    items: [{ id: 'A-1', branch: 'team/a-1' }],
    unavailable: [
      { code: 'SESSION_STORY_INVALID', claimedId: 'B-1', branch: 'team/b-1', sourceCode: 'SCHEMA_VERSION_FUTURE' },
      { code: 'SESSION_METADATA_RECOVERY_UNAVAILABLE', claimedId: null, branch: null }
    ]
  };
  assert.deepEqual(blockingUnavailableStories(roster, 'A-1'), []);
  assert.deepEqual(blockingUnavailableStories(roster, 'team/a-1'), []);
  assert.deepEqual(blockingUnavailableStories(roster, 'B-1').map((entry) => entry.claimedId), ['B-1']);
  assert.deepEqual(blockingUnavailableStories(roster, 'team/b-1').map((entry) => entry.claimedId), ['B-1']);
  assert.equal(blockingUnavailableStories(roster, 'JIRA-7').length, 2, 'an alias may belong to an unreadable Story');
  assert.equal(blockingUnavailableStories(roster).length, 2, 'a listing still needs every Story');
  const shared = { items: [{ id: 'A-1', branch: 'team/shared' }], unavailable: [{ code: 'SESSION_STORY_INVALID', claimedId: 'C-1', branch: 'team/shared' }] };
  assert.equal(blockingUnavailableStories(shared, 'A-1').length, 1, 'an unreadable claim on the same branch still blocks');
});
