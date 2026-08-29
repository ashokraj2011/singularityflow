import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createGvmProgram,
  createIntentIr,
  createWorkflowIr,
  createWorkflowRatification
} from '../src/sgos/contracts.mjs';
import { compileSgosProgram, registrySnapshotDigest } from '../src/sgos/compiler.mjs';
import { assertTrustedSgosConfigurationAuthority } from '../src/sgos/authority-trust.mjs';
import {
  assertSgosInstalledProgramLimits,
  assertSgosProgramExecutionAdmission,
  loadApprovedSgosProgramAuthority,
  validateSgosProgramStaticSafety,
  verifySgosProgramRegistry
} from '../src/sgos/program-trust.mjs';
import { publishSgosProgramAuthority } from './helpers/sgos-authority.mjs';

const POLICY_SHA = `sha256:${'1'.repeat(64)}`;
const STORAGE_SHA = `sha256:${'2'.repeat(64)}`;
const MANIFEST_RUN = `sha256:${'3'.repeat(64)}`;
const MANIFEST_VERIFY = `sha256:${'4'.repeat(64)}`;

function registrySnapshot(overrides = {}) {
  const core = {
    kind: 'registry-snapshot',
    operations: [
      { id: 'core.run', version: '1', status: 'active', manifestSha256: MANIFEST_RUN },
      { id: 'core.verify', version: '1', status: 'active', manifestSha256: MANIFEST_VERIFY }
    ],
    taskKinds: [],
    devices: [],
    ...overrides
  };
  return { ...core, registrySnapshotSha256: registrySnapshotDigest(core) };
}

function compilerFixture({ registry = registrySnapshot(), operationVersion = null } = {}) {
  const intentIr = createIntentIr({
    generation: 1,
    objective: { statement: 'Run one governed operation.', provenance: 'human-confirmed' },
    outcomes: [], successCriteria: [], constraints: [], invariants: [], preferences: [],
    nonGoals: [], assumptions: [], unknowns: [], contradictions: [], risks: [],
    evidenceExpectations: [], authorityRequirements: [], budgets: [], domainCandidates: [],
    workTypeCandidates: [], subjects: []
  });
  const clauseId = `${intentIr.intentId}:objective`;
  const coverage = {
    clauses: { [clauseId]: [{ kind: 'task', targetId: 'run' }] },
    tasks: { run: [{ kind: 'intent-clause', sourceId: clauseId }] }
  };
  const workflow = createWorkflowIr({
    apiVersion: 'sflow/v1', version: '1',
    intentIrSha256: intentIr.intentIrSha256,
    policySnapshotSha256: POLICY_SHA,
    metadata: { id: 'program-trust', version: '1', domainPack: 'core' },
    spec: {
      inputs: {},
      tasks: {
        run: {
          kind: 'task', opcode: 'KERNEL', operation: 'core.run', dependsOn: [],
          resources: { reads: [], writes: ['artifact:result'], devices: [], externalEffects: [] },
          evidence: { required: ['candidate-snapshot', 'verification-result'] },
          authority: {}, recovery: {}, intentClauseIds: [clauseId], material: true,
          metadata: {
            ...(operationVersion == null ? {} : { operationVersion }),
            verification: { kind: 'kernel', operation: 'core.verify' }
          },
          inputs: [], outputs: [{ ref: 'artifact:result' }], retry: { maximumAttempts: 1 },
          policySnapshotSha256: POLICY_SHA
        },
        end: { kind: 'end', opcode: 'END', dependsOn: ['run'], material: false }
      },
      joins: {},
      terminalConditions: [{ taskTemplateId: 'end', state: 'succeeded' }],
      budgets: { maximumTasks: 2, maximumAttempts: 1 },
      recovery: {}, evidence: {}, authority: {},
      storageRequirements: { profileSha256: STORAGE_SHA },
      intentWorkflowMap: coverage
    }
  });
  const ratification = createWorkflowRatification({
    intentIrSha256: intentIr.intentIrSha256,
    workflowSha256: workflow.workflowSha256,
    policySnapshotSha256: POLICY_SHA,
    registrySnapshotSha256: registry.registrySnapshotSha256,
    storageProfileSha256: STORAGE_SHA,
    packetSha256: `sha256:${'5'.repeat(64)}`,
    decision: 'ratified',
    principal: { id: 'reviewer', kind: 'human' },
    coverage,
    decidedAt: '2026-08-29T00:00:00.000Z'
  });
  const request = {
    intentIr, workflow, ratification,
    policySnapshotSha256: POLICY_SHA,
    registrySnapshotSha256: registry.registrySnapshotSha256,
    registrySnapshot: registry,
    storageProfileSha256: STORAGE_SHA
  };
  return { request, program: compileSgosProgram(request).program, registry };
}

