import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hookBenchmarkSampleCount, runCopilotHookBenchmark } from '../src/copilot-hook-benchmark.mjs';

test('hook benchmark bounds sample counts before creating a fixture', () => {
  assert.equal(hookBenchmarkSampleCount(), 30);
  for (const value of [0, -1, 1.5, Infinity, '30', 301]) assert.throws(() => hookBenchmarkSampleCount(value));
  const script = fileURLToPath(new URL('../scripts/copilot-hook-benchmark.mjs', import.meta.url));
  for (const args of [['--samples'], ['--samples', '0'], ['--samples', '3', '--other'], ['--root', '/']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
});

test('ambient Git relocation and a selected real checkout cannot escape the benchmark fixture', { timeout: 60000 }, async t => {
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-hook-bench-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const init = spawnSync('git', ['init', '-q', '-b', 'main', outside], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const sentinel = path.join(outside, 'unchanged.txt');
  await writeFile(sentinel, 'preserved');
  const changes = { GIT_DIR: path.join(outside, '.git'), GIT_WORK_TREE: outside,
    GIT_COMMON_DIR: path.join(outside, '.git'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(outside, 'real-mode.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(outside, 'real-workspace.json') };
  const previous = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
  Object.assign(process.env, changes);
  try {
    const report = await runCopilotHookBenchmark({ samples: 1, profileModules: false });
    assert.ok(report.scenarios.every(scenario => scenario.parityVerified));
    assert.equal(await readFile(sentinel, 'utf8'), 'preserved');
    for (const relative of ['real-mode.json', 'real-workspace.json', '.git/singularity-flow/session.json']) {
      await assert.rejects(access(path.join(outside, relative)), { code: 'ENOENT' });
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test('isolated benchmark proves response parity and a smaller hook graph without using timing as a flaky gate', { timeout: 120000 }, async () => {
  const report = await runCopilotHookBenchmark({ samples: 1 });
  assert.equal(report.recommendedSampleCountMet, false);
  assert.equal(report.platform, process.platform);
  assert.equal(report.billedSavings, null);
  assert.equal(report.scenarios.length, 3);
  for (const scenario of report.scenarios) {
    assert.equal(scenario.parityVerified, true);
    assert.equal(scenario.legacy.samples, 1);
    assert.equal(scenario.dedicated.samples, 1);
    assert.ok(scenario.legacy.p50Ms > 0);
    assert.ok(scenario.dedicated.p95Ms > 0);
    if (!scenario.moduleCounts) continue;
    assert.equal(scenario.moduleCounts.legacy.loadedGeneralCli, true);
    assert.equal(scenario.moduleCounts.dedicated.loadedGeneralCli, false);
    assert.ok(scenario.moduleCounts.dedicated.count < scenario.moduleCounts.legacy.count,
      `${scenario.id}: dedicated=${scenario.moduleCounts.dedicated.count}, legacy=${scenario.moduleCounts.legacy.count}`);
  }
});
