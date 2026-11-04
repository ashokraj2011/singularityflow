import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { childTimeout } from './helpers/child-timeout.mjs';
import { publishedSpecificationStory, reviewReport } from './helpers/source-review-fixture.mjs';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { sourceReviewContext } from '../src/source-review-lifecycle.mjs';
import { sourceReviewProgress } from '../src/source-review-progress.mjs';
import { sourceReviewStagingPath } from '../src/phase-staging-paths.mjs';
import { gitDir } from '../src/git-execution.mjs';
import { recordRepositoryBoundaryTurn, endRepositoryBoundaryTurn, repositoryToolGuard, sourceReviewCompletionRequested } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn } from '../src/copilot-mutation-guard.mjs';
import { sourceReviewAgentStop, noteReviewCompletionFailure } from '../src/copilot-review-completion.mjs';
import { setCopilotPaused } from '../src/copilot-mode.mjs';
import { agentAct } from '../src/agent-output.mjs';
import { validateSafeSflowCommand } from '../src/safe-command-guidance.mjs';
import { observeWorkflowTask } from '../src/workflow-task-store.mjs';
import { recordSha256 } from '../src/records.mjs';

async function fixture(t, copied = false) {
  const item = await publishedSpecificationStory(t, { copied });
  const root = await realpath(item.root);
  const prior = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(root, '.git', 'review-hooks', 'mode.json');
  t.after(() => { if (prior === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = prior; });
  const hook = { sessionId: 'review-completion', cwd: root, prompt: `/sf-review-source ${item.phaseId}` };
  const start = () => recordRepositoryBoundaryTurn(hook, { captureMutation: (payload, record) =>
    captureMutationTurn(payload, record, { resolveRoot: async () => root }) });
  const context = async () => {
    const { config, workflow } = await loadAcceptedStoryExecution(root);
    return sourceReviewContext(root, config, workflow, item.phaseId,
      sourceReviewStagingPath(gitDir(root), workflow, workflow.phases[item.phaseId]));
  };
  await start();
  return { ...item, root, hook, start, context, stop: extra => sourceReviewAgentStop({ ...hook, stopReason: 'end_turn', ...extra }) };
}

test('read-only review stops once, resumes a real draft, and never invents findings for seeded or copied phases', async t => {
  for (const copied of [false, true]) await t.test(copied ? 'custom scope phase' : 'seeded specification', async t => {
    const item = await fixture(t, copied);
    const packet = await item.context();
    assert.equal(packet.progress.state, 'author-report');
    assert.equal(packet.continuation.nextCommand, null, 'an admitted review cannot hand back its entry command');
    const workflowPath = path.join(item.root, 'singularity/work-items/REVIEW-1/workflow.json');
    const before = await readFile(workflowPath);
    const overlapping = await Promise.all([item.stop(), item.stop()]);
    assert.equal(overlapping.filter(result => result.decision === 'block').length, 1, 'overlapping callbacks share one atomic continuation claim');
    const decision = overlapping.find(result => result.decision === 'block');
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /Author the independent report/);
    assert.match(decision.reason, /one automatic continuation/);
    await recordRepositoryBoundaryTurn({ ...item.hook, prompt: decision.reason });
    assert.deepEqual(await item.stop(), {}, 'repeated stop callbacks cannot spin');
    assert.deepEqual(await item.stop({ stop_hook_active: true }), {});
    assert.deepEqual(await readFile(workflowPath), before, 'the completion hook changes no Story state');
    const report = reviewReport(packet);
    await writeFile(packet.stagingPath, JSON.stringify(report));
    await item.start();
    const resumed = await item.context();
    assert.equal(resumed.progress.state, 'retain-report');
    assert.match(resumed.continuation.nextCommand, /review-source submit/);
    assert.equal(agentAct({ ...resumed, resultType: 'source-review-agent-context' }).state, 'retain');
    const draftStop = await item.stop();
    assert.equal(draftStop.decision, 'block');
    assert.match(draftStop.reason, /Run singularity-flow review-source check/);
    assert.deepEqual(JSON.parse(await readFile(packet.stagingPath)), report, 'a resume preserves independent judgments');
    const issuedCheck = validateSafeSflowCommand(draftStop.reason.match(/Run (singularity-flow review-source check .+?) now,/u)?.[1]);
    assert.ok(issuedCheck, 'the completion checkpoint issues a parseable check');
    const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
    const checked = spawnSync(process.execPath, [cli, '--no-model', ...issuedCheck.argv],
      { cwd: item.root, encoding: 'utf8', timeout: childTimeout(30000) });
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    assert.equal(JSON.parse(checked.stdout).retentionReady, true);
    assert.deepEqual(await readFile(workflowPath), before, 'checking cannot retain a review or publish a generation');
    const { workflow } = await loadAcceptedStoryExecution(item.root);
    await observeWorkflowTask(item.root, workflow, workflow.phases[item.phaseId], {
      state: 'retention-requested', inputSha256: recordSha256(resumed.binding), checkpoint: 'retention-requested'
    }, { role: 'source-reviewer', generation: resumed.generation });
    const interrupted = await item.context();
    assert.equal(interrupted.taskResume.state, 'retain-report', 'fresh retained-state and draft observations resolve an interrupted retention');
    assert.equal(interrupted.taskResume.complete, false);
  });
});

