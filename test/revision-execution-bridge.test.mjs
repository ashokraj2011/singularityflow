import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeRevisionBrokeredPlan, readRevisionBrokeredResultBytes,
  recoverRevisionBrokeredPlan, registerRevisionBrokeredExecutionPlan
} from '../src/revision/execution-bridge.mjs';

const boundary = { config: {}, workflow: {} };
const parentFiles = [
  { path: 'src/app.js', bytes: Buffer.from('export const value = 1;\n') },
  { path: 'src/old.js', bytes: Buffer.from('obsolete\n') }
];
const allowedEffects = ['local-process', 'candidate-filesystem'];

test('fixed brokered worker collects bounded exact bytes and a non-promoting effect receipt', async () => {
  const plan = registerRevisionBrokeredExecutionPlan([
    { kind: 'write', path: 'src/app.js', bytes: Buffer.from('export const value = 2;\n') },
    { kind: 'delete', path: 'src/old.js' },
    { kind: 'write', path: 'src/new.js', bytes: Buffer.from('new\n'), executable: true }
  ]);
  const result = await executeRevisionBrokeredPlan({
    plan, parentFiles, allowedPaths: ['src/app.js', 'src/old.js', 'src/new.js'],
    allowedEffects, ...boundary
  });
  assert.equal(result.status, 'bounded-effects-collected');
  assert.equal(result.kind, 'revision-effect-receipt');
  assert.equal(result.cleanup.verified, true);
  assert.equal(result.candidateAdmitted, false);
  assert.equal(result.loopHeadAdvanced, false);
  assert.equal(result.retryAllowed, false);
  assert.equal(result.processTiming.timeoutMs, 60_000);
  assert.match(result.processTiming.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(result.processTiming.endedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Number.isSafeInteger(result.processTiming.durationMs));
  assert.ok(result.processTiming.durationMs >= 0
    && result.processTiming.durationMs <= result.processTiming.timeoutMs);
  assert.deepEqual(result.unknownEffects, []);
  assert.equal(result.effects.find((effect) => effect.class === 'local-process').quiescenceStatus,
    'confirmed');
  assert.deepEqual(result.effects.map((effect) => effect.resolutionStatus), ['absent', 'restored']);
  const output = readRevisionBrokeredResultBytes(result);
  assert.deepEqual([...output.keys()].sort(), ['src/app.js', 'src/new.js', 'src/old.js']);
  assert.equal(output.get('src/app.js').toString(), 'export const value = 2;\n');
  assert.equal(output.get('src/old.js'), null);
  assert.equal(result.effects[1].observed, true);
  output.get('src/app.js').fill(0);
  assert.equal(readRevisionBrokeredResultBytes(result).get('src/app.js').toString(),
    'export const value = 2;\n');
  assert.deepEqual(result.changes.map((change) => change.path),
    ['src/app.js', 'src/new.js', 'src/old.js']);
});

test('Git, arbitrary command, governed path, forged token and undeclared effects refuse before spawn', async () => {
  assert.throws(() => registerRevisionBrokeredExecutionPlan([
    { kind: 'git', command: 'git commit' }
  ]), { code: 'REV_AGENT_GIT_MUTATION_DENIED' });
  assert.throws(() => registerRevisionBrokeredExecutionPlan([
    { kind: 'run', argv: ['/usr/bin/git', 'add', '.'] }
  ]), { code: 'REV_AGENT_GIT_MUTATION_DENIED' });
  assert.throws(() => registerRevisionBrokeredExecutionPlan([
    { kind: 'run', command: 'node -e "bad"' }
  ]), { code: 'REV_ATTEMPT_DRIVER_UNSUPPORTED' });
  assert.throws(() => registerRevisionBrokeredExecutionPlan([
    { kind: 'write', path: '.git/config', bytes: Buffer.from('bad') }
  ]), { code: 'REV_ATTEMPT_PATH_INVALID' });
  assert.throws(() => registerRevisionBrokeredExecutionPlan([
    { kind: 'write', path: '.gitattributes', bytes: Buffer.from('bad') }
  ]), { code: 'REV_AGENT_GIT_MUTATION_DENIED' });
  for (const protectedPath of [
    '.sflow/revision-pilot.json', '.SFLOW/revision-pilot.json',
    '.singularity-flow/session.json', 'SINGULARITY/workflow.yml'
  ]) {
    assert.throws(() => registerRevisionBrokeredExecutionPlan([
      { kind: 'write', path: protectedPath, bytes: Buffer.from('bad') }
    ]), { code: 'REV_ATTEMPT_SCOPE_REFUSED' });
  }
  assert.throws(() => registerRevisionBrokeredExecutionPlan([
    { kind: 'write', path: 'src/app.js', bytes: Buffer.from('one') },
    { kind: 'write', path: 'SRC/app.js', bytes: Buffer.from('two') }
  ]), { code: 'REV_ATTEMPT_DRIVER_INVALID' });
  const plan = registerRevisionBrokeredExecutionPlan([
    { kind: 'write', path: 'src/app.js', bytes: Buffer.from('changed') }
  ]);
  const base = { plan, parentFiles, allowedPaths: ['src/app.js'], allowedEffects, ...boundary };
  await assert.rejects(executeRevisionBrokeredPlan({ ...base, plan: { ...plan } }),
    { code: 'REV_ATTEMPT_DRIVER_UNSUPPORTED' });
  await assert.rejects(executeRevisionBrokeredPlan({ ...base,
    allowedEffects: ['candidate-filesystem', 'local-process', 'network-write']
  }), { code: 'REV_EXTERNAL_EFFECT_UNKNOWN' });
  await assert.rejects(executeRevisionBrokeredPlan({ ...base,
    config: { governedRoots: ['src'] }
  }), { code: 'REV_ATTEMPT_SCOPE_REFUSED' });
  await assert.rejects(executeRevisionBrokeredPlan({ ...base,
    allowedPaths: ['src/other.js']
  }), { code: 'REV_ATTEMPT_SCOPE_REFUSED' });
  await assert.rejects(executeRevisionBrokeredPlan({ ...base,
    allowedPaths: ['src/app.js', 'SRC/app.js']
  }), { code: 'REV_ATTEMPT_SCOPE_REFUSED' });
});

test('timeout stops the fixed worker, confirms quiescence, disposes effects, and yields no candidate', async () => {
  const plan = registerRevisionBrokeredExecutionPlan([
    { kind: 'wait', ms: 2_000 },
    { kind: 'write', path: 'src/app.js', bytes: Buffer.from('too late') }
  ]);
  const result = await executeRevisionBrokeredPlan({
    plan, parentFiles, allowedPaths: ['src/app.js'], allowedEffects, timeoutMs: 20,
    ...boundary
  });
  assert.equal(result.status, 'timed-out');
  assert.equal(result.code, 'REV_ATTEMPT_BUDGET_EXHAUSTED');
  assert.equal(result.cleanup.verified, true);
  assert.equal(result.retryAllowed, true);
  assert.equal(result.effects[0].quiescenceStatus, 'confirmed');
  assert.equal(result.effects[1].observed, true);
  assert.equal(result.processTiming.timeoutMs, 20);
  assert.ok(result.processTiming.durationMs >= 20);
  assert.deepEqual(result.unknownEffects, []);
  assert.throws(() => readRevisionBrokeredResultBytes(result),
    { code: 'REV_ATTEMPT_RESULT_UNVERIFIED' });
});

test('cancellation stops the fixed worker and pre-aborted signal never starts it', async () => {
  const plan = registerRevisionBrokeredExecutionPlan([{ kind: 'wait', ms: 2_000 }]);
  const controller = new AbortController();
  const running = executeRevisionBrokeredPlan({
    plan, parentFiles, allowedPaths: ['src/app.js'], allowedEffects,
    signal: controller.signal, ...boundary
  });
  setTimeout(() => controller.abort(), 20);
  const cancelled = await running;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.effects[0].quiescenceStatus, 'confirmed');
  assert.equal(cancelled.retryAllowed, true);
  controller.abort();
  const pre = await executeRevisionBrokeredPlan({
    plan, parentFiles, allowedPaths: ['src/app.js'], allowedEffects,
    signal: controller.signal, ...boundary
  });
  assert.equal(pre.status, 'cancelled');
  assert.equal(pre.effects[0].observed, false);
  assert.equal(pre.effects[0].stopOutcome, 'not-started');
  assert.equal(pre.retryAllowed, true);
});

