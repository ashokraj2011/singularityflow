import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createGvmProgram, createIntentIr, createPolicySnapshot, createWorkflowIr,
  createWorkflowRatification
} from '../src/sgos/contracts.mjs';
import { registrySnapshotDigest } from '../src/sgos/compiler.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const h = (digit) => `sha256:${digit.repeat(64)}`;

function execute(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'SGOS CLI Tester' }
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function git(root, ...args) { return execute('git', args, root); }
function flow(root, ...args) { return execute(process.execPath, [bin, ...args], root); }
function flowResult(root, ...args) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'SGOS CLI Tester' }
  });
}

function narrated(root, ...args) {
  const envelope = JSON.parse(flow(root, ...args, '--json'));
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.resultType, 'command-result');
  assert.match(envelope.operation.id, /^(?:intent|program|process|task|request)\./);
  return envelope;
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-cli-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'SGOS CLI Tester');
  git(root, 'config', 'user.email', 'sgos-cli@example.test');
  const storyRoot = path.join(root, 'singularity', 'work-items', 'SGOS-CLI');
  await mkdir(storyRoot, { recursive: true });
  await writeFile(path.join(storyRoot, 'workflow.json'), `${JSON.stringify({
    schemaVersion: 2, workItem: { id: 'SGOS-CLI', branch: 'main' }, currentPhase: 'implementation'
  }, null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture authority');
  return root;
}

function task(taskTemplateId, opcode, dependsOn = []) {
  return {
    taskTemplateId,
    opcode,
    dependsOn,
    resources: { reads: [], writes: [], devices: [], externalEffects: [] },
    evidence: {}, authority: {}, recovery: {}, intentClauseIds: [], inputs: [], outputs: [],
    retry: { maximumAttempts: 1 }, policySnapshotSha256: h('4'), material: false,
    metadata: { sourceConstruct: opcode.toLowerCase() }
  };
}

function humanTask(taskTemplateId = 'approve') {
  return {
    ...task(taskTemplateId, 'HUMAN_REQUEST'),
    operation: 'human.approval',
    authority: { kind: 'role', id: 'reviewer' },
    metadata: {
      sourceConstruct: 'human-request',
      humanRequest: {
        requestType: 'approval',
        requestedBy: { id: 'sgos-runtime', kind: 'system' },
        authorityRequired: { kind: 'role', id: 'reviewer' },
        prompt: { title: 'Approve governed execution', detail: 'Review this exact request.' },
        options: [{ id: 'approved', label: 'Approve' }],
        inputSchema: null,
        sensitiveMode: 'none',
        externalUrl: null,
        secretBroker: null,
        expiresAt: null
      }
    }
  };
}

function compileInputs() {
  const policy = createPolicySnapshot({
    authorityRevision: 'refs/heads/sflow/config@0123456789abcdef',
    lawSha256: h('a'),
    registrySha256: h('b'),
    executionUnitPolicySha256: h('c'),
    devicePolicySha256: h('d'),
    storagePolicySha256: h('e'),
    memoryPolicySha256: h('f'),
    humanAuthoritySha256: h('1'),
    governedRootsSha256: h('2'),
    verificationPolicySha256: h('3'),
    publicationPolicySha256: h('4')
  });
  const registryCore = {
    kind: 'registry-snapshot',
    operations: ['core.copy', 'core.verify'].map((id) => ({
      id, version: '1', status: 'active', manifestSha256: h('8')
    })),
    taskKinds: [],
    devices: []
  };
  const registry = { ...registryCore, registrySnapshotSha256: registrySnapshotDigest(registryCore) };
  const intent = createIntentIr({
    generation: 1,
    objective: { statement: 'Copy a governed value.', provenance: 'human-confirmed' },
    outcomes: [], successCriteria: [], constraints: [], invariants: [], preferences: [],
    nonGoals: [], assumptions: [], unknowns: [], contradictions: [], risks: [],
    subjects: [], evidenceExpectations: [], authorityRequirements: [], budgets: [],
    domainCandidates: [], workTypeCandidates: []
  });
  const objective = `${intent.intentId}:objective`;
  const coverage = {
    clauses: { [objective]: [{ kind: 'task', targetId: 'copy' }] },
    tasks: { copy: [{ kind: 'intent-clause', sourceId: objective }] }
  };
  const workflow = createWorkflowIr({
    apiVersion: 'sflow/v1',
    version: '1',
    intentIrSha256: intent.intentIrSha256,
    policySnapshotSha256: policy.snapshotSha256,
    metadata: { id: 'copy-governed-value', version: '1', domainPack: 'core@1' },
    spec: {
      inputs: {},
      tasks: {
        copy: {
          kind: 'task', opcode: 'KERNEL', operation: 'core.copy', dependsOn: [],
          resources: { reads: [], writes: [], devices: [], externalEffects: [] },
          evidence: { required: ['candidate', 'verification-result'] }, authority: {}, recovery: {},
          intentClauseIds: [objective], inputs: [], outputs: [], retry: { maximumAttempts: 1 },
          policySnapshotSha256: policy.snapshotSha256, material: true,
          metadata: { operationVersion: '1', verification: { kind: 'kernel', operation: 'core.verify' } }
        },
        end: { kind: 'end', opcode: 'END', dependsOn: ['copy'], material: false }
      },
      joins: {}, terminalConditions: [{ taskTemplateId: 'end', state: 'succeeded' }],
      budgets: { maximumTasks: 2, maximumAttempts: 1 }, recovery: {}, evidence: {}, authority: {},
      storageRequirements: { profileSha256: h('6') }, intentWorkflowMap: coverage
    }
  });
  const ratification = createWorkflowRatification({
    intentIrSha256: intent.intentIrSha256,
    workflowSha256: workflow.workflowSha256,
    policySnapshotSha256: policy.snapshotSha256,
    registrySnapshotSha256: registry.registrySnapshotSha256,
    storageProfileSha256: h('6'),
    packetSha256: h('7'),
    decision: 'ratified',
    principal: { id: 'sgos-cli@example.test', kind: 'human' },
    coverage,
    decidedAt: '2026-08-29T10:00:00.000Z'
  });
  return { intent, workflow, ratification, policy, registry };
}

test('SGOS CLI compiles no authority from chat and runs a finite model-free Program beside Story state', async () => {
  const root = await repository();
  const program = createGvmProgram({
    intentIrSha256: h('1'), workflowSha256: h('2'), ratificationSha256: h('3'),
    policySnapshotSha256: h('4'), registrySnapshotSha256: h('5'), storageProfileSha256: h('6'),
    taskTemplates: [task('observe', 'NOOP'), task('finish', 'END', ['observe'])],
    edges: [{ from: 'observe', to: 'finish' }], joins: [], budgets: { maximumTasks: 2 },
    recoveryPolicy: { mode: 'fail-closed' }, terminalConditions: [{ taskTemplateId: 'finish' }],
    compiler: { id: 'sgos-cli-fixture', version: '1' }
  });
  await writeFile(path.join(root, 'program.json'), `${JSON.stringify(program, null, 2)}\n`);
  const storyFile = path.join(root, 'singularity', 'work-items', 'SGOS-CLI', 'workflow.json');
  const storyBefore = await readFile(storyFile, 'utf8');
  const headBefore = git(root, 'rev-parse', 'HEAD');

  const capturedEnvelope = narrated(root, 'intent', 'capture', 'Produce', 'a', 'verified', 'result');
  const captured = capturedEnvelope.data.result;
  assert.equal(captured.kind, 'intent-envelope');
  assert.match(captured.envelopeSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(capturedEnvelope.effects.filesChanged, false);

  const validation = narrated(root, 'program', 'validate', 'program.json').data.result;
  const simulation = narrated(root, 'program', 'simulate', 'program.json').data.result;
  assert.equal(validation.valid, true);
  assert.deepEqual(simulation.waves, [['observe'], ['finish']]);

  const started = narrated(root, 'process', 'start', 'program.json', '--subject', 'SGOS-CLI', '--subject-kind', 'story').data.result;
  assert.equal(started.process.status, 'running');
  assert.equal(started.binding.subjectId, 'SGOS-CLI');
  const processId = started.process.processId;

  const first = narrated(root, 'process', 'step', processId).data.result;
  const second = narrated(root, 'process', 'step', processId).data.result;
  const status = narrated(root, 'process', 'status', processId).data.result;
  const tasks = narrated(root, 'task', 'list', processId).data.result;

  assert.equal(first.status, 'succeeded', JSON.stringify(first));
  assert.equal(second.status, 'succeeded', JSON.stringify(second));
  assert.equal(status.process.status, 'succeeded');
  assert.equal(tasks.tasks.every((entry) => entry.state === 'succeeded' && entry.receiptSha256), true);
  assert.equal(await readFile(storyFile, 'utf8'), storyBefore, 'SGOS operational execution must not rewrite Story authority');
  assert.equal(git(root, 'rev-parse', 'HEAD'), headBefore, 'SGOS operational execution must not create a Git authority commit');
});

test('SGOS CLI refuses final and intermediate symlink escapes for reads and writes', async () => {
  const root = await repository();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-sgos-outside-'));
  const externalProgram = path.join(outside, 'program.json');
  await writeFile(externalProgram, '{}\n');
  await symlink(externalProgram, path.join(root, 'linked-program.json'));
  await symlink(outside, path.join(root, 'linked-directory'));

  for (const input of ['linked-program.json', 'linked-directory/program.json']) {
    const result = flowResult(root, 'program', 'validate', input, '--json');
    assert.notEqual(result.status, 0, input);
    assert.match(result.stderr, /symbolic link|resolves outside the repository/i);
  }

  const externalOutput = path.join(outside, 'captured.json');
  await writeFile(externalOutput, 'outside-bytes\n');
  await symlink(externalOutput, path.join(root, 'linked-output.json'));
  const write = flowResult(root, 'intent', 'capture', 'Do not escape', '--out', 'linked-output.json', '--json');
  assert.notEqual(write.status, 0);
  assert.match(write.stderr, /symbolic link|resolves outside the repository/i);
  assert.equal(await readFile(externalOutput, 'utf8'), 'outside-bytes\n');
});

test('SGOS read operations cannot hide a repository write behind --out', async () => {
  const root = await repository();
  const program = createGvmProgram({
    intentIrSha256: h('1'), workflowSha256: h('2'), ratificationSha256: h('3'),
    policySnapshotSha256: h('4'), registrySnapshotSha256: h('5'), storageProfileSha256: h('6'),
    taskTemplates: [task('finish', 'END')], edges: [], joins: [], budgets: { maximumTasks: 1 },
    recoveryPolicy: {}, terminalConditions: [{ taskTemplateId: 'finish' }],
    compiler: { id: 'sgos-cli-fixture', version: '1' }
  });
  await writeFile(path.join(root, 'program.json'), `${JSON.stringify(program)}\n`);
  const result = flowResult(root, 'program', 'validate', 'program.json', '--out', 'validation.json', '--json');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--out is not supported/);
  await assert.rejects(() => readFile(path.join(root, 'validation.json'), 'utf8'), { code: 'ENOENT' });
});

test('SGOS CLI refuses an authority supplied by the responder', async () => {
  const root = await repository();
  const program = createGvmProgram({
    intentIrSha256: h('1'), workflowSha256: h('2'), ratificationSha256: h('3'),
    policySnapshotSha256: h('4'), registrySnapshotSha256: h('5'), storageProfileSha256: h('6'),
    taskTemplates: [humanTask()], edges: [], joins: [], budgets: { maximumTasks: 1 },
    recoveryPolicy: {}, terminalConditions: [{ taskTemplateId: 'approve' }],
    compiler: { id: 'sgos-cli-fixture', version: '1' }
  });
  await writeFile(path.join(root, 'program.json'), `${JSON.stringify(program)}\n`);
  const started = narrated(root, 'process', 'start', 'program.json').data.result;
  const waiting = narrated(root, 'process', 'step', started.process.processId).data.result;
  assert.equal(waiting.status, 'waiting-human');

  const response = flowResult(root, 'request', 'respond', waiting.request.requestId,
    '--process', started.process.processId,
    '--option', 'approved',
    '--confirm', waiting.request.requestSha256,
    '--authority', 'reviewer',
    '--json');
  assert.notEqual(response.status, 0);
  assert.match(response.stderr, /--authority cannot grant response authority/);

  const status = narrated(root, 'process', 'status', started.process.processId).data.result;
  assert.equal(status.process.status, 'waiting-human');
  assert.deepEqual(status.process.openHumanRequests, [waiting.request.requestSha256]);
});

test('SGOS intent compile requires and consumes the exact pinned registry snapshot', async () => {
  const root = await repository();
  const fixture = compileInputs();
  for (const [name, value] of Object.entries(fixture)) {
    await writeFile(path.join(root, `${name}.json`), `${JSON.stringify(value)}\n`);
  }

  const missing = flowResult(root, 'intent', 'compile', 'intent.json',
    '--workflow', 'workflow.json', '--ratification', 'ratification.json',
    '--policy', 'policy.json', '--json');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--registry is required/);

  const compiled = narrated(root, 'intent', 'compile', 'intent.json',
    '--workflow', 'workflow.json', '--ratification', 'ratification.json',
    '--policy', 'policy.json', '--registry', 'registry.json',
    '--out', 'program.json');
  assert.equal(compiled.data.result.kind, 'gvm-program');
  assert.equal(compiled.data.result.registrySnapshotSha256, fixture.registry.registrySnapshotSha256);
  assert.equal(compiled.data.output, 'program.json');
  assert.equal(compiled.effects.filesChanged, true);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'program.json'), 'utf8')), compiled.data.result);
});