test('completion opts in only the full review and leaves explicit single-step requests alone', async t => {
  for (const args of ['', 'custom-requirements']) assert.equal(sourceReviewCompletionRequested(`/sf-review-source ${args}`), true);
  for (const action of ['context', 'stage', 'check', 'submit', 'status', 'decide']) {
    assert.equal(sourceReviewCompletionRequested(`/sf-review-source ${action} specification`), false);
  }
  assert.equal(sourceReviewCompletionRequested('<skill-context name="sf-review-source">instructions\nARGUMENTS: custom-plan\n</skill-context>'), true);
  assert.equal(sourceReviewCompletionRequested('Please read /sf-review-source'), false);
  const item = await fixture(t);
  await recordRepositoryBoundaryTurn({ ...item.hook, prompt: `/sf-review-source check ${item.phaseId}` }, {
    captureMutation: (payload, record) => captureMutationTurn(payload, record, { resolveRoot: async () => item.root }) });
  await item.context();
  assert.deepEqual(await item.stop(), {});
});

test('real failures, cancellation, pause, native chat and changed input bindings never force continuation', async t => {
  const item = await fixture(t);
  const packet = await item.context();
  assert.deepEqual(await item.stop({ stopReason: 'cancelled' }), {});
  assert.deepEqual(await item.stop({ stopHookActive: true }), {});
  await noteReviewCompletionFailure(item.hook, 'FILE_READ_TOO_LONG: request the issued safe ranges');
  assert.equal((await item.stop()).decision, 'block', 'safe read retries can still complete');
  await item.start(); await item.context();
  await noteReviewCompletionFailure(item.hook, 'Path does not exist');
  assert.deepEqual(await item.stop(), {}, 'real tool failures stay visible');
  await item.start(); await item.context();
  await repositoryToolGuard({ ...item.hook, toolName: 'edit', toolArgs: { path: path.join(item.root, 'forbidden.txt'), old_str: '', new_str: 'no' } });
  assert.deepEqual(await item.stop(), {}, 'permission denials cannot be auto-retried');
  await item.start(); await item.context();
  const stale = reviewReport(packet); stale.binding.generation = 2;
  await writeFile(packet.stagingPath, JSON.stringify(stale));
  assert.deepEqual(await item.stop(), {}, 'different-generation judgments require fresh review');
  await setCopilotPaused(true);
  assert.deepEqual(await item.stop(), {});
  await setCopilotPaused(false);
  await recordRepositoryBoundaryTurn({ ...item.hook, prompt: 'Ordinary native chat' });
  assert.deepEqual(await item.stop(), {});
  await endRepositoryBoundaryTurn(item.hook);
  assert.deepEqual(await item.stop(), {});
});

