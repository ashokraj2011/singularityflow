/**
 * A person's answer renews the Copilot turn it belongs to [owner, 2026-11-16].
 *
 * The incident: /sf-code at 09:03 opened the decisions card at 09:24, the person confirmed it at 09:57, and the
 * agent's next edit was refused, since the turn's permissions ran 30 minutes from its prompt. The window bounds what
 * an agent does unattended; an answer is the person being there. So the person's answer, on the card the turn opened
 * or to its question tool (Copilot CLI's ask_user, VS Code's vscode_askQuestions), starts the window again. An agent's
 * own call never does, nor an answer in another chat, for another Story, or a host's own reply.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { copilotModeFile, noteTurnRenewal, setCopilotPaused, TURN_WINDOW_MS, turnRenewalFile } from '../src/copilot-mode.mjs';
import { captureMutationTurn, mutationToolGuard, renewTurnAfterCardAnswer } from '../src/copilot-mutation-guard.mjs';
import { endRepositoryBoundaryTurn, recordRepositoryBoundaryTurn, repositoryPostToolGuard, repositoryToolGuard } from '../src/copilot-repository-boundary.mjs';
import { boundTurnStories } from '../src/story-routing.mjs';
import { recordStorySelection, settledStorySelection } from '../src/story-selection-settle.mjs';
import { repository, startQuickFix } from './helpers/run-and-test-fixture.mjs';
import { slowLane } from './helpers/slow-lane.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const MINUTE = 60_000;
const EXPIRED = /^PHASE_MUTATION_TURN_EXPIRED: this turn's permissions last 30 minutes from its prompt and have ended; nothing was written\. Invoke \/sf-code again/u;
const AGENT_HOST_REPLY = 'The user is not available to answer your question. Choose a pragmatic option best aligned with the context of the request.';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-turn-renewal-')));
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git('init', '-q'); git('config', 'user.name', 'Renewal Tester'); git('config', 'user.email', 'renewal@example.test');
  await writeFile(path.join(root, 'src', 'App.jsx'), 'export const value = 1;\n');
  const phase = { id: 'custom-step', status: 'in_progress', generation: 0, writeScope: 'artifact-only',
    generationPolicy: { task: 'document', requirement: 'required' } };
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: ['policy', '.github/hooks'] } };
  const workflow = { workItem: { id: 'PMC-1' }, currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase }, resolution: {} };
  const workflowFile = path.join(root, definition.workItemRoot, 'PMC-1', 'workflow.json');
  await mkdir(path.dirname(workflowFile), { recursive: true });
  await writeFile(workflowFile, JSON.stringify(workflow));
  git('add', 'src', 'singularity'); git('commit', '-qm', 'fixture');
  const accepted = { definition, workflow };
  /** A skill's turn whose prompt came `ago` milliseconds before now; the payload of an edit the step permits. */
  const enter = async (skill, sessionId, ago = 0) => {
    const payload = { cwd: root, sessionId, prompt: skill };
    await recordRepositoryBoundaryTurn(payload, { now: Date.now() - ago, captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => root, load: async () => accepted }) });
    return { ...payload, toolName: 'edit', toolArgs: { path: 'singularity/work-items/PMC-1/artifacts/custom-step/summary.md' } };
  };
  const boundaries = path.join(directory, 'machine', 'copilot-boundaries');
  const recordOf = (sessionId) => path.join(boundaries, `${createHash('sha256').update(sessionId).digest('hex')}.json`);
  return { root, directory, enter, recordOf };
}

const openCard = (payload, workId = 'PMC-1', toolName = 'sflow_decide') => repositoryToolGuard({ ...payload, toolName, toolArgs: { workId } });
const answered = (payload, words) => repositoryPostToolGuard({ ...payload, toolName: 'ask_user', toolArgs: { question: 'Which name?' },
  toolResult: { resultType: 'success', textResultForLlm: `User responded: ${words}` } });

