import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { compileObservation } from '../src/observation-compiler.mjs';
import { run } from '../src/util.mjs';

function repository() {
  return mkdtemp(path.join(os.tmpdir(), 'sflow-observation-outcome-')).then((root) => {
    run('git', ['init', '-q'], { cwd: root });
    run('git', ['config', 'user.email', 'observation@example.test'], { cwd: root });
    run('git', ['config', 'user.name', 'Observation Test'], { cwd: root });
    run('git', ['commit', '--allow-empty', '-qm', 'initial'], { cwd: root });
    return root;
  });
}

test('build observations take their verdict only from structured execution metadata', async () => {
  const root = await repository();
  const descriptive = await compileObservation(root, {
    kind: 'build-output',
    raw: 'Build complete.\nImproved error handling for malformed requests.\n0 warnings.\n',
    execution: { started: true, exitCode: 0 }
  });
  assert.equal(descriptive.status, 'passed');
  assert.equal(descriptive.outcome.state, 'succeeded');
  assert.equal(descriptive.outcome.authority, 'process-exit');
  assert.equal(descriptive.summary.errorDiagnostics, 1);

  const optimistic = await compileObservation(root, {
    kind: 'build-output', raw: 'Build succeeded.\n0 errors.\n0 failed.\n',
    execution: { started: true, exitCode: 1 }
  });
  assert.equal(optimistic.status, 'failed');
  assert.equal(optimistic.outcome.state, 'failed');
  assert.equal(optimistic.outcome.exitCode, 1);
});

test('observation outcomes preserve cancellation, timeout, spawn, signal, and unknown states', async () => {
  const root = await repository();
  const cases = [
    [{ cancelled: true }, ['cancelled', 'cancelled']],
    [{ timedOut: true }, ['failed', 'timed-out']],
    [{ started: false, spawnErrorCode: 'ENOENT' }, ['failed', 'not-started']],
    [{ signal: 'SIGKILL' }, ['failed', 'failed']],
    [{}, ['unknown', 'unknown']]
  ];
  for (const [execution, [status, state]] of cases) {
    const observation = await compileObservation(root, {
      kind: 'build-output', raw: 'success and error are just words', execution
    });
    assert.equal(observation.status, status);
    assert.equal(observation.outcome.state, state);
  }
});

test('only a complete versioned test protocol can contradict process outcome', async () => {
  const root = await repository();
  const completeTap = [
    'TAP version 13',
    'not ok 1 - broken case',
    'ok 2 - passing case',
    '1..2',
    '# tests 2',
    '# pass 1',
    '# fail 1',
    ''
  ].join('\n');
  const contradiction = await compileObservation(root, {
    kind: 'test-result', raw: completeTap, execution: { started: true, exitCode: 0 }
  });
  assert.deepEqual(contradiction.protocol, {
    id: 'tap', version: '13', parserVersion: '1.0.0', complete: true, verdict: 'failed'
  });
  assert.equal(contradiction.status, 'failed');
  assert.equal(contradiction.outcome.contradiction.code, 'OBSERVATION_OUTCOME_CONTRADICTION');
  assert.equal(contradiction.outcome.contradiction.resolution, 'failed-safe');

  const loose = await compileObservation(root, {
    kind: 'test-result', raw: '12 passed\n1 failed\nError: descriptive only\n',
    execution: { started: true, exitCode: 0 }
  });
  assert.equal(loose.protocol, null);
  assert.equal(loose.status, 'passed');
  assert.equal(loose.outcome.contradiction, null);
});

test('observation parser tripwires keep durable status centralized and guidance-only', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(
    new URL('../src/observation-compiler.mjs', import.meta.url), 'utf8'
  ));
  for (const parser of ['testObservation', 'stackObservation', 'gitObservation', 'buildObservation', 'genericObservation']) {
    const body = source.slice(source.indexOf(`function ${parser}`), source.indexOf('\n}', source.indexOf(`function ${parser}`)) + 2);
    assert.doesNotMatch(body, /\bstatus\s*:/, `${parser} assigns a top-level status`);
  }
  assert.match(source, /guidanceOnly:\s*true/);
});