function reseal(program, mutate) {
  const seed = structuredClone(program);
  delete seed.schemaVersion;
  delete seed.kind;
  delete seed.programId;
  delete seed.programSha256;
  mutate(seed);
  return createGvmProgram(seed);
}

function staticSafetyTask(taskTemplateId, {
  opcode = 'NOOP', dependsOn = [], resources = null, recovery = {}
} = {}) {
  return {
    taskTemplateId,
    opcode,
    dependsOn,
    resources: resources ?? { reads: [], writes: [], devices: [], externalEffects: [] },
    evidence: {},
    authority: {},
    recovery,
    inputs: [],
    outputs: [],
    retry: { maximumAttempts: 1 },
    policySnapshotSha256: POLICY_SHA,
    material: false,
    metadata: {}
  };
}

function staticSafetyProgram(taskTemplates, edges, terminalTaskTemplateId = 'z-end') {
  const { program } = compilerFixture();
  return reseal(program, (seed) => {
    seed.taskTemplates = taskTemplates;
    seed.edges = edges;
    seed.joins = [];
    seed.budgets = { maximumTasks: taskTemplates.length, maximumAttempts: 1 };
    seed.terminalConditions = [{ taskTemplateId: terminalTaskTemplateId, state: 'succeeded' }];
  });
}

function oracleResourceOverlap(left, right) {
  const normalize = (value) => String(value).replaceAll('\\', '/')
    .replace(/\/(?:\*\*|\*)$/, '').replace(/\/$/, '');
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b
    && (a === '*' || b === '*' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

function oracleConflictKind(leftField, rightField) {
  if (leftField === 'writes' && rightField === 'writes') return 'write/write';
  if (leftField === 'writes' && rightField === 'reads') return 'write/read';
  if (leftField === 'reads' && rightField === 'writes') return 'read/write';
  if (leftField === 'devices' && rightField === 'devices') return 'device/device';
  if (leftField === 'externalEffects' && rightField === 'externalEffects') return 'effect/effect';
  return null;
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error?.code, code, error?.stack);
    return true;
  });
}

async function verifiedAuthority(program) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-program-authority-'));
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'SGOS Authority Tester'],
    ['config', 'user.email', 'sgos-authority@example.test'],
    ['commit', '--allow-empty', '-m', 'authority fixture']
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  await publishSgosProgramAuthority(root, program);
  return loadApprovedSgosProgramAuthority(root, program);
}

async function authorityRepository(program) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-authority-boundary-'));
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'SGOS Authority Tester'],
    ['config', 'user.email', 'sgos-authority@example.test'],
    ['commit', '--allow-empty', '-m', 'authority fixture']
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  await publishSgosProgramAuthority(root, program);
  return root;
}

test('execution admission requires approved authority and proves exact compiler output by recompilation', async () => {
  const fixture = compilerFixture();
  const programAuthority = await verifiedAuthority(fixture.program);
  const admission = assertSgosProgramExecutionAdmission(fixture.program, {
    compilerRequest: fixture.request,
    programAuthority
  });

  assert.equal(admission.admitted, true);
  assert.equal(admission.provenance.method, 'approved-authority+deterministic-recompilation');
  assert.equal(admission.provenance.source.ref, 'refs/heads/sflow/config');
  assert.equal(admission.safety.registry.verified, true);
  assert.deepEqual(admission.safety.graph.topologicalOrder, ['run', 'end']);
  const run = fixture.program.taskTemplates.find((task) => task.taskTemplateId === 'run');
  assert.equal(run.metadata.operationVersion, '1');
  assert.equal(run.metadata.operationManifestSha256, MANIFEST_RUN);
  assert.equal(run.metadata.verificationOperationVersion, '1');
  assert.equal(run.metadata.verificationOperationManifestSha256, MANIFEST_VERIFY);
});

