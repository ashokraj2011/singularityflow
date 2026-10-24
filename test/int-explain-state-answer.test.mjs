/**
 * "Why is my Story blocked?" is answered by `sflow_explain` itself, from the work record.
 *
 * A live Copilot run (2026-10-24, VS Code Copilot Chat, real model) asked "#sflow_explain why is my
 * Story blocked?" in a repository with one Story waiting in Planning for approval. The first call,
 * `sflow_explain {question, topic: 'blocked', subject: {workId}}`, came back as a clarification
 * listing documentation topics: the host dropped the subject and the planner read the question only
 * as a topic lookup. Copilot needed five more calls (explain again, three `sflow_resolve`s and an
 * `sflow_read`) before it could say: Planning, awaiting approval, blocked by outstanding approvals,
 * and the decision is yours. These tests drive the same calls against the same shape of repository
 * and hold the answer to the first one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { WORK_CODES } from '../src/gateway/catalog.mjs';
import { planDeveloperConversation, workStateQuestion } from '../src/gateway/conversation.mjs';
import { createHostGateway } from '../src/gateway/host.mjs';
import { serveMcp } from '../src/gateway/mcp-stdio.mjs';
import { BLOCKER_TOPICS } from '../src/gateway/planners/help-explain.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { validateSflowResult } from '../src/gateway/result.mjs';
import { run } from '../src/util.mjs';

const ACTOR = { login: 'dev', email: 'dev@example.test', name: 'Dev' };
const AUTHORITIES = {
  developers: {
    label: 'Developers', allowAnyGitIdentity: false, githubTeams: [],
    members: [{ name: ACTOR.name, email: ACTOR.email, githubLogin: ACTOR.login }]
  }
};

/** The live Story's shape: Specification approved, Planning submitted and awaiting this actor. */
const waitingStory = (id, at) => ({
  workItem: { id, title: `Story ${id}`, workType: 'feature', branch: `wi/${id}` },
  phaseOrder: ['specification', 'planning', 'implementation'],
  currentPhase: 'planning',
  phases: {
    specification: { label: 'Specification', status: 'approved', generation: 1 },
    planning: {
      label: 'Planning', status: 'awaiting_approval', generation: 1,
      approvalPolicy: { authorities: ['developers'], minimum: 1, allowSelfApproval: true }
    },
    implementation: { label: 'Implementation', status: 'pending' }
  },
  history: [
    { event: 'work_started', phase: 'specification', actor: ACTOR, at },
    { event: 'phase_submitted', phase: 'planning', actor: ACTOR, at }
  ],
  resolution: { approvalAuthorities: AUTHORITIES }
});

/** A Git repository on `main` holding the given Stories' records, and the gateway a host builds. */
async function repository(t, stories, { branch = null } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'sflow-explain-state-'));
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
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  const { kernel } = createHostGateway({ root, hostSessionId: `explain-state-${stories.join('-')}`, planners: gatewayPlanners() });
  return { kernel, head };
}

/** Each tool call the conversation makes, counted the way the live run was. */
function counted(kernel) {
  const calls = [];
  return {
    calls,
    explain: async (request) => { calls.push('sflow_explain'); return validateSflowResult(await kernel.explain(request)); },
    read: async (request) => { calls.push('sflow_read'); return validateSflowResult(await kernel.read(request)); },
    resolve: async (request) => { calls.push('sflow_resolve'); return validateSflowResult(await kernel.resolve(request)); }
  };
}

/** The facts an answer about one Story has to carry, and nothing a wording change would move. */
function stateOf(answer) {
  const { work } = answer.data;
  return {
    kind: answer.kind,
    operation: answer.operation.id,
    subject: answer.subject && { kind: answer.subject.kind, id: answer.subject.id },
    work: { id: work.id, phase: work.phase, status: work.status, blockers: work.blockers.map((entry) => entry.blocker), group: work.group }
  };
}

const LIVE_ANSWER = {
  kind: 'read',
  operation: 'help.explain',
  subject: { kind: 'story', id: 'hex-2018' },
  work: { id: 'hex-2018', phase: 'planning', status: 'awaiting_approval', blockers: ['approvals-outstanding'], group: 'waiting-on-you' }
};

