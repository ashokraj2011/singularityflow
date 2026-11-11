/**
 * The reviewer runs in the author's chat, as a sub-agent (owner, 2026-11-11), on a real quick-fix Story through the
 * real hook commands:
 *   - the publication hands the author's turn the reviewer to start as a sub-agent, with a new chat as the fallback;
 *   - subagentStart (agent-start) gives the Story's pinned reviewer its own read-only review turn in that chat;
 *   - the host names the sub-agent on each of its calls, so the guard checks the reviewer's calls under the
 *     read-only-review contract while the author's turn keeps its own authoring contract;
 *   - the sub-agent's task text never replaces the author's turn;
 *   - the retained review returns to the author's turn: a ready review routes to submission there;
 *   - a host that does not name the sub-agent on its calls leaves them under the author's contract, which cannot
 *     retain a review: the review then runs in a new chat, as the handoff says.
 */
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { repository, cli as CLI } from './helpers/run-and-test-fixture.mjs';
import { documentReport } from './helpers/step-review.mjs';
import { reviewSubagentHandoff, reviewerSessionId, reviewerSubagentPayload, subagentName } from '../src/review-subagent.mjs';
import { agentAct } from '../src/agent-output.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const INTAKE = ['# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
  '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The exported value equals 2. |', '',
  '## Planned implementation evidence', '',
  '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
  '| `QF-1:AC-001` | `src/value.mjs` | `test/value.test.mjs` | modified | The test reads 2. |', '',
  '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n');

