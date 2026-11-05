import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordSha256 } from '../src/records.mjs';
import { workflowTaskIdentity, workflowTaskInputSha256, updateWorkflowTask, workflowTaskResume,
  validateWorkflowTask, mergeWorkflowTasks, workflowTaskDeltaSafe } from '../src/workflow-task.mjs';
import { observeWorkflowTask, readWorkflowTask, readWorkflowTaskResume, reserveWorkflowTaskContinuation,
  batchWorkflowTaskProgress, resumeWorkflowTask, observeWorkflowTaskCheck } from '../src/workflow-task-store.mjs';
import { importSharedWorkflowTaskProgress, quarantineWorkflowTaskProgress, shareWorkflowTaskProgress } from '../src/workflow-task-store.mjs';
import { publishToStateBranch } from '../src/ledger.mjs';
import { phaseRepairLoopSummary } from '../src/phase-repair-journal.mjs';
import { LIFECYCLE_EVENT } from '../src/lifecycle-event.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';
import { startedSpecificationStory, specification, CLI } from './helpers/submitted-planning-story.mjs';
import { completeAgentResult, agentAct } from '../src/agent-output.mjs';

function story(phaseId = 'custom-inspection') {
  const phase = { id: phaseId, generation: 0, status: 'in_progress', defaultAgent: 'author',
    generationPolicy: { task: 'document', requirement: 'required' }, requiredArtifact: { path: `artifacts/${phaseId}/report.md` } };
  const workflow = { workItem: { id: 'TASK-RESUME', createdAt: '2026-11-04T00:00:00Z' },
    status: 'in_progress', currentPhase: phaseId, phaseOrder: [phaseId], phases: { [phaseId]: phase },
    resolution: { sourceSha256: 'source-v1', capability: { id: 'test-capability' } } };
  return { workflow, phase };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-task-resume Ω ')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Task Tester'); git('config', 'user.email', 'task@example.test');
  await writeFile(path.join(root, 'README.md'), 'Fixture\n'); git('add', '.'); git('commit', '-qm', 'Fixture');
  return { root, git, ...story() };
}

test('a phase neither being authored nor ever published has no task, so reading it refuses nothing', async t => {
  const f = await fixture(t);
  f.phase.status = 'awaiting_approval';
  assert.equal(await readWorkflowTaskResume(f.root, f.workflow, f.phase), null);
  assert.equal(await readWorkflowTaskResume(f.root, f.workflow, f.phase, { generation: 0 }), null);
  assert.equal(await resumeWorkflowTask(f.root, f.workflow, f.phase), null);
  assert.equal(await observeWorkflowTaskCheck(f.root, f.workflow, f.phase, { status: 'ready', generation: 0 }), null);
  f.workflow.resolution.ledger = { enabled: true, remote: 'origin', branch: 'state' };
  assert.deepEqual(await importSharedWorkflowTaskProgress(f.root, f.workflow, f.phase), { status: 'imported', imported: 0 });
  // Asking for this task by name is still a refusal: there is nothing to share or repair.
  await assert.rejects(shareWorkflowTaskProgress(f.root, f.workflow, f.phase), { code: 'WORKFLOW_TASK_RECORD_INVALID' });
  f.phase.status = 'in_progress';
  assert.equal((await readWorkflowTaskResume(f.root, f.workflow, f.phase)).generation, 1, 'authoring it names its next generation');
});

for (const id of ['planning', 'implementation', 'verification', 'release', 'copied-user-phase', 'future-task']) {
  test(`${id} uses the same portable task identity, independent of a chat or checkout path`, () => {
    const { workflow, phase } = story(id);
    const a = workflowTaskIdentity(workflow, phase);
    const copy = structuredClone(workflow);
    assert.deepEqual(workflowTaskIdentity(copy, copy.phases[id]), a);
    assert.notEqual(workflowTaskIdentity(workflow, phase, 'source-reviewer', 1).id, a.id);
    assert.notEqual(workflowTaskIdentity(workflow, phase, 'author', 2).id, a.id);
    copy.workItem.createdAt = '2026-11-04T00:00:01Z';
    assert.notEqual(workflowTaskIdentity(copy, phase).id, a.id);
  });
}

