import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repositoryCheckFixture } from '../scripts/repository-check-benchmark.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';

test('separate phase/next/session processes reuse verification; Check now refreshes without advancing', async t => {
  const f = await repositoryCheckFixture({ files: 0, historyCommits: 0, artifacts: 0 });
  t.after(f.cleanup);
  const statePath = path.join(f.repository, 'singularity/work-items', f.workId, 'workflow.json');
  const state = await readFile(statePath, 'utf8');
  const head = f.git(['rev-parse', 'HEAD'], { cwd: f.repository });
  for (const args of [['nextsteps'], ['phase', 'enter'], ['session', 'open', f.workId], ['nextsteps']]) {
    const result = f.invoke([...args, '--for-agent', '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.packet.ready, true, result.stdout);
    assert.equal(result.packet.repositoryChecks.source, 'cache', args.join(' '));
    assert.equal(result.packet.repositoryChecks.mode, 'cached');
    assert.equal(result.packet.repositoryChecks.intervalMinutes, 30);
  }
  const checked = f.invoke(['check', '--for-agent', '--json']);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.equal(checked.packet.operation.id, 'check');
  assert.equal(checked.packet.data.repositoryChecks.source, 'fresh');
  assert.equal(checked.packet.data.effects.testsRun, false);
  assert.equal(checked.packet.effects.publicationCreated, false);
  assert.equal(checked.packet.next[0].copilotCommand, '/sf-nextsteps');
  assert.equal(await readFile(statePath, 'utf8'), state);
  assert.equal(f.git(['rev-parse', 'HEAD'], { cwd: f.repository }), head);
  assert.equal(f.invoke(['nextsteps', '--for-agent', '--json']).packet.repositoryChecks.source, 'cache');

  const edited = JSON.parse(state); edited.resolution.sequenceGates = { requireApproval: false };
  await writeFile(statePath, JSON.stringify(edited));
  const refused = f.invoke(['phase', 'enter', '--for-agent', '--json']);
  assert.notEqual(refused.status, 0, 'a cached configuration cannot hide edited Story authority');
  assert.match(refused.stdout + refused.stderr, /WFA_SNAPSHOT_INVALID|compatibility projection/);
  const routes = safeCommandGuidance({ command: 'singularity-flow check --json' });
  assert.equal(routes.copilotCommand, '/sf-check'); assert.equal(routes.modelFreeCommand, '@sflow /check');
});

test('Check now pauses before any Git invocation, and rejects unrelated execution flags', async t => {
  const f = await repositoryCheckFixture({ files: 0, historyCommits: 0, artifacts: 0 });
  t.after(f.cleanup);
  const invalid = f.invoke(['check', '--run', '--json']);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stdout + invalid.stderr, /REPOSITORY_CHECK_OPTIONS_INVALID/);
  await writeFile(f.env.SINGULARITY_FLOW_COPILOT_MODE_FILE, JSON.stringify({ schemaVersion: 1, paused: true }));
  const paused = f.invoke(['check', '--for-agent', '--json'], { PATH: '' });
  assert.equal(paused.status, 0, paused.stdout + paused.stderr);
  assert.equal(paused.packet.paused ?? paused.packet.data?.paused, true);
});

test('the stamped installed bundle serves all three entries and the explicit Check now route', async t => {
  const f = await repositoryCheckFixture({ files: 0, historyCommits: 0, artifacts: 0 });
  t.after(f.cleanup);
  const { buildCliBundle } = await import(pathToFileURL(path.join(f.engine, 'scripts/build-cli-bundle.mjs')));
  const bundle = await buildCliBundle({ root: f.engine });
  const env = { SINGULARITY_FLOW_BUNDLE: 'on', SINGULARITY_FLOW_BUNDLE_DIR: bundle.outdir };
  for (const args of [['nextsteps'], ['nextsteps'], ['phase', 'enter', '--compose'], ['session', 'open', f.workId], ['check']]) {
    const result = f.invoke([...args, '--for-agent', '--json'], env);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    if (args[0] === 'check') {
      assert.equal(result.packet.data.repositoryChecks.source, 'fresh');
      assert.equal(result.packet.effects.publicationCreated, false);
    } else assert.equal(result.packet.ready, true, result.stdout);
  }
});
