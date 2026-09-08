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
  assert.match(plan.steps[0].label, /Configuration Center → Auto mode/);
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

test('FOS:AC-044 FOS refusals provide bounded real commands without executing recovery', () => {
  const cases = new Map([
    ['AUTHORITY_ROUTE_AMBIGUOUS', 'singularity-flow onboard <LOCAL-PATH> --remote <NAME>'],
    ['AUTHORITY_REBIND_REQUIRED', 'singularity-flow explain fast-onboarding'],
    ['AUTHORITY_PIN_INVALID', 'singularity-flow doctor --json'],
    ['FOS_CACHE_PATH_INVALID', 'singularity-flow doctor --json'],
    ['OBJECT_SERVICE_UNAVAILABLE', 'singularity-flow doctor --git-speed --json'],
    ['WORK_PRESERVATION_FAILED', 'singularity-flow workspace list --json']
  ]);
  for (const [code, command] of cases) {
    const plan = refusalRemediationPlan(Object.assign(new Error('hostile path /tmp/a b/δ'), { code }), ['onboard']);
    assert.equal(plan.steps[0].command, command, code);
    assert.equal(plan.steps[0].execution, 'user-reviewed', code);
    assert.equal(plan.retry.automatic, false, code);
    assert.doesNotMatch(JSON.stringify(plan), /Error:|\n\s+at /, code);
  }
});

test('FOS:AC-033 recovery remains registered and shell-safe on macOS Linux and Windows with hostile context', () => {
  const secret = 'https://person:office-secret@example.test/repo.git';
  const error = Object.assign(new Error(`hostile path /tmp/a b/δ; touch escaped ${secret}`), {
    code: 'AUTHORITY_PIN_INVALID',
    details: {
      diagnosticAction: { command: 'singularity-flow doctor --json; touch escaped' },
      recoveryCommand: 'singularity-flow doctor --json'
    }
  });
  const envelope = refusalEnvelope(error, ['onboard']);
  const plan = envelope.remediationPlan;
  assert.equal(plan.retry.automatic, false);
  assert.ok(plan.steps.length > 0 && plan.steps.length <= 3);
  assert.ok(plan.steps.every((step) => step.execution === 'user-reviewed'));
  assert.ok(plan.steps.every((step) => /^singularity-flow [a-z][a-z0-9-]*(?: |$)/.test(step.command)));
  assert.ok(plan.steps.every((step) => Array.isArray(step.argv)));
  for (const step of plan.steps.filter((entry) => entry.copyable)) {
    assert.deepEqual(Object.keys(step.platformCommands), ['darwin', 'linux', 'win32']);
    assert.match(step.platformCommands.darwin, /^'singularity-flow'/);
    assert.match(step.platformCommands.linux, /^'singularity-flow'/);
    assert.match(step.platformCommands.win32, /^& 'singularity-flow'/);
    assert.doesNotMatch(JSON.stringify(step.platformCommands), /touch escaped|office-secret/);
  }
  assert.doesNotMatch(JSON.stringify(envelope), /office-secret|\n\s+at /);
  assert.match(envelope.error.message, /REDACTED/);
});

test('every published executable routes its own refusal through the shared planner', async () => {
  const manifest = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
  const executables = [...new Set(Object.values(manifest.bin))];
  for (const relative of executables) {
    const source = await readFile(path.resolve(relative), 'utf8');
    assert.match(source, /reportCliFailure/, relative);
  }
});