test('legacy repository base maps and current arrays resolve to the same task identity', () => {
  const { workflow, phase } = story();
  workflow.workItem.repositoryBases = [{ repositoryId: 'api' }, null, { id: 'web' }];
  const current = workflowTaskIdentity(workflow, phase);
  workflow.workItem.repositoryBases = { web: { branch: 'main' }, api: { branch: 'main' } };
  assert.deepEqual(workflowTaskIdentity(workflow, phase), current);
});

test('input changes invalidate checkpoints, retaining budgets and distinct repair conditions', () => {
  const { workflow, phase } = story();
  const id = workflowTaskIdentity(workflow, phase);
  const inputSha256 = workflowTaskInputSha256(workflow, phase);
  const record = updateWorkflowTask(id, null, { inputSha256, state: 'repair-draft', continuations: 2,
    repairConsumed: 2, condition: recordSha256('failure'), checkpoint: 'validation' });
  assert.strictEqual(updateWorkflowTask(id, record, { inputSha256, state: 'repair-draft' }), record, 'identical reads do not create revisions');
  workflow.resolution.sourceSha256 = 'source-v2';
  const updated = updateWorkflowTask(id, record, { inputSha256: workflowTaskInputSha256(workflow, phase) });
  assert.equal(updated.continuations, 2);
  assert.equal(updated.repairConsumed, 2);
  assert.equal(updated.conditions.length, 1);
  assert.deepEqual(updated.checkpoints, []);
  assert.equal(workflowTaskResume(workflow, phase, { record }).inputChanged, true);
});

test('untrusted progress cannot declare publication or retained review complete', () => {
  const { workflow, phase } = story();
  const record = updateWorkflowTask(workflowTaskIdentity(workflow, phase), null, {
    inputSha256: workflowTaskInputSha256(workflow, phase), state: 'complete', checkpoint: 'publication' });
  assert.equal(workflowTaskResume(workflow, phase, { record }).complete, false);
  assert.equal(workflowTaskResume(workflow, phase, { published: true, pendingPublication: true }).complete, false);
  const review = { state: 'retained', complete: true };
  assert.equal(workflowTaskResume(workflow, phase, { role: 'source-reviewer', generation: 1, review }).complete, true);
});

test('a fresh human or attachment blocker retains its exact owner action', () => {
  const { workflow, phase } = story();
  const action = safeCommandGuidance({ argv: ['decisions', workflow.workItem.id, '--for-agent', '--json'] });
  const value = workflowTaskResume(workflow, phase, { blocked: { code: 'HUMAN_APPROVAL_REQUIRED', nextAction: action } });
  assert.equal(value.state, 'blocked');
  assert.deepEqual(value.nextAction, action);
  assert.equal(value.complete, false);
});

test('ambiguous publication resumes by observation before any command replay', () => {
  const { workflow, phase } = story();
  const record = updateWorkflowTask(workflowTaskIdentity(workflow, phase), null, {
    inputSha256: workflowTaskInputSha256(workflow, phase), state: 'publication-requested', checkpoint: 'publication-requested' });
  const value = workflowTaskResume(workflow, phase, { record });
  assert.equal(value.state, 'inspect-interrupted-operation');
  assert.match(value.nextAction.command, /^singularity-flow phase draft-check custom-inspection --work-id TASK-RESUME/);
  assert.equal(value.nextAction.copilotCommand, null, 'a read-only inspection cannot route back to phase authoring');
  assert.equal(workflowTaskResume(workflow, phase, { record, published: true }).complete, true);
});

