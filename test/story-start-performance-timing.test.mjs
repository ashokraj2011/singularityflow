import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  commandTimer, commandTimingDirectory, measureCommandSpan, recordCommandTiming, withCommandTiming
} from '../src/dx-command-timing.mjs';

test('durable Story timing retains stage spans and independent overlapping read durations', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-start-stage-timing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-b', 'main'], { cwd: root }).status, 0);
  let clock = 0n;
  const timer = commandTimer('start', { clock: () => clock, wallClock: () => 0,
    commandClass: 'mutation', operationId: 'start' });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await withCommandTiming(timer, async () => {
    const authority = measureCommandSpan('start.authority', async () => {
      await gate; return 'sealed';
    });
    const fetch = measureCommandSpan('start.fetch', async () => {
      clock = 3_000_000n; release(); return 'fetched';
    });
    assert.deepEqual(await Promise.all([authority, fetch]), ['sealed', 'fetched']);
    for (const name of ['start.worktree', 'start.destination', 'start.repository-preflight',
      'start.readiness', 'start.enrollment', 'start.publication']) {
      await measureCommandSpan(name, async () => { clock += 1_000_000n; });
    }
  });
  timer.stage('execute');
  const event = timer.finish();
  await recordCommandTiming(root, event);
  const stored = JSON.parse((await readFile(path.join(commandTimingDirectory(root), 'timings.jsonl'), 'utf8')).trim());
  assert.equal(stored.event, 'dx.command-timing');
  assert.deepEqual(stored.spans, event.spans);
  assert.equal(stored.spans['start.authority'], 3);
  assert.equal(stored.spans['start.fetch'], 3);
  assert.equal(stored.stages.execute, 9);
  assert.doesNotMatch(JSON.stringify(stored), /remoteUrl|repositoryPath|argv|password|credential/);
});

test('the first emitted Start progress marks feedback, not the final JSON response', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { commandTimer, measureCommandSpan, withCommandTiming } from './src/dx-command-timing.mjs';
    let clock = 0n;
    const timer = commandTimer('start', { clock: () => clock });
    await withCommandTiming(timer, async () => {
      clock = 2_000_000n;
      await measureCommandSpan('start.authority', async () => { clock = 12_000_000n; });
      await measureCommandSpan('start.worktree', async () => { clock = 22_000_000n; });
    });
    console.log(JSON.stringify(timer.finish()));
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_PROGRESS: 'stderr-v1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /@@sflow-progress\/v1 start\.authority/);
  const event = JSON.parse(result.stdout);
  assert.equal(event.firstFeedbackMs, 2);
  assert.equal(event.durationMs, 22);
});
