import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NETWORK_TIMEOUT_MS, defaultTimeoutFor, networkDisabled, run, writeJson, writeText } from '../src/util.mjs';

test('shared atomic writers tolerate concurrent writes without temporary-file collisions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-util-concurrent-'));
  const jsonFile = path.join(root, 'state.json');
  const textFile = path.join(root, 'state.txt');
  const jsonValues = Array.from({ length: 12 }, (_, index) => ({ index, payload: `value-${index}` }));
  const textValues = Array.from({ length: 12 }, (_, index) => `value-${index}`);

  await Promise.all(jsonValues.map((value) => writeJson(jsonFile, value)));
  await Promise.all(textValues.map((value) => writeText(textFile, value)));

  const finalJson = JSON.parse(await readFile(jsonFile, 'utf8'));
  const finalText = await readFile(textFile, 'utf8');
  assert.ok(jsonValues.some((value) => JSON.stringify(value) === JSON.stringify(finalJson)));
  assert.ok(textValues.some((value) => `${value}\n` === finalText));
  assert.deepEqual((await readdir(root)).sort(), ['state.json', 'state.txt']);
});

test('shared atomic writers remove temporary files after replacement failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-util-cleanup-'));
  const target = path.join(root, 'existing-directory');
  await mkdir(target);

  await assert.rejects(() => writeText(target, 'cannot replace a directory'));

  assert.deepEqual(await readdir(root), ['existing-directory']);
});

test('a command that reaches the network gets a bound, and a timeout is not a refusal', () => {
  // `gh` had no timeout at any of its ten call sites. Behind a captive portal a single `gh api user`
  // held this repository's own suite for thirty-two minutes with no output and no error.
  assert.equal(defaultTimeoutFor('gh'), NETWORK_TIMEOUT_MS);
  assert.ok(NETWORK_TIMEOUT_MS > 0);
  // A fetch against a large repository legitimately takes minutes; a shorter deadline is not the fix.
  assert.equal(defaultTimeoutFor('git'), undefined);
  assert.equal(defaultTimeoutFor('node'), undefined);

  const started = Date.now();
  const result = run('sleep', ['30'], { timeoutMs: 250, allowFailure: true });
  assert.ok(Date.now() - started < 5000, 'the bound was not applied');
  assert.equal(result.timedOut, true);
  assert.notEqual(result.status, 0);

  // Without allowFailure the caller hears that it did not answer, not that it said no.
  assert.throws(() => run('sleep', ['30'], { timeoutMs: 250 }), (error) => error.code === 'SUBPROCESS_TIMEOUT');
});

test('the no-network switch actually reaches the subprocess it names', () => {
  // `SINGULARITY_FLOW_NO_NETWORK` was set by `scripts/dx-benchmark.mjs`, asserted by the reference
  // fixture as `protocol.network: "disabled"`, refused by `assertBaselineCandidate` if absent — and
  // read by nothing. Every recorded number silently included whatever `gh api user` cost that day.
  assert.equal(networkDisabled({}), false);
  assert.equal(networkDisabled({ SINGULARITY_FLOW_NO_NETWORK: '1' }), true);
  assert.equal(networkDisabled({ SINGULARITY_FLOW_NO_NETWORK: 'TRUE' }), true);
  assert.equal(networkDisabled({ SINGULARITY_FLOW_NO_NETWORK: '0' }), false);

  const env = { ...process.env, SINGULARITY_FLOW_NO_NETWORK: '1' };
  const blocked = run('gh', ['api', 'user'], { env, allowFailure: true });
  assert.equal(blocked.blocked, true, 'a network command must be refused, not attempted');
  assert.notEqual(blocked.status, 0);

  /**
   * `blocked` and `timedOut` stay apart, and both stay apart from a plain failure.
   *
   * "we never asked", "we asked and got no answer" and "we asked and it said no" are three
   * different facts about the world, and a disclosure that collapses them tells a reader their
   * account is signed out on the evidence of nobody having looked.
   */
  assert.equal(blocked.timedOut, false);
  assert.equal(run('git', ['--version'], { env }).blocked, false, 'git is not a network command');

  // Without allowFailure the caller is told why, rather than being handed an empty answer.
  assert.throws(() => run('gh', ['api', 'user'], { env }), (error) => error.code === 'NETWORK_DISABLED');
});
