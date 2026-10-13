import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/proposal-performance-benchmark.mjs', import.meta.url));
test('the proposal benchmark exercises actual local activation and reports bounded Git work', { timeout: 120_000 }, () => {
  const result = spawnSync(process.execPath, [script, '--samples=1', '--files=10'],
    { encoding: 'utf8', timeout: 110_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_DIR: '/unavailable-benchmark-poison', GIT_WORK_TREE: '/unavailable-benchmark-poison' } });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.protocol.remote, 'local-bare-only');
  assert.equal(report.protocol.applicationWorkspacesTouched, false);
  assert.equal(report.protocol.model, 'disabled');
  assert.equal(report.protocol.trackedSourceFiles, 10);
  assert.ok(report.actions.review.gitSpawns.maximum <= 52);
  assert.ok(report.actions.activate.gitSpawns.maximum <= 90);
  assert.equal(report.actions['list-warm'].clones.maximum, 0);
  assert.ok(report.samples[0].find(row => row.action === 'activate').sealReuse > 0);
  assert.ok(report.samples[0].find(row => row.action === 'activate').inventoryReuse > 0);
  assert.doesNotMatch(result.stdout, /repositoryPath|proposalCommit|example\.invalid|sflow-proposal-benchmark-/u);
});

test('invalid benchmark bounds fail before a fixture can be created', () => {
  for (const option of ['--samples=0', '--samples=31', '--files=10001']) {
    const result = spawnSync(process.execPath, [script, option], { encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Use --samples=1\.\.30 and --files=0\.\.10000/u);
    assert.equal(result.stdout, '');
  }
});