test('the handoff starts the pinned reviewer as a sub-agent in this chat, then reads its review, with a new chat as the fallback', () => {
  const handoff = reviewSubagentHandoff({ workId: 'QF-1', phase: 'implement', generation: 2, reviewerAgent: 'sflow-source-reviewer' });
  assert.equal(handoff.agent, 'sflow-source-reviewer');
  assert.equal(handoff.prompt, '/sf-review-source implement');
  assert.equal(handoff.reviewStatus, 'singularity-flow review-source status implement --work-id QF-1 --for-agent --json');
  assert.match(handoff.instruction, /When it returns, run singularity-flow review-source status implement --work-id QF-1 --for-agent --json once and follow its route here/u);
  assert.match(handoff.instruction, /as a sub-agent with the task tool: agent_type 'sflow-source-reviewer', prompt '\/sf-review-source implement' \(VS Code's Copilot agent and the Copilot CLI alike\)/u);
  assert.match(handoff.instruction, /do not review, edit or retain it yourself/u);
  // Started in the background, the author ended its turn on /sf-review-source while the reviewer ran (Story anu-bin, 2026-11-11).
  assert.match(handoff.instruction, /Run it in the foreground and wait for its result \(mode 'sync' where the tool has one, never 'background'\)/u);
  // "wait for its completion notice" named no way to wait while the host said to end the response (agent-text audit, 2026-11-11).
  assert.doesNotMatch(handoff.instruction, /wait for its completion notice/u);
  assert.match(handoff.instruction, /If a host starts it in the background anyway: read or wait for that agent's result with the host's own tool when it has one; if ending your response is the only way to wait, end it saying only that the review is running and continues here when it returns, with no route or skill\./u);
  assert.match(handoff.instruction, /never offer \/sf-review-source implement while it runs, and never end the turn before it returns but as just said/u);
  // A correction is confirmed by the person in this chat and corrected in the same turn, never left as "/sf-phase" (Story anu-bin, 2026-11-11).
  assert.match(handoff.instruction, /a correction: show the person its findings and ask now with ask_user whether to correct them in generation 3; on yes, run the route's command and correct the draft in this same turn, then prepublish; never end the turn on that route\. A ready review goes to submission\./u);
  assert.match(handoff.instruction, /No sub-agent tool: end with "Run this in a new chat:" and \/sf-review-source implement\.$/u);
  assert.equal(reviewSubagentHandoff({ workId: 'QF-1', phase: 'implement', generation: 2, reviewerAgent: 'Not An Id' }), null);
  // Hosts name a sub-agent differently: Copilot CLI agentType on its calls and agentName at its start, VS Code agent_type.
  for (const payload of [{ agentType: 'sflow-source-reviewer' }, { agent_type: 'sflow-source-reviewer' }, { agentName: 'sflow-source-reviewer' }]) {
    assert.equal(subagentName(payload), 'sflow-source-reviewer');
  }
  assert.equal(subagentName({}), null);
  assert.equal(reviewerSessionId('chat-1', 'sflow-source-reviewer'), 'chat-1#agent:sflow-source-reviewer');
  const top = { sessionId: 'chat-1', toolName: 'bash' };
  assert.equal(reviewerSubagentPayload(top, '/nowhere'), top, 'a top-level call is the author\'s');
  const unknown = { sessionId: 'chat-1', agentId: 'a1', agentType: 'sflow-source-reviewer' };
  assert.equal(reviewerSubagentPayload(unknown, '/nowhere'), unknown, 'a sub-agent with no recorded review turn stays under the author\'s turn');
});

test('every way an agent publishes a reviewed step hands it the reviewer: the prepublish act and a plain phase publish', async (t) => {
  // Story anu-bin verification (2026-11-11): plain prepublish acted 'publish' with `phase publish`, whose result named
  // no reviewer; generation 3 was published and the turn ended with none started.
  const repo = await repository(t, { implementCommands: false, reviews: true });
  const { root, sflow, must } = repo;
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(repo.base, 'remote.git')], repo.base);
  must('git', ['remote', 'add', 'origin', path.join(repo.base, 'remote.git')]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), INTAKE);
  const checked = JSON.parse(sflow('phase', 'prepublish', 'intake', '--for-agent', '--json'));
  assert.equal(checked.status, 'ready', JSON.stringify(checked.findings ?? checked).slice(0, 1500));
  const publish = agentAct(checked);
  assert.equal(publish.state, 'publish');
  assert.match(publish.do.shell, /^singularity-flow phase prepublish intake (?:--work-id QF-1 )?--for-agent --json --publish-if-ready$/u,
    'the act publishes through the command that hands back the reviewer');
  // Run as it was given anyway, the plain publication names the reviewer too, and the agent view starts it.
  const [, ...args] = checked.commands.publish.split(' ');
  const published = JSON.parse(sflow(...args, '--json'));
  assert.equal(published.status, 'published');
  assert.equal(published.reviewSubagent?.prompt, '/sf-review-source intake');
  assert.deepEqual([agentAct(published).state, agentAct(published).do, agentAct(published).read[0]], ['start-reviewer', null, 'reviewSubagent']);
});

