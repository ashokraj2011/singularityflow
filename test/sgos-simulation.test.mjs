import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createGvmProgram, sha256
} from '../src/sgos/contracts.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { simulateSgosProgram } from '../src/sgos/compiler.mjs';
import {
  planSgosProgramFault,
  SGOS_FAULT_FAILURES,
  SGOS_SIMULATION_ASSURANCE,
  simulateSgosProgramAssurance,
  whatIfSgosProgram
} from '../src/sgos/simulation.mjs';

function hash(label) {
  return sha256(`simulation:${label}`);
}

function task(taskTemplateId, {
  opcode = 'KERNEL',
  operation = 'core.copy',
  dependsOn = [],
  reads = [],
  writes = [],
  devices = [],
  externalEffects = [],
  metadata = {},
  recovery = {},
  authority = {},
  maximumAttempts = 1,
  material = true
} = {}) {
  return {
    taskTemplateId,
    opcode,
    operation,
    dependsOn,
    resources: { reads, writes, devices, externalEffects },
    evidence: material ? { required: ['verification-result'] } : {},
    authority,
    recovery,
    intentClauseIds: material ? ['INTENT-CLAUSE'] : [],
    inputs: [],
    outputs: [],
    retry: { maximumAttempts },
    policySnapshotSha256: hash('policy'),
    material,
    metadata
  };
}

function program() {
  const tasks = [
    task('prepare', {
      reads: ['input:request'], writes: ['artifact:prepared']
    }),
    task('agent-analysis', {
      opcode: 'AGENT', operation: 'agent.analyze', dependsOn: ['prepare'],
      reads: ['artifact:prepared'], writes: ['artifact:analysis'],
      metadata: {
        executionUnitId: 'copilot-proposal',
        executionUnitManifestSha256: hash('execution-unit')
      }
    }),
    task('warehouse-write', {
      opcode: 'DEVICE', operation: 'warehouse.write', dependsOn: ['prepare'],
      reads: ['artifact:prepared'], writes: ['warehouse:fact'],
      devices: ['snowflake'],
      externalEffects: ['network:warehouse', 'external:audit-event'],
      metadata: {
        deviceId: 'snowflake', deviceManifestSha256: hash('device')
      },
      recovery: { interruptedExecution: 'reconcile-before-retry' },
      maximumAttempts: 2
    }),
    task('approve', {
      opcode: 'HUMAN_REQUEST', operation: null,
      dependsOn: ['agent-analysis', 'warehouse-write'],
      authority: { group: 'reviewers' }
    }),
    task('end', {
      opcode: 'END', operation: null, dependsOn: ['approve'], material: false
    })
  ];
  return createGvmProgram({
    intentIrSha256: hash('intent'),
    workflowSha256: hash('workflow'),
    ratificationSha256: hash('ratification'),
    policySnapshotSha256: hash('policy'),
    registrySnapshotSha256: hash('registry'),
    storageProfileSha256: hash('storage'),
    taskTemplates: tasks,
    edges: tasks.flatMap((entry) => entry.dependsOn.map((from) => ({
      from, to: entry.taskTemplateId
    }))),
    joins: [],
    budgets: { maximumTasks: tasks.length, maximumAttempts: 2 },
    recoveryPolicy: {},
    terminalConditions: [{ taskTemplateId: 'end', state: 'succeeded' }],
    compiler: { id: 'test-compiler', version: '1', sourceSha256: hash('compiler') }
  });
}

