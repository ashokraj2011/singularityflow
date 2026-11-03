import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { actionActor } from '../src/git.mjs';
import { actionActor as commandActor } from '../src/commands/kernel.mjs';
import { loadSession, restoreAgentSession } from '../src/session.mjs';
import { evaluateApproval } from '../src/state.mjs';
import { submittedPlanningStory } from './helpers/submitted-planning-story.mjs';

test('approval previews and commands resolve the same explicit automation actor', () => {
  const previous = process.env.SINGULARITY_FLOW_GITHUB_ACTOR;
  try {
    process.env.SINGULARITY_FLOW_GITHUB_ACTOR = 'approval-runner';
    assert.deepEqual(actionActor('/unused'), { name: 'approval-runner', login: 'approval-runner', email: null });
    assert.deepEqual(commandActor('/unused'), actionActor('/unused'));
  } finally {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_GITHUB_ACTOR;
    else process.env.SINGULARITY_FLOW_GITHUB_ACTOR = previous;
  }
});

test('submitted phases preview the current reviewer without creating or requiring an author session', async t => {
  const id = 'PREVIEW-IDENTITY';
  const { git, cli, item } = await submittedPlanningStory(t, id);
  const root = git('rev-parse', '--show-toplevel');
  const originalSession = await loadSession(root);
  await restoreAgentSession(root, null);
  const before = { head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain=v1'),
    workflow: await readFile(path.join(item, 'workflow.json')) };
  const accepted = await loadAcceptedStoryExecution(root, id);
  const config = accepted.definition;
  const workflow = accepted.workflow;
  const check = (value = workflow) => evaluateApproval(root, config, structuredClone(value), { preview: true });

  const checked = await check();
  assert.deepEqual(checked.holds, []);
  assert.deepEqual(checked.decision.actor, actionActor(root));
  assert.equal(checked.decision.agent, null);
  for (const argv of [
    ['status', id, '--submission-readiness', '--json'],
    ['phase', 'show', 'planning', '--json']
  ]) {
    const value = JSON.parse(cli(...argv).stdout);
    assert.equal(value.approvalCheck.ready, true, JSON.stringify(value.approvalCheck));
    assert.deepEqual(value.approvalCheck.holds, []);
  }
  const decisions = JSON.parse(cli('decisions', id, '--json').stdout).data;
  assert.ok(decisions.items.some(entry => entry.kind === 'approval'));
  assert.ok(decisions.items.every(entry => entry.kind !== 'approval-hold'), JSON.stringify(decisions.items));
  assert.equal(decisions.next.copilotCommand, `/sf-approve planning --work-id ${id}`);
  assert.equal(decisions.next.command, `singularity-flow approve planning --work-id ${id} --fetch`);
  assert.doesNotMatch(JSON.stringify(decisions), /No active agent session|resume <WORK-ID>/u);
  assert.equal(await loadSession(root, { required: false }), null, 'read-only checks never create a session');
  assert.equal(git('rev-parse', 'HEAD'), before.head);
  assert.equal(git('status', '--porcelain=v1'), before.status);
  assert.ok(before.workflow.equals(await readFile(path.join(item, 'workflow.json'))));

  // A previous author is presentation context, not the next reviewer's authority or identity.
  await restoreAgentSession(root, { ...originalSession,
    actor: { name: 'Previous Author', email: 'previous-author@example.test', login: null } });
  const stale = await check();
  assert.deepEqual(stale.holds, []);
  assert.deepEqual(stale.decision.actor, actionActor(root));
  assert.notEqual(stale.decision.actor.email, 'previous-author@example.test');

  // No session must not mean unrestricted approval: authority and self-approval still apply.
  await restoreAgentSession(root, null);
  const unauthorized = structuredClone(workflow);
  for (const authority of Object.values(unauthorized.resolution.approvalAuthorities)) {
    authority.allowAnyGitIdentity = false;
    authority.members = [];
  }
  assert.ok((await check(unauthorized)).holds.some(error => error.code === 'APPROVAL_IDENTITY_NOT_AUTHORIZED'));
  const selfApproval = structuredClone(workflow);
  selfApproval.phases.planning.generatedBy = actionActor(root);
  selfApproval.phases.planning.approvalPolicy.allowSelfApproval = false;
  assert.ok((await check(selfApproval)).holds.some(error => error.code === 'APPROVAL_SELF_APPROVAL_PROHIBITED'));

  // The selected read-only reviewer keeps its role restriction even with a different actor.
  const reviewer = structuredClone(workflow);
  reviewer.resolution.sourceReview.reviewerAgent = originalSession.agent;
  await restoreAgentSession(root, originalSession);
  assert.ok((await check(reviewer)).holds.some(error => error.code === 'SOURCE_REVIEW_REVIEWER_CANNOT_APPROVE'));
});