test('in the author\'s chat, the reviewer sub-agent reviews read-only under its own contract while the author keeps authoring', async (t) => {
  const repo = await repository(t, { implementCommands: false, reviews: true });
  const { root, sflow, sflowJson, must, env } = repo;
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(repo.base, 'remote.git')], repo.base);
  must('git', ['remote', 'add', 'origin', path.join(repo.base, 'remote.git')]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), INTAKE);
  const hook = (event, payload) => {
    const result = spawnSync(process.execPath, [CLI, 'hook', event], { cwd: root, env, input: JSON.stringify({ cwd: root, ...payload }),
      encoding: 'utf8', timeout: childTimeout(60_000) });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout || '{}');
  };
  const decision = (answer) => answer.permissionDecision ?? answer.hookSpecificOutput?.permissionDecision ?? 'allow';
  const boundaries = path.join(path.dirname(env.SINGULARITY_FLOW_COPILOT_MODE_FILE), 'copilot-boundaries');
  const contracts = async () => {
    const found = {};
    for (const name of (await readdir(boundaries)).filter((entry) => entry.endsWith('.mutation.json'))) {
      const value = JSON.parse(await readFile(path.join(boundaries, name), 'utf8'));
      found[value.sessionId] = value.contract?.turnMode ?? null;
    }
    return found;
  };

  // The author's /sf-phase turn publishes intake; the publication hands it the reviewer to start as a sub-agent.
  hook('boundary-turn', { sessionId: 'author-chat', prompt: '/sf-phase intake' });
  const published = JSON.parse(sflow('phase', 'prepublish', 'intake', '--for-agent', '--json', '--publish-if-ready'));
  assert.equal(published.publishIfReady.published, true, JSON.stringify(published.publishIfReady).slice(0, 2000));
  const handoff = published.publishIfReady.reviewSubagent;
  assert.deepEqual({ agent: handoff.agent, prompt: handoff.prompt, generation: handoff.generation },
    { agent: 'sflow-source-reviewer', prompt: '/sf-review-source intake', generation: 1 });
  assert.equal(published.publishIfReady.next.instruction, `Published. ${handoff.instruction}`, 'the author is told to start it here, not in a new chat first');
  assert.equal(published.publishIfReady.next.commandGuidance.copilotCommand, '/sf-review-source intake', 'the new-chat route stays the fallback');
  assert.equal(agentAct(published).read[0], 'publishIfReady.reviewSubagent', 'the author reads the handoff first');
  // No route to relay while the reviewer runs: the act says to start it and wait, not "Next: /sf-review-source".
  assert.deepEqual([agentAct(published).state, agentAct(published).do], ['start-reviewer', null]);
  assert.match(agentAct(published).said, /wait for its result in this turn/u);

  // The host starts it as the G0 probe saw (SPEC-SFG §1.1): subagentStart names the agent and the author's chat
  // (parentAgentId), and every sub-agent event runs under a session of its own. agent-start gives the pinned
  // reviewer its own review turn in the author's chat.
  const started = hook('agent-start', { sessionId: 'reviewer-own-1', agentName: 'sflow-source-reviewer', agentDescription: 'reviewer',
    agentId: 'reviewer-1', parentAgentId: 'author-chat' });
  assert.match(JSON.stringify(started), /independent read-only reviewer of QF-1 intake generation 1/u);
  const subagent = { sessionId: 'reviewer-own-1', agentId: 'reviewer-1', agentType: 'sflow-source-reviewer', parentAgentId: 'author-chat' };
  // Its task text, written by the author's turn, never replaces that turn, whether it arrives under the sub-agent's
  // own session or a host sends it under the author's.
  hook('boundary-turn', { ...subagent, prompt: 'Review intake: /sf-review-source intake' });
  hook('boundary-turn', { ...subagent, sessionId: 'author-chat', prompt: 'Review intake: /sf-review-source intake' });
  assert.deepEqual(await contracts(), { 'author-chat': 'authoring', 'author-chat#agent:sflow-source-reviewer': 'read-only-review' });

  // The reviewer reads its packet; the review's staging file is issued to the reviewer's turn alone.
  const packet = sflowJson('review-source', 'context', 'intake', '--for-agent').value;
  const stagingPath = packet.stagingPath;
  const write = (who) => hook('boundary-guard', { ...who, toolName: 'create', toolArgs: { path: stagingPath, file_text: JSON.stringify(documentReport(packet)) } });
  assert.equal(decision(write(subagent)), 'allow', 'the reviewer writes its own report');
  assert.equal(decision(write({ sessionId: 'author-chat' })), 'deny', 'the author cannot write the reviewer\'s report');
  const edit = hook('boundary-guard', { ...subagent, toolName: 'edit', toolArgs: { path: path.join(root, 'src/value.mjs'), old_str: '1', new_str: '2' } });
  assert.equal(decision(edit), 'deny', 'the reviewer is read-only');
  const retain = hook('boundary-guard', { ...subagent, toolName: 'bash', toolArgs: { command: `singularity-flow review-source submit intake --report-file ${stagingPath} --json` } });
  assert.equal(decision(retain), 'allow', 'the reviewer retains its review');
  const shared = { ...subagent, sessionId: 'author-chat' };
  assert.equal(decision(hook('boundary-guard', { ...shared, toolName: 'edit', toolArgs: { path: path.join(root, 'src/value.mjs'), old_str: '1', new_str: '2' } })),
    'deny', 'a host that runs the sub-agent under the author\'s session checks it as the reviewer too');
  assert.equal(decision(write(shared)), 'allow');
  const authorRetains = hook('boundary-guard', { sessionId: 'author-chat', toolName: 'bash', toolArgs: { command: `singularity-flow review-source submit intake --report-file ${stagingPath} --json` } });
  assert.equal(decision(authorRetains), 'deny', 'the author never retains the review of its own step');

  // The reviewer's work, then back to the author: the retained review routes to submission in this chat.
  await writeFile(stagingPath, JSON.stringify(documentReport(packet)));
  sflowJson('review-source', 'submit', 'intake', '--report-file', stagingPath);
  const status = sflowJson('review-source', 'status', 'intake', '--work-id', 'QF-1', '--for-agent').value;
  assert.equal(status.status, 'ready');
  assert.match(JSON.stringify(status.continuation ?? status.act ?? status), /submit intake/u);
  assert.equal((await contracts())['author-chat'], 'authoring', 'the author kept its own turn throughout');

  // Snake-case hook fields name the same things (session_id, agent_type, agent_id, tool_name, tool_input).
  hook('boundary-turn', { session_id: 'vscode-chat', prompt: '/sf-phase intake' });
  const vscodeStart = hook('agent-start', { session_id: 'vscode-chat', agent_type: 'sflow-source-reviewer', agent_id: 'reviewer-vs' });
  assert.match(vscodeStart.hookSpecificOutput?.additionalContext ?? '', /independent read-only reviewer of QF-1 intake/u, 'VS Code reads it under hookSpecificOutput');
  assert.equal((await contracts())['vscode-chat#agent:sflow-source-reviewer'], 'read-only-review');
  sflowJson('review-source', 'context', 'intake', '--for-agent');
  const vscodeEdit = hook('boundary-guard', { session_id: 'vscode-chat', agent_id: 'reviewer-vs', agent_type: 'sflow-source-reviewer',
    tool_name: 'edit', tool_input: { path: path.join(root, 'src/value.mjs'), old_str: '1', new_str: '2' } });
  assert.equal(decision(vscodeEdit), 'deny', 'the VS Code reviewer sub-agent is read-only too');
  assert.equal(vscodeEdit.hookSpecificOutput?.permissionDecision, 'deny');

  // A host that does not name the sub-agent on its calls leaves them under the author's contract: no review there.
  const unnamed = hook('boundary-guard', { sessionId: 'author-chat', agentId: 'reviewer-2', toolName: 'create',
    toolArgs: { path: stagingPath, file_text: '{}' } });
  assert.equal(decision(unnamed), 'deny', 'an unnamed sub-agent cannot write the review: the handoff says to run it in a new chat');
});

