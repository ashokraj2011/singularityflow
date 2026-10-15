import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { qualifyNativeEfficiency, qualificationSamples } from '../src/native-efficiency-qualification.mjs';

test('local qualification measures catalog reuse and byte-stable serialization without attesting native performance', async () => {
  const report = await qualifyNativeEfficiency({ samples: 2, hooks: false });
  assert.equal(report.recommendedSampleCountMet, false);
  assert.equal(report.catalogs.identityPreserved, true);
  assert.equal(report.catalogs.baseline.counters['catalog.scans'], 6);
  assert.equal(report.catalogs.reused.counters['catalog.scans'], 3);
  assert.equal(report.catalogs.reused.counters['catalog.cache-hits'], 3);
  assert.equal(report.serialization.byteEquivalent, true);
  assert.equal(report.serialization.serialization.samples, 2);
  assert.equal(report.hooks, null);
  assert.equal(report.decisions.warmService.enabled, false);
  assert.equal(report.decisions.parallelQualityChecks.enabled, false);
  assert.equal(report.externalQualification.complete, false);
  assert.equal(report.externalQualification.billedSavings, null);
});

test('qualification rejects invalid options without creating benchmark fixtures or running hooks', () => {
  for (const value of [0, -1, 301, Infinity, 1.1, '30']) assert.throws(() => qualificationSamples(value));
  const script = new URL('../scripts/native-efficiency-qualification.mjs', import.meta.url);
  for (const args of [['--samples', '0'], ['--samples', '2.1'], ['--skip-hooks', '--skip-hooks'], ['--network']]) {
    const result = spawnSync(process.execPath, [fileURLToPath(script), ...args], { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
});
