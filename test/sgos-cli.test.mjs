import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';
import { HELP } from '../src/help-text.mjs';
import { recordSha256 } from '../src/records.mjs';
import {
  createGvmProgram, createIntentIr, createPolicySnapshot, createWorkflowIr,
  createWorkflowRatification
} from '../src/sgos/contracts.mjs';
import { compileSgosProgram, registrySnapshotDigest } from '../src/sgos/compiler.mjs';
import { SGOS_BUILTIN_OPERATION_MANIFESTS } from '../src/sgos/builtin-adapters.mjs';
import { SGOS_INSTALLED_LIMITS } from '../src/sgos/limits.mjs';
import {
  createSgosProgramAuthorityRecord, sgosProgramAuthorityPath
} from '../src/sgos/program-trust.mjs';
import { sgosProcessDirectory } from '../src/sgos/store.mjs';

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

function humanCas(waiting) {
  return [
    '--expected-revision', String(waiting.process.processRevision),
    '--expected-process-sha256', waiting.process.processSha256
  ];
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
    schemaVersion: 2,
    workItem: { id: 'SGOS-CLI', branch: 'main' },
    status: 'in_progress',
    currentPhase: 'implementation',
    phaseOrder: ['implementation'],
    phases: { implementation: { id: 'implementation', status: 'in_progress', approvals: [] } }
  }, null, 2)}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture authority');
  return root;
}

async function configureApprovedAuthority(root, { authorityId = 'reviewer', includeReviewer = false } = {}) {
  await initializeDefinition(root);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.approvalAuthorities[authorityId] = {
    label: 'SGOS reviewers',
    allowAnyGitIdentity: false,
    members: includeReviewer
      ? [{ name: 'SGOS CLI Tester', email: 'sgos.cli.tester@example.com' }]
      : []
  };
  await writeFile(workflowPath, YAML.stringify(workflow));
  git(root, 'add', '.');
  git(root, 'commit', '-m', includeReviewer ? 'configure SGOS reviewer' : 'configure SGOS authority');
  git(root, 'branch', '-f', 'sflow/config', 'HEAD');
}

