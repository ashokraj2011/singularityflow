import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  refusalEnvelope, refusalRemediationPlan, renderRefusalPlan
} from '../src/refusal-remediation.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

test('an Auto policy refusal gives a capability-aware bounded plan without executing it', () => {
  const error = Object.assign(new Error('Auto mode is disabled by repository policy.'), {
    code: 'AUTO_DISABLED'
  });
  const plan = refusalRemediationPlan(error, [
    'auto', 'plan', 'add sin operator', '--capability', 'rule-engine'
  ]);
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.steps.length, 3);
  assert.ok(plan.steps.every((entry) => entry.execution === 'user-reviewed'));
  assert.equal(plan.retry.automatic, false);
  assert.deepEqual(plan.steps.map((entry) => entry.command), [
    'singularity-flow explain auto-mode',
    'singularity-flow configuration explain --pointer /auto --json',
    'singularity-flow capability show rule-engine --verbose --json'
  ]);
  assert.match(renderRefusalPlan(plan), /Recovery plan:/);
});

test('producer recovery guidance is accepted only as a bounded credential-free SFlow command', () => {
  const accepted = refusalRemediationPlan(Object.assign(new Error('blocked'), {
    details: { diagnosticAction: { command: 'singularity-flow workspace doctor --network --json' } }
  }), ['workspace']);
  assert.equal(accepted.steps[0].command, 'singularity-flow workspace doctor --network --json');

  const rejected = refusalRemediationPlan(Object.assign(new Error('blocked'), {
    details: { diagnosticAction: { command: 'singularity-flow retry --token office-secret' } }
  }), ['workspace']);
  assert.doesNotMatch(JSON.stringify(rejected), /office-secret/);
  assert.ok(rejected.steps.length <= 3);
});

test('the public CLI turns an otherwise plain refusal into one parseable recovery envelope', () => {
  const result = spawnSync(process.execPath, [cli, 'definitely-not-a-command', '--json'], {
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  const envelope = JSON.parse(result.stderr);
  assert.equal(envelope.resultType, 'sflow-refusal-plan');
  assert.equal(envelope.error.code, 'UNKNOWN_COMMAND');
  assert.equal(envelope.remediationPlan.retry.automatic, false);
  assert.deepEqual(envelope.remediationPlan.steps.slice(0, 2).map((entry) => entry.command), [
    'singularity-flow --help', 'singularity-flow quickstart'
  ]);
});

test('the refusal envelope preserves existing bounded transport diagnostics', () => {
  const diagnosticAction = { command: 'singularity-flow workspace doctor --network --json' };
  const remoteFailure = { classification: 'authentication', retryable: true };
  const envelope = refusalEnvelope(Object.assign(new Error('Git access failed.'), {
    code: 'REMOTE_AUTHENTICATION', details: { diagnosticAction, remoteFailure }
  }), ['capability', 'proposals']);
  assert.deepEqual(envelope.error.diagnosticAction, { ...diagnosticAction, skill: null });
  assert.deepEqual(envelope.error.remoteFailure, remoteFailure);
  assert.equal(envelope.remediationPlan.steps[0].command, diagnosticAction.command);
});

test('every published executable routes its own refusal through the shared planner', async () => {
  const manifest = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
  const executables = [...new Set(Object.values(manifest.bin))];
  for (const relative of executables) {
    const source = await readFile(path.resolve(relative), 'utf8');
    assert.match(source, /reportCliFailure/, relative);
  }
});
