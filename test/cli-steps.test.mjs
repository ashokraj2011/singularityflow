import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reusableReadStep, step, stop } from '../src/cli-steps.mjs';
import { capturedStepResult } from '../src/cli-step-result.mjs';
import { stateRefreshError } from '../src/git-remote-diagnostics.mjs';
import { refusalEnvelope } from '../src/refusal-remediation.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { withReadScope, withoutReadScope, inReadScope, scopedReadSync } from '../src/read-scope.mjs';
import { configurationReadScope, withConfigurationReadRoot } from '../src/configuration-read-scope.mjs';

test('only fixed model-free read operations reuse the CLI runtime', () => {
  for (const args of [
    ['pause', 'status', '--json'], ['workspace', 'current', '--json'], ['session', 'candidates', '--table'],
    ['session', 'status', '--json'], ['session', 'context', '--work-id', 'A-1', '--slice', 'brief', '--json'],
    ['nextsteps', 'A-1', '--json'], ['phase', 'show', 'intake', '--json'],
    ['phase', 'prepublish', 'intake', '--json'], ['status', 'A-1', '--submission-readiness', '--json']
  ]) assert.equal(reusableReadStep(args), true, args.join(' '));
  for (const args of [
    ['phase', 'prepublish', 'intake', '--publish-if-ready', '--for-agent', '--json'],
    ['status', 'A-1', '--submission-readiness', '--submit-if-ready', '--json'],
    ['phase', 'publish', 'intake', '--json'], ['submit', 'intake'], ['approve', 'intake'],
    ['session', 'attach', 'A-1', '--json'], ['session', 'open-local', 'A-1', '--json'],
    ['choices', 'begin', 'approve', 'A-1', '--json'], ['wm', 'compose'], ['pause', 'off'],
    ['not-a-command']
  ]) assert.equal(reusableReadStep(args), false, args.join(' '));
});

test('structured refusals survive all composed command families and every seeded or future phase', async () => {
  const definition = YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
  for (const phase of [...Object.keys(definition.phases), 'custom-future-phase']) for (const args of [
    ['session', 'open'], ['phase', 'prepublish', phase, '--publish-if-ready'],
    ['status', '--submission-readiness', '--submit-if-ready'], ['choices', 'begin', 'approve', 'STORY-1']
  ]) {
    const original = refusalEnvelope(new SingularityFlowError('The exact phase finding must survive.', {
      code: 'TEST_PHASE_REFUSAL', details: { phase, findings: [{ code: 'actual.finding', phase, message: 'Keep this reason.' }] }
    }), args);
    const result = capturedStepResult({ status: 7, stdout: '', stderr: 'Human-readable refusal\n'
      + '--- singularity-flow structured refusal v1 ---\n' + JSON.stringify(original) + '\nError: optional debug stack\n' });
    assert.equal(result.ok, false);
    assert.throws(() => stop(result, args.join(' ')), error => {
      assert.equal(error.code, original.error.code); assert.equal(error.exitCode, 7);
      assert.deepEqual(error.relayedResult, original); return true;
    });
  }
});

test('process deadlines, output limits and first meaningful text errors are retained, not the retry footer', () => {
  const narrated = { schemaVersion: 1, outcome: { status: 'refused', messageId: 'gate.not-ready' },
    why: [{ id: 'exact.finding' }], next: [{ command: 'singularity-flow status --json' }] };
  assert.throws(() => stop(capturedStepResult({ status: 1, stdout: JSON.stringify(narrated) }), 'phase publish'), error => {
    assert.deepEqual(error.relayedResult, narrated); return true;
  });
  for (const [processCode, expected] of [['ETIMEDOUT', 'CLI_STEP_TIMEOUT'], ['ENOBUFS', 'CLI_STEP_OUTPUT_TOO_LARGE']]) {
    const result = capturedStepResult({ status: null, signal: 'SIGTERM', error: { code: processCode, message: 'Child did not finish.' } });
    assert.throws(() => stop(result, 'phase publish'), error => {
      assert.equal(error.code, expected); assert.equal(error.details.execution.processCode, processCode);
      assert.equal(error.details.execution.signal, 'SIGTERM');
      assert.equal(refusalEnvelope(error).error.details.execution.processCode, processCode); return true;
    });
  }
  assert.throws(() => stop(capturedStepResult({ status: 1, stdout: '',
    stderr: 'Singularity Flow error: Exact underlying failure.\nThen: Retry the original command only after resolving it.\n' }), 'session candidates'),
  /Exact underlying failure/u);
});

