/**
 * "What can I do next?" is answered by `sflow_next` itself.
 *
 * A live Copilot run (2026-10-24, VS Code agent mode, real model) asked "#sflow_next What can I do
 * next in this repository?" in a repository with one Story waiting in Planning for approval, and
 * made eleven SFlow calls before answering: `next` returned every legal read in registry order and
 * no Story, for both `subject` and `home`, and `resolve` with goal `work.list` came back as a
 * work.continue question for a workId nobody had. These tests drive the same opening calls against
 * the same shape of repository and hold the answer to the first one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { auditedKernel } from '../src/gateway/audit.mjs';
import { planDeveloperConversation } from '../src/gateway/conversation.mjs';
import { createHostGateway } from '../src/gateway/host.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { validateSflowResult } from '../src/gateway/result.mjs';
import { estimateTokens } from '../src/gateway/tools.mjs';
import { run } from '../src/util.mjs';

const ACTOR = { login: 'dev', email: 'dev@example.test', name: 'Dev' };
const AUTHORITIES = {
  developers: {
    label: 'Developers', allowAnyGitIdentity: false, githubTeams: [],
    members: [{ name: ACTOR.name, email: ACTOR.email, githubLogin: ACTOR.login }]
  }
};

/** A Story in Planning, submitted and awaiting a decision this actor may make. */
const waitingStory = (id, at) => ({
  workItem: { id, title: `Story ${id}`, workType: 'feature', branch: `wi/${id}` },
  phaseOrder: ['planning', 'design', 'implementation'],
  currentPhase: 'planning',
  phases: {
    planning: {
      label: 'Planning', status: 'awaiting_approval', generation: 1,
      approvalPolicy: { authorities: ['developers'], minimum: 1, allowSelfApproval: true }
    },
    design: { label: 'Design', status: 'pending' },
    implementation: { label: 'Implementation', status: 'pending' }
  },
  history: [
    { event: 'work_started', phase: 'planning', actor: ACTOR, at },
    { event: 'phase_submitted', phase: 'planning', actor: ACTOR, at }
  ],
  resolution: { approvalAuthorities: AUTHORITIES }
});

/** A Git repository on `main` holding the given Stories' records, with the gateway a host builds. */
async function repository(t, stories, { branch = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-next-answer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.email', ACTOR.email], { cwd: root });
  run('git', ['config', 'user.name', ACTOR.name], { cwd: root });
  for (const [index, id] of stories.entries()) {
    const directory = path.join(root, 'singularity', 'work-items', id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'workflow.json'),
      JSON.stringify(waitingStory(id, `2026-10-24T1${index}:00:00.000Z`)));
  }
  await writeFile(path.join(root, 'README.md'), '# fixture\n');
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-q', '-m', 'first'], { cwd: root });
  if (branch) run('git', ['checkout', '-q', '-b', branch], { cwd: root });
  const { kernel } = createHostGateway({ root, hostSessionId: `next-answer-${stories.join('-')}`, planners: gatewayPlanners() });
  return kernel;
}

/** Each tool call the conversation makes, counted the way the live run was. */
function counted(kernel) {
  const calls = [];
  return {
    calls,
    next: async (request) => { calls.push('sflow_next'); return validateSflowResult(await kernel.next(request)); },
    read: async (request) => { calls.push('sflow_read'); return validateSflowResult(await kernel.read(request)); },
    resolve: async (request) => { calls.push('sflow_resolve'); return validateSflowResult(await kernel.resolve(request)); }
  };
}