test('the live call is answered by its first sflow_explain, from the record, with citations', async (t) => {
  const { kernel, head } = await repository(t, ['hex-2018']);
  const tools = counted(kernel);

  // The live run's first call, verbatim.
  const answer = await tools.explain({ question: 'Why is my Story blocked?', topic: 'blocked', subject: { workId: 'hex-2018' } });
  assert.deepEqual(stateOf(answer), LIVE_ANSWER);
  assert.equal(answer.outcome.messageId, 'gateway.explained-work');
  assert.deepEqual({ ...answer.outcome.slots }, { work: 'hex-2018', phase: 'planning', status: 'awaiting_approval' });
  assert.equal(answer.data.helpIntent, 'diagnose');
  assert.equal(answer.data.answeredFrom, 'work-records');

  // Cited: the state plane, read at this checkout's revision, and each blocker by its own code.
  assert.deepEqual(answer.why.map((reason) => [reason.code, reason.source]), [
    ['explain.situation-from-state', 'lifecycle'],
    ['work.blocked.approvals-outstanding', 'lifecycle'],
    ['readiness.awaiting-a-human-decision', 'lifecycle']
  ]);
  assert.equal(answer.why[0].reference, head);
  assert.equal(answer.subject.revision.sourceCommit, head);
  assert.deepEqual({ ...answer.data.citation }, { plane: 'state', subject: 'hex-2018', branch: 'main', revision: head });
  assert.deepEqual(answer.data.work.rail.map((phase) => [phase.id, phase.state]),
    [['specification', 'done'], ['planning', 'current'], ['implementation', 'pending']]);
  assert.deepEqual(answer.data.work.blockers.map((entry) => ({ ...entry })),
    [{ blocker: 'approvals-outstanding', code: 'work.blocked.approvals-outstanding', topic: 'approvals' }]);

  // The approval is a person's decision: relayed, never run. It names who may make it and where.
  assert.deepEqual({ ...answer.data.decision }, {
    operation: 'review.open', phase: 'planning', decidedBy: 'person', availableToActor: true, executable: false
  });
  const ceremony = answer.next.find((action) => action.kind === 'ceremony');
  assert.deepEqual([ceremony.interaction, ceremony.confirmation, ceremony.executable], ['ceremony', 'ceremony', false]);
  assert.equal(ceremony.fallback.command, 'sflow approve planning --work-id hex-2018 --fetch');
  assert.ok(answer.next.every((action) => action.kind === 'read' || !action.executable));

  // The one executable action is the read the record computed: open the packet.
  const [lead] = answer.next;
  assert.deepEqual([lead.id, lead.kind, lead.emphasis, lead.executable, lead.reasonCode],
    ['work:hex-2018', 'read', 'primary', true, 'approval.open-the-packet']);
  assert.equal(answer.data.work.nextAction.handle, lead.handle);
  assert.equal(answer.data.work.nextAction.operation, 'review.packet');

  // Live: the answer appeared at call 6. Now at call 1, and the packet, if wanted, is call 2.
  assert.deepEqual(tools.calls, ['sflow_explain']);
  const packet = await tools.read({ resolutionId: lead.handle });
  assert.deepEqual([packet.operation.id, packet.data.packet.decisionAvailableToActor], ['review.packet', true]);
  assert.deepEqual(tools.calls, ['sflow_explain', 'sflow_read']);
});

/**
 * What the first answer may cost, as the compact JSON both hosts hand the model.
 *
 * 3,758 B on this fixture, against 2,044 B for the topic list it replaces and the ~10 KB the five
 * calls after it returned. The headroom is for longer IDs, titles and phase rails, not for a body
 * of documentation: a topic is named per blocker, never inlined.
 */
const EXPLAIN_ANSWER_BYTE_BOUND = 5_000;

test('the answer stays small, and every topic it points to ships with the documentation', async (t) => {
  const { kernel } = await repository(t, ['hex-2018']);
  const answer = validateSflowResult(await kernel.explain({ question: 'Why is my Story blocked?', subject: { workId: 'hex-2018' } }));
  const bytes = Buffer.byteLength(JSON.stringify(answer), 'utf8');
  assert.ok(bytes <= EXPLAIN_ANSWER_BYTE_BOUND, `sflow_explain is ${bytes} B, over its ${EXPLAIN_ANSWER_BYTE_BOUND} B bound`);
  for (const topic of new Set(Object.values(BLOCKER_TOPICS))) {
    const served = validateSflowResult(await kernel.explain({ question: topic, topic }));
    assert.deepEqual([served.why[0].code, served.data.topic], ['explain.cited', topic], topic);
  }
  // Every blocker the work record can report has a topic, so none is pointed nowhere.
  assert.deepEqual(Object.keys(BLOCKER_TOPICS).map((blocker) => `work.blocked.${blocker}`),
    WORK_CODES.filter((code) => code.startsWith('work.blocked.') && code !== 'work.blocked.unrecognised'));
});