test('interrupted tasks across phase names preserve pending publications and real owner blockers', () => {
  for (const phaseId of ['specification', 'planning', 'implementation', 'verification', 'release', 'custom-code', 'future-task']) {
    const { workflow, phase } = story(phaseId);
    const record = updateWorkflowTask(workflowTaskIdentity(workflow, phase), null, {
      inputSha256: workflowTaskInputSha256(workflow, phase), state: 'publication-requested', continuations: 2, repairConsumed: 1 });
    const inspection = workflowTaskResume(workflow, phase, { record });
    assert.deepEqual(inspection.nextAction.argv, ['phase', 'draft-check', phaseId, '--work-id', workflow.workItem.id, '--for-agent', '--json']);
    assert.equal(inspection.continuationBudget.consumed, 2);
    assert.equal(inspection.repairConsumed, 1);
    const pending = workflowTaskResume(workflow, phase, { record, pendingPublication: true });
    assert.equal(pending.state, 'blocked');
    assert.match(pending.nextAction.command, /^singularity-flow recover /);
    const owner = safeCommandGuidance({ argv: ['decisions', workflow.workItem.id, '--json'] });
    const blocked = workflowTaskResume(workflow, phase, { record, blocked: { code: 'HUMAN_APPROVAL_REQUIRED', nextAction: owner } });
    assert.equal(blocked.state, 'blocked');
    assert.deepEqual(blocked.nextAction, owner);
  }
});

test('Copilot receives the interruption recovery before authoring or review and pause still takes precedence', () => {
  const { workflow, phase } = story();
  const record = updateWorkflowTask(workflowTaskIdentity(workflow, phase), null, {
    inputSha256: workflowTaskInputSha256(workflow, phase), state: 'publication-requested' });
  const taskResume = workflowTaskResume(workflow, phase, { record });
  for (const resultType of ['sflow-phase-entry', 'source-review-agent-context']) {
    const packet = { resultType, status: 'authoring-entry', canReview: true, taskResume };
    const action = agentAct(packet);
    assert.equal(action.state, 'next');
    assert.match(action.do.shell, /^singularity-flow phase draft-check/);
    assert.equal(action.do.copilot, null);
    assert.equal(agentAct({ ...packet, paused: true }).state, 'paused');
    assert.equal(agentAct({ ...packet, documentReadiness: { status: 'upload-required' } }).state, 'ask-person');
    const refusal = agentAct({ ...packet, error: { code: 'EACCES', message: 'The issued file cannot be read.' },
      remediationPlan: { steps: [{ kind: 'remediation', label: 'Ask the filesystem owner to restore access.' }] } });
    assert.equal(refusal.state, 'ask-person');
    assert.match(refusal.said, /EACCES/);
  }
});

test('portable records reject added local paths, prompts and executable commands even with a recomputed hash', () => {
  const { workflow, phase } = story();
  const record = updateWorkflowTask(workflowTaskIdentity(workflow, phase), null, {
    inputSha256: workflowTaskInputSha256(workflow, phase) });
  for (const key of ['path', 'prompt', 'command', 'attachment']) {
    const { recordSha256: ignored, ...core } = { ...record, [key]: '/Users/private/file' };
    assert.throws(() => validateWorkflowTask({ ...core, recordSha256: recordSha256(core) }), /cannot contain local paths/);
  }
});

test('independent snapshots merge spent budgets and conditions without a clock or budget refund', () => {
  const { workflow, phase } = story();
  const id = workflowTaskIdentity(workflow, phase);
  const inputSha256 = workflowTaskInputSha256(workflow, phase);
  const shared = updateWorkflowTask(id, null, { inputSha256, continuations: 2, repairConsumed: 2,
    maximumContinuations: 2, condition: recordSha256('shared') });
  const local = updateWorkflowTask(id, null, { inputSha256, continuations: 1, condition: recordSha256('local') });
  const merged = mergeWorkflowTasks(shared, local, id);
  assert.equal(merged.continuations, 2);
  assert.equal(merged.maximumContinuations, 2);
  assert.equal(merged.repairConsumed, 2);
  assert.equal(merged.conditions.length, 2);
});

test('a human decision can carry advisory progress without permitting budget refunds or another Story task', () => {
  const { workflow, phase } = story();
  const identity = workflowTaskIdentity(workflow, phase);
  const record = updateWorkflowTask(identity, null, { inputSha256: workflowTaskInputSha256(workflow, phase), continuations: 2, repairConsumed: 2 });
  const before = structuredClone(workflow);
  workflow.taskOperations = { [record.id]: record };
  assert.equal(workflowTaskDeltaSafe(before, workflow), true);
  const after = structuredClone(workflow);
  const { recordSha256: ignored, ...core } = after.taskOperations[record.id];
  core.continuations = 0;
  after.taskOperations[record.id] = { ...core, recordSha256: recordSha256(core) };
  assert.equal(workflowTaskDeltaSafe(workflow, after), false);
  after.taskOperations = {};
  assert.equal(workflowTaskDeltaSafe(workflow, after), false);
  const unrelated = structuredClone(workflow);
  unrelated.workItem.id = 'OTHER-STORY';
  assert.equal(workflowTaskDeltaSafe(before, unrelated), false);
});

