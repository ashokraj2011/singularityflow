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
