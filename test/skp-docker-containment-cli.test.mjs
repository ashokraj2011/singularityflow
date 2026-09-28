import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  parseSkpDockerProbeArguments, runSkpDockerProbeCli, SKP_DOCKER_PROBE_FIXTURE
} from '../scripts/skp-docker-containment.mjs';

const IMAGE = `docker.io/library/busybox@sha256:${'a'.repeat(64)}`;
const APPROVED_ROOT = path.resolve('approved-docker-containment-fixture');
const DOCKER_EXE = path.join(APPROVED_ROOT, 'docker');
const SOCKET = path.join(APPROVED_ROOT, 'docker.sock');
const FLAGS = ['--image', IMAGE, '--docker-executable', DOCKER_EXE,
  '--docker-socket', SOCKET];
const CHECK_IDS = ['hash', 'runtimePolicy', 'read', 'write', 'network',
  'controlPlane', 'cancellation'];

test('Docker containment CLI accepts only an explicit digest and absolute local paths', () => {
  assert.deepEqual(parseSkpDockerProbeArguments(FLAGS), {
    image: IMAGE, dockerExecutable: DOCKER_EXE,
    dockerSocketPath: SOCKET
  });
  for (const invalid of [
    [], FLAGS.slice(0, 4), [...FLAGS, '--pull'],
    ['--image', 'busybox:latest', ...FLAGS.slice(2)],
    ['--image', `example.invalid/busybox@sha256:${'a'.repeat(64)}`, ...FLAGS.slice(2)],
    ['--image', IMAGE, '--docker-executable', 'docker', ...FLAGS.slice(4)],
    ['--image', IMAGE, '--docker-executable', DOCKER_EXE,
      '--docker-socket', 'docker.sock'],
    ['--image', IMAGE, '--image', IMAGE, ...FLAGS.slice(4)]
  ]) {
    assert.throws(() => parseSkpDockerProbeArguments(invalid), {
      code: 'SKP_DOCKER_PROBE_INPUT_INVALID'
    });
  }
});

test('Docker containment CLI passes only fixed inert bytes and never claims qualification', async () => {
  const output = []; let called = 0;
  const exit = await runSkpDockerProbeCli(FLAGS, {
    probe: async (input) => {
      called += 1;
      assert.deepEqual(Object.keys(input).sort(), [
        'dockerExecutable', 'dockerSocketPath', 'image', 'packageBytes'
      ]);
      assert.equal(input.packageBytes.toString('utf8'), SKP_DOCKER_PROBE_FIXTURE);
      assert.equal(input.image, IMAGE);
      return {
        status: 'candidate-observed', qualified: false, launchAuthorized: false,
        skillExecuted: false, deliveryAuthenticated: false, hostEnforcementProven: false,
        checks: CHECK_IDS.map((id) => ({ id, status: 'observed' })),
        recovery: { containers: CHECK_IDS.map((id) => ({ id, cleanup: 'observed-absent' })),
          localStageCleanup: 'observed-removed' },
        secret: 'must not print'
      };
    },
    write: (line) => output.push(line)
  });
  assert.equal(called, 1);
  assert.equal(exit, 0);
  assert.equal(output.length, 1);
  assert.equal(output[0].includes('must not print'), false);
  const report = JSON.parse(output[0]);
  assert.equal(report.status, 'candidate-observed');
  assert.deepEqual(report.checks, CHECK_IDS.map((id) => ({ id, status: 'observed' })));
  assert.equal(report.recovery.localStageCleanup, 'observed-removed');
  for (const field of ['qualified', 'launchAuthorized', 'skillExecuted',
    'deliveryAuthenticated', 'hostEnforcementProven']) assert.equal(report[field], false);
});

test('Docker containment CLI reports unavailable without Docker, raw errors or false success', async () => {
  let calls = 0; const output = [];
  const missing = await runSkpDockerProbeCli([], {
    probe: async () => { calls += 1; }, write: (line) => output.push(line)
  });
  assert.equal(missing, 1);
  assert.equal(calls, 0);
  assert.equal(JSON.parse(output.pop()).code, 'SKP_DOCKER_PROBE_INPUT_INVALID');
  const failed = await runSkpDockerProbeCli(FLAGS, {
    probe: async () => { throw Object.assign(new Error('secret in raw Docker output'), {
      code: 'SKP_DOCKER_CONTAINMENT_UNAVAILABLE'
    }); },
    write: (line) => output.push(line)
  });
  assert.equal(failed, 1);
  assert.equal(output[0].includes('secret'), false);
  assert.equal(JSON.parse(output.pop()).status, 'unavailable');
  const forged = await runSkpDockerProbeCli(FLAGS, {
    probe: async () => ({ status: 'candidate-observed', qualified: true }),
    write: (line) => output.push(line)
  });
  assert.equal(forged, 1);
  assert.equal(JSON.parse(output.pop()).qualified, false);
});

test('npm exposes only an opt-in containment probe command', async () => {
  const packageJson = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
  assert.equal(packageJson.scripts['probe:skp-docker'],
    'node scripts/skp-docker-containment.mjs');
});