test('state-refresh diagnostics retain transport classification and deadline evidence without secrets', () => {
  for (const [stage, stderr, classification] of [['observation', 'fatal: Authentication failed', 'authentication-required'],
    ['fetch', 'fatal: SSL certificate problem: unable to get local issuer certificate', 'tls-trust'],
    ['fetch', '', 'operation-timeout']]) {
    const error = stateRefreshError({ branch: 'state' }, stage, {
      status: null, timedOut: true, signal: 'SIGTERM', stderr, timeoutMs: 300000
    }, { elapsedMs: 300012 });
    const packet = refusalEnvelope(error);
    assert.equal(packet.error.code, 'SESSION_STATE_REFRESH_UNAVAILABLE');
    assert.equal(packet.error.remoteFailure.failure.classification, classification);
    assert.equal(packet.error.remoteFailure.timeoutMs, 300000);
    assert.equal(packet.error.remoteFailure.elapsedMs, 300012);
    assert.equal(packet.error.remoteFailure.evidence.timedOut, true);
    assert.equal(packet.error.remoteFailure.stage, stage);
    assert.doesNotMatch(JSON.stringify(packet), /rawStderr|credential=/u);
  }
});

test('isolated scopes leave a caller cache and its overlay intact', async () => {
  const root = path.join(os.tmpdir(), 'scope-test');
  await withConfigurationReadRoot(root, root + '-overlay', { commit: 'caller' }, () => withReadScope(async () => {
    scopedReadSync('caller-value', () => 'before');
    assert.equal(inReadScope(), true);
    await withoutReadScope(async () => {
      assert.equal(inReadScope(), false);
      assert.equal(scopedReadSync('caller-value', () => 'fresh'), 'fresh');
    });
    assert.equal(scopedReadSync('caller-value', () => 'wrong'), 'before');
    assert.equal(configurationReadScope(root).authority.commit, 'caller');
  }));
});

test('composed reads restore cwd, output streams, exit status and start time on success and refusal', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cli-steps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const second = path.join(root, 'second'); await mkdir(second);
  const overrides = {
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(root, 'mode.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, 'active.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, 'registry.json'),
    SINGULARITY_FLOW_PRODUCT_ALIGNMENT: 'off', SINGULARITY_FLOW_PRODUCT_UPDATE: 'off',
    SINGULARITY_FLOW_CONFIGURATION_REVIEWS: 'off', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1'
  };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const cwd = process.cwd(), stdout = process.stdout.write, stderr = process.stderr.write;
  const started = globalThis.__SINGULARITY_FLOW_PROCESS_STARTED_AT, exit = process.exitCode;
  try {
    const [pause, workspace] = await Promise.all([
      step(['pause', 'status', '--json'], root), step(['workspace', 'current', '--json'], second)
    ]);
    assert.equal(pause.ok, true, pause.stderr); assert.ok(pause.value);
    assert.equal(workspace.ok, true, workspace.stderr); assert.equal(workspace.value.active, false);
    const reuse = process.env.SINGULARITY_FLOW_COMPOSED_READS;
    try {
      process.env.SINGULARITY_FLOW_COMPOSED_READS = 'off';
      const isolatedProcess = await step(['pause', 'status', '--json'], root);
      assert.equal(isolatedProcess.ok, true, isolatedProcess.stderr);
      assert.deepEqual(isolatedProcess.value, pause.value, 'the diagnostic fallback preserves the same result');
    } finally {
      reuse === undefined ? delete process.env.SINGULARITY_FLOW_COMPOSED_READS : process.env.SINGULARITY_FLOW_COMPOSED_READS = reuse;
    }
    process.exitCode = 23;
    const refused = await step(['status', '--submission-readiness', '--json'], root);
    assert.equal(refused.ok, false); assert.equal(refused.value.resultType, 'sflow-refusal-plan');
    assert.equal(refused.value.error.code, 'REPOSITORY_CONTEXT_REQUIRED');
    for (const composed of ['on', 'off']) {
      const before = process.env.SINGULARITY_FLOW_COMPOSED_READS;
      process.env.SINGULARITY_FLOW_COMPOSED_READS = composed;
      try {
        const textFailure = await step(['status', '--submission-readiness'], root);
        assert.equal(textFailure.ok, false);
        assert.equal(textFailure.value.error.code, 'REPOSITORY_CONTEXT_REQUIRED', textFailure.stderr);
      } finally {
        before === undefined ? delete process.env.SINGULARITY_FLOW_COMPOSED_READS : process.env.SINGULARITY_FLOW_COMPOSED_READS = before;
      }
    }
    assert.equal(process.exitCode, 23);
    assert.equal(process.cwd(), cwd); assert.equal(process.stdout.write, stdout); assert.equal(process.stderr.write, stderr);
    assert.equal(globalThis.__SINGULARITY_FLOW_PROCESS_STARTED_AT, started);
  } finally {
    process.exitCode = exit;
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});