test('the host passes the subject: the same call over MCP is the same answer', async (t) => {
  const { kernel } = await repository(t, ['hex-2018', 'hex-7']);
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = [];
  let buffered = '';
  output.on('data', (chunk) => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const reply = JSON.parse(buffered.slice(0, at));
      replies.push(reply);
      buffered = buffered.slice(at + 1);
      if (reply.id === 1) {
        input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
          name: 'sflow_explain', arguments: { question: 'Why is my Story blocked?', topic: 'blocked', subject: { workId: 'hex-2018' } }
        } })}\n`);
      }
      if (reply.id === 2) input.end();
    }
  });
  const served = serveMcp({ input, output, serverInfo: { name: 'sflow-test', version: '0' }, createKernel: async () => kernel });
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  await served;
  // With two open Stories and none checked out, only the subject can have picked this one.
  const answer = validateSflowResult(replies.find((reply) => reply.id === 2).result.structuredContent);
  assert.deepEqual(stateOf(answer), LIVE_ANSWER);
});

test('no subject and exactly one open Story: Home\'s focus rule picks it', async (t) => {
  const tools = counted((await repository(t, ['hex-2018'])).kernel);
  const answer = await tools.explain({ question: 'Why is my Story blocked?' });
  assert.deepEqual(stateOf(answer), LIVE_ANSWER);
  assert.ok(answer.why.some((reason) => reason.code === 'gateway.next-only-open-work'));
  assert.equal(tools.calls.length, 1);
});

test('no subject, several open: the checked-out Story is the one asked about', async (t) => {
  const answer = await (await repository(t, ['hex-1', 'hex-2'], { branch: 'wi/hex-1' })).kernel.explain({ question: 'What is blocking?' });
  assert.equal(answer.kind, 'read');
  assert.equal(answer.data.work.id, 'hex-1');
  assert.ok(answer.why.some((reason) => reason.code === 'gateway.next-current-work'));
});

test('no subject, several open and none current: the question back lists the Stories, not topics', async (t) => {
  const answer = validateSflowResult(await (await repository(t, ['hex-1', 'hex-2'])).kernel.explain({ question: 'Why is my Story blocked?' }));
  assert.equal(answer.kind, 'clarification');
  assert.equal(answer.why[0].code, 'gateway.next-several-open-work');
  assert.deepEqual(answer.data.work.items.map((item) => [item.id, item.status, item.blockers]),
    [['hex-2', 'awaiting_approval', ['approvals-outstanding']], ['hex-1', 'awaiting_approval', ['approvals-outstanding']]]);
  assert.deepEqual(answer.next.map((action) => action.id), ['work:hex-2', 'work:hex-1']);
  assert.equal(answer.next.some((action) => action.emphasis === 'primary'), false);
  assert.equal(answer.next.some((action) => action.id.startsWith('topic:')), false);
});

test('a named Story this repository lacks is said, never swapped for the open one', async (t) => {
  const answer = validateSflowResult(await (await repository(t, ['hex-2018'])).kernel.explain({
    question: 'Why is my Story blocked?', subject: { workId: 'hex-404' }
  }));
  assert.equal(answer.kind, 'clarification');
  assert.equal(answer.why[0].code, 'work.not-in-this-repository');
  assert.equal(answer.subject.id, 'hex-404');
  assert.equal(answer.data.work.items.some((item) => item.id === 'hex-404'), false);
  assert.equal(answer.next.some((action) => action.emphasis === 'primary'), false);
});

test('no Story at all: the documentation clarification is unchanged', async (t) => {
  const answer = validateSflowResult(await (await repository(t, [])).kernel.explain({ question: 'Why is my Story blocked?', topic: 'blocked' }));
  assert.equal(answer.kind, 'clarification');
  assert.equal(answer.why[0].code, 'explain.no-match');
  assert.ok(answer.next.length > 0 && answer.next.every((action) => action.id.startsWith('topic:')));
});

test('a question about the product is still answered from the documentation, subject or not', async (t) => {
  const { kernel } = await repository(t, ['hex-2018']);
  for (const question of ['How do approvals work?', 'What does awaiting approval mean?', 'What is a blocker?']) {
    const answer = validateSflowResult(await kernel.explain({ question, subject: { workId: 'hex-2018' } }));
    assert.notEqual(answer.data.answeredFrom, 'work-records', question);
  }
  const cited = validateSflowResult(await kernel.explain({ question: 'approvals', topic: 'approvals', subject: { workId: 'hex-2018' } }));
  assert.deepEqual([cited.kind, cited.why[0].code, cited.data.topic], ['read', 'explain.cited', 'approvals']);
  assert.deepEqual({ kind: cited.subject.kind, id: cited.subject.id }, { kind: 'story', id: 'hex-2018' });
});

test('other ways of asking where a Story stands get the same first answer', async (t) => {
  const { kernel } = await repository(t, ['hex-2018']);
  for (const question of [
    'What is blocking?', 'what is blocking my story', "Why can't I continue?", "Why can't I submit this?",
    "What's wrong with hex-2018?", "What's wrong with HEX-2018?", 'What is wrong with my Story?',
    'Why is hex-2018 stuck?', 'What phase is my Story in?'
  ]) {
    assert.equal(workStateQuestion(question), true, question);
    const answer = validateSflowResult(await kernel.explain({ question }));
    assert.deepEqual(stateOf(answer), LIVE_ANSWER, question);
  }
  // Named in the words and not here: said, not swapped.
  const missing = validateSflowResult(await kernel.explain({ question: "What's wrong with hex-123?" }));
  assert.deepEqual([missing.kind, missing.why[0].code, missing.subject.id], ['clarification', 'work.not-in-this-repository', 'hex-123']);
  for (const question of ['How do approvals work?', 'What does blocked mean?', 'Why is the build failing?', 'Why does SFlow need approvals?']) {
    assert.equal(workStateQuestion(question), false, question);
  }
});

test('the same words through resolve reach a read about that Story', async (t) => {
  const tools = counted((await repository(t, ['hex-2018'])).kernel);
  for (const utterance of ["What's wrong with hex-2018?", 'Why is my Story stuck?']) {
    assert.equal(planDeveloperConversation(utterance).route?.operationId, 'work.readiness', utterance);
  }
  const readiness = await tools.resolve({ utterance: "What's wrong with hex-2018?", subject: { workId: 'hex-2018' } });
  assert.deepEqual([readiness.kind, readiness.operation.id, readiness.data.arguments.workId], ['read', 'work.readiness', 'hex-2018']);
});

/**
 * The rest of the live trace: a read-only packet request with goal `review.open`.
 *
 * Live, it took four calls: the subject was dropped (`resolution.arguments.missing`), then the goal
 * offered the decision and the packet as two candidates (`resolution.ambiguous`), then the
 * selection, then the read. The words ask to see the packet, and a goal may choose a read.
 */
test('a request to see the review packet resolves to the packet read, with the subject as its workId', async (t) => {
  const tools = counted((await repository(t, ['hex-2018'])).kernel);
  const utterance = 'Show me the review packet for Story hex-2018 so I can see exactly which approvals are outstanding.';
  // VS Code hands the tool input to resolve as it arrived, subject included.
  const resolved = await tools.resolve({ utterance, goalHint: 'review.open', subject: { workId: 'hex-2018' } });
  assert.deepEqual([resolved.kind, resolved.operation.id, resolved.why[0].code], ['read', 'review.packet', 'resolution.matched.conversation']);
  assert.equal(resolved.data.arguments.workId, 'hex-2018');
  const packet = await tools.read({ resolutionId: resolved.next[0].handle });
  assert.deepEqual([packet.data.packet.status, [...packet.data.packet.blockers], packet.data.packet.decisionAvailableToActor],
    ['awaiting_approval', ['approvals-outstanding'], true]);
  assert.deepEqual(tools.calls, ['sflow_resolve', 'sflow_read']);

  for (const words of ['Open the review packet for hex-2018', 'Which approvals are outstanding on hex-2018?']) {
    const again = await tools.resolve({ utterance: words, goalHint: 'review.open', arguments: { workId: 'hex-2018' } });
    assert.deepEqual([again.kind, again.operation.id], ['read', 'review.packet'], words);
  }

  // Asking to decide is still never resolved to a read, and never to anything executable.
  const decide = await tools.resolve({ utterance: 'approve planning for hex-2018', goalHint: 'review.open', arguments: { workId: 'hex-2018' } });
  assert.notEqual(decide.kind, 'read');
  assert.ok(decide.next.every((action) => action.executable === false));
});

test('a subject fills workId only where the operation takes one', async (t) => {
  const { kernel } = await repository(t, ['hex-2018']);
  const home = validateSflowResult(await kernel.resolve({ utterance: 'hello', subject: { workId: 'hex-2018' } }));
  assert.notEqual(home.kind, 'refusal');
  const named = validateSflowResult(await kernel.resolve({ utterance: 'show me the review packet', subject: { workId: 'hex-2018' } }));
  assert.deepEqual([named.kind, named.data.arguments.workId], ['read', 'hex-2018']);
  // An argument the caller gave wins over the subject.
  const explicit = validateSflowResult(await kernel.resolve({
    utterance: 'show me the review packet', arguments: { workId: 'hex-9' }, subject: { workId: 'hex-2018' }
  }));
  assert.equal(explicit.data.arguments.workId, 'hex-9');
});