test('the person confirming the decisions card at minute 31 renews the turn that opened it, and its edits go on', async t => {
  const f = await fixture(t);
  const author = await f.enter('/sf-code', 'card-author', 31 * MINUTE);
  // Without an answer the turn has ended, and says so as it always did.
  const before = await mutationToolGuard(author);
  assert.match(before.permissionDecisionReason, EXPIRED);
  assert.deepEqual(await boundTurnStories(f.root), []);
  // Opening the card is a tool call of the agent's: it renews nothing.
  assert.notEqual((await openCard(author)).permissionDecision, 'deny');
  assert.match((await mutationToolGuard(author)).permissionDecisionReason, EXPIRED);
  // The card records the person's answers with its own command, outside the chat (decisions record --answers).
  const renewed = await renewTurnAfterCardAnswer(f.root, 'PMC-1');
  assert.equal(typeof renewed, 'string');
  const after = await mutationToolGuard(author);
  assert.notEqual(after.permissionDecision, 'deny', JSON.stringify(after));
  assert.equal(JSON.stringify(after).includes('PHASE_MUTATION_TURN_EXPIRED'), false, 'nothing is said about the renewal');
  assert.deepEqual(await boundTurnStories(f.root), ['PMC-1'], 'the turn is bound to its Story again');
  // A second answer of the same card run (a sign-off after the decisions) renews it again.
  assert.equal(await renewTurnAfterCardAnswer(f.root, 'PMC-1'), renewed);
});

test('an agent tool call at minute 31 is refused as before: its own calls, a host\'s reply and a declined question renew nothing', async t => {
  const f = await fixture(t);
  const author = await f.enter('/sf-code', 'agent-only', 31 * MINUTE);
  const shell = (command) => repositoryToolGuard({ ...author, toolName: 'bash', toolArgs: { command, cwd: f.root } });
  assert.deepEqual(await shell('singularity-flow phase enter --for-agent --json'), {}, 'an expired turn keeps its reads');
  // Something changed since the turn bound its Story: its entry read renews nothing (owner, 2026-11-19).
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'moved on'], { cwd: f.root });
  await repositoryPostToolGuard({ ...author, toolName: 'bash', toolArgs: { command: 'singularity-flow phase enter --for-agent --json', cwd: f.root } });
  // Asking is the agent's; only the answer is the person's.
  assert.notEqual((await repositoryToolGuard({ ...author, toolName: 'ask_user', toolArgs: { question: 'Which name?' } })).permissionDecision, 'deny');
  for (const reply of [AGENT_HOST_REPLY, 'User declined to answer', '']) {
    await repositoryPostToolGuard({ ...author, toolName: 'ask_user', toolArgs: { question: 'Which name?' }, toolResult: { resultType: 'success', textResultForLlm: reply } });
  }
  await repositoryPostToolGuard({ ...author, toolName: 'ask_user', toolArgs: { question: 'Which name?' } });
  // A card for another Story is not this turn's, and no card answer comes from a chat.
  await openCard(author, 'OTHER-1');
  assert.equal(await renewTurnAfterCardAnswer(f.root, 'OTHER-1'), null);
  assert.equal(await renewTurnAfterCardAnswer(f.root, 'PMC-1'), null, 'this turn opened no card for its Story');
  const refusal = await mutationToolGuard(author);
  assert.match(refusal.permissionDecisionReason, EXPIRED);
  assert.deepEqual(refusal.next, []);
  assert.match((await shell('singularity-flow session attach PMC-1')).permissionDecisionReason, /^PHASE_MUTATION_TURN_EXPIRED: /u);
});