test('new processes resume a task without replenishing its continuation budget or changing application files', async t => {
  const f = await fixture(t);
  const before = f.git('rev-parse', 'HEAD');
  const first = await resumeWorkflowTask(f.root, f.workflow, f.phase, { progress: { state: 'author-draft' } });
  const expected = workflowTaskIdentity(f.workflow, f.phase);
  await reserveWorkflowTaskContinuation(f.root, first.operationId, expected);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {readWorkflowTaskResume} from ${JSON.stringify(new URL('../src/workflow-task-store.mjs', import.meta.url).href)};
     console.log(JSON.stringify(await readWorkflowTaskResume(${JSON.stringify(f.root)},${JSON.stringify(f.workflow)},${JSON.stringify(f.phase)})));`],
    { cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const resumed = JSON.parse(result.stdout);
  assert.equal(resumed.operationId, first.operationId);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.continuationBudget.consumed, 1);
  for (let n = 0; n < 2; n++) assert.equal((await reserveWorkflowTaskContinuation(f.root, first.operationId, expected)).allowed, true);
  assert.equal((await reserveWorkflowTaskContinuation(f.root, first.operationId, expected)).allowed, false);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('takeover imports only portable progress and requires fresh local context and terminal evidence', async t => {
  const f = await fixture(t);
  const other = await fixture(t);
  const value = await observeWorkflowTask(f.root, f.workflow, f.phase,
    { state: 'repair-draft', repairConsumed: 2, checkpoint: 'validation' });
  await reserveWorkflowTaskContinuation(f.root, value.id, workflowTaskIdentity(f.workflow, f.phase));
  await batchWorkflowTaskProgress(f.root, f.workflow);
  other.workflow = structuredClone(f.workflow);
  const resumed = await resumeWorkflowTask(other.root, other.workflow, other.phase);
  assert.equal(resumed.operationId, value.id);
  assert.equal(resumed.continuationBudget.consumed, 1);
  assert.equal(resumed.repairConsumed, 2);
  assert.equal(resumed.complete, false);
  assert.match(resumed.instruction, /Local drafts and attachments require explicit handoff or re-upload/);
  assert.equal(JSON.stringify(other.workflow.taskOperations).includes(f.root), false);
  assert.equal((await readWorkflowTask(other.root, other.workflow, other.phase)).continuations, 1);
});

test('local store corruption is explicit and never silently resets a spent budget', async t => {
  const f = await fixture(t);
  const record = await observeWorkflowTask(f.root, f.workflow, f.phase, { state: 'author-draft' });
  const file = path.join(f.root, '.git/singularity-flow/workflow-tasks', `${record.id}.json`);
  await writeFile(file, '{broken');
  await assert.rejects(readWorkflowTaskResume(f.root, f.workflow, f.phase), error => {
    assert.match(error.message, /could not be read/);
    assert.equal(error.details.path, file);
    assert.match(error.details.nextAction, /appeal task-quarantine --work-id TASK-RESUME/);
    return true;
  });
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('exact task-progress recovery preserves corrupt bytes, rejects stale confirmation and cannot refund budgets', async t => {
  const f = await fixture(t);
  const record = await observeWorkflowTask(f.root, f.workflow, f.phase, { state: 'author-draft' });
  const file = path.join(f.root, '.git/singularity-flow/workflow-tasks', `${record.id}.json`);
  await writeFile(file, '{broken');
  const before = f.git('rev-parse', 'HEAD');
  const preview = await quarantineWorkflowTaskProgress(f.root, f.workflow, f.phase);
  assert.match(preview.commandGuidance.command, /appeal task-quarantine/);
  await writeFile(file, '{changed');
  await assert.rejects(quarantineWorkflowTaskProgress(f.root, f.workflow, f.phase, { confirm: preview.confirmation }),
    { code: 'WORKFLOW_TASK_RECOVERY_STALE' });
  const fresh = await quarantineWorkflowTaskProgress(f.root, f.workflow, f.phase);
  const result = await quarantineWorkflowTaskProgress(f.root, f.workflow, f.phase, { confirm: fresh.confirmation });
  assert.equal(result.status, 'quarantined');
  assert.equal(Buffer.from(JSON.parse(await readFile(result.backupPath)).local, 'base64').toString(), '{changed');
  const resumed = await resumeWorkflowTask(f.root, f.workflow, f.phase, { progress: { state: 'author-draft' } });
  assert.equal(resumed.continuationBudget.maximum, 0);
  assert.equal(resumed.repairConsumed, 3);
  assert.equal(resumed.state, 'author-draft', 'manual correction remains available in this phase');
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(f.git('status', '--porcelain'), '');
  await rm(file);
  const recreated = await observeWorkflowTask(f.root, f.workflow, f.phase, { state: 'author-draft' });
  assert.equal(recreated.continuations, 3, 'deleting the record cannot delete the spent continuation claims');
  assert.equal((await reserveWorkflowTaskContinuation(f.root, recreated.id, workflowTaskIdentity(f.workflow, f.phase))).allowed, false);
});

test('unreadable task metadata preserves an explicit filesystem owner route without an unchanged retry loop', async t => {
  const f = await fixture(t);
  const record = await observeWorkflowTask(f.root, f.workflow, f.phase, { state: 'author-draft' });
  const file = path.join(f.root, '.git/singularity-flow/workflow-tasks', `${record.id}.json`);
  await rm(file);
  await mkdir(file);
  await assert.rejects(readWorkflowTask(f.root, f.workflow, f.phase), error => {
    assert.equal(error.code, 'PRIVATE_SIDECAR_PATH_UNSAFE');
    assert.match(error.details.nextAction, /appeal task-quarantine/);
    return true;
  });
  const result = await quarantineWorkflowTaskProgress(f.root, f.workflow, f.phase);
  assert.equal(result.status, 'owner-required');
  assert.equal(result.path, file);
  assert.equal(result.filesChanged, false);
  assert.equal(result.manualRecovery.owner, 'filesystem-owner');
  assert.equal(result.commandGuidance, undefined);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('overlapping CLI observations share the short task lock without losing spent budgets', async t => {
  const f = await fixture(t);
  await observeWorkflowTask(f.root, f.workflow, f.phase, { state: 'author-draft' });
  await Promise.all([1, 2, 3].map(repairConsumed => observeWorkflowTask(f.root, f.workflow, f.phase,
    { state: 'repair-draft', repairConsumed })));
  assert.equal((await readWorkflowTask(f.root, f.workflow, f.phase)).repairConsumed, 3);
});

test('takeover cannot refund a real phase repair budget when the original machine journal is absent', async t => {
  const f = await fixture(t);
  await observeWorkflowTask(f.root, f.workflow, f.phase, { state: 'repair-draft', repairConsumed: 2 });
  await batchWorkflowTaskProgress(f.root, f.workflow);
  const other = await fixture(t);
  other.workflow = structuredClone(f.workflow);
  const summary = await phaseRepairLoopSummary(other.root, other.workflow, other.phase);
  assert.equal(summary.consumed, 2);
  assert.equal(summary.attemptsRemaining, 1);
  assert.equal(summary.automaticReservationHistoryAvailable, false);
  assert.match(summary.instruction, /Correct the current owned draft and recheck/);
});

test('stop-time reservation uses no Git process and overlapping callbacks cannot spend more than the pinned budget', async t => {
  const f = await fixture(t);
  const record = await observeWorkflowTask(f.root, f.workflow, f.phase, { state: 'author-draft' });
  const previous = process.env.PATH;
  let results;
  try {
    process.env.PATH = path.join(f.root, 'no-programs');
    results = await Promise.all(Array.from({ length: 8 }, () => reserveWorkflowTaskContinuation(f.root, record.id,
      workflowTaskIdentity(f.workflow, f.phase))));
  } finally { process.env.PATH = previous; }
  assert.equal(results.filter(value => value.allowed).length, 3);
  assert.equal((await readWorkflowTaskResume(f.root, f.workflow, f.phase)).continuationBudget.consumed, 3);
});

test('current gate facts drive remaining work and checkpoint publication batches with the existing event', async t => {
  const f = await fixture(t);
  await observeWorkflowTaskCheck(f.root, f.workflow, f.phase, { generation: 1, status: 'ready', draftFingerprint: 'current', findings: [] });
  const ready = await readWorkflowTaskResume(f.root, f.workflow, f.phase, { progress: { state: 'publish-ready' } });
  assert.deepEqual(ready.remaining, ['publish']);
  assert.equal(ready.complete, false);
  f.phase.generation = 1;
  f.phase.generationIntent = { status: 'consumed', generation: 1 };
  await batchWorkflowTaskProgress(f.root, f.workflow, { type: LIFECYCLE_EVENT.ARTIFACT_GENERATED,
    eventId: 'publication-event', phaseId: f.phase.id, generation: 1, payload: {} });
  const id = workflowTaskIdentity(f.workflow, f.phase).id;
  assert.equal(f.workflow.taskOperations[id].state, 'complete');
  assert.ok(f.workflow.taskOperations[id].checkpoints.some(entry => entry.kind === 'publication'));
  assert.equal((await readWorkflowTaskResume(f.root, f.workflow, f.phase)).complete, true);
});

test('an interrupted publication inspects the draft and resumes without a recovery-entry loop', async t => {
  const id = 'TASK-INTERRUPTED';
  const f = await startedSpecificationStory(t, id, { configure(config) { config.phases.specification.clarification = { mode: 'off' }; } });
  const entry = completeAgentResult(f.cli('phase', 'enter', '--compose', '--for-agent', '--json').stdout);
  await writeFile(path.join(f.item, 'artifacts/specification/spec.md'), specification(id, 1));
  const workflow = JSON.parse(await readFile(path.join(f.item, 'workflow.json'), 'utf8'));
  await observeWorkflowTask(f.root, workflow, workflow.phases.specification,
    { state: 'publication-requested', checkpoint: 'publication-requested' });
  const interrupted = completeAgentResult(f.cli('phase', 'enter', '--for-agent', '--json').stdout);
  assert.equal(interrupted.taskResume.operationId, entry.taskResume.operationId);
  assert.equal(interrupted.taskResume.state, 'inspect-interrupted-operation');
  const inspection = interrupted.taskResume.nextAction;
  assert.match(inspection.command, /phase draft-check specification/);
  assert.match(interrupted.act.do.shell, /phase draft-check specification/);
  assert.doesNotMatch(interrupted.act.do.shell, /publish-if-ready/);
  const head = f.git('rev-parse', 'HEAD');
  f.cli(...inspection.argv);
  assert.equal(f.git('rev-parse', 'HEAD'), head, 'inspection cannot publish or replay a mutation');
  const resumed = completeAgentResult(f.cli('phase', 'enter', '--for-agent', '--json').stdout);
  assert.notEqual(resumed.taskResume.state, 'inspect-interrupted-operation');
  assert.equal(resumed.taskResume.complete, false);
});

test('a real publication carries progress through Git takeover and phase entry observes completion without replay', async t => {
  const id = 'TASK-TAKEOVER';
  const f = await startedSpecificationStory(t, id, { configure(config) { config.phases.specification.clarification = { mode: 'off' }; } });
  const first = completeAgentResult(f.cli('phase', 'enter', '--compose', '--for-agent', '--json').stdout);
  assert.equal(first.taskResume.complete, false);
  await writeFile(path.join(f.item, 'artifacts/specification/spec.md'), specification(id, 1));
  const published = completeAgentResult(f.cli('phase', 'prepublish', 'specification', '--for-agent', '--json', '--publish-if-ready').stdout);
  assert.equal(published.publishIfReady.published, true, JSON.stringify(published));
  const state = JSON.parse(await readFile(path.join(f.item, 'workflow.json'), 'utf8'));
  const record = state.taskOperations[first.taskResume.operationId];
  assert.equal(record.state, 'complete');
  assert.ok(record.checkpoints.some(entry => entry.kind === 'publication'));
  assert.equal(JSON.stringify(record).includes(f.root), false);
  const other = path.join(f.directory, 'second-laptop');
  f.run('git', ['clone', '-q', '--branch', id, f.remote, other], { cwd: f.directory });
  f.run('git', ['config', 'user.name', 'Task Takeover Reviewer'], { cwd: other });
  f.run('git', ['config', 'user.email', 'takeover@example.test'], { cwd: other });
  const attached = completeAgentResult(f.run(process.execPath, [CLI, '--no-model', 'session', 'attach', id, '--json'], { cwd: other }).stdout);
  const target = attached.repositoryPath;
  assert.equal(attached.taskResume.operationId, first.taskResume.operationId);
  const resumed = completeAgentResult(f.run(process.execPath, [CLI, '--no-model', 'phase', 'enter', '--for-agent', '--json'], { cwd: target }).stdout);
  assert.equal(resumed.taskResume.operationId, first.taskResume.operationId);
  assert.equal(resumed.taskResume.complete, true);
  assert.equal(resumed.taskResume.resumed, true);
  assert.ok(resumed.taskResume.checkpoints.includes('publication'));
  assert.equal(resumed.effects.committed, false);
  assert.equal(resumed.effects.testsRun, false);
});

test('inactive generation-zero phases do not prevent a rework or cancellation publication', async t => {
  const f = await fixture(t);
  f.phase.status = 'not_started';
  f.workflow.currentPhase = null;
  await batchWorkflowTaskProgress(f.root, f.workflow, { phaseId: f.phase.id, generation: 0, type: 'work-returned' });
  assert.equal(f.workflow.taskOperations, undefined);
});

test('approval-only steps have no invented author task and submitted legacy phases retain their lifecycle handoff', async t => {
  const f = await fixture(t);
  f.phase.generationPolicy = { requirement: 'none', task: 'none' };
  assert.equal(await readWorkflowTaskResume(f.root, f.workflow, f.phase), null);
  assert.equal(await observeWorkflowTask(f.root, f.workflow, f.phase, { state: 'author-draft' }), null);
  f.phase.generationPolicy = { task: 'document', requirement: 'required' };
  f.phase.generation = 1;
  f.phase.status = 'awaiting_approval';
  const value = await readWorkflowTaskResume(f.root, f.workflow, f.phase);
  assert.equal(value.state, 'lifecycle-handoff');
  assert.match(value.nextAction.command, /nextsteps/);
});

test('an unfinished task checkpoint shares metadata on state, preserving dirty source and carrying spent budgets on attach', async t => {
  const id = 'TASK-HANDOFF';
  const f = await startedSpecificationStory(t, id, { configure(config) {
    config.phases.specification.clarification = { mode: 'off' };
    config.ledger = { ...(config.ledger ?? {}), enabled: true };
  } });
  const entry = completeAgentResult(f.cli('phase', 'enter', '--compose', '--for-agent', '--json').stdout);
  const workflow = JSON.parse(await readFile(path.join(f.item, 'workflow.json'), 'utf8'));
  const phase = workflow.phases.specification;
  await observeWorkflowTask(f.root, workflow, phase, { state: 'repair-draft', repairConsumed: 2 });
  await reserveWorkflowTaskContinuation(f.root, entry.taskResume.operationId, workflowTaskIdentity(workflow, phase));
  const artifact = path.join(f.item, 'artifacts/specification/spec.md');
  await writeFile(artifact, specification(id, 1));
  const beforeHead = f.git('rev-parse', 'HEAD');
  const beforeStatus = f.git('status', '--porcelain');
  const output = completeAgentResult(f.cli('appeal', 'task-checkpoint', '--phase', 'specification', '--role', 'author', '--json').stdout);
  const checkpoint = output.data ?? output;
  assert.equal(checkpoint.shared, true, JSON.stringify(checkpoint));
  assert.equal(checkpoint.effects.sourceShared, false);
  assert.equal(checkpoint.effects.attachmentsShared, false);
  assert.equal(f.git('rev-parse', 'HEAD'), beforeHead);
  assert.equal(f.git('status', '--porcelain'), beforeStatus);
  assert.match(output.next[0].command, /phase enter specification/);
  const repeated = completeAgentResult(f.cli('appeal', 'task-checkpoint', '--phase', 'specification', '--role', 'author', '--json').stdout);
  const again = repeated.data ?? repeated;
  assert.equal(again.status, 'already-shared');
  const other = path.join(f.directory, 'handoff-laptop');
  f.run('git', ['clone', '-q', '--branch', id, f.remote, other], { cwd: f.directory });
  f.run('git', ['config', 'user.name', 'Task Handoff Tester'], { cwd: other });
  f.run('git', ['config', 'user.email', 'handoff@example.test'], { cwd: other });
  const attached = completeAgentResult(f.run(process.execPath, [CLI, '--no-model', 'session', 'attach', id, '--json'], { cwd: other }).stdout);
  assert.equal(attached.taskProgressImport.status, 'imported', JSON.stringify(attached));
  assert.equal(attached.taskProgressImport.imported, 1);
  assert.equal(attached.taskResume.operationId, entry.taskResume.operationId);
  assert.equal(attached.taskResume.continuationBudget.consumed, 1);
  assert.equal(attached.taskResume.repairConsumed, 2);
  assert.equal(attached.taskResume.complete, false);
  const otherArtifact = path.join(attached.repositoryPath, 'singularity/work-items', id, 'artifacts/specification/spec.md');
  assert.notEqual(await readFile(otherArtifact, 'utf8'), specification(id, 1), 'metadata did not transfer the uncommitted draft');
});

test('a malformed shared checkpoint is preserved on takeover, disables automation and repairs only known metadata', async t => {
  const id = 'TASK-SHARED-RECOVERY';
  const f = await startedSpecificationStory(t, id, { configure(config) {
    config.phases.specification.clarification = { mode: 'off' };
    config.ledger = { ...(config.ledger ?? {}), enabled: true };
  } });
  const entry = completeAgentResult(f.cli('phase', 'enter', '--compose', '--for-agent', '--json').stdout);
  const workflow = JSON.parse(await readFile(path.join(f.item, 'workflow.json'), 'utf8'));
  const phase = workflow.phases.specification;
  const shared = await shareWorkflowTaskProgress(f.root, workflow, phase);
  const file = shared.stateReference.entry;
  const corrupt = Buffer.from('{malformed-progress');
  await publishToStateBranch(f.root, workflow.resolution.ledger, { [file]: corrupt }, 'Fixture damaged task checkpoint');
  const other = path.join(f.directory, 'recovery-laptop');
  f.run('git', ['clone', '-q', '--branch', id, f.remote, other], { cwd: f.directory });
  const attached = completeAgentResult(f.run(process.execPath, [CLI, '--no-model', 'session', 'attach', id, '--json'], { cwd: other }).stdout);
  assert.equal(attached.workId, id);
  assert.equal(attached.taskProgressImport.warnings.length, 1, JSON.stringify(attached));
  const warning = attached.taskProgressImport.warnings[0];
  assert.equal(warning.code, 'SCHEMA_RECORD_INVALID');
  assert.deepEqual(await readFile(warning.backupPath), corrupt);
  assert.equal(attached.taskResume.continuationBudget.maximum, 0);
  assert.equal(attached.taskResume.repairConsumed, 3);
  const repaired = await shareWorkflowTaskProgress(f.root, workflow, phase);
  assert.equal(repaired.shared, true);
  assert.deepEqual(await readFile(repaired.warnings[0].backupPath), corrupt);
  const current = await readWorkflowTask(f.root, workflow, phase);
  assert.equal(current.maximumContinuations, 0);
  assert.equal(current.progressQuarantined, true);
  assert.equal(current.id, entry.taskResume.operationId);
  const { recordSha256: ignored, ...future } = current;
  future.schemaVersion = 999;
  const futureBytes = Buffer.from(JSON.stringify({ ...future, recordSha256: recordSha256(future) }));
  await publishToStateBranch(f.root, workflow.resolution.ledger, { [file]: futureBytes }, 'Fixture future task schema');
  await assert.rejects(shareWorkflowTaskProgress(f.root, workflow, phase), error => {
    assert.match(error.code, /^SCHEMA_VERSION_/);
    assert.equal(error.details.nextAction, 'singularity-flow about --json');
    return true;
  });
});