function expectCode(action, code) {
  assert.throws(action, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function assuranceValues(value, found = []) {
  if (Array.isArray(value)) value.forEach((entry) => assuranceValues(entry, found));
  else if (value && typeof value === 'object') {
    if (typeof value.assurance === 'string') found.push(value.assurance);
    Object.values(value).forEach((entry) => assuranceValues(entry, found));
  }
  return found;
}

function assertReportHash(report) {
  const core = structuredClone(report);
  core.reportSha256 = null;
  assert.equal(report.reportSha256, sha256(core));
}

function resealProgram(baseline, changes) {
  const seed = structuredClone(baseline);
  delete seed.schemaVersion;
  delete seed.kind;
  delete seed.programId;
  delete seed.programSha256;
  return createGvmProgram({ ...seed, ...changes });
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function command(cwd, executable, args) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' }
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('assurance simulation is deterministic, bounded, pure, and retains the legacy schedule view', () => {
  const input = program();
  const before = structuredClone(input);
  const first = simulateSgosProgramAssurance(input);
  const second = simulateSgosProgramAssurance({ program: input, capabilityPackAuthorities: [] });
  const compatibility = simulateSgosProgram(input);

  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
  assert.deepEqual(first.waves, [
    ['prepare'], ['agent-analysis', 'warehouse-write'], ['approve'], ['end']
  ]);
  assert.deepEqual(compatibility, first);
  assert.deepEqual(first.claims.schedule.criticalPath.taskTemplateIds,
    ['prepare', 'agent-analysis', 'approve', 'end']);
  assert.deepEqual(first.claims.schedule.parallelGroups, [{
    wave: 2,
    taskTemplateIds: ['agent-analysis', 'warehouse-write'],
    basis: 'dependency-ready-and-resource-nonconflicting',
    assurance: 'deterministically-proven'
  }]);
  assert.deepEqual(first.claims.humanStops.items.map((entry) => entry.taskTemplateId), ['approve']);
  assert.deepEqual(first.claims.effects.devices.items.map((entry) => entry.deviceId), ['snowflake']);
  assert.deepEqual(first.claims.effects.network.items.map((entry) => entry.effect), ['network:warehouse']);
  assert.deepEqual(first.claims.storage.writeResources,
    ['artifact:analysis', 'artifact:prepared', 'warehouse:fact']);
  assert.equal(first.claims.estimates.cost.value, null);
  assert.equal(first.claims.estimates.cost.assurance, 'unknown');
  assert.equal(first.consequentialEffectsPerformed, false);
  assert.equal(first.readOnly, true);
  assert.equal(Object.isFrozen(first), true);
  assertReportHash(first);

  const classifications = assuranceValues(first);
  assert.ok(classifications.length > 20);
  assert.ok(classifications.every((entry) => SGOS_SIMULATION_ASSURANCE.includes(entry)));
  assert.equal(classifications.includes('historically-estimated'), false);
  assert.equal(classifications.includes('model-advised'), false);
  assert.equal(first.assuranceSummary.counts['historically-estimated'], 0);
  assert.equal(first.assuranceSummary.counts['model-advised'], 0);
});

test('what-if removes exact device IDs and proves only structural blast radius', () => {
  const input = program();
  const report = whatIfSgosProgram(input, { withoutDeviceIds: ['snowflake'] });

  assert.deepEqual(report.impact.directTaskIds, ['warehouse-write']);
  assert.deepEqual(report.impact.blockedTaskIds, ['approve', 'end', 'warehouse-write']);
  assert.deepEqual(report.impact.unaffectedTaskIds, ['agent-analysis', 'prepare']);
  assert.deepEqual(report.impact.blockedTerminalTaskIds, ['end']);
  assert.equal(report.impact.allTerminalPathsBlocked, true);
  assert.equal(report.estimates.costDelta.assurance, 'unknown');
  assert.equal(report.consequentialEffectsPerformed, false);
  assertReportHash(report);

  expectCode(() => whatIfSgosProgram(input, { withoutDeviceIds: ['missing'] }),
    'SGOS_SIMULATION_DEVICE_NOT_FOUND');
  expectCode(() => whatIfSgosProgram(input, { withoutDeviceIds: ['Snowflake'] }),
    'SGOS_SIMULATION_INPUT_INVALID');
  expectCode(() => whatIfSgosProgram(input, {
    withoutDeviceIds: ['snowflake'], execute: () => {}
  }), 'SGOS_SIMULATION_INPUT_INVALID');
});

test('fault planning accepts only a closed exact target and never injects or executes', () => {
  const input = program();
  const taskPlan = planSgosProgramFault(input, {
    target: { kind: 'task', id: 'agent-analysis' },
    failure: 'verification-failed'
  });
  assert.deepEqual(taskPlan.impact.directTaskIds, ['agent-analysis']);
  assert.deepEqual(taskPlan.impact.affectedTaskIds, ['agent-analysis', 'approve', 'end']);
  assert.equal(taskPlan.faultInjected, false);
  assert.equal(taskPlan.executionPerformed, false);
  assert.equal(taskPlan.recovery.items[0].recoveryOutcome.assurance, 'unknown');
  assertReportHash(taskPlan);

  const devicePlan = planSgosProgramFault(input, {
    target: { kind: 'device', id: 'snowflake' }, failure: 'timeout'
  });
  assert.deepEqual(devicePlan.impact.directTaskIds, ['warehouse-write']);
  assert.equal(Object.isFrozen(devicePlan), true);

  assert.deepEqual(SGOS_FAULT_FAILURES, [
    'interrupted', 'malformed-result', 'permission-denied', 'timeout', 'unavailable',
    'verification-failed'
  ]);
  expectCode(() => planSgosProgramFault(input, {
    target: { kind: 'device', id: 'snowflake' }, failure: 'run-arbitrary-code'
  }), 'SGOS_SIMULATION_FAILURE_INVALID');
  expectCode(() => planSgosProgramFault(input, {
    target: { kind: 'task', id: 'not-present' }, failure: 'timeout'
  }), 'SGOS_SIMULATION_TASK_NOT_FOUND');
  expectCode(() => planSgosProgramFault(input, {
    target: { kind: 'device', id: 'snowflake', adapter: {} }, failure: 'timeout'
  }), 'SGOS_SIMULATION_INPUT_INVALID');
});

test('CLI exposes read-only what-if and fault planning without an execution command', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-simulation-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  command(root, 'git', ['init', '-b', 'main']);
  command(root, 'git', ['config', 'user.name', 'Simulation Tester']);
  command(root, 'git', ['config', 'user.email', 'simulation@example.test']);
  await initializeDefinition(root);
  const workItem = path.join(root, 'singularity', 'work-items', 'SIMULATION');
  await mkdir(workItem, { recursive: true });
  await writeFile(path.join(workItem, 'workflow.json'), `${JSON.stringify({
    schemaVersion: 2,
    workItem: { id: 'SIMULATION' },
    currentPhase: 'implementation'
  })}\n`);
  const programFile = path.join(root, 'program.json');
  await writeFile(programFile, `${JSON.stringify(program(), null, 2)}\n`);
  command(root, 'git', ['add', '.']);
  command(root, 'git', ['commit', '-m', 'Simulation fixture']);

  const whatIf = JSON.parse(command(root, process.execPath, [
    cli, 'program', 'what-if', path.basename(programFile), '--without-device', 'snowflake', '--json'
  ]));
  assert.equal(whatIf.operation.id, 'program.what-if');
  assert.deepEqual(whatIf.data.result.impact.directTaskIds, ['warehouse-write']);
  assert.equal(whatIf.effects.stateChanged, false);

  const fault = JSON.parse(command(root, process.execPath, [
    cli, 'program', 'fault-plan', path.basename(programFile), '--target', 'device:snowflake',
    '--failure', 'timeout', '--json'
  ]));
  assert.equal(fault.operation.id, 'program.fault-plan');
  assert.equal(fault.data.result.faultInjected, false);
  assert.equal(fault.effects.stateChanged, false);
});

test('malformed and adversarial Program graphs fail closed before producing a report', () => {
  const baseline = program();
  const mismatched = resealProgram(baseline, {
    edges: baseline.edges.filter((edge) => edge.to !== 'approve')
  });
  expectCode(() => simulateSgosProgramAssurance(mismatched), 'SGOS_SIMULATION_GRAPH_INVALID');

  const tasks = baseline.taskTemplates.map((entry) => {
    if (entry.taskTemplateId === 'prepare') return { ...entry, dependsOn: ['end'] };
    if (entry.taskTemplateId === 'end') return { ...entry, dependsOn: ['approve'] };
    return entry;
  });
  const cyclic = resealProgram(baseline, {
    taskTemplates: tasks,
    edges: [
      ...baseline.edges,
      { from: 'end', to: 'prepare' }
    ]
  });
  expectCode(() => simulateSgosProgramAssurance(cyclic), 'SGOS_SIMULATION_GRAPH_CYCLE');

  const conflictingTasks = baseline.taskTemplates.map((entry) =>
    ['agent-analysis', 'warehouse-write'].includes(entry.taskTemplateId)
      ? { ...entry, resources: { ...entry.resources, writes: ['shared:resource'] } }
      : entry);
  const unsafeParallel = resealProgram(baseline, { taskTemplates: conflictingTasks });
  expectCode(() => simulateSgosProgramAssurance(unsafeParallel),
    'SGOS_SIMULATION_PARALLEL_UNSAFE');

  const conditionalEdge = resealProgram(baseline, {
    edges: baseline.edges.map((edge, index) => index === 0
      ? { ...edge, condition: { expression: 'arbitrary' } } : edge)
  });
  expectCode(() => simulateSgosProgramAssurance(conditionalEdge),
    'SGOS_SIMULATION_GRAPH_INVALID');
});