test('the first sflow_next carries the waiting Story, its phase and its next action', async (t) => {
  const tools = counted(await repository(t, ['WRK-2018']));

  // The live run's first call: `subject` scope with no subject named.
  const answer = await tools.next({ scope: 'subject' });
  assert.equal(answer.operation.id, 'gateway.next');
  assert.deepEqual({ kind: answer.subject.kind, id: answer.subject.id }, { kind: 'story', id: 'WRK-2018' });
  assert.equal(answer.why[0].code, 'gateway.next-only-open-work');
  assert.deepEqual(
    (({ id, phase, status, group }) => ({ id, phase, status, group }))(answer.data.focus),
    { id: 'WRK-2018', phase: 'planning', status: 'awaiting_approval', group: 'waiting-on-you' }
  );
  assert.equal(answer.data.focus.nextAction.operation, 'review.packet');
  assert.deepEqual({ ...answer.outcome.slots }, { scope: 'subject', count: answer.next.length, work: 'WRK-2018', phase: 'planning' });

  // The Story's action leads the list, as the one filled action, and is a read sflow_read takes.
  const [lead] = answer.next;
  assert.equal(lead.id, 'work:WRK-2018');
  assert.equal(lead.emphasis, 'primary');
  assert.equal(lead.handle, answer.data.focus.nextAction.handle);
  assert.deepEqual([lead.kind, lead.interaction, lead.executable], ['read', 'read', true]);
  assert.deepEqual({ ...lead.slots }, { work: 'WRK-2018', phase: 'planning', status: 'awaiting_approval', group: 'waiting-on-you' });
  assert.equal(answer.next.filter((action) => action.emphasis === 'primary').length, 1);
  // The legal set is still all there, after the work, as phrases rather than more actions.
  assert.equal(answer.next.length, 1);
  assert.equal(answer.data.legal.via, 'sflow_resolve');
  assert.equal(Object.keys(answer.data.legal.utterances).length, answer.data.legal.count);

  // Answering took one call; acting on the answer takes one more, straight from the handle.
  assert.deepEqual(tools.calls, ['sflow_next']);
  const packet = await tools.read({ resolutionId: lead.handle });
  assert.equal(packet.operation.id, 'review.packet');
  assert.equal(packet.kind, 'read');
  assert.deepEqual(tools.calls, ['sflow_next', 'sflow_read']);
});

/**
 * What one `sflow_next` on this fixture may cost, as the compact JSON both hosts hand the model.
 *
 * 22,278 B (~5.6K tokens at four bytes a token) while the legal set followed the Story as 47
 * selections; 4,319 B with it as `data.legal`. The headroom is for registry growth (~42 B an
 * operation) and a longer temporary path, not for a second list of actions.
 */
const NEXT_ANSWER_BYTE_BOUND = 6_000;

test('with work leading, the answer stays small and the legal set is still everything legal now', async (t) => {
  const kernel = await repository(t, ['WRK-2018']);
  const answer = validateSflowResult(await kernel.next({ scope: 'subject' }));
  const text = JSON.stringify(answer);
  const bytes = Buffer.byteLength(text, 'utf8');
  assert.ok(bytes <= NEXT_ANSWER_BYTE_BOUND,
    `sflow_next is ${bytes} B (~${estimateTokens(text)} tokens), over its ${NEXT_ANSWER_BYTE_BOUND} B bound`);

  // A scope that reads no work answers with the legal set as actions: the same operations, in the
  // same order, with the same phrases, and none of them is left out of the compact form.
  const full = kernel.next({ scope: 'investigation' });
  assert.ok(full.next.length > 0);
  assert.deepEqual(Object.entries(answer.data.legal.utterances),
    full.next.map((action) => [action.id.slice('legal:'.length), action.label]));
  assert.equal(answer.data.legal.count, full.next.length);
});

test('each legal phrase is one sflow_resolve from its operation, as a selection handle was', async (t) => {
  const tools = counted(await repository(t, ['WRK-2018']));
  const { legal } = (await tools.next({ scope: 'home' })).data;
  for (const [operation, utterance] of Object.entries(legal.utterances)) {
    assert.equal((await tools.resolve({ utterance })).operation.id, operation, utterance);
  }
  assert.equal(tools.calls.length, 1 + legal.count);
});

test('home scope answers the same way, and so does a host behind the audit wrapper', async (t) => {
  const kernel = await repository(t, ['WRK-2018']);
  const state = await mkdtemp(path.join(tmpdir(), 'sflow-next-audit-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const audited = auditedKernel(kernel, {
    host: 'vscode', env: { SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(state, 'active-workspace.json') }
  });
  for (const answer of [await kernel.next({ scope: 'home' }), await audited.next({ scope: 'home' })]) {
    assert.equal(answer.data.focus.id, 'WRK-2018');
    assert.equal(answer.next[0].id, 'work:WRK-2018');
    assert.equal(answer.next[0].reasonCode, 'approval.open-the-packet');
  }
});