test('a configured remote prevents a local-only sflow/config head from authorizing execution', async () => {
  const fixture = compilerFixture();
  const root = await authorityRepository(fixture.program);
  assert.deepEqual(assertTrustedSgosConfigurationAuthority(root, {
    kind: 'approved-configuration-ref', ref: 'refs/heads/sflow/config'
  }), { mode: 'offline-local-head-authority', remote: null });
  const remote = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-empty-remote-'));
  const initialized = spawnSync('git', ['init', '--bare'], { cwd: remote, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const added = spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: root, encoding: 'utf8' });
  assert.equal(added.status, 0, added.stderr);

  await assert.rejects(
    () => loadApprovedSgosProgramAuthority(root, fixture.program),
    (error) => {
      assert.equal(error?.code, 'SGOS_CONFIGURATION_AUTHORITY_UNTRUSTED', error?.stack);
      assert.match(error.message, /local-only configuration authority/i);
      return true;
    }
  );

  const localCommit = spawnSync('git', [
    'rev-parse', '--verify', 'refs/heads/sflow/config^{commit}'
  ], { cwd: root, encoding: 'utf8' }).stdout.trim();
  const cached = spawnSync('git', [
    'update-ref', 'refs/remotes/origin/sflow/config', localCommit
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(cached.status, 0, cached.stderr);
  await assert.rejects(
    () => loadApprovedSgosProgramAuthority(root, fixture.program),
    (error) => {
      assert.equal(error?.code, 'SGOS_CONFIGURATION_AUTHORITY_UNTRUSTED', error?.stack);
      return true;
    },
    'a locally manufactured remote-tracking ref is not proof that the remote advertised it'
  );

  const upstream = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-attacker-remote-'));
  const upstreamInit = spawnSync('git', ['init', '--bare'], {
    cwd: upstream, encoding: 'utf8'
  });
  assert.equal(upstreamInit.status, 0, upstreamInit.stderr);
  const upstreamAdd = spawnSync('git', ['remote', 'add', 'upstream', upstream], {
    cwd: root, encoding: 'utf8'
  });
  assert.equal(upstreamAdd.status, 0, upstreamAdd.stderr);
  const pushed = spawnSync('git', [
    'push', 'upstream',
    'refs/heads/sflow/config:refs/heads/sflow/config'
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(pushed.status, 0, pushed.stderr);
  const clearedPushTrackingRef = spawnSync('git', [
    'update-ref', '-d', 'refs/remotes/upstream/sflow/config'
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(clearedPushTrackingRef.status, 0, clearedPushTrackingRef.stderr);
  const missingOriginRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-missing-origin-'));
  const unavailableOrigin = spawnSync('git', [
    'remote', 'set-url', 'origin', path.join(missingOriginRoot, 'does-not-exist.git')
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(unavailableOrigin.status, 0, unavailableOrigin.stderr);

  assert.throws(() => assertTrustedSgosConfigurationAuthority(root, {
    kind: 'approved-configuration-ref', ref: 'refs/remotes/upstream/sflow/config'
  }), (error) => {
    assert.equal(error?.code, 'SGOS_CONFIGURATION_AUTHORITY_UNTRUSTED', error?.stack);
    assert.equal(error?.details?.canonicalRemote, 'origin');
    return true;
  });
  await assert.rejects(
    () => loadApprovedSgosProgramAuthority(root, fixture.program),
    (error) => {
      assert.equal(error?.code, 'SGOS_CONFIGURATION_AUTHORITY_UNTRUSTED', error?.stack);
      return true;
    },
    'a valid authority on another remote cannot replace an unavailable origin authority'
  );
  assert.equal(spawnSync('git', [
    'show-ref', '--verify', '--quiet', 'refs/remotes/upstream/sflow/config'
  ], { cwd: root, encoding: 'utf8' }).status, 1,
  'SGOS must not even fetch an alternate remote while origin is canonical');

  const originRemoved = spawnSync('git', ['remote', 'remove', 'origin'], {
    cwd: root, encoding: 'utf8'
  });
  assert.equal(originRemoved.status, 0, originRemoved.stderr);
  const authority = await loadApprovedSgosProgramAuthority(root, fixture.program);
  assert.equal(authority.source.ref, 'refs/remotes/upstream/sflow/config',
    'one configured non-origin remote is the canonical authority');
});

test('SGOS refuses ambiguous remotes when no origin defines the canonical authority', async () => {
  const fixture = compilerFixture();
  const root = await authorityRepository(fixture.program);
  for (const remote of ['reviewed', 'attacker']) {
    const bare = await mkdtemp(path.join(os.tmpdir(), `sflow-sgos-${remote}-`));
    const initialized = spawnSync('git', ['init', '--bare'], { cwd: bare, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    const added = spawnSync('git', ['remote', 'add', remote, bare], { cwd: root, encoding: 'utf8' });
    assert.equal(added.status, 0, added.stderr);
  }

  await assert.rejects(
    () => loadApprovedSgosProgramAuthority(root, fixture.program),
    (error) => {
      assert.equal(error?.code, 'SGOS_CONFIGURATION_AUTHORITY_UNTRUSTED', error?.stack);
      assert.deepEqual(error?.details?.configuredRemotes, ['attacker', 'reviewed']);
      assert.match(error.message, /one canonical configuration remote/i);
      return true;
    }
  );
});

test('a contract-valid self-hash is integrity, not executable compiler provenance', () => {
  const { program } = compilerFixture();
  validateSgosProgramStaticSafety(program);
  expectCode(
    () => assertSgosProgramExecutionAdmission(program),
    'SGOS_PROGRAM_AUTHORITY_REQUIRED'
  );
});

test('only an authority loaded from approved configuration can witness a Program', async () => {
  const { program, registry } = compilerFixture();
  const programAuthority = await verifiedAuthority(program);
  const admission = assertSgosProgramExecutionAdmission(program, {
    programAuthority,
    registrySnapshot: registry
  });
  assert.equal(admission.provenance.method, 'approved-program-authority');
  expectCode(() => assertSgosProgramExecutionAdmission(program, {
    programAuthority: structuredClone(programAuthority), registrySnapshot: registry
  }), 'SGOS_PROGRAM_AUTHORITY_REQUIRED');
});

test('copied compiler labels cannot substitute for exact deterministic recompilation', async () => {
  const { request, program } = compilerFixture();
  const forged = reseal(program, (seed) => {
    seed.recoveryPolicy = { forgedButSelfHashed: true };
  });
  const programAuthority = await verifiedAuthority(forged);
  expectCode(
    () => assertSgosProgramExecutionAdmission(forged, { compilerRequest: request, programAuthority }),
    'SGOS_PROGRAM_RECOMPILATION_MISMATCH'
  );
});

test('execution admission rejects an untrusted compiler identity before provenance', () => {
  const { program } = compilerFixture();
  const forged = reseal(program, (seed) => {
    seed.compiler = { id: 'lookalike-compiler', version: '2' };
  });
  expectCode(
    () => assertSgosProgramExecutionAdmission(forged),
    'SGOS_PROGRAM_COMPILER_UNTRUSTED'
  );
});

test('execution admission rechecks graph and terminal safety', async (t) => {
  const { program } = compilerFixture();
  await t.test('cycle', () => {
    const forged = reseal(program, (seed) => {
      seed.edges = [{ from: 'end', to: 'run' }, { from: 'run', to: 'end' }];
      seed.taskTemplates.find((task) => task.taskTemplateId === 'run').dependsOn = ['end'];
    });
    expectCode(() => validateSgosProgramStaticSafety(forged), 'SGOS_PROGRAM_GRAPH_CYCLE');
  });
  await t.test('missing END', () => {
    const forged = reseal(program, (seed) => {
      seed.taskTemplates = seed.taskTemplates.filter((task) => task.taskTemplateId === 'run');
      seed.edges = [];
      seed.budgets.maximumTasks = 1;
      seed.terminalConditions = [{ taskTemplateId: 'run', state: 'succeeded' }];
    });
    expectCode(() => validateSgosProgramStaticSafety(forged), 'SGOS_PROGRAM_TERMINAL_INVALID');
  });
  await t.test('edge/dependency mismatch', () => {
    const forged = reseal(program, (seed) => {
      seed.taskTemplates.find((task) => task.taskTemplateId === 'end').dependsOn = [];
    });
    expectCode(() => validateSgosProgramStaticSafety(forged), 'SGOS_PROGRAM_DEPENDENCY_MISMATCH');
  });
});

test('parallel resource safety preserves prefix, wildcard, and dependency semantics', () => {
  const alphaResources = {
    reads: ['read-root/item'],
    writes: ['shared/exact', 'workspace/**'],
    devices: ['*'],
    externalEffects: ['service']
  };
  const betaResources = {
    reads: ['workspace/file'],
    writes: ['read-root', 'shared/exact'],
    devices: ['device/fleet/camera'],
    externalEffects: ['service/deploy']
  };
  const unordered = staticSafetyProgram([
    staticSafetyTask('alpha', { resources: alphaResources, recovery: { mode: 'manual' } }),
    staticSafetyTask('beta', { resources: betaResources, recovery: { mode: 'manual' } }),
    staticSafetyTask('z-end', { opcode: 'END', dependsOn: ['alpha', 'beta'] })
  ], [
    { from: 'alpha', to: 'z-end' },
    { from: 'beta', to: 'z-end' }
  ]);
  assert.throws(() => validateSgosProgramStaticSafety(unordered), (error) => {
    assert.equal(error?.code, 'SGOS_PROGRAM_PARALLEL_CONFLICT', error?.stack);
    assert.equal(error?.details?.leftTaskTemplateId, 'alpha');
    assert.equal(error?.details?.rightTaskTemplateId, 'beta');
    assert.deepEqual(
      error?.details?.conflicts.map((entry) => entry.kind).sort(),
      ['device/device', 'effect/effect', 'read/write', 'write/read', 'write/write']
    );
    assert.ok(error.details.conflicts.some((entry) =>
      entry.kind === 'write/read'
      && entry.left === 'workspace/**'
      && entry.right === 'workspace/file'));
    return true;
  });

  const ordered = staticSafetyProgram([
    staticSafetyTask('alpha', { resources: alphaResources, recovery: { mode: 'manual' } }),
    staticSafetyTask('beta', {
      dependsOn: ['alpha'], resources: betaResources, recovery: { mode: 'manual' }
    }),
    staticSafetyTask('z-end', { opcode: 'END', dependsOn: ['beta'] })
  ], [
    { from: 'alpha', to: 'beta' },
    { from: 'beta', to: 'z-end' }
  ]);
  assert.equal(validateSgosProgramStaticSafety(ordered).safe, true,
    'the same overlapping resources are safe when the dependency graph orders them');
});

test('resource prefix indexing retains an ancestor across lexicographic interlopers', () => {
  const program = staticSafetyProgram([
    staticSafetyTask('alpha', {
      resources: { reads: [], writes: ['a'], devices: [], externalEffects: [] }
    }),
    staticSafetyTask('beta', {
      resources: { reads: [], writes: ['a-b'], devices: [], externalEffects: [] }
    }),
    staticSafetyTask('gamma', {
      resources: { reads: ['a/c'], writes: [], devices: [], externalEffects: [] }
    }),
    staticSafetyTask('z-end', { opcode: 'END', dependsOn: ['alpha', 'beta', 'gamma'] })
  ], [
    { from: 'alpha', to: 'z-end' },
    { from: 'beta', to: 'z-end' },
    { from: 'gamma', to: 'z-end' }
  ]);
  assert.throws(() => validateSgosProgramStaticSafety(program), (error) => {
    assert.equal(error?.code, 'SGOS_PROGRAM_PARALLEL_CONFLICT', error?.stack);
    assert.equal(error?.details?.leftTaskTemplateId, 'alpha');
    assert.equal(error?.details?.rightTaskTemplateId, 'gamma');
    assert.deepEqual(error?.details?.conflicts, [
      { kind: 'write/read', left: 'a', right: 'a/c' }
    ]);
    return true;
  });
});

test('resource conflict index agrees with a brute-force oracle across normalized path fuzz cases', () => {
  const fields = ['reads', 'writes', 'devices', 'externalEffects'];
  const resourcePairs = [
    ['*', 'a'],
    ['a', '*'],
    ['a', 'a/c'],
    ['a/c', 'a'],
    ['a', 'a-b'],
    ['a/c', 'a/d'],
    ['a/**', 'a/c/d'],
    ['a\\c', 'a/c/d'],
    ['double//segment', 'double//segment/child'],
    ['α', 'α/β'],
    ['/root', '/root/child']
  ];
  let iteration = 0;
  for (const leftField of fields) for (const rightField of fields) {
    for (const [leftResource, rightResource] of resourcePairs) {
      iteration += 1;
      const conflictKind = oracleConflictKind(leftField, rightField);
      const shouldConflict = conflictKind != null
        && oracleResourceOverlap(leftResource, rightResource);
      const declarations = (field, resource) => ({
        reads: field === 'reads' ? [resource] : [],
        writes: field === 'writes' ? [resource] : [],
        devices: field === 'devices' ? [resource] : [],
        externalEffects: field === 'externalEffects' ? [resource] : []
      });
      const program = staticSafetyProgram([
        staticSafetyTask('alpha', {
          resources: declarations(leftField, leftResource),
          recovery: leftField === 'externalEffects' ? { mode: 'manual' } : {}
        }),
        staticSafetyTask('beta', {
          resources: declarations(rightField, rightResource),
          recovery: rightField === 'externalEffects' ? { mode: 'manual' } : {}
        }),
        staticSafetyTask('z-end', { opcode: 'END', dependsOn: ['alpha', 'beta'] })
      ], [
        { from: 'alpha', to: 'z-end' },
        { from: 'beta', to: 'z-end' }
      ]);
      const label = `case ${iteration}: ${leftField}:${leftResource} vs ${rightField}:${rightResource}`;
      if (shouldConflict) {
        assert.throws(() => validateSgosProgramStaticSafety(program), (error) => {
          assert.equal(error?.code, 'SGOS_PROGRAM_PARALLEL_CONFLICT', `${label}\n${error?.stack}`);
          assert.equal(error?.details?.conflicts.length, 1, label);
          assert.equal(error?.details?.conflicts[0].kind, conflictKind, label);
          return true;
        }, label);
      } else {
        assert.equal(validateSgosProgramStaticSafety(program).safe, true, label);
      }
    }
  }
});

test('static safety remains bounded at installed graph and resource ceilings', {
  timeout: 15_000
}, () => {
  if (process.env.SINGULARITY_FLOW_STATIC_SAFETY_LIMIT_PROBE !== '1') {
    const probeEnv = { ...process.env, SINGULARITY_FLOW_STATIC_SAFETY_LIMIT_PROBE: '1' };
    delete probeEnv.NODE_TEST_CONTEXT;
    const probe = spawnSync(process.execPath, [
      '--test',
      '--test-name-pattern=^static safety remains bounded',
      fileURLToPath(import.meta.url)
    ], {
      encoding: 'utf8',
      timeout: 10_000,
      env: probeEnv
    });
    assert.notEqual(probe.error?.code, 'ETIMEDOUT',
      'installed-limit static safety must finish within the subprocess deadline');
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
    assert.match(probe.stdout, /SGOS_STATIC_SAFETY_LIMIT_OK/,
      'the bounded subprocess must execute the installed-limit validation');
    return;
  }
  const branch = (prefix, count) => Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index).padStart(4, '0')}`
  );
  const branches = [branch('a-task', 1_000), branch('b-task', 999)];
  const taskIds = [...branches.flat(), 'z-end'];
  const resources = (taskId) => {
    const declarations = Array.from(
      { length: 25 },
      (_, index) => `resource/${taskId}/${String(index).padStart(2, '0')}`
    );
    return {
      reads: declarations.slice(13),
      writes: declarations.slice(0, 13),
      devices: [],
      externalEffects: []
    };
  };
  const predecessor = new Map();
  const edges = [];
  for (const ids of branches) {
    for (let index = 1; index < ids.length; index += 1) {
      predecessor.set(ids[index], ids[index - 1]);
      edges.push({ from: ids[index - 1], to: ids[index] });
    }
    edges.push({ from: ids.at(-1), to: 'z-end' });
  }
  const tasks = taskIds.map((taskId) => staticSafetyTask(taskId, {
    opcode: taskId === 'z-end' ? 'END' : 'NOOP',
    dependsOn: taskId === 'z-end'
      ? branches.map((ids) => ids.at(-1))
      : predecessor.has(taskId) ? [predecessor.get(taskId)] : [],
    resources: resources(taskId)
  }));
  const program = staticSafetyProgram(tasks, edges);
  assert.equal(program.taskTemplates.length, 2_000);
  assert.equal(program.taskTemplates.reduce((total, task) => total
    + Object.values(task.resources).reduce((count, values) => count + values.length, 0), 0), 50_000);

  const started = performance.now();
  const safety = validateSgosProgramStaticSafety(program);
  const elapsed = performance.now() - started;
  assert.equal(safety.graph.taskCount, 2_000);
  assert.equal(safety.graph.edgeCount, 1_999);
  assert.ok(elapsed < 10_000,
    `installed-limit static safety took ${elapsed.toFixed(1)}ms (expected < 10000ms)`);
  console.log(`SGOS_STATIC_SAFETY_LIMIT_OK ${elapsed.toFixed(1)}ms`);
});

test('execution admission rechecks evidence, authority, recovery, and budgets', async (t) => {
  const { program } = compilerFixture();
  await t.test('evidence', () => {
    const forged = reseal(program, (seed) => {
      seed.taskTemplates.find((task) => task.taskTemplateId === 'run').evidence = {};
    });
    expectCode(() => validateSgosProgramStaticSafety(forged), 'SGOS_PROGRAM_EVIDENCE_REQUIRED');
  });
  await t.test('empty evidence declaration', () => {
    const forged = reseal(program, (seed) => {
      seed.taskTemplates.find((task) => task.taskTemplateId === 'run').evidence = { required: [] };
    });
    expectCode(() => validateSgosProgramStaticSafety(forged), 'SGOS_PROGRAM_EVIDENCE_REQUIRED');
  });
  await t.test('human authority', () => {
    const forged = reseal(program, (seed) => {
      const task = seed.taskTemplates.find((entry) => entry.taskTemplateId === 'run');
      task.opcode = 'HUMAN_REQUEST';
      task.authority = {};
    });
    expectCode(() => validateSgosProgramStaticSafety(forged), 'SGOS_PROGRAM_AUTHORITY_REQUIRED');
  });
  await t.test('external-effect recovery', () => {
    const forged = reseal(program, (seed) => {
      const task = seed.taskTemplates.find((entry) => entry.taskTemplateId === 'run');
      task.resources.externalEffects = ['service:production'];
      task.recovery = {};
    });
    expectCode(() => validateSgosProgramStaticSafety(forged), 'SGOS_PROGRAM_RECOVERY_REQUIRED');
  });
  await t.test('retry ceiling', () => {
    const forged = reseal(program, (seed) => {
      seed.budgets.maximumAttempts = 2;
      seed.taskTemplates.find((task) => task.taskTemplateId === 'run').retry.maximumAttempts = 2;
    });
    expectCode(() => validateSgosProgramStaticSafety(forged), 'SGOS_PROGRAM_SEMANTICS_UNSUPPORTED');
  });
});

test('execution admission rejects opcodes whose semantics are not installed', () => {
  const { program } = compilerFixture();
  const forged = reseal(program, (seed) => {
    seed.taskTemplates.find((task) => task.taskTemplateId === 'run').opcode = 'AGENT';
  });
  expectCode(() => validateSgosProgramStaticSafety(forged), 'SGOS_PROGRAM_SEMANTICS_UNSUPPORTED');
});

test('installed admission ceilings reject an attempt envelope that cannot fit immutable storage', () => {
  const taskTemplates = Array.from({ length: 501 }, (_, index) => ({
    taskTemplateId: `task-${String(index).padStart(3, '0')}`,
    retry: { maximumAttempts: 10 },
    resources: { reads: [], writes: [], devices: [], externalEffects: [] }
  }));
  expectCode(() => assertSgosInstalledProgramLimits({
    taskTemplates,
    edges: [],
    budgets: { maximumTasks: taskTemplates.length, maximumAttempts: 10 }
  }), 'SGOS_PROGRAM_BUDGET_EXCEEDED');
});

test('installed admission reserves worst-case control transitions before execution', () => {
  const taskTemplates = Array.from({ length: 400 }, (_, index) => ({
    taskTemplateId: `task-${String(index).padStart(3, '0')}`,
    retry: { maximumAttempts: 10 },
    resources: { reads: [], writes: [], devices: [], externalEffects: [] }
  }));
  assert.throws(() => assertSgosInstalledProgramLimits({
    taskTemplates,
    edges: [],
    budgets: { maximumTasks: taskTemplates.length, maximumAttempts: 10 }
  }), (error) => error.code === 'SGOS_PROGRAM_BUDGET_EXCEEDED'
    && error.details?.possibleControlRecords === 12_066
    && error.details?.maximumControlRecords === 10_000);
});

test('supported SGOS barrel exposes safe stepping and no raw adapter or storage writers', async () => {
  const publicSgos = await import('../src/sgos/index.mjs');
  assert.equal(typeof publicSgos.stepSgosProcess, 'function');
  for (const unsafe of [
    'runNextSgosTask', 'createSgosBuiltinAdapters', 'putSgosCandidateSnapshot',
    'putSgosImmutableRecord', 'mutateSgosProcess', 'createSgosProcess'
  ]) {
    assert.equal(Object.hasOwn(publicSgos, unsafe), false, unsafe);
  }
});

test('registry verification binds operation ID, version, and exact manifest hash', async (t) => {
  const { program, registry } = compilerFixture();
  assert.equal(verifySgosProgramRegistry(program, registry).verified, true);

  await t.test('snapshot bytes', () => {
    const changed = registrySnapshot({
      operations: registry.operations.map((entry) => entry.id === 'core.run'
        ? { ...entry, manifestSha256: `sha256:${'9'.repeat(64)}` }
        : entry)
    });
    expectCode(() => verifySgosProgramRegistry(program, changed), 'SGOS_PROGRAM_REGISTRY_MISMATCH');
  });

  await t.test('manifest binding', () => {
    const changed = registrySnapshot({
      operations: registry.operations.map((entry) => entry.id === 'core.run'
        ? { ...entry, manifestSha256: `sha256:${'9'.repeat(64)}` }
        : entry)
    });
    const forged = reseal(program, (seed) => {
      seed.registrySnapshotSha256 = changed.registrySnapshotSha256;
      // Deliberately retain the old operation manifest in task metadata.
    });
    expectCode(() => verifySgosProgramRegistry(forged, changed), 'SGOS_PROGRAM_OPERATION_MANIFEST_MISMATCH');
  });
});

test('compiler refuses an operation version that differs from the pinned registry', () => {
  const registry = registrySnapshot({
    operations: [
      { id: 'core.run', version: '2', status: 'active', manifestSha256: MANIFEST_RUN },
      { id: 'core.verify', version: '1', status: 'active', manifestSha256: MANIFEST_VERIFY }
    ]
  });
  expectCode(() => compilerFixture({ registry }), 'SGOS_TASK_OPERATION_VERSION_MISMATCH');
});

test('compiler supports an explicitly selected active operation version', () => {
  const registry = registrySnapshot({
    operations: [
      { id: 'core.run', version: '2', status: 'active', manifestSha256: MANIFEST_RUN },
      { id: 'core.verify', version: '1', status: 'active', manifestSha256: MANIFEST_VERIFY }
    ]
  });
  const { program } = compilerFixture({ registry, operationVersion: '2' });
  const run = program.taskTemplates.find((task) => task.taskTemplateId === 'run');
  assert.equal(run.metadata.operationVersion, '2');
  assert.equal(run.metadata.operationManifestSha256, MANIFEST_RUN);
});
