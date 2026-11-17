import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const script = fileURLToPath(new URL('../scripts/proposal-performance-benchmark.mjs', import.meta.url));
test('the proposal benchmark exercises actual local activation and reports bounded Git work', slowLane({ timeout: 120_000 }), () => {
  const result = spawnSync(process.execPath, [script, '--samples=1', '--files=10'],
    { encoding: 'utf8', timeout: childTimeout(110_000), maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_DIR: '/unavailable-benchmark-poison', GIT_WORK_TREE: '/unavailable-benchmark-poison' } });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.protocol.remote, 'local-bare-only');
  assert.equal(report.protocol.applicationWorkspacesTouched, false);
  assert.equal(report.protocol.model, 'disabled');
  assert.equal(report.protocol.trackedSourceFiles, 10);
  const measured = JSON.stringify(report.actions);
  assert.ok(report.actions.review.gitSpawns.maximum <= 52, measured);
  // `configuration approve` is the one approval path (SCF:REQ-010): in the same process it reads the proposal for
  // the view its approver is shown (REQ-008) and checks it against `workflow validate` (ER-F7), then activates it.
  // Measured 127 on 2026-11-17 (Node 22, 10 files); the activation alone was 78 before SCF (ceiling 90,
  // docs/PROPOSAL-PERFORMANCE-RESULTS.md). 135 keeps a similar headroom. The activation does not yet reuse the view's reads.
  assert.ok(report.actions.activate.gitSpawns.maximum <= 135, measured);
  assert.equal(report.actions['list-warm'].clones.maximum, 0);
  assert.ok(report.samples[0].find(row => row.action === 'activate').sealReuse > 0);
  assert.ok(report.samples[0].find(row => row.action === 'activate').inventoryReuse > 0);
  assert.doesNotMatch(result.stdout, /repositoryPath|proposalCommit|example\.invalid|sflow-proposal-benchmark-/u);
});

test('invalid benchmark bounds fail before a fixture can be created', () => {
  for (const option of ['--samples=0', '--samples=31', '--files=10001']) {
    const result = spawnSync(process.execPath, [script, option], { encoding: 'utf8', timeout: childTimeout(10_000) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Use --samples=1\.\.30 and --files=0\.\.10000/u);
    assert.equal(result.stdout, '');
  }
});
