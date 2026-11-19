/**
 * A person never composes a command [owner, 2026-11-19]: each route below used to leave a value to look up
 * (a digest, a branch, a workspace, a question, a step) and now hands it over filled in. The audit entry
 * each one fixes is named beside it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { proposalRoutes, proposalListLines } from '../src/configuration-proposal-list.mjs';
import { importPlanText } from '../src/workflow-transfer-resolution.mjs';
import { personRecordRoute } from '../src/presence/story-verify.mjs';
import { refreshStoryApprovers } from '../src/commands/story-approvers.mjs';

const refusal = (code, details = {}) => Object.assign(new Error('refused'), { code, details });
const commands = (plan) => plan.steps.map((entry) => entry.command);
const REVISION = '0123456789abcdef0123456789abcdef01234567';

test('a configuration proposal row carries a whole approve and a whole reject, only the reason open [entry 23]', () => {
  const routes = proposalRoutes('sflow/proposals/people-1', REVISION, 'proposed');
  assert.equal(routes.act.command, `singularity-flow configuration approve sflow/proposals/people-1 --confirm ${REVISION}`);
  assert.equal(routes.reject.command, `singularity-flow configuration reject sflow/proposals/people-1 --confirm ${REVISION} --reason "<REASON>"`);
  // On a lead, `--lead` before `--confirm`; one that needs a choice or would be refused is read before it is approved.
  assert.equal(proposalRoutes('sflow/capabilities/web', REVISION, 'proposed', 'https://git.example.test/lead.git').reject.command,
    `singularity-flow configuration reject sflow/capabilities/web --lead https://git.example.test/lead.git --confirm ${REVISION} --reason "<REASON>"`);
  assert.equal(proposalRoutes('sflow/proposals/people-2', REVISION, 'needs-choice').act.command, 'singularity-flow configuration approve sflow/proposals/people-2');
  const lines = proposalListLines({ sources: [], proposals: [{ kind: 'people', state: 'proposed', branch: 'sflow/proposals/people-1', subjects: [],
    ...routes }] }).join('\n');
  assert.match(lines, /next: singularity-flow configuration approve sflow\/proposals\/people-1 --confirm 0123/u);
  assert.match(lines, /or reject it: singularity-flow configuration reject sflow\/proposals\/people-1 --confirm 0123[0-9a-f]+ --reason "<REASON>"/u);
});

test('an import preview gives each choice as a whole command and is applied by its routes, never a digest to copy [entry 14]', () => {
  const blocked = { status: 'blocked', counts: { add: 1, conflicts: 1 }, resolutions: {},
    unresolved: [{ kind: 'phase', id: 'release-plan', subject: 'phase:release-plan', reasons: ['Yours differs.'], usedBy: [],
      choices: ['rename', 'keep'], suggested: 'rename', renameTo: 'release-plan-imported' }] };
  const text = importPlanText(blocked, 'release.json').join('\n');
  assert.match(text, /To import theirs as release-plan-imported; yours stays as it is \(suggested\):\n {6}singularity-flow workflow import release\.json --dry-run --resolve phase:release-plan=rename:release-plan-imported/u);
  assert.match(text, /To keep yours; the import uses your step:\n {6}singularity-flow workflow import release\.json --dry-run --resolve phase:release-plan=keep/u);
  assert.doesNotMatch(text, /--resolve …|^ {4}--resolve /mu);
  const ready = { status: 'ready', counts: { add: 1 }, planSha256: `sha256:${'a'.repeat(64)}`, resolutions: { 'phase:release-plan': { action: 'keep' } } };
  const routed = importPlanText(ready, 'release.json', { routeLines: (command, indent) => [`${indent}- Shell: ${command.length}`] }).join('\n');
  assert.match(routed, /Apply it:\n {2}- Shell: \d+/u);
  assert.doesNotMatch(routed, /Confirm plan|sha256:a{64}/u, 'the person reads the routes, never the digest');
});

test('a test-policy record that does not count is redone through its preview, with its step filled [entry 11]', () => {
  const workflow = { workItem: { id: 'PAY-1' } };
  assert.equal(personRecordRoute(workflow, { list: 'testCommandAmendments', record: { phaseId: 'build' } }),
    'the approver previews the test-policy amendment again in their own terminal and runs the command it gives: singularity-flow story test-policy amend --work-id PAY-1 --phase build --reason "<why>"');
  assert.equal(personRecordRoute(workflow, { list: 'testRecovery.selectionConfirmations', record: { phaseId: 'build' } }),
    'the reviewer reads the test selection again in their own terminal and runs the command it gives to confirm it: singularity-flow story test-policy plan --work-id PAY-1 --phase build');
});

test('a confirmation that is not the refresh preview\'s routes back to the preview, filled in [entry 10]', async () => {
  await assert.rejects(refreshStoryApprovers({ root: '/nonexistent', positionals: ['PAY-1'], options: { confirm: 'abc', reason: 'Two reviewers joined the team.' } }), (error) => {
    assert.equal(error.code, 'APR_CONFIRMATION_REQUIRED');
    assert.equal(error.details.nextAction.command, 'singularity-flow story approvers refresh PAY-1 --reason "Two reviewers joined the team."');
    return true;
  });
});

test('no branch in every repository: each starts from its own usual branch, in one whole command [entry 12]', () => {
  const plan = refusalRemediationPlan(refusal('STORY_BASE_REQUIRED', { branches: [], repositoryBases: { api: 'main', web: 'develop' } }),
    ['start', 'PAY-2', '--title', 'Split payments']);
  assert.deepEqual(commands(plan).slice(0, 2), ["singularity-flow start PAY-2 --title 'Split payments' --from-branch api=main --from-branch web=develop",
    'singularity-flow resume PAY-2 --fetch']);
});

test('a missing workspace is one whole selection per workspace this machine knows, last opened first [entry 13]', () => {
  const workspaces = [{ id: 'payments', name: 'Payments' }, { id: 'search', name: 'search' }, { id: 'billing', name: 'Billing' }];
  const session = refusalRemediationPlan(refusal('SESSION_REPOSITORY_REQUIRED', { workspaces }), ['session', 'attach', 'PAY-1']);
  assert.deepEqual(commands(session), ['singularity-flow session workspace payments', 'singularity-flow session workspace search', 'singularity-flow workspace list --json']);
  assert.match(session.steps[0].label, /Payments \(payments\), opened last/u);
  const inbox = refusalRemediationPlan(refusal('SESSION_REPOSITORY_UNAVAILABLE', { workspaces }), ['inbox']);
  assert.deepEqual(commands(inbox).slice(0, 2), ['singularity-flow workspace use payments', 'singularity-flow workspace use search']);
  // None known: the list, never a <WORKSPACE> to fill in.
  const none = commands(refusalRemediationPlan(refusal('SESSION_REPOSITORY_REQUIRED', { workspaces: [] }), ['session', 'attach', 'PAY-1']));
  assert.equal(none[0], 'singularity-flow workspace list --json');
  assert.ok(!none.some((command) => /<WORKSPACE>/u.test(command ?? '')), none.join('\n'));
});

test('the planned-claim contract a workflow\'s steps suggest is one whole workflow edit [entry 26]', () => {
  const plan = refusalRemediationPlan(refusal('WORKFLOW_PLANNED_CLAIMS_MIGRATION_REQUIRED', { workType: 'feature',
    steps: [['requirements', 'clauses'], ['planning', ''], ['implementation', 'code'], ['review', '']] }), ['start', 'PAY-3']);
  assert.ok(commands(plan).includes('singularity-flow workflow edit feature --planned-claims required --clause-phases requirements --claim-owners implementation=planning'),
    commands(plan).join('\n'));
  const unsuggested = refusalRemediationPlan(refusal('WORKFLOW_PLANNED_CLAIMS_MIGRATION_REQUIRED', { workType: 'feature' }), ['start', 'PAY-3']);
  assert.ok(!commands(unsuggested).some((command) => /<[A-Z]/u.test(command ?? '')), commands(unsuggested).join('\n'));
});

test('a closed Story reopens at its named final step [entry 28]', () => {
  const plan = refusalRemediationPlan(refusal('WITNESS_EXCEPTION_STORY_CLOSED', { workId: 'PAY-4', finalStep: 'release' }),
    ['decision', 'witness-exception', 'PAY-4']);
  assert.equal(plan.steps[0].command, 'singularity-flow reopen PAY-4 --to release --reason "<why the exception is renewed>"');
  assert.match(plan.steps[0].label, /final step, release,/u);
});

test('an approval identity refusal names the Git setting for each listed address [entry 30]', () => {
  const plan = refusalRemediationPlan(refusal('APPROVAL_IDENTITY_NOT_AUTHORIZED', { identity: 'dev@example.test', phase: 'build',
    authorities: ['engineering'], eligibleApprovers: ['lead@example.test', 'octo-login'] }), ['approve', 'build']);
  const listed = plan.steps.find((entry) => entry.id === 'set-listed-address');
  assert.equal(listed.label, 'To decide as a listed address, set it here: git config user.email lead@example.test.');
  assert.equal(plan.steps.at(-1).id, 'ask-eligible-member');
});

test('the Repository brief names the step the refused command named, or none [entry 31]', () => {
  assert.equal(refusalRemediationPlan(refusal('WMB_REMOVED'), ['wm', 'view', '--phase', 'design']).steps[0].command, 'singularity-flow wm brief --phase design');
  assert.equal(refusalRemediationPlan(refusal('COMMAND_REMOVED'), ['wm', 'register']).steps[0].command, 'singularity-flow wm brief');
});