test('past its 30 minutes, a turn whose Story did not change goes on in the same chat once its agent reads the entry again', async t => {
  const f = await fixture(t);
  const author = await f.enter('/sf-code', 'unchanged', 31 * MINUTE);
  const refused = await mutationToolGuard(author);
  assert.match(refused.permissionDecisionReason, EXPIRED);
  // The refusal says how it goes on without the person typing anything: a read it names, here. Not the skill's own first
  // command: that composes context (`phase enter --compose`), which an expired turn refuses the same way [limit audit, item 3].
  assert.match(refused.permissionDecisionReason, /first run singularity-flow session current --for-agent --json once in this same chat; when nothing changed since, that read continues this turn here/u);
  assert.equal((await mutationToolGuard({ ...author, toolName: 'bash', toolArgs: { command: 'singularity-flow phase enter --compose --for-agent --json', cwd: f.root } })).permissionDecision, 'deny');
  assert.deepEqual(await mutationToolGuard({ ...author, toolName: 'bash', toolArgs: { command: 'singularity-flow session current --for-agent --json', cwd: f.root } }), {}, 'the named read runs');
  // An edit renews nothing; the entry read does, with nothing changed since the turn bound its Story (owner, 2026-11-19).
  await repositoryPostToolGuard({ ...author, toolName: 'edit', toolArgs: { path: 'src/App.jsx' } });
  assert.match((await mutationToolGuard(author)).permissionDecisionReason, EXPIRED);
  await repositoryPostToolGuard({ ...author, toolName: 'bash', toolArgs: { command: 'singularity-flow phase enter --for-agent --json', cwd: f.root } });
  const after = await mutationToolGuard(author);
  assert.notEqual(after.permissionDecision, 'deny', JSON.stringify(after));
  assert.deepEqual(await boundTurnStories(f.root), ['PMC-1'], 'the turn is bound to its Story again');
});

