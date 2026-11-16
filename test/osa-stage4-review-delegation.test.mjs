/**
 * SPEC-OSA v1.1 Stage 4 (plan section 6 items 5–6, §9): the independent review is started only through a qualified Copilot
 * delegation, bound to the exact version and packet, a fresh reviewer context, its own read-only role and issued staging,
 * and the identity its retained report carries. The author never gains the reviewer's or an approver's authority. When
 * delegation is unavailable, failed or cancelled, the review stays pending and the supported way on is /sf-review-source
 * in a new chat; never a self-review, never another harness [OSA:REQ-052, AC-018].
 *
 * On a real quick-fix Story through the real hook commands (the fixture of review-subagent-cli.test.mjs). Expected results
 * are written out here.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { repository, cli as CLI } from './helpers/run-and-test-fixture.mjs';
import { documentReport } from './helpers/step-review.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { delegatedReportProblem, REVIEW_DELEGATION_CAPABILITY, REVIEW_DISPATCH_MODES, reviewDelegation, reviewDelegationAfter,
  reviewDelegationOutcome, reviewDispatchMode } from '../src/review-subagent.mjs';
import { stepState } from '../src/kernel/step-state.mjs';
import { stepSnapshotOf } from '../src/step-decision.mjs';

const INTAKE = ['# QF-1 — Quick fix scope and plan', '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
  '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', '| [QF-1:AC-001] | The exported value equals 2. |', '',
  '## Planned implementation evidence', '',
  '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
  '| `QF-1:AC-001` | `src/value.mjs` | `test/value.test.mjs` | modified | The test reads 2. |', '',
  '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n');

/** A quick-fix Story at intake, its draft written and published in the author's /sf-phase turn. */
async function publishedIntake(t) {
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
  hook('boundary-turn', { sessionId: 'author-chat', prompt: '/sf-phase intake' });
  const published = JSON.parse(sflow('phase', 'prepublish', 'intake', '--for-agent', '--json', '--publish-if-ready'));
  assert.equal(published.publishIfReady.published, true, JSON.stringify(published.publishIfReady).slice(0, 2000));
  return { ...repo, hook, contracts, published };
}
const decisionOf = (answer) => answer.permissionDecision ?? answer.hookSpecificOutput?.permissionDecision ?? 'allow';
const reasonOf = (answer) => answer.permissionDecisionReason ?? answer.hookSpecificOutput?.permissionDecisionReason ?? '';
const contextOf = (answer) => answer.additionalContext ?? answer.hookSpecificOutput?.additionalContext ?? '';

test('the qualified dispatch modes are Copilot\'s own, each with what makes it independent and its evidence; nothing else qualifies', () => {
  assert.deepEqual(Object.keys(REVIEW_DISPATCH_MODES), ['copilot-cli-task', 'vscode-run-subagent']);
  for (const mode of Object.values(REVIEW_DISPATCH_MODES)) for (const field of ['context', 'attribution', 'evidence']) assert.ok(mode[field]?.length > 10, field);
  assert.equal(reviewDispatchMode('task'), 'copilot-cli-task');
  assert.equal(reviewDispatchMode('runSubagent'), 'vscode-run-subagent');
  assert.equal(reviewDispatchMode('copilot.run_subagent'), 'vscode-run-subagent');
  for (const other of ['spawn_agent', 'write_agent', 'delegate', 'codex_exec', '', null]) assert.equal(reviewDispatchMode(other), null, String(other));
});