async function configureReviewer(root, authorityId = 'reviewer') {
  return configureApprovedAuthority(root, { authorityId, includeReviewer: true });
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

function providedTask({ sensitive = false } = {}) {
  const inputSchema = sensitive ? {
    type: 'object',
    required: ['kind', 'broker', 'handle', 'referenceSha256'],
    additionalProperties: false,
    properties: {
      kind: { const: 'secret-broker' },
      broker: { const: 'vault:test' },
      handle: { type: 'string', minLength: 1 },
      referenceSha256: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }
    }
  } : {
    type: 'object',
    required: ['answer'],
    additionalProperties: false,
    properties: { answer: { type: 'string', minLength: 3 } }
  };
  return {
    ...task(sensitive ? 'credential' : 'clarify', 'HUMAN_REQUEST'),
    operation: sensitive ? 'human.credential' : 'human.clarification',
    authority: { kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local' },
    metadata: {
      sourceConstruct: 'human-request',
      humanRequest: {
        requestType: sensitive ? 'credential' : 'clarification',
        requestedBy: { id: 'sgos-runtime', kind: 'system' },
        authorityRequired: { kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local' },
        prompt: { title: sensitive ? 'Provide credential handle' : 'Clarify intent', detail: 'Provide typed input.' },
        options: [], inputSchema,
        sensitiveMode: sensitive ? 'secret-broker' : 'none',
        externalUrl: null, secretBroker: sensitive ? 'vault:test' : null, expiresAt: null
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
  const operationIds = ['sflow.story.inspect', 'sflow.story.inspect.verify'];
  const registryCore = {
    kind: 'registry-snapshot',
    operations: operationIds.map((id) => ({
      id,
      version: SGOS_BUILTIN_OPERATION_MANIFESTS[id].version,
      status: 'active',
      manifestSha256: SGOS_BUILTIN_OPERATION_MANIFESTS[id].manifestSha256
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
          kind: 'task', opcode: 'KERNEL', operation: 'sflow.story.inspect', dependsOn: [],
          resources: { reads: [], writes: [], devices: [], externalEffects: [] },
          evidence: { required: ['candidate', 'verification-result'] }, authority: {}, recovery: {},
          intentClauseIds: [objective], inputs: [], outputs: [], retry: { maximumAttempts: 1 },
          policySnapshotSha256: policy.snapshotSha256, material: true,
          metadata: {
            operationVersion: '2',
            verification: { kind: 'kernel', operation: 'sflow.story.inspect.verify' }
          }
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

function compilerRequest(fixture) {
  return {
    intentIr: fixture.intent,
    workflow: fixture.workflow,
    ratification: fixture.ratification,
    policySnapshotSha256: fixture.policy.snapshotSha256,
    registrySnapshotSha256: fixture.registry.registrySnapshotSha256,
    registrySnapshot: fixture.registry,
    storageProfileSha256: fixture.ratification.storageProfileSha256
  };
}

async function writeExecutable(root, name, fixture) {
  const request = compilerRequest(fixture);
  const program = compileSgosProgram(request).program;
  const programFile = `${name}-program.json`;
  const requestFile = `${name}-compiler-request.json`;
  await writeFile(path.join(root, programFile), `${JSON.stringify(program, null, 2)}\n`);
  await writeFile(path.join(root, requestFile), `${JSON.stringify(request, null, 2)}\n`);
  return { program, programFile, requestFile };
}

async function approveProgram(root, program) {
  const relative = sgosProgramAuthorityPath(program);
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  const authority = createSgosProgramAuthorityRecord(program, {
    approvedBy: { kind: 'human', id: 'sgos-cli@example.test' },
    approvedAt: '2026-08-29T10:00:00.000Z'
  });
  await writeFile(target, `${JSON.stringify(authority, null, 2)}\n`);
  git(root, 'add', relative);
  git(root, 'commit', '-m', `approve SGOS Program ${program.programId}`);
  git(root, 'branch', '-f', 'sflow/config', 'HEAD');
}

function humanCompileInputs(human, suffix = human.taskTemplateId) {
  const base = compileInputs();
  const intent = createIntentIr({
    generation: 1,
    objective: { statement: `Resolve ${suffix}.`, provenance: 'human-confirmed' },
    outcomes: [], successCriteria: [], constraints: [], invariants: [], preferences: [],
    nonGoals: [], assumptions: [], unknowns: [], contradictions: [], risks: [],
    subjects: [], evidenceExpectations: [], authorityRequirements: [], budgets: [],
    domainCandidates: [], workTypeCandidates: []
  });
  const objective = `${intent.intentId}:objective`;
  const coverage = {
    clauses: { [objective]: [{ kind: 'task', targetId: human.taskTemplateId }] },
    tasks: { [human.taskTemplateId]: [{ kind: 'intent-clause', sourceId: objective }] }
  };
  const workflow = createWorkflowIr({
    apiVersion: 'sflow/v1',
    version: '1',
    intentIrSha256: intent.intentIrSha256,
    policySnapshotSha256: base.policy.snapshotSha256,
    metadata: { id: `human-${suffix}`, version: '1', domainPack: 'core@1' },
    spec: {
      inputs: {},
      tasks: {
        [human.taskTemplateId]: {
          kind: 'task', opcode: 'HUMAN_REQUEST', dependsOn: [],
          resources: human.resources,
          evidence: { required: ['candidate', 'verification-result'] },
          authority: human.authority,
          recovery: {},
          intentClauseIds: [objective],
          inputs: [], outputs: [], retry: { maximumAttempts: 1 },
          policySnapshotSha256: base.policy.snapshotSha256,
          material: true,
          // Workflow IR owns construct-specific extension data under metadata. The compiler
          // preserves this reviewed value in the executable Task Template; a top-level
          // humanRequest field is deliberately rejected by the strict Workflow IR contract.
          metadata: { humanRequest: human.metadata.humanRequest }
        },
        finish: { kind: 'end', opcode: 'END', dependsOn: [human.taskTemplateId], material: false }
      },
      joins: {},
      terminalConditions: [{ taskTemplateId: 'finish', state: 'succeeded' }],
      budgets: { maximumTasks: 2, maximumAttempts: 1 },
      recovery: {}, evidence: {}, authority: {},
      storageRequirements: { profileSha256: h('6') }, intentWorkflowMap: coverage
    }
  });
  const ratification = createWorkflowRatification({
    intentIrSha256: intent.intentIrSha256,
    workflowSha256: workflow.workflowSha256,
    policySnapshotSha256: base.policy.snapshotSha256,
    registrySnapshotSha256: base.registry.registrySnapshotSha256,
    storageProfileSha256: h('6'),
    packetSha256: h('7'),
    decision: 'ratified',
    principal: { id: 'sgos-cli@example.test', kind: 'human' },
    coverage,
    decidedAt: '2026-08-29T10:00:00.000Z'
  });
  return { intent, workflow, ratification, policy: base.policy, registry: base.registry };
}

test('SGOS CLI compiles no authority from chat and runs a finite model-free Program beside Story state', async () => {
  const root = await repository();
  const executable = await writeExecutable(root, 'story-inspect', compileInputs());
  const storyFile = path.join(root, 'singularity', 'work-items', 'SGOS-CLI', 'workflow.json');

  const capturedEnvelope = narrated(root, 'intent', 'capture', 'Produce', 'a', 'verified', 'result');
  const captured = capturedEnvelope.data.result;
  assert.equal(captured.kind, 'intent-envelope');
  assert.match(captured.envelopeSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(capturedEnvelope.effects.filesChanged, false);

  const validation = narrated(root, 'program', 'validate', executable.programFile).data.result;
  const simulation = narrated(root, 'program', 'simulate', executable.programFile).data.result;
  assert.equal(validation.valid, true);
  assert.deepEqual(simulation.waves, [['copy'], ['end']]);

  const unproven = flowResult(root, 'process', 'start', executable.programFile,
    '--subject', 'SGOS-CLI', '--subject-kind', 'story', '--json');
  assert.notEqual(unproven.status, 0);
  assert.match(unproven.stderr, /Program (?:authority|approval).*(?:approved configuration|sflow\/config)/i);

  await configureApprovedAuthority(root);
  await approveProgram(root, executable.program);
  const storyBefore = await readFile(storyFile, 'utf8');
  const headBefore = git(root, 'rev-parse', 'HEAD');

  const invalidSubject = flowResult(root, 'process', 'start', executable.programFile,
    '--subject', 'SGOS-CLI', '--subject-kind', 'stor', '--json');
  assert.notEqual(invalidSubject.status, 0);
  assert.match(invalidSubject.stderr, /Allowed: story, repository/);

  const repositoryStarted = narrated(root, 'process', 'start', executable.programFile,
    '--compiler-request', executable.requestFile,
    '--subject', 'repository-baseline').data.result;
  assert.equal(repositoryStarted.process.authorityBinding.kind, 'repository');
  assert.equal(repositoryStarted.process.authorityBinding.subjectAuthority, null);
  assert.equal(repositoryStarted.process.authorityBinding.authority,
    'existing-repository-baseline');
  const currentArchive = flowResult(root, 'process', 'archive',
    repositoryStarted.process.processId, '--json');
  assert.notEqual(currentArchive.status, 0);
  assert.match(currentArchive.stderr, /readable current state.*must not be quarantined/i);

  const started = narrated(root, 'process', 'start', executable.programFile,
    '--compiler-request', executable.requestFile,
    '--subject', 'SGOS-CLI', '--subject-kind', 'story').data.result;
  assert.equal(started.process.status, 'running');
  assert.equal(started.binding.subjectId, 'SGOS-CLI');
  const processId = started.process.processId;

  const commandCenter = narrated(root, 'process', 'list').data.result;
  const card = commandCenter.processes.find((entry) => entry.processId === processId);
  assert.ok(card, 'the started Process is visible in the deterministic Command Center inventory');
  assert.equal(card.processSha256, started.process.processSha256);
  assert.equal(card.processRevision, started.process.processRevision);
  assert.equal(commandCenter.runtimeProfile.id, 'bounded-static-parallel-lineage');
  assert.equal(commandCenter.runtimeProfile.capabilities.parallelExecution.status, 'available');
  assert.equal(commandCenter.runtimeProfile.capabilities.replay.status, 'available');
  assert.equal(commandCenter.runtimeProfile.capabilities.fork.status, 'available');
  const graph = narrated(root, 'process', 'graph', processId).data.result;
  assert.equal(graph.processSha256, started.process.processSha256);
  assert.equal(graph.processRevision, started.process.processRevision);
  assert.equal(graph.programSha256, started.process.programSha256);

  const invalidStopRevision = flowResult(root, 'process', 'stop', processId,
    '--expected-revision', '0', '--json');
  assert.notEqual(invalidStopRevision.status, 0);
  assert.match(invalidStopRevision.stderr, /expected-revision must be a positive safe integer/i);
  const staleStop = flowResult(root, 'process', 'stop', processId,
    '--expected-revision', String(started.process.processRevision + 1), '--json');
  assert.notEqual(staleStop.status, 0);
  assert.match(staleStop.stderr, /revision|changed|compare|expected/i);

  const fractionalParallel = flowResult(root, 'process', 'run', processId,
    '--maximum-parallel', '1.5', '--json');
  assert.notEqual(fractionalParallel.status, 0);
  assert.match(fractionalParallel.stderr, /positive whole number.*installed execution bound/i);
  const excessiveParallel = flowResult(root, 'process', 'run', processId,
    '--maximum-parallel', String(SGOS_INSTALLED_LIMITS.maximumParallelExecutions + 1), '--json');
  assert.notEqual(excessiveParallel.status, 0);
  assert.match(excessiveParallel.stderr, /outside the installed execution bound/i);

  const firstEnvelope = narrated(root, 'process', 'run', processId);
  const first = firstEnvelope.data.result;
  const secondEnvelope = narrated(
    root, 'process', 'run', processId, '--maximum-parallel', '2', '--allow-model'
  );
  const second = secondEnvelope.data.result;
  const idleEnvelope = narrated(root, 'process', 'run', processId, '--maximum-parallel', '2');
  const idle = idleEnvelope.data.result;
  const status = narrated(root, 'process', 'status', processId).data.result;
  const tasks = narrated(root, 'task', 'list', processId).data.result;

  assert.equal(first.launched, 1, JSON.stringify(first));
  assert.equal(first.maximumParallel, SGOS_INSTALLED_LIMITS.maximumParallelExecutions);
  assert.equal(first.taskInstanceIds.length, 1);
  assert.equal(first.processChanged, true);
  assert.equal(firstEnvelope.operation.id, 'process.run');
  assert.equal(firstEnvelope.operation.classification, 'mutation');
  assert.equal(firstEnvelope.effects.stateChanged, true);
  assert.equal(second.launched, 1, JSON.stringify(second));
  assert.equal(second.maximumParallel, 2);
  assert.equal(secondEnvelope.operation.id, 'process.run.model');
  assert.equal(second.process.status, 'succeeded');
  assert.equal(idle.launched, 0);
  assert.equal(idle.processChanged, false);
  assert.deepEqual(idle.taskInstanceIds, []);
  assert.equal(idleEnvelope.effects.stateChanged, false);
  assert.equal(idleEnvelope.effects.filesChanged, false);
  assert.equal(status.process.status, 'succeeded');
  assert.equal(tasks.tasks.every((entry) => entry.state === 'succeeded' && entry.receiptSha256), true);
  assert.equal(await readFile(storyFile, 'utf8'), storyBefore, 'SGOS operational execution must not rewrite Story authority');
  assert.equal(git(root, 'rev-parse', 'HEAD'), headBefore, 'SGOS operational execution must not create a Git authority commit');
});

test('SGOS help documents the bounded one-wave process runner', () => {
  assert.match(HELP,
    /process run <PROCESS-ID> \[--maximum-parallel N\] \[--expected-revision N\] \[--allow-model\] \[--json\]/);
  assert.match(HELP, /one deterministic ready wave/);
  assert.match(HELP, /proposal-only Copilot tasks/);
});

test('built-in Story inspection refuses an uncommitted workflow mutation instead of attesting mutable state', async () => {
  const root = await repository();
  const executable = await writeExecutable(root, 'story-inspect-dirty-state', compileInputs());
  await configureApprovedAuthority(root);
  await approveProgram(root, executable.program);
  const storyRelative = 'singularity/work-items/SGOS-CLI/workflow.json';
  const storyFile = path.join(root, ...storyRelative.split('/'));
  const baselineRevision = git(root, 'rev-parse', 'HEAD');
  const baseline = await readFile(storyFile, 'utf8');
  const started = narrated(root, 'process', 'start', executable.programFile,
    '--compiler-request', executable.requestFile,
    '--subject', 'SGOS-CLI', '--subject-kind', 'story').data.result;

  const mutable = JSON.parse(baseline);
  mutable.workItem.branch = 'uncommitted-adversarial-branch';
  await writeFile(storyFile, `${JSON.stringify(mutable, null, 2)}\n`);

  const stepEnvelope = narrated(root, 'process', 'step', started.process.processId, '--allow-model');
  assert.equal(stepEnvelope.operation.id, 'process.step.model');
  const result = stepEnvelope.data.result;
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'SGOS_STORY_STATE_DIVERGED');
  assert.match(result.error.message, /exact Process baseline|mutable state was not attested/i);
  assert.equal(result.process.status, 'failed');
  const inspected = Object.values(result.process.taskInstances)
    .find((entry) => entry.taskTemplateId === 'copy');
  assert.equal(inspected.state, 'failed');
  assert.equal(inspected.receiptSha256, null);
  assert.equal(git(root, 'rev-parse', 'HEAD'), baselineRevision);
  assert.equal(git(root, 'show', `${baselineRevision}:${storyRelative}`), baseline.trimEnd());
  assert.notEqual(await readFile(storyFile, 'utf8'), baseline);
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
    compiler: { id: 'sgos-cli-fixture', version: '2' }
  });
  await writeFile(path.join(root, 'program.json'), `${JSON.stringify(program)}\n`);
  const result = flowResult(root, 'program', 'validate', 'program.json', '--out', 'validation.json', '--json');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--out is not supported/);
  await assert.rejects(() => readFile(path.join(root, 'validation.json'), 'utf8'), { code: 'ENOENT' });
});

test('SGOS subcommands reject unknown options instead of silently ignoring them', async () => {
  const root = await repository();
  const result = flowResult(root, 'process', 'list', '--definitely-not-a-real-option', '--json');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown option '--definitely-not-a-real-option' for 'process list'/);
});

test('process model permission is explicit and global --no-model still refuses it before dispatch', async () => {
  const root = await repository();
  const deterministic = flowResult(
    root, 'process', 'step', 'PROC-NOT-INSTALLED', '--no-model', '--json'
  );
  assert.notEqual(deterministic.status, 0);
  assert.doesNotMatch(deterministic.stderr, /requires a model/);

  const refused = flowResult(
    root, 'process', 'step', 'PROC-NOT-INSTALLED', '--allow-model', '--no-model', '--json'
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /process\.step\.model.*requires a model.*--no-model/i);
  assert.doesNotMatch(refused.stderr, /PROC-NOT-INSTALLED.*unavailable/i,
    'required-model refusal happens before the Process or provider is opened');
});

test('SGOS CLI refuses an authority supplied by the responder', async () => {
  const root = await repository();
  await configureApprovedAuthority(root);
  const executable = await writeExecutable(root, 'untrusted-human', humanCompileInputs(humanTask(), 'untrusted'));
  await approveProgram(root, executable.program);
  const started = narrated(root, 'process', 'start', executable.programFile,
    '--compiler-request', executable.requestFile, '--subject', 'SGOS-CLI').data.result;
  const waiting = narrated(root, 'process', 'step', started.process.processId).data.result;
  assert.equal(waiting.status, 'waiting-human');

  const response = flowResult(root, 'request', 'respond', waiting.request.requestId,
    '--process', started.process.processId,
    '--option', 'approved',
    '--confirm', waiting.request.requestSha256,
    ...humanCas(waiting),
    '--authority', 'reviewer',
    '--json');
  assert.notEqual(response.status, 0);
  assert.match(response.stderr, /--authority cannot grant response authority/);

  const status = narrated(root, 'process', 'status', started.process.processId).data.result;
  assert.equal(status.process.status, 'waiting-human');
  assert.deepEqual(status.process.openHumanRequests, [waiting.request.requestSha256]);
  assert.equal(status.workObjects[0].view.actions[0].id, 'request.respond');
  assert.equal(status.workObjects[0].view.actions[0].operation, 'request.respond');
});

test('SGOS CLI cannot authorize a local self-add before or after the protected configuration is reverted', async () => {
  const root = await repository();
  await configureApprovedAuthority(root);
  const executable = await writeExecutable(root, 'self-add-human', humanCompileInputs(humanTask(), 'self-add'));
  await approveProgram(root, executable.program);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const approvedBytes = await readFile(workflowPath, 'utf8');
  const locallyEscalated = YAML.parse(approvedBytes);
  locallyEscalated.approvalAuthorities.reviewer = {
    label: 'Local self-added reviewers',
    allowAnyGitIdentity: false,
    members: [{ name: 'SGOS CLI Tester', email: 'sgos-cli@example.test' }]
  };
  await writeFile(workflowPath, YAML.stringify(locallyEscalated));
  const dirtyStart = flowResult(root, 'process', 'start', executable.programFile,
    '--compiler-request', executable.requestFile, '--subject', 'SGOS-CLI', '--json');
  assert.notEqual(dirtyStart.status, 0);
  assert.match(dirtyStart.stderr, /refuses dirty protected configuration/i);

  git(root, 'add', 'singularity/workflow.yml');
  git(root, 'commit', '-m', 'attempt local authority escalation');

  const escalatedStart = flowResult(root, 'process', 'start', executable.programFile,
    '--compiler-request', executable.requestFile, '--subject', 'SGOS-CLI', '--json');
  assert.notEqual(escalatedStart.status, 0);
  assert.match(escalatedStart.stderr, /not present byte-for-byte in the approved configuration authority/i);

  await writeFile(workflowPath, approvedBytes);
  git(root, 'add', 'singularity/workflow.yml');
  git(root, 'commit', '-m', 'revert local authority escalation');
  const started = narrated(root, 'process', 'start', executable.programFile,
    '--compiler-request', executable.requestFile, '--subject', 'SGOS-CLI').data.result;
  assert.equal(started.process.authorityBinding.humanAuthorityRequirements.length, 1);
  assert.equal(started.process.authorityBinding.configurationAuthority.ref, 'refs/heads/sflow/config');
  const waiting = narrated(root, 'process', 'step', started.process.processId).data.result;
  assert.deepEqual(waiting.request.configurationAuthority,
    started.process.authorityBinding.configurationAuthority);
  const response = flowResult(root, 'request', 'respond', waiting.request.requestId,
    '--process', started.process.processId, '--decision', 'approved',
    '--confirm', waiting.request.requestSha256, ...humanCas(waiting), '--json');
  assert.notEqual(response.status, 0);
  assert.match(response.stderr, /no trusted binding/i);
});

test('SGOS CLI pins configured Git authority, records approval, and exposes exact receipt lineage', async () => {
  const root = await repository();
  await configureReviewer(root);
  const executable = await writeExecutable(root, 'approved-human', humanCompileInputs(humanTask(), 'approved'));
  await approveProgram(root, executable.program);
  const started = narrated(root, 'process', 'start', executable.programFile,
    '--compiler-request', executable.requestFile, '--subject', 'SGOS-CLI').data.result;
  assert.deepEqual(started.process.authorityBinding.humanAuthorityRequirements.map((entry) => ({
    kind: entry.kind,
    id: entry.id,
    minimumAssurance: entry.minimumAssurance
  })), [{
    kind: 'role',
    id: 'reviewer',
    minimumAssurance: null
  }]);
  const waiting = narrated(root, 'process', 'step', started.process.processId).data.result;
  const missingCas = flowResult(root, 'request', 'respond', waiting.request.requestId,
    '--process', started.process.processId, '--decision', 'approved',
    '--confirm', waiting.request.requestSha256, '--json');
  assert.notEqual(missingCas.status, 0);
  assert.match(missingCas.stderr, /requires --expected-revision/i);
  const missingDigest = flowResult(root, 'request', 'respond', waiting.request.requestId,
    '--process', started.process.processId, '--decision', 'approved',
    '--confirm', waiting.request.requestSha256,
    '--expected-revision', String(waiting.process.processRevision), '--json');
  assert.notEqual(missingDigest.status, 0);
  assert.match(missingDigest.stderr, /requires --expected-process-sha256/i);
  const wrongDigest = flowResult(root, 'request', 'respond', waiting.request.requestId,
    '--process', started.process.processId, '--decision', 'approved',
    '--confirm', waiting.request.requestSha256,
    '--expected-revision', String(waiting.process.processRevision),
    '--expected-process-sha256', h('9'), '--json');
  assert.notEqual(wrongDigest.status, 0);
  assert.match(wrongDigest.stderr, /reviewed Process revision or digest changed/i);
  const unchanged = narrated(root, 'process', 'status', started.process.processId).data.result;
  assert.equal(unchanged.process.processSha256, waiting.process.processSha256);
  assert.deepEqual(unchanged.process.openHumanRequests, [waiting.request.requestSha256]);
  const response = narrated(root, 'request', 'respond', waiting.request.requestId,
    '--process', started.process.processId,
    '--decision', 'approved',
    '--confirm', waiting.request.requestSha256, ...humanCas(waiting)).data.result;
  assert.equal(response.response.decision, 'approved');
  assert.equal(response.response.actor.authoritySha256,
    started.process.authorityBinding.humanAuthorityRequirements[0].authoritySha256);

  const shown = narrated(root, 'task', 'show', started.process.processId, 'approve').data.result;
  assert.equal(shown.taskTemplate.opcode, 'HUMAN_REQUEST');
  assert.equal(shown.taskContractSha256, response.process.taskContractSha256);
  assert.deepEqual(shown.attemptLineage.attemptIds, response.process.taskInstances[shown.task.taskInstanceId].attemptIds);
  assert.equal(shown.receipt.receiptSha256, response.receipt.receiptSha256);

  const evidence = narrated(root, 'task', 'evidence', started.process.processId, 'approve').data.result;
  assert.equal(evidence.integrity, 'validated-on-read');
  assert.equal(evidence.candidate.status, 'available');
  assert.equal(evidence.candidate.record.candidateSha256, response.receipt.candidateSha256);
  assert.equal(evidence.actionEvidence.length, 1);
  assert.equal(evidence.humanResponses.length, 1);
  assert.equal(evidence.humanResponses[0].record.responseSha256, response.response.responseSha256);
  assert.deepEqual(evidence.unresolvedEvidenceRefs, []);
  assert.deepEqual(evidence.unresolvedEffectRefs, []);
});

test('SGOS CLI validates typed JSON and accepts only non-secret handles for sensitive requests', async () => {
  const root = await repository();
  await configureReviewer(root);
  for (const [name, human] of [['typed', providedTask()], ['sensitive', providedTask({ sensitive: true })]]) {
    const executable = await writeExecutable(root, name, humanCompileInputs(human, name));
    await approveProgram(root, executable.program);
    const started = narrated(root, 'process', 'start', executable.programFile,
      '--compiler-request', executable.requestFile, '--subject', 'SGOS-CLI').data.result;
    const waiting = narrated(root, 'process', 'step', started.process.processId).data.result;
    if (name === 'typed') {
      const malformed = flowResult(root, 'request', 'respond', waiting.request.requestId,
        '--process', started.process.processId, '--decision', 'provided', '--input-json', '{bad',
        '--confirm', waiting.request.requestSha256, ...humanCas(waiting), '--json');
      assert.notEqual(malformed.status, 0);
      assert.match(malformed.stderr, /must be valid safe JSON/);
      const answered = narrated(root, 'request', 'respond', waiting.request.requestId,
        '--process', started.process.processId, '--decision', 'provided',
        '--input-json', JSON.stringify({ answer: 'Use the approved boundary.' }),
        '--confirm', waiting.request.requestSha256, ...humanCas(waiting)).data.result;
      assert.deepEqual(answered.response.input, { answer: 'Use the approved boundary.' });
      continue;
    }
    const raw = flowResult(root, 'request', 'respond', waiting.request.requestId,
      '--process', started.process.processId, '--decision', 'provided',
      '--input-json', JSON.stringify({ token: 'raw-secret' }),
      '--confirm', waiting.request.requestSha256, ...humanCas(waiting), '--json');
    assert.notEqual(raw.status, 0);
    assert.match(raw.stderr, /refuse --input-json|non-secret typed reference/);
    const handle = {
      kind: 'secret-broker', broker: 'vault:test', handle: 'secret/ref/42', referenceSha256: h('a')
    };
    const answered = narrated(root, 'request', 'respond', waiting.request.requestId,
      '--process', started.process.processId, '--decision', 'provided',
      '--sensitive-handle', JSON.stringify(handle), '--confirm', waiting.request.requestSha256,
      ...humanCas(waiting)).data.result;
    assert.deepEqual(answered.response.input, handle);
  }
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

test('SGOS CLI previews and confirms byte-preserving quarantine of an unreadable v1 Process', async () => {
  const root = await repository();
  const processId = 'PROC-CLI-ARCHIVE';
  const directory = sgosProcessDirectory(root, processId);
  await mkdir(path.join(directory, 'bindings'), { recursive: true });
  const bindingCore = {
    schemaVersion: 1,
    kind: 'process-binding',
    processId,
    subjectId: 'SGOS-CLI'
  };
  const binding = {
    ...bindingCore,
    bindingSha256: `sha256:${recordSha256(bindingCore)}`
  };
  const bindingFile = path.join(
    directory, 'bindings', `${binding.bindingSha256.slice('sha256:'.length)}.json`
  );
  await writeFile(bindingFile, `${JSON.stringify(binding)}\n`);
  const stateCore = {
    schemaVersion: 1,
    kind: 'gvm-process',
    processId,
    processBindingSha256: binding.bindingSha256,
    openHumanRequests: [],
    activeLeases: []
  };
  const state = { ...stateCore, processSha256: `sha256:${recordSha256(stateCore)}` };
  const stateFile = path.join(directory, 'state.json');
  const stateBytes = `${JSON.stringify(state)}\n`;
  await writeFile(stateFile, stateBytes);

  const preview = narrated(root, 'process', 'quarantine', processId);
  assert.equal(preview.operation.id, 'process.quarantine');
  assert.equal(preview.effects.stateChanged, false);
  assert.equal(preview.data.result.status, 'quarantine-ready');
  assert.equal(preview.data.result.reason, 'legacy-v1-authority-unreadable');
  assert.equal(preview.data.result.successClaimed, false);
  assert.match(preview.data.result.next[0], new RegExp(preview.data.result.confirmationSha256));

  const stale = flowResult(root, 'process', 'quarantine', processId, '--confirm', h('f'), '--json');
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /confirmation must equal/);
  assert.equal(await readFile(stateFile, 'utf8'), stateBytes);

  const confirmed = narrated(root, 'process', 'quarantine', processId,
    '--confirm', preview.data.result.confirmationSha256);
  assert.equal(confirmed.effects.stateChanged, true);
  assert.equal(confirmed.data.result.status, 'quarantined');
  assert.equal(confirmed.data.result.quarantined, true);
  const quarantine = path.join(
    root, '.git', 'singularity-flow',
    ...confirmed.data.result.quarantine.slice('$git/'.length).split('/')
  );
  assert.equal(await readFile(path.join(quarantine, 'state.json'), 'utf8'), stateBytes);
  await assert.rejects(() => readFile(stateFile, 'utf8'), { code: 'ENOENT' });
});