/** A quick-fix Story at intake with its draft written, and the hook commands as a host runs them from the checkout. */
async function authorStory(t) {
  const repo = await repository(t, { implementCommands: false, reviews: true });
  const { root, sflow, must, env } = repo;
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(repo.base, 'remote.git')], repo.base);
  must('git', ['remote', 'add', 'origin', path.join(repo.base, 'remote.git')]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  sflow('prepare', 'intake');
  await writeFile(path.join(root, 'singularity/work-items/QF-1/artifacts/intake/intake.md'), INTAKE);
  const hook = (event, payload) => {
    const result = spawnSync(process.execPath, [CLI, 'hook', event], { cwd: root, env, input: JSON.stringify({ cwd: root, ...payload }),
      encoding: 'utf8', timeout: childTimeout(60_000) });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout || '{}');
  };
  const boundaries = path.join(path.dirname(env.SINGULARITY_FLOW_COPILOT_MODE_FILE), 'copilot-boundaries');
  const contracts = async () => {
    const found = {};
    for (const name of (await readdir(boundaries)).filter((entry) => entry.endsWith('.mutation.json'))) {
      const value = JSON.parse(await readFile(path.join(boundaries, name), 'utf8'));
      found[value.sessionId] = value.contract?.turnMode ?? null;
    }
    return found;
  };
  return { ...repo, hook, contracts, boundaries };
}
const decisionOf = (answer) => answer.permissionDecision ?? answer.hookSpecificOutput?.permissionDecision ?? 'allow';