test('interrupted malformed/citation drafts resume at repair while honest retained gaps are complete', async t => {
  const item = await fixture(t);
  const packet = await item.context();
  await writeFile(packet.stagingPath, '{bad json');
  let resumed = await item.context();
  assert.equal(resumed.progress.state, 'repair-report');
  assert.equal(resumed.progress.error.code, 'SOURCE_REVIEW_REPORT_INVALID');
  const report = reviewReport(packet); report.rows[0].line = 999;
  await writeFile(packet.stagingPath, JSON.stringify(report));
  resumed = await item.context();
  assert.equal(resumed.progress.state, 'repair-report');
  assert.ok(resumed.progress.repair.citations.length);
  const stale = structuredClone(report); stale.binding.generation = 2;
  const oldDraft = JSON.stringify(stale);
  await writeFile(packet.stagingPath, oldDraft);
  resumed = await item.context();
  assert.equal(resumed.progress.state, 'review-changed-inputs');
  assert.equal(resumed.continuation.nextCommand, null, 'the current fresh context must not route to another context');
  assert.equal(await readFile(resumed.progress.previousDraftPath, 'utf8'), oldDraft);
  assert.deepEqual(await repositoryToolGuard({ ...item.hook, toolName: 'view',
    toolArgs: { path: resumed.progress.previousDraftPath } }), {}, 'the exact preserved draft is issued for reading');
  const repeated = await item.context();
  assert.equal(repeated.progress.previousDraftPath, resumed.progress.previousDraftPath, 'unchanged drafts share one content-addressed backup');
  assert.equal((await item.stop()).decision, 'block', 'a fresh entry owns independent re-review of an old-bound draft');
  await writeFile(packet.stagingPath, JSON.stringify(reviewReport(packet)));
  assert.equal(await readFile(resumed.progress.previousDraftPath, 'utf8'), oldDraft, 'editing the new draft never changes the preserved inode');
  const complete = await sourceReviewProgress({ input: { binding: packet.binding }, stagingPath: packet.stagingPath,
    retained: { status: 'correction-required', reportPath: 'retained.json', reportSha256: 'a'.repeat(64) } });
  assert.equal(complete.complete, true, 'retaining an honest gap completes review, not approval');
  assert.equal(agentAct({ resultType: 'source-review-agent-context', canReview: true, progress: complete }).state, 'review-complete');
  assert.equal(complete.state, 'retained');
});

test('unsafe staging is reported without replacing the file or requesting a continuation', async t => {
  const item = await fixture(t);
  const packet = await item.context();
  await mkdir(packet.stagingPath);
  const resumed = await item.context();
  assert.equal(resumed.progress.state, 'read-error');
  assert.equal(resumed.progress.error.code, 'SOURCE_REVIEW_REPORT_STAGING_INVALID');
  assert.match(resumed.progress.nextAction?.command ?? '', new RegExp(`recover REVIEW-1 --phase ${item.phaseId}`));
  assert.deepEqual(await item.stop(), {});
});

test('packaged dedicated and legacy stop/failure hooks preserve the bounded continuation protocol', async t => {
  const item = await fixture(t);
  const launcher = fileURLToPath(new URL('../plugin/hook-launcher.mjs', import.meta.url));
  const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
  const invoke = (runtime, action, extra = {}) => {
    const result = spawnSync(process.execPath, [launcher, action, cli], { cwd: item.root,
      env: { ...process.env, SINGULARITY_FLOW_BUNDLE: 'off', SINGULARITY_FLOW_HOOK_RUNTIME: runtime },
      input: JSON.stringify({ ...item.hook, stopReason: 'end_turn', ...extra }), encoding: 'utf8', timeout: childTimeout(30000) });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  for (const runtime of ['dedicated', 'legacy']) {
    await item.start(); await item.context();
    assert.equal(invoke(runtime, 'boundary-stop').decision, 'block');
    assert.deepEqual(invoke(runtime, 'boundary-stop', { stop_hook_active: true }), {});
    await item.start(); await item.context();
    const failure = invoke(runtime, 'boundary-failure', { error: 'The tool was denied.' });
    assert.match(failure.additionalContext, /The tool was denied/);
    assert.match(failure.additionalContext, /singularity-flow recover REVIEW-1/);
    assert.deepEqual(invoke(runtime, 'boundary-stop'), {});
  }
});