test('a publication that owes its review starts it through the qualified delegation, bound to its exact version, role and report [§9]', async (t) => {
  const { published, sflowJson } = await publishedIntake(t);
  const handoff = published.publishIfReady.reviewSubagent;
  const { delegation } = handoff;
  const pinned = sflowJson('review-source', 'context', 'intake', '--for-agent').value.reviewerAgentSha256 ?? null;
  assert.equal(delegation.schema, 'sflow-review-delegation/v1');
  assert.equal(delegation.status, 'delegate');
  assert.deepEqual({ workId: delegation.binding.workId, phase: delegation.binding.phase, version: delegation.binding.version, role: delegation.binding.role },
    { workId: 'QF-1', phase: 'intake', version: 1, role: 'reviewer' });
  assert.equal(delegation.binding.reviewer.agent, 'sflow-source-reviewer');
  if (pinned) assert.equal(delegation.binding.reviewer.sha256, pinned, 'the pinned reviewer bytes, never a live replacement');
  assert.equal(delegation.binding.packet.command, 'singularity-flow review-source context intake --for-agent --json');
  assert.equal(delegation.binding.packet.version, 1);
  assert.match(delegation.binding.context, /^fresh: the review prompt alone, never the author's conversation$/u);
  assert.match(delegation.binding.staging, /issued staging path only/u);
  assert.deepEqual(delegation.binding.report, { version: 1, reviewer: 'sflow-source-reviewer', retainedBy: 'singularity-flow review-source submit intake' });
  assert.match(delegation.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(delegation.parent, { role: 'author', gains: [] }, 'starting the reviewer grants the author nothing');
  assert.deepEqual(delegation.modes, ['copilot-cli-task', 'vscode-run-subagent']);
  // The supported fallback and what holds with no qualified mode: written out.
  assert.deepEqual(delegation.fallback, { status: 'fresh-conversation', copilotCommand: '/sf-review-source intake', prerequisite: 'independent-context',
    words: 'Run this in a new chat: /sf-review-source intake. A new chat keeps the review independent of the conversation that wrote it.' });
  assert.equal(delegation.pending.status, 'review-pending');
  assert.equal(delegation.pending.capability, REVIEW_DELEGATION_CAPABILITY);
  assert.match(delegation.pending.words, /^intake version 1 waits for its independent review: this host has no qualified way to start it, so nothing was reviewed\./u);
  assert.match(handoff.instruction, /No sub-agent tool: end with "Run this in a new chat:" and \/sf-review-source intake\./u);
  assert.doesNotMatch(JSON.stringify(handoff), /codex|claude|gemini|another harness/iu, 'no other harness is ever named');
});

test('only a qualified sub-agent tool starts the reviewer; any other is refused with the fresh-conversation route, and the author gains no authority', async (t) => {
  const { root, hook, contracts, sflowJson } = await publishedIntake(t);
  const start = (toolName, id) => hook('boundary-guard', { sessionId: 'author-chat', toolName, toolCallId: id,
    toolArgs: { agent_type: 'sflow-source-reviewer', prompt: '/sf-review-source intake' } });
  for (const tool of ['spawn_agent', 'delegate', 'write_agent']) {
    const refused = start(tool, `call-${tool}`);
    assert.equal(decisionOf(refused), 'deny', tool);
    assert.match(reasonOf(refused), /^PHASE_MUTATION_DELEGATION_NOT_QUALIFIED: [a-z_]+ is not a qualified way to start the independent reviewer, and this turn never reviews its own step\. End with "Run this in a new chat:" and \/sf-review-source intake/u, tool);
  }
  assert.equal(decisionOf(start('task', 'call-task')), 'allow', 'Copilot CLI\'s task starts it');
  // The author's turn stays the author's: it never writes, retains or approves the review of its own step.
  const packet = sflowJson('review-source', 'context', 'intake', '--for-agent').value;
  await writeFile(packet.stagingPath, JSON.stringify(documentReport(packet)));
  const asAuthor = (command) => hook('boundary-guard', { sessionId: 'author-chat', toolName: 'bash', toolArgs: { command } });
  assert.equal(decisionOf(hook('boundary-guard', { sessionId: 'author-chat', toolName: 'create', toolArgs: { path: packet.stagingPath, file_text: '{}' } })), 'deny');
  assert.equal(decisionOf(asAuthor(`singularity-flow review-source submit intake --report-file ${packet.stagingPath} --json`)), 'deny', 'no self-review');
  assert.equal(decisionOf(asAuthor('singularity-flow approve intake --yes')), 'deny', 'no approver authority');
  assert.equal((await contracts())['author-chat'], 'authoring');
  assert.ok(root);
});

test('a failed or cancelled reviewer launch keeps the review pending and names the fresh-conversation route, never a self-review', async (t) => {
  const { hook, sflowJson } = await publishedIntake(t);
  const launch = { sessionId: 'author-chat', toolName: 'task', toolCallId: 'call-review', toolArgs: { agent_type: 'sflow-source-reviewer', prompt: '/sf-review-source intake' } };
  assert.equal(decisionOf(hook('boundary-guard', launch)), 'allow');
  const failed = hook('boundary-after', { ...launch, toolResult: { resultType: 'failure', textResultForLlm: 'The sub-agent could not start.' } });
  assert.equal(contextOf(failed), 'SFlow: the reviewer of intake did not run (failed). Its review stays pending and nothing was reviewed. Never review, stage or retain it yourself. Run this in a new chat: /sf-review-source intake (a new chat keeps the review independent).');
  const cancelled = hook('boundary-after', { ...launch, toolCallId: 'call-review-2', toolResult: { resultType: 'rejected', textResultForLlm: 'The user cancelled.' } });
  assert.match(contextOf(cancelled), /^SFlow: the reviewer of intake did not run \(cancelled\)\./u);
  // The host's tool-failure event for the launch says the same.
  const errored = hook('boundary-failure', { ...launch, toolCallId: 'call-review-3', error: { message: 'tool failed' } });
  assert.match(contextOf(errored), /^SFlow: the reviewer of intake did not run \(failed\)\./u);
  // Nothing was reviewed: every view still names the review, in a new turn.
  const status = sflowJson('review-source', 'status', 'intake', '--work-id', 'QF-1', '--for-agent').value;
  assert.notEqual(status.status, 'ready');
  const next = sflowJson('nextsteps', 'QF-1').value;
  const now = (next.data?.actions ?? next.actions ?? []).find((action) => action.timing === 'now');
  assert.match(now?.copilotCommand ?? '', /^\/sf-review-source intake\b/u, JSON.stringify(now));
});

test('a launch that completed, another tool, or the reviewer\'s own call adds nothing; the outcome is read from the host\'s result', () => {
  const launch = { sessionId: 'a', toolName: 'task', toolArgs: { agent_type: 'sflow-source-reviewer', prompt: '/sf-review-source plan' } };
  assert.equal(reviewDelegationAfter({ ...launch, toolResult: { resultType: 'success' } }), null);
  assert.equal(reviewDelegationAfter({ ...launch, toolName: 'bash', toolArgs: { command: 'ls' }, toolResult: { resultType: 'failure' } }), null);
  assert.equal(reviewDelegationAfter({ ...launch, toolArgs: { agent_type: 'helper', prompt: 'summarize' }, toolResult: { resultType: 'failure' } }), null, 'another sub-agent');
  assert.equal(reviewDelegationAfter({ ...launch, agentId: 'reviewer-1', toolResult: { resultType: 'failure' } }), null, 'the sub-agent\'s own event');
  assert.equal(reviewDelegationAfter(launch, { failure: true }).outcome, 'failed');
  for (const [type, outcome] of [['success', 'completed'], ['failure', 'failed'], ['error', 'failed'], ['rejected', 'cancelled'], ['denied', 'cancelled'],
    ['cancelled', 'cancelled'], ['interrupted', 'cancelled'], ['', null]]) assert.equal(reviewDelegationOutcome({ resultType: type }), outcome, type);
});

test('a retained review answers the delegation only for its exact version, by the pinned reviewer, read-only [§9, AC-018]', () => {
  const { binding } = reviewDelegation({ workId: 'QF-1', phase: 'intake', generation: 2, reviewerAgent: 'sflow-source-reviewer' });
  const retained = (generation, reviewer = 'sflow-source-reviewer', readOnly = true) => ({ generation, provenance: { reviewerAgentId: reviewer, readOnly } });
  assert.equal(delegatedReportProblem(binding, retained(2)), null);
  assert.equal(delegatedReportProblem(binding, retained(1)).code, 'REVIEW_DELEGATION_VERSION_MISMATCH');
  assert.equal(delegatedReportProblem(binding, retained(1)).words, 'The retained review is of version 1, not version 2 that was delegated; it does not count for it.');
  assert.equal(delegatedReportProblem(binding, retained(2, 'sflow-workflow')).code, 'REVIEW_DELEGATION_REVIEWER_MISMATCH');
  assert.equal(delegatedReportProblem(binding, retained(2, 'sflow-source-reviewer', false)).code, 'REVIEW_DELEGATION_NOT_READ_ONLY');
  assert.equal(delegatedReportProblem(binding, null).code, 'REVIEW_DELEGATION_REPORT_MISSING');
  assert.equal(reviewDelegation({ workId: 'QF-1', phase: 'intake', generation: 0, reviewerAgent: 'sflow-source-reviewer' }), null, 'nothing published, nothing to delegate');
  // The kernel: a ready review of version 1 is not version 2's review; version 2 is still in review [§4.3, §9].
  const workflow = { schemaVersion: 13, workItem: { id: 'QF-1' }, status: 'in_progress', currentPhase: 'intake', phaseOrder: ['intake'], history: [],
    resolution: { sourceReview: { mode: 'enforce', phases: ['intake'], reviewerAgent: 'sflow-source-reviewer' } },
    phases: { intake: { id: 'intake', status: 'in_progress', generation: 2, generationPolicy: { requirement: 'required', task: 'document' },
      authorship: [{ generation: 1, publishedAt: '2026-11-17T08:00:00.000Z' }, { generation: 2, publishedAt: '2026-11-17T09:00:00.000Z' }] } } };
  const decide = (version) => stepState(stepSnapshotOf({ workflow, phase: workflow.phases.intake, review: { phaseId: 'intake', status: 'ready', version }, reviewOwed: true }));
  assert.equal(decide(2).next.operation, 'submit-version');
  assert.equal(decide(1).state, 'in-review', 'a stale report never satisfies the current review');
  assert.equal(decide(1).next.operation, 'start-review');
});

test('a report staged for another version than the packet\'s is refused at retention; nothing is retained', async (t) => {
  const { sflow, sflowJson } = await publishedIntake(t);
  const packet = sflowJson('review-source', 'context', 'intake', '--for-agent').value;
  const report = documentReport(packet);
  const binding = typeof report.binding === 'object' && report.binding ? report.binding : packet.reportTemplate?.binding ?? packet.binding;
  const wrong = { ...report, binding: { ...(typeof binding === 'object' ? binding : {}), generation: 2 } };
  await writeFile(packet.stagingPath, JSON.stringify(wrong));
  let refusal = null;
  try { sflow('review-source', 'submit', 'intake', '--report-file', packet.stagingPath, '--json'); } catch (error) { refusal = String(error.stdout ?? error.message ?? error); }
  assert.ok(refusal, 'the wrong-version report was not refused');
  assert.match(refusal, /SOURCE_REVIEW_(?:REPORT_INVALID|BINDING_STALE)/u);
  const status = sflowJson('review-source', 'status', 'intake', '--work-id', 'QF-1', '--for-agent').value;
  assert.notEqual(status.status, 'ready', 'nothing was retained');
});