test('the Story whose branch is checked out leads when more than one is open', async (t) => {
  const answer = await (await repository(t, ['WRK-1', 'WRK-2'], { branch: 'wi/WRK-1' })).next({ scope: 'home' });
  assert.equal(answer.why[0].code, 'gateway.next-current-work');
  assert.equal(answer.data.focus.id, 'WRK-1');
  assert.deepEqual(answer.next.slice(0, 2).map((action) => [action.id, action.emphasis]),
    [['work:WRK-1', 'primary'], ['work:WRK-2', 'secondary']]);
  assert.equal(answer.data.work.count, 2);
});

test('several open and none current: each is listed with its next action and none leads', async (t) => {
  const answer = await (await repository(t, ['WRK-1', 'WRK-2'])).next({ scope: 'subject' });
  assert.equal(answer.why[0].code, 'gateway.next-several-open-work');
  assert.equal(answer.data.focus, null);
  assert.equal(answer.subject, null);
  assert.deepEqual(answer.data.work.items.map((item) => [item.id, item.nextAction.operation]),
    [['WRK-2', 'review.packet'], ['WRK-1', 'review.packet']]);
  assert.deepEqual(answer.next.slice(0, 2).map((action) => action.id), ['work:WRK-2', 'work:WRK-1']);
  assert.equal(answer.next.some((action) => action.emphasis === 'primary'), false);
});

test('a named subject this repository lacks is said, never swapped for the open one', async (t) => {
  const answer = await (await repository(t, ['WRK-2018'])).next({ scope: 'subject', subject: { workId: 'WRK-404' } });
  assert.equal(answer.why[0].code, 'work.not-in-this-repository');
  assert.equal(answer.data.focus, null);
  assert.equal(answer.subject.id, 'WRK-404');
  assert.equal(answer.next.some((action) => action.emphasis === 'primary'), false);
});

test('the same words through resolve reach a read, with or without a goal hint', async (t) => {
  const tools = counted(await repository(t, ['WRK-2018']));
  const utterance = 'What can I do next in this repository?';

  // The goal hint the model sent is no longer overridden by a pattern route serving another goal.
  const hinted = await tools.resolve({ utterance, goalHint: 'work.list' });
  assert.deepEqual([hinted.kind, hinted.operation.id, hinted.why[0].code], ['read', 'work.list', 'resolution.matched.goal']);
  const listed = await tools.read({ resolutionId: hinted.next[0].handle });
  assert.deepEqual(listed.data.items.map((item) => [item.id, item.phase, item.nextAction.operation]),
    [['WRK-2018', 'planning', 'review.packet']]);

  // Without one, the question is orientation rather than "do the next step".
  const plain = await tools.resolve({ utterance });
  assert.deepEqual([plain.kind, plain.operation.id], ['read', 'developer.next']);
  assert.equal(tools.calls.length, 3);
});

test('a question about what is possible is not an imperative, and a route agreeing with the hint stands', async (t) => {
  for (const utterance of ['What can I do next in this repository?', 'What should I do next on this Story?', "What's next?"]) {
    const planned = planDeveloperConversation(utterance);
    assert.deepEqual([planned.intent, planned.route?.operationId], ['orient', 'developer.next'], utterance);
  }
  assert.equal(planDeveloperConversation('Do the next step').route.id, 'act-next');
  assert.equal(planDeveloperConversation('Run the next action for this Story').route.id, 'act-next');

  const kernel = await repository(t, ['WRK-2018']);
  const agreeing = await kernel.resolve({
    utterance: 'Could you show what is blocking this Story?', goalHint: 'work.ready', arguments: { workId: 'WRK-2018' }
  });
  assert.deepEqual([agreeing.operation.id, agreeing.why[0].code], ['work.readiness', 'resolution.matched.conversation']);
});