test('a plain prepublish that keeps what the person asked for is SFlow\'s own commit, also after a shell command took a baseline', async (t) => {
  // Copilot CLI live probe (2026-11-12, Haiku 5.5): the author read three files with one chained shell command, which
  // took the turn's shell baseline; the plain prepublish then committed what the person asked for, the after-tool check
  // called that commit a change made outside SFlow, and the author stopped before publishing.
  const { root, sflow, must, hook } = await authorStory(t);
  hook('boundary-turn', { sessionId: 'author-chat', prompt: '/sf-phase QF-1 make the exported value 2' });
  const read = { sessionId: 'author-chat', toolName: 'bash', toolArgs: { command: 'cat src/value.mjs; ls test* tests 2>/dev/null; cat package.json 2>/dev/null | head -30' } };
  assert.equal(decisionOf(hook('boundary-guard', read)), 'allow');
  assert.deepEqual(hook('boundary-after', read), {});
  const before = must('git', ['rev-parse', 'HEAD']).trim();
  const prepublish = { sessionId: 'author-chat', toolName: 'bash', toolArgs: { command: 'singularity-flow phase prepublish intake --work-id QF-1 --for-agent --json' } };
  assert.equal(decisionOf(hook('boundary-guard', prepublish)), 'allow');
  const checked = JSON.parse(sflow('phase', 'prepublish', 'intake', '--work-id', 'QF-1', '--for-agent', '--json'));
  assert.equal(checked.status, 'ready', JSON.stringify(checked.findings ?? checked).slice(0, 1500));
  assert.match(must('git', ['log', '-1', '--format=%s']), /^\[QF-1\]\[asked-for\] intake generation 1$/mu, 'the prepublish kept what the person asked for');
  assert.notEqual(must('git', ['rev-parse', 'HEAD']).trim(), before);
  assert.deepEqual(hook('boundary-after', prepublish), {}, 'its own commit is no change made outside SFlow');
  // A change no SFlow command made is still caught against the baseline moved past that commit.
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 2;\n');
  const other = { sessionId: 'author-chat', toolName: 'bash', toolArgs: { command: 'node tools/bump.mjs' } };
  assert.match(JSON.stringify(hook('boundary-after', other)), /PHASE_MUTATION_SHELL_CHANGE_DETECTED[^"]*src\/value\.mjs/u);
});

test('Copilot CLI task: the reviewer named after SFlow\'s plugin gets its own review turn, and the author\'s is never replaced', async (t) => {
  // Copilot CLI 1.0.109, live 2026-11-12: a plugin's agent arrives as "<plugin>:<agent>"; the sub-agent's events carry a
  // session of its own (its agentId), the author's as parentAgentId; subagentStart and subagentStop the author's session.
  assert.equal(subagentName({ agentType: 'singularity-flow:sflow-source-reviewer' }), 'sflow-source-reviewer');
  assert.equal(subagentName({ agentType: 'another-plugin:sflow-source-reviewer' }), null, 'another plugin\'s agent is not SFlow\'s');
  const { root, sflow, sflowJson, hook, contracts } = await authorStory(t);
  const author = 'cli-author';
  hook('boundary-turn', { sessionId: author, prompt: '/sf-phase QF-1 make the exported value 2' });
  const published = JSON.parse(sflow('phase', 'prepublish', 'intake', '--for-agent', '--json', '--publish-if-ready'));
  assert.equal(published.publishIfReady.published, true, JSON.stringify(published.publishIfReady).slice(0, 2000));
  const agentType = 'singularity-flow:sflow-source-reviewer';
  const task = { sessionId: author, toolCallId: 'toolu_review', toolName: 'task',
    toolArgs: { name: 'review-intake', agent_type: agentType, description: 'Review intake', prompt: '/sf-review-source intake', mode: 'sync' } };
  assert.equal(decisionOf(hook('boundary-guard', task)), 'allow');
  const started = hook('agent-start', { sessionId: author, agentName: agentType, agentDisplayName: 'sflow-source-reviewer',
    agentDescription: 'Independently reviews an exact Story step', agentId: 'reviewer-own', agentType, parentAgentId: author });
  assert.match(JSON.stringify(started), /independent read-only reviewer of QF-1 intake generation 1/u);
  const subagent = { sessionId: 'reviewer-own', agentId: 'reviewer-own', agentType, parentAgentId: author };
  hook('boundary-turn', { ...subagent, prompt: `${started.additionalContext}\n\n/sf-review-source intake` });
  assert.deepEqual(await contracts(), { [author]: 'authoring', [`${author}#agent:sflow-source-reviewer`]: 'read-only-review' });
  const packet = sflowJson('review-source', 'context', 'intake', '--for-agent').value;
  const write = (who) => hook('boundary-guard', { ...who, toolCallId: 'toolu_write', toolName: 'create', toolArgs: { path: packet.stagingPath, file_text: JSON.stringify(documentReport(packet)) } });
  assert.equal(decisionOf(write(subagent)), 'allow', 'the reviewer writes its own report');
  assert.equal(decisionOf(hook('boundary-guard', { ...subagent, toolCallId: 'toolu_edit', toolName: 'edit',
    toolArgs: { path: path.join(root, 'src/value.mjs'), old_str: '1', new_str: '2' } })), 'deny', 'the reviewer is read-only');
  assert.equal(decisionOf(write({ sessionId: author })), 'deny', 'the author never writes the review');
  hook('boundary-stop', { ...subagent, stopReason: 'end_turn', stop_hook_active: false });
  hook('boundary-after', { ...task, toolResult: 'The review is retained.' });
  assert.equal((await contracts())[author], 'authoring', 'the author\'s turn is its own throughout');
});

test('a standalone SFlow command the author\'s turn does not run is never sent back to be run on its own', async (t) => {
  // Copilot CLI live probe (2026-11-12, Haiku 5.5): `singularity-flow --help` in /sf-phase was refused with "Run
  // `singularity-flow --help` on its own"; it already was, so the model handed the step to sub-agents, which published
  // it with no reviewer started.
  const { hook } = await authorStory(t);
  hook('boundary-turn', { sessionId: 'author-chat', prompt: '/sf-phase QF-1' });
  const guard = (command) => hook('boundary-guard', { sessionId: 'author-chat', toolName: 'bash', toolArgs: { command } });
  for (const command of ['singularity-flow --help', 'singularity-flow -h']) {
    const answer = guard(command);
    assert.equal(decisionOf(answer), 'deny', command);
    assert.match(answer.permissionDecisionReason, /^PHASE_MUTATION_OPERATION_NOT_ALLOWED: run `singularity-flow help` \(or `singularity-flow help <command>`\) instead/u, command);
    assert.doesNotMatch(answer.permissionDecisionReason, /on its own/u, command);
  }
  assert.equal(decisionOf(guard('singularity-flow help')), 'allow', 'the route it names runs');
  // A real chain still gets the one command to run alone.
  assert.match(guard('singularity-flow help | head -5').permissionDecisionReason, /Run `singularity-flow help` on its own in this turn/u);
});
