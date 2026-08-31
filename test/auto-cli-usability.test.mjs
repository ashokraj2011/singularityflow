import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createAutoFlightState, readAutoFlightState } from '../src/auto/auto-flight-store.mjs';
import { resolveOperation } from '../src/command-registry.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Auto CLI Tester' }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Auto CLI Tester'], root);
  run('git', ['config', 'user.email', 'auto-cli@example.com'], root);
  // A governed repository prevents the desktop workspace selector from redirecting this subprocess
  // to whichever repository happens to be active on the test machine.
  run(process.execPath, [cli, 'init'], root);
  return root;
}

test('Auto shorthand and compatibility commands have exact registry classifications', () => {
  const operation = (positionals, options = {}) => resolveOperation({
    requestedCommand: 'auto', positionals, options
  });

  assert.equal(operation(['auto', 'Add CSV export']).id, 'auto.plan');
  assert.equal(operation(['auto', 'Add CSV export']).modelPolicy, 'required');
  assert.equal(operation(['auto', 'planning']).id, 'auto.plan');
  assert.equal(operation(['auto', 'reporting']).id, 'auto.plan');
  assert.equal(operation(['auto', 'list']).classification, 'read');
  assert.equal(operation(['auto', 'stop', 'AFL-AAAAAAAAAAAAAAAAAAAAAAAAAA']).id, 'auto.stop');
  assert.equal(operation(['auto', 'stop', 'AFL-AAAAAAAAAAAAAAAAAAAAAAAAAA']).classification, 'mutation');
  assert.equal(operation(['auto', 'halt', 'AFL-AAAAAAAAAAAAAAAAAAAAAAAAAA']).id, 'auto.halt');
  assert.equal(operation(['auto', 'takeover', 'AFL-AAAAAAAAAAAAAAAAAAAAAAAAAA']).id, 'auto.takeover');
  assert.equal(operation(['auto', 'takeover', 'AFL-AAAAAAAAAAAAAAAAAAAAAAAAAA']).classification, 'mutation');
  assert.throws(
    () => operation(['auto', 'takevoer', 'AFL-AAAAAAAAAAAAAAAAAAAAAAAAAA']),
    (error) => error.code === 'UNKNOWN_SUBCOMMAND' && /takeover/.test(error.message)
  );
});

test('a mistyped Auto control never reaches model-backed requirement planning', async (t) => {
  const root = await repository(t);
  const result = run(process.execPath, [cli, 'auto', 'lits', '--json'], root, { allowFailure: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UNKNOWN_SUBCOMMAND|Did you mean 'list'/);
});

test('Auto list is read-only and stop retains the legacy halt behavior', async (t) => {
  const root = await repository(t);
  const flightId = `AFL-${'A'.repeat(26)}`;
  await createAutoFlightState(root, {
    flightId,
    planId: `APL-${'B'.repeat(26)}`,
    planSha256: `sha256:${'c'.repeat(64)}`,
    status: 'running',
    story: { workId: 'AUTO-CLI-1', phase: 'implementation', revision: null },
    worktree: root,
    execution: { ceilings: {} },
    stopReason: 'test-running',
    nextAction: 'Continue the test flight.'
  });

  const listed = JSON.parse(run(process.execPath, [cli, 'auto', 'list', '--json'], root).stdout);
  assert.equal(listed.operation.id, 'auto.list');
  assert.equal(listed.operation.classification, 'read');
  assert.equal(listed.effects.stateChanged, false);
  assert.equal(listed.data.value.flights.length, 1);
  assert.equal(listed.data.value.flights[0].flightId, flightId);

  const stopped = JSON.parse(run(process.execPath, [cli, 'auto', 'stop', flightId, '--json'], root).stdout);
  assert.equal(stopped.operation.id, 'auto.stop');
  assert.equal(stopped.data.value.status, 'halted');
  assert.equal(stopped.data.value.stopReason, 'human-halted');
  assert.equal((await readAutoFlightState(root, flightId)).status, 'halted');
});

test('Auto start accepts --plan without removing the positional compatibility form', async (t) => {
  const root = await repository(t);
  const planId = `APL-${'D'.repeat(26)}`;
  const confirm = `sha256:${'e'.repeat(64)}`;

  for (const args of [
    ['auto', 'start', planId, '--confirm', confirm],
    ['auto', 'start', '--plan', planId, '--confirm', confirm]
  ]) {
    const result = run(process.execPath, [cli, ...args, '--json'], root, { allowFailure: true });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /requires a Plan ID|AUTO_ARGUMENT_REQUIRED/);
    assert.match(result.stderr, /not available|AUTO_PLAN_NOT_FOUND/);
  }

  const conflict = run(process.execPath, [
    cli, 'auto', 'start', planId, '--plan', `APL-${'F'.repeat(26)}`, '--confirm', confirm, '--json'
  ], root, { allowFailure: true });
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /different Plan IDs|AUTO_ARGUMENT_CONFLICT/);
});

test('Auto requirement shorthand reaches planning and never the removed pilot refusal', async (t) => {
  const root = await repository(t);
  const result = run(process.execPath, [
    cli, 'auto', 'Add CSV export while keeping JSON as the default', '--json'
  ], root, { allowFailure: true });

  // Auto remains disabled in the default governed configuration. Reaching that policy check proves
  // the requirement occupied the planning argument slot and was neither treated as mutation consent
  // nor rejected by the former shorthand gate.
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /interactive Auto shorthand is intentionally gated|AUTO_PILOT_SCOPE/);
  assert.doesNotMatch(result.stderr, /requires a quoted requirement|AUTO_ARGUMENT_REQUIRED/);
});
