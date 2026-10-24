/**
 * Governed work start through `sflow_run`, against the real `start` operation and a real remote.
 * `[INT:AC-019]` `[INT:CON-066]` `[INT:CON-115]` `[INT:REQ-156]` `[INT:REQ-069]`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHostGateway } from '../src/gateway/host.mjs';
import { cliStartRoute, gatewayMutationExecutors } from '../src/gateway/planners/executors.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const ACTOR = { login: 'tester', email: 'tester@example.com', name: 'Tester' };

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: childTimeout(60_000) });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

async function governedRepository(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-int-publication-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const remote = path.join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', remote);
  // The remote refuses exactly one Story branch, so that start's publication fails after its commit.
  const hook = path.join(remote, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/WRK-8 ] && { echo "rejected by fixture" >&2; exit 1; }; done\nexit 0\n');
  await chmod(hook, 0o755);
  const root = path.join(base, 'repo');
  await mkdir(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', ACTOR.email);
  git(root, 'config', 'user.name', ACTOR.name);
  const init = spawnSync(process.execPath, [cli, 'init'], { cwd: root, encoding: 'utf8', timeout: childTimeout(120_000) });
  assert.equal(init.status, 0, init.stderr);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return { root, remote };
}

/** The guided path: a typed proposal, the exact preview, a confirmation out of band, one run. */
async function startThroughGateway(kernel, fields) {
  const resolved = await kernel.resolve({ utterance: 'I have an idea', arguments: { workType: 'feature', baseBranch: 'main', ...fields } });
  const intake = await kernel.read({ resolutionId: resolved.next[0].handle });
  assert.equal(intake.data.intake.workId, fields.workId);
  const planned = await kernel.resolve({ selectionHandle: intake.next[0].handle });
  assert.equal(planned.kind, 'plan', JSON.stringify(planned.why));
  const review = kernel.planReview(planned.data.plan.handle);
  assert.equal(review.confirmation, 'exact-confirm');
  const receipt = kernel.confirmPlan({ planId: review.planId, planHash: review.planHash, reviewDigest: review.review.digest });
  const run = () => kernel.run({ planId: review.planId }, { confirmationReceiptId: receipt.receiptId, confirmationValue: receipt.value });
  return { review, result: await run(), run };
}

test('gateway-preserves-publication-recovery', { timeout: 300_000 }, async (t) => {
  const { root, remote } = await governedRepository(t);
  const { kernel } = createHostGateway({
    root, hostSessionId: 'sess-publication', planners: gatewayPlanners(), plannerContext: { actor: ACTOR },
    mutationExecutors: gatewayMutationExecutors({ runStart: cliStartRoute }), readOnly: false
  });

  // A start whose publication the remote refuses: committed locally, not published.
  const failed = await startThroughGateway(kernel, { workId: 'WRK-8', title: 'Refused push', description: 'The remote refuses it.' });
  assert.equal(failed.result.outcome.status, 'failed');
  assert.equal(failed.result.why[0].code, 'publication.pending');
  // The recovery record is the existing pending-publication record, preserved, and it leads.
  const record = failed.result.data.recovery.record;
  assert.ok(record && existsSync(path.join(root, record)), `the pending publication record ${record} is not on disk`);
  assert.equal(failed.result.next[0].id, 'recover:publication');
  assert.equal(failed.result.next[0].interaction, 'recovery');
  assert.equal(failed.result.next[0].emphasis, 'primary');
  assert.equal(failed.result.next[0].fallback.command, 'sflow sync WRK-8');
  assert.equal(failed.result.effects.publicationCreated, false);
  assert.ok(failed.result.preserved.some((entry) => entry.code === 'work.start-recovery-record-kept' && entry.reference === record));
  // Asking again answers with what happened; it does not start a second time.
  const again = await failed.run();
  assert.ok(again.warnings.some((warning) => warning.code === 'gateway.result-replayed'));

  // The same path with a remote that accepts: created, published, and described exactly.
  const started = await startThroughGateway(kernel, { workId: 'WRK-7', title: 'Stop duplicates', description: 'Twice creates two orders.' });
  assert.equal(started.result.outcome.status, 'succeeded', JSON.stringify(started.result.why));
  assert.equal(started.result.data.workId, 'WRK-7');
  assert.equal(started.result.data.branch, 'WRK-7');
  assert.equal(started.result.data.pinnedProfile.workType, 'feature');
  assert.equal(started.result.data.publication.pushed, true);
  assert.deepEqual(started.result.data.unchangedSystems, started.review.review.preview.unchanged);
  assert.match(git(remote, 'for-each-ref', 'refs/heads/WRK-7'), /refs\/heads\/WRK-7/);
  assert.equal(started.result.next[0].id, 'started:continue');
  // Effects are within the reviewed preview, and say what actually happened.
  for (const [key, value] of Object.entries(started.result.effects)) {
    if (value) assert.equal(started.review.effects[key], true, key);
  }
  assert.equal(started.result.effects.publicationCreated, true);
});

test('the start route runs without blocking the server, and a start killed on timeout is an unknown outcome', async (t) => {
  const { runSingularityFlowCli } = await import('../src/gateway/planners/executors.mjs');
  const { spawn } = await import('node:child_process');
  // The real spawn, given a child that outlives the timeout in place of the CLI, so the kill is real too.
  const slow = (command, _args, options) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], options);
  let ticks = 0;
  const pulse = setInterval(() => { ticks += 1; }, 20);
  t.after(() => clearInterval(pulse));
  const started = Date.now();
  const killed = await runSingularityFlowCli(['start', 'WRK-9', '--json'], { cwd: os.tmpdir(), timeoutMs: 600, spawnCommand: slow });
  clearInterval(pulse);
  assert.deepEqual([killed.timedOut, killed.json], [true, null]);
  assert.ok(Date.now() - started < 30_000, 'the timed-out child was not stopped');
  // The event loop kept turning while the child ran: pings, cancellations and elicitation replies are answered.
  assert.ok(ticks >= 10, `only ${ticks} timer ticks ran while the start route waited`);
  const answered = await runSingularityFlowCli(['status'], { cwd: os.tmpdir(), spawnCommand: (command, _args, options) =>
    spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ resultType: "command-result" }))'], options) });
  assert.deepEqual([answered.status, answered.timedOut, answered.json], [0, false, { resultType: 'command-result' }]);

  // The executor does not say nothing was created when it cannot know: it says what may exist and how to check.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-int-start-timeout-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { workStartExecutor } = await import('../src/gateway/planners/work-start.mjs');
  const preview = {
    action: 'start-work', subject: { kind: 'story', id: 'WRK-9', title: 'Slow start' }, workspace: null, repository: root,
    workProfile: { workType: 'feature', label: 'Feature', phases: ['design'] }, branch: { name: 'WRK-9', base: 'main', isolatedWorktree: true },
    source: { tracker: 'none', description: 'It takes too long.', acceptanceCriteria: null }, unchanged: ['other Stories'], externalReferences: []
  };
  const unknown = await workStartExecutor({ runStart: async () => killed })({ plan: { review: { preview } }, root });
  assert.equal(unknown.outcome.status, 'failed');
  assert.equal(unknown.why[0].code, 'work.start-outcome-unknown');
  assert.equal(unknown.preserved.some((entry) => entry.code === 'work.no-governed-record-created'), false);
  assert.deepEqual(unknown.data.check, ['sflow status --work-id WRK-9', 'sflow sync WRK-9']);
  assert.ok(unknown.data.mayHaveCreated.includes('the Story branch WRK-9'));
});