test('the unchanged renewal is once per prompt: past its second window only the person renews the turn [OSA:REQ-051]', async t => {
  const f = await fixture(t);
  const author = await f.enter('/sf-code', 'renewed-once', 31 * MINUTE);
  const read = () => repositoryPostToolGuard({ ...author, toolName: 'bash', toolArgs: { command: 'singularity-flow phase enter --for-agent --json', cwd: f.root } });
  await read();
  assert.notEqual((await mutationToolGuard(author)).permissionDecision, 'deny', 'the first unchanged read renews it');
  const renewal = JSON.parse(await readFile(turnRenewalFile(f.recordOf('renewed-once')), 'utf8'));
  assert.equal(renewal.unchangedAt, renewal.renewedAt, 'noted as the one unchanged renewal');
  // Thirty-one minutes after that renewal, nothing changed again: source edits change no stamp, so another read would extend
  // one prompt without end. It renews nothing, and the refusal no longer offers it.
  const record = JSON.parse(await readFile(f.recordOf('renewed-once'), 'utf8'));
  const earlier = Date.now() - TURN_WINDOW_MS - MINUTE;
  await noteTurnRenewal(f.recordOf('renewed-once'), record, { renewedAt: earlier, unchangedAt: earlier });
  const expired = await mutationToolGuard(author);
  assert.match(expired.permissionDecisionReason, /^PHASE_MUTATION_TURN_EXPIRED: this turn's permissions last 30 minutes from its renewal and have ended; nothing was written\. Invoke \/sf-code again to continue: the new turn enters again/u);
  assert.match(expired.permissionDecisionReason, /renewed once already with nothing changed, so its entry read renews it no more/u);
  assert.doesNotMatch(expired.permissionDecisionReason, /first run singularity-flow session current/u);
  // After the call, a read that renewed nothing is told to invoke the skill again, never to run another read: `session
  // current` there passed the pre-tool check and came back to this same stop [limit audit, item 3].
  const after = await read();
  assert.match(after.additionalContext ?? '', /PHASE_MUTATION_TURN_EXPIRED: [^\n]*Invoke \/sf-code again to continue/u, JSON.stringify(after));
  assert.doesNotMatch(after.additionalContext ?? '', /PHASE_MUTATION_CONTRACT_STALE|first run singularity-flow session current/u);
  assert.match((await mutationToolGuard(author)).permissionDecisionReason, /^PHASE_MUTATION_TURN_EXPIRED: /u, 'a second unchanged read renews nothing');
  // The person's own answer still renews it, as always.
  await answered(author, 'keep going');
  assert.notEqual((await mutationToolGuard(author)).permissionDecision, 'deny');
});

test('an answer in another session, another checkout or an earlier turn renews nothing of this one', async t => {
  const f = await fixture(t);
  const mine = await f.enter('/sf-code', 'mine', 31 * MINUTE);
  const theirs = await f.enter('/sf-code', 'theirs', 31 * MINUTE);
  await answered(theirs, 'keep the old name');
  assert.notEqual((await mutationToolGuard(theirs)).permissionDecision, 'deny', 'the session that was answered goes on');
  assert.match((await mutationToolGuard(mine)).permissionDecisionReason, EXPIRED, 'the other session is not renewed');
  // A card opened in this session and answered in another checkout of the Story renews nothing here.
  await openCard(mine);
  const elsewhere = path.join(f.directory, 'elsewhere');
  await mkdir(elsewhere);
  assert.equal(await renewTurnAfterCardAnswer(elsewhere, 'PMC-1'), null);
  assert.match((await mutationToolGuard(mine)).permissionDecisionReason, EXPIRED);
  // A new prompt is a new turn: what was answered in the earlier one does not carry over.
  await answered(mine, 'keep the old name');
  assert.notEqual((await mutationToolGuard(mine)).permissionDecision, 'deny');
  const next = await f.enter('/sf-code', 'mine', 31 * MINUTE);
  assert.match((await mutationToolGuard(next)).permissionDecisionReason, EXPIRED);
  // Paused, SFlow renews nothing.
  await openCard(next);
  await setCopilotPaused(true);
  assert.equal(await renewTurnAfterCardAnswer(f.root, 'PMC-1'), null);
});

test('ask_user and vscode_askQuestions answers renew the turn they belong to', async t => {
  const f = await fixture(t);
  // Copilot CLI and VS Code's agent host.
  const cli = await f.enter('/sf-code', 'copilot-cli', 31 * MINUTE);
  await answered(cli, 'name=keep the old name');
  assert.notEqual((await mutationToolGuard(cli)).permissionDecision, 'deny');
  // VS Code's own chat, in its own payload shape.
  const local = (payload, fields) => ({ session_id: payload.sessionId, cwd: payload.cwd, hook_event_name: fields.tool_response === undefined ? 'PreToolUse' : 'PostToolUse', ...fields });
  const vscode = await f.enter('/sf-code', 'vscode-local', 31 * MINUTE);
  const edit = local(vscode, { tool_name: 'create_file', tool_input: { filePath: path.join(f.root, 'singularity/work-items/PMC-1/artifacts/custom-step/summary.md') } });
  assert.match((await repositoryToolGuard(edit)).permissionDecisionReason, EXPIRED);
  await repositoryPostToolGuard(local(vscode, { tool_name: 'vscode_askQuestions', tool_use_id: 't1', tool_input: { questions: [{ header: 'Name', question: 'Which name?' }] },
    tool_response: JSON.stringify({ answers: { Name: { selected: ['Keep the old name'], freeText: null, skipped: false } } }) }));
  assert.notEqual((await repositoryToolGuard(edit)).permissionDecision, 'deny');
  // A skipped question is no answer.
  const skipped = await f.enter('/sf-code', 'vscode-skipped', 31 * MINUTE);
  await repositoryPostToolGuard(local(skipped, { tool_name: 'vscode_askQuestions', tool_use_id: 't2', tool_input: { questions: [] },
    tool_response: JSON.stringify({ answers: { Name: { selected: [], freeText: null, skipped: true } } }) }));
  assert.match((await mutationToolGuard(skipped)).permissionDecisionReason, EXPIRED);
});

test('a window that runs out again after an answer says it ran from that answer, and a live turn reads nothing more', async t => {
  const f = await fixture(t);
  const author = await f.enter('/sf-code', 'answered-long-ago', 62 * MINUTE);
  const record = JSON.parse(await readFile(f.recordOf('answered-long-ago'), 'utf8'));
  await noteTurnRenewal(f.recordOf('answered-long-ago'), record, { renewedAt: Date.now() - TURN_WINDOW_MS - MINUTE });
  assert.match((await mutationToolGuard(author)).permissionDecisionReason,
    /^PHASE_MUTATION_TURN_EXPIRED: this turn's permissions last 30 minutes from the person's last answer in it and have ended; nothing was written\. Invoke \/sf-code again/u);
  // A renewal in the future, or for another turn of the session, counts for nothing.
  await noteTurnRenewal(f.recordOf('answered-long-ago'), record, { renewedAt: Date.now() + 10 * MINUTE });
  assert.match((await mutationToolGuard(author)).permissionDecisionReason, EXPIRED);
  await noteTurnRenewal(f.recordOf('answered-long-ago'), { ...record, turnId: 'another-turn' }, { renewedAt: Date.now() });
  assert.match((await mutationToolGuard(author)).permissionDecisionReason, EXPIRED);
  // Within its window a turn never opens the file: one that cannot be read changes nothing.
  const live = await f.enter('/sf-code', 'live');
  const renewal = turnRenewalFile(f.recordOf('live'));
  await mkdir(renewal);
  assert.deepEqual(await mutationToolGuard(live), {});
  await rm(renewal, { recursive: true });
  // The turn's end takes what was noted with it.
  await answered(author, 'keep the old name');
  assert.ok(await lstat(turnRenewalFile(f.recordOf('answered-long-ago'))));
  await endRepositoryBoundaryTurn(author);
  await assert.rejects(lstat(turnRenewalFile(f.recordOf('answered-long-ago'))), { code: 'ENOENT' });
  assert.equal(path.dirname(copilotModeFile()), path.join(f.directory, 'machine'));
});

test('two chats holding the card for one Story: the card not yet answered is renewed, and with two waiting, neither', async t => {
  const f = await fixture(t);
  const first = await f.enter('/sf-code', 'first-chat', 31 * MINUTE);
  const second = await f.enter('/sf-code', 'second-chat', 31 * MINUTE);
  await openCard(first);
  await openCard(second, 'PMC-1', 'singularityFlow_decide');
  // Which chat's card the person answered cannot be told from the card's command: neither is renewed.
  assert.equal(await renewTurnAfterCardAnswer(f.root, 'PMC-1'), null);
  assert.match((await mutationToolGuard(first)).permissionDecisionReason, EXPIRED);
  assert.match((await mutationToolGuard(second)).permissionDecisionReason, EXPIRED);
  // One answered already (its card closed with that answer); the next answer is the other one's.
  const third = await f.enter('/sf-code', 'third-chat', 31 * MINUTE);
  const fourth = await f.enter('/sf-code', 'fourth-chat', 31 * MINUTE);
  await openCard(third, 'PMC-1', 'sflow_adjudicate');
  await rm(turnRenewalFile(f.recordOf('first-chat')));
  await rm(turnRenewalFile(f.recordOf('second-chat')));
  const thirdTurn = await renewTurnAfterCardAnswer(f.root, 'PMC-1');
  assert.equal(thirdTurn, JSON.parse(await readFile(f.recordOf('third-chat'), 'utf8')).turnId);
  await openCard(fourth, 'PMC-1', 'singularityFlow_witnessReview');
  assert.equal(await renewTurnAfterCardAnswer(f.root, 'PMC-1'), JSON.parse(await readFile(f.recordOf('fourth-chat'), 'utf8')).turnId);
  assert.notEqual((await mutationToolGuard(fourth)).permissionDecision, 'deny');
});

test('through the packaged bash hook, an ask_user answer reaches the runtime and is noted; another tool\'s result is not', {
  skip: process.platform === 'win32'
}, async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.directory, 'host-bin');
  await mkdir(bin);
  await symlink(fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url)), path.join(bin, 'singularity-flow'));
  const chat = path.join(f.directory, 'chat');
  await mkdir(chat);
  const launch = (action, payload) => {
    const result = spawnSync('/bin/bash', [fileURLToPath(new URL('../plugin/hook-launcher.sh', import.meta.url)), action], {
      cwd: chat, input: JSON.stringify({ sessionId: 'hooked', cwd: chat, ...payload }), encoding: 'utf8', timeout: childTimeout(60_000),
      env: { ...process.env, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, SINGULARITY_FLOW_ENGINE_HOME: path.join(f.directory, 'no engine') } });
    assert.equal(result.status, 0, `${action}: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  launch('boundary-turn', { prompt: '/sf-code' });
  const renewal = turnRenewalFile(f.recordOf('hooked'));
  const turnId = JSON.parse(await readFile(f.recordOf('hooked'), 'utf8')).turnId;
  assert.deepEqual(launch('boundary-after', { toolName: 'view', toolArgs: { path: 'src/App.jsx' }, toolResult: { resultType: 'success', textResultForLlm: 'User responded: yes' } }), {});
  await assert.rejects(lstat(renewal), { code: 'ENOENT' }, 'only a question tool\'s answer is noted');
  const before = Date.now();
  assert.deepEqual(launch('boundary-after', { toolName: 'ask_user', toolArgs: { question: 'Which name?' },
    toolResult: { resultType: 'success', textResultForLlm: 'User responded: keep the old name' } }), {});
  const noted = JSON.parse(await readFile(renewal, 'utf8'));
  assert.equal(noted.turnId, turnId);
  assert.ok(noted.renewedAt >= before && noted.renewedAt <= Date.now(), JSON.stringify(noted));
});

test('the card\'s own command, decisions record --answers, renews the turn that opened the card', slowLane({ timeout: 600_000 }), async (t) => {
  const repo = await repository(t, { implementCommands: false });
  await startQuickFix(repo);
  // One decision on the list: the undo of what SFlow settled for the person (settled-decisions-flow.test.mjs).
  await recordStorySelection(repo.root, await settledStorySelection([repo.root]));
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = repo.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  t.after(() => { if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE; else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous; });
  const root = await realpath(repo.root);
  const author = { cwd: root, sessionId: 'card-cli', prompt: '/sf-code' };
  await recordRepositoryBoundaryTurn(author, { now: Date.now() - 31 * MINUTE,
    captureMutation: (value, record) => captureMutationTurn(value, record, { resolveRoot: async () => root }) });
  const edit = { ...author, toolName: 'edit', toolArgs: { path: path.join(root, 'src', 'value.mjs') } };
  assert.match((await mutationToolGuard(edit)).permissionDecisionReason, EXPIRED);
  assert.notEqual((await openCard(author, 'QF-1')).permissionDecision, 'deny');
  const listed = repo.sflowJson('decisions', 'QF-1').value.data;
  const item = listed.settled.find((candidate) => candidate.kind === 'settled');
  const answers = path.join(repo.base, 'card-answers.json');
  await writeFile(answers, JSON.stringify({ choose: { [item.id]: 'undo' }, reason: { [item.id]: 'Not the Story I meant.' }, confirm: listed.packetSha256 }));
  const recorded = repo.sflowJson('decisions', 'record', 'QF-1', '--answers', answers);
  assert.equal(recorded.status, 0, JSON.stringify(recorded.value));
  // The window runs from the person's answer: whatever this edit meets now, it is not the turn's end.
  assert.doesNotMatch(JSON.stringify(await mutationToolGuard(edit)), /PHASE_MUTATION_TURN_EXPIRED/u);
  assert.deepEqual(await boundTurnStories(root), ['QF-1']);
  // A person's own terminal choice (no answers file) is not the card's: another turn that opened none stays ended.
  const other = { cwd: root, sessionId: 'no-card', prompt: '/sf-code' };
  await recordRepositoryBoundaryTurn(other, { now: Date.now() - 31 * MINUTE,
    captureMutation: (value, record) => captureMutationTurn(value, record, { resolveRoot: async () => root }) });
  assert.match((await mutationToolGuard({ ...other, toolName: 'edit', toolArgs: edit.toolArgs })).permissionDecisionReason, EXPIRED);
});