test('wait-only execution refuses an undeclared candidate filesystem before materialization', async () => {
  const plan = registerRevisionBrokeredExecutionPlan([{ kind: 'wait', ms: 1 }]);
  await assert.rejects(executeRevisionBrokeredPlan({
    plan, parentFiles, allowedPaths: ['src/app.js'], allowedEffects: ['local-process'],
    ...boundary
  }), { code: 'REV_EXTERNAL_EFFECT_UNKNOWN' });
});

test('forged result bytes and recovery handles cannot be used', async () => {
  const plan = registerRevisionBrokeredExecutionPlan([
    { kind: 'write', path: 'src/app.js', bytes: Buffer.from('changed') }
  ]);
  const result = await executeRevisionBrokeredPlan({
    plan, parentFiles, allowedPaths: ['src/app.js'], allowedEffects, ...boundary
  });
  assert.throws(() => readRevisionBrokeredResultBytes({ ...result }),
    { code: 'REV_ATTEMPT_RESULT_UNVERIFIED' });
  result.processTiming.durationMs = 0;
  assert.throws(() => readRevisionBrokeredResultBytes(result),
    { code: 'REV_ATTEMPT_RESULT_UNVERIFIED' });
  result.changes[0].path = 'src/forged.js';
  assert.throws(() => readRevisionBrokeredResultBytes(result),
    { code: 'REV_ATTEMPT_RESULT_UNVERIFIED' });
  await assert.rejects(recoverRevisionBrokeredPlan(result), { code: 'REV_RECOVERY_REQUIRED' });
});
