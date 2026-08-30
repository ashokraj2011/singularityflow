import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { initializeDefinition } from '../src/config.mjs';
import {
  createCandidateSnapshot, createGvmProgram, createHumanRequest, createHumanResponse
} from '../src/sgos/contracts.mjs';
import { SGOS_COMPILER_ID } from '../src/sgos/compiler.mjs';
import { sgosSha256 } from '../src/sgos/evidence.mjs';
import {
  compileSgosProcessEvidence, parseSgosProcessEvidence, serializeSgosProcessEvidence,
  SGOS_PROCESS_EVIDENCE_MAXIMUM_BYTES, verifySgosProcessEvidence
} from '../src/sgos/process-evidence.mjs';
import { runNextSgosTask, startSgosProcess } from '../src/sgos/runtime.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { publishSgosProgramAuthority } from './helpers/sgos-authority.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const T0 = '2026-08-30T06:00:00.000Z';
const T1 = '2026-08-30T06:01:00.000Z';
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function flowResult(root, ...args) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Evidence Tester'
    }
  });
}

function kernelProgram() {
  const taskTemplates = [{
    taskTemplateId: '10-work', opcode: 'KERNEL', operation: 'evidence.work', dependsOn: [],
    resources: { reads: [], writes: [], devices: [], externalEffects: [] },
    evidence: { required: ['candidate', 'verification-result'] }, authority: {}, recovery: {},
    intentClauseIds: [], inputs: [], outputs: [], retry: { maximumAttempts: 1 },
    policySnapshotSha256: H('4'), material: true,
    metadata: {
      sourceConstruct: 'task', operationVersion: '1', operationManifestSha256: H('8')
    }
  }, {
    taskTemplateId: '90-end', opcode: 'END', operation: 'kernel.end', dependsOn: ['10-work'],
    resources: { reads: [], writes: [], devices: [], externalEffects: [] },
    evidence: {}, authority: {}, recovery: {}, intentClauseIds: [], inputs: [], outputs: [],
    retry: { maximumAttempts: 1 }, policySnapshotSha256: H('4'), material: false,
    metadata: {
      sourceConstruct: 'end', operationVersion: '1', operationManifestSha256: H('8')
    }
  }];
  return createGvmProgram({
    intentIrSha256: H('1'), workflowSha256: H('2'), ratificationSha256: H('3'),
    policySnapshotSha256: H('4'), registrySnapshotSha256: H('5'),
    storageProfileSha256: H('6'), taskTemplates,
    edges: [{ from: '10-work', to: '90-end' }], joins: [],
    budgets: { maximumTasks: 2, maximumAttempts: 1 },
    recoveryPolicy: { mode: 'fail-closed' },
    terminalConditions: [{ taskTemplateId: '90-end', state: 'succeeded' }],
    // This manually-authored fixture exercises portable evidence, not Signed-Pack
    // compilation. Keep it on the legacy compiler contract; v3 requires the exact
    // compiler result and its capability-Pack authority digest.
    compiler: { id: SGOS_COMPILER_ID, version: '2' }
  });
}

async function processFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-process-evidence-'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Evidence Tester']);
  git(root, ['config', 'user.email', 'evidence@example.test']);
  await initializeDefinition(root);
  const storyId = 'SGOS-EVIDENCE-1';
  const storyDirectory = path.join(root, 'singularity', 'work-items', storyId);
  await mkdir(storyDirectory, { recursive: true });
  await writeFile(path.join(storyDirectory, 'workflow.json'), `${JSON.stringify({
    schemaVersion: 2,
    workItem: { id: storyId, title: 'Portable Process evidence' },
    currentPhase: 'implementation'
  }, null, 2)}\n`);
  await writeFile(path.join(root, 'app.mjs'), 'export const evidence = true;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'Evidence fixture']);

  const program = kernelProgram();
  await publishSgosProgramAuthority(root, program);
  const started = await startSgosProcess(root, {
    program,
    taskContractSha256: H('7'),
    subject: {
      kind: 'story', id: storyId, branch: 'main', baselineRevision: git(root, ['rev-parse', 'HEAD'])
    },
    clock: T0
  });
  const adapters = {
    handlers: { kernel: { 'evidence.work': async () => ({ rawResult: { status: 'completed' } }) } },
    captureCandidates: { 'evidence.work': async () => ({ resources: [] }) },
    verifiers: { 'evidence.work': async ({ candidateSha256 }) => ({
      status: 'passed', candidateSha256, checksSha256: H('9')
    }) },
    clock: T1
  };
  let process = started.process;
  for (let count = 0; count < 4 && process.status !== 'succeeded'; count += 1) {
    process = (await runNextSgosTask(root, process.processId, adapters)).process;
  }
  assert.equal(process.status, 'succeeded');
  return { root, process, program };
}

function reseal(bundle) {
  const value = structuredClone(bundle);
  delete value.bundleSha256;
  value.bundleSha256 = sgosSha256(value);
  return value;
}

function codes(report) {
  return new Set(report.contradictions.map((entry) => entry.code));
}

function sortWrappers(values) {
  values.sort((left, right) => {
    const a = `${left.family}\0${left.recordSha256}`;
    const b = `${right.family}\0${right.recordSha256}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

test('Process Evidence exports exact rooted history and verifies after the source sidecar is gone', async (t) => {
  const fixture = await processFixture();
  const destination = await mkdtemp(path.join(os.tmpdir(), 'sflow-process-evidence-fresh-'));
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  });

  const bundle = await compileSgosProcessEvidence(fixture.root, fixture.process.processId);
  assert.equal(bundle.processSha256, fixture.process.processSha256);
  assert.equal(bundle.program.programSha256, fixture.program.programSha256);
  assert.equal(bundle.processBinding.bindingSha256, fixture.process.processBindingSha256);
  assert.equal(bundle.records.some((entry) => entry.family === 'gvm-task-attempt'), true);
  assert.equal(bundle.records.some((entry) => entry.family === 'gvm-task-receipt'), true);
  assert.equal(bundle.records.some((entry) => entry.family === 'candidate-snapshot'), true);
  assert.equal(bundle.records.some((entry) => entry.family === 'action-evidence'), true);
  assert.equal(bundle.controlLineage.length > 0, true);
  assert.deepEqual(bundle.assurance, {
    integrity: 'content-addressed-local-export',
    authority: 'not-provided',
    signature: 'not-provided',
    freshAuthorityVerification: 'not-performed',
    source: 'machine-local-operational-sidecar'
  });

  const target = path.join(destination, 'process-evidence.json');
  const portableBytes = serializeSgosProcessEvidence(bundle);
  const actualBytes = Buffer.byteLength(portableBytes, 'utf8');
  assert.equal(actualBytes <= SGOS_PROCESS_EVIDENCE_MAXIMUM_BYTES, true);
  await assert.rejects(
    () => compileSgosProcessEvidence(fixture.root, fixture.process.processId, {
      maximumBytes: actualBytes - 1
    }),
    (error) => error.code === 'SGOS_PROCESS_EVIDENCE_LIMIT'
  );
  assert.throws(
    () => serializeSgosProcessEvidence(bundle, { maximumBytes: actualBytes - 1 }),
    (error) => error.code === 'SGOS_PROCESS_EVIDENCE_LIMIT'
  );
  assert.throws(
    () => parseSgosProcessEvidence(portableBytes, { maximumBytes: actualBytes - 1 }),
    (error) => error.code === 'SGOS_PROCESS_EVIDENCE_LIMIT'
  );
  await writeFile(target, portableBytes);
  await rm(fixture.root, { recursive: true, force: true });
  const parsed = parseSgosProcessEvidence(await readFile(target));
  assert.equal(parsed.report.integrity, 'valid');
  assert.equal(parsed.report.status, 'incomplete', 'unexported authority/task-contract bytes remain explicit gaps');
  assert.equal(parsed.report.contradictions.length, 0);
  assert.equal(parsed.report.gaps.some((entry) => entry.code === 'task-contract-bytes-not-exported'), true);
  assert.equal(parsed.report.gaps.some((entry) => entry.code === 'approved-authority-bundle-not-exported'), true);
});

test('Process Evidence detects omission, reordering, duplication, tampering, orphaning, and unreferenced records', async (t) => {
  const fixture = await processFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const original = await compileSgosProcessEvidence(fixture.root, fixture.process.processId);

  const omitted = structuredClone(original);
  omitted.records.splice(omitted.records.findIndex((entry) => entry.family === 'action-evidence'), 1);
  assert.equal(codes(verifySgosProcessEvidence(reseal(omitted))).has('indexed-record-omitted'), true);

  const reordered = structuredClone(original);
  reordered.records.reverse();
  assert.equal(codes(verifySgosProcessEvidence(reseal(reordered))).has('bundle-record-reordered'), true);

  const duplicated = structuredClone(original);
  duplicated.records.push(structuredClone(duplicated.records[0]));
  sortWrappers(duplicated.records);
  assert.equal(codes(verifySgosProcessEvidence(reseal(duplicated))).has('bundle-record-duplicated'), true);

  const tampered = structuredClone(original);
  const evidence = tampered.records.find((entry) => entry.family === 'action-evidence');
  evidence.record.latencyMs += 1;
  assert.equal(codes(verifySgosProcessEvidence(reseal(tampered))).has('bundle-record-tampered'), true);

  const orphaned = structuredClone(original);
  const existing = orphaned.records.find((entry) => entry.family === 'candidate-snapshot').record;
  const extra = createCandidateSnapshot({
    subject: existing.subject,
    baseline: existing.baseline,
    resources: [{
      path: 'unreferenced.txt', type: 'file', mode: '100644', contentSha256: H('a'),
      operation: 'added', renameFrom: null, renameTo: null, deletion: false
    }],
    createdBy: existing.createdBy,
    createdAt: T1
  });
  orphaned.records.push({
    family: 'candidate-snapshot', recordSha256: extra.candidateSha256, record: extra
  });
  sortWrappers(orphaned.records);
  const orphanReport = verifySgosProcessEvidence(reseal(orphaned));
  assert.equal(codes(orphanReport).has('bundle-record-orphaned'), true);
  assert.equal(codes(orphanReport).has('indexed-record-unreferenced'), true);

  const humanOrphan = structuredClone(original);
  const request = createHumanRequest({
    requestType: 'approval', processId: original.processId,
    taskInstanceId: 'unreferenced-human-task',
    checkpointSha256: original.process.currentCheckpointSha256,
    requestedBy: { id: 'evidence-test', kind: 'system' },
    authorityRequired: { kind: 'role', id: 'reviewer', minimumAssurance: 'configured-local' },
    configurationAuthority: original.process.authorityBinding.configurationAuthority,
    prompt: { title: 'Unreferenced request', detail: 'Must not become its own evidence root.' },
    options: [], inputSchema: null, sensitiveMode: 'none', externalUrl: null,
    secretBroker: null, subjectSha256: H('b'),
    policySnapshotSha256: original.process.policySnapshotSha256,
    status: 'answered', createdAt: T0, expiresAt: null
  });
  const response = createHumanResponse({
    requestSha256: request.requestSha256, processId: original.processId,
    taskInstanceId: request.taskInstanceId,
    actor: { id: 'evidence@example.test', kind: 'human' },
    decision: 'approved', input: null, respondedAt: T1
  });
  humanOrphan.records.push(
    { family: 'human-request', recordSha256: request.requestSha256, record: request },
    { family: 'human-response', recordSha256: response.responseSha256, record: response }
  );
  sortWrappers(humanOrphan.records);
  const humanReport = verifySgosProcessEvidence(reseal(humanOrphan));
  assert.ok(humanReport.contradictions.some((entry) =>
    entry.code === 'indexed-record-unreferenced'
      && entry.family === undefined
      && entry.subject === 'human-request'));
  assert.ok(humanReport.contradictions.some((entry) =>
    entry.code === 'indexed-record-unreferenced' && entry.subject === 'human-response'));
});

test('Process Evidence CLI exports atomically and verifies model-free from a fresh directory', async (t) => {
  const fixture = await processFixture();
  const fresh = await mkdtemp(path.join(os.tmpdir(), 'sflow-process-evidence-cli-fresh-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-process-evidence-cli-outside-'));
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fresh, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  for (const [action, classification] of [['export', 'mutation'], ['verify', 'read']]) {
    const operation = resolveOperation({
      requestedCommand: 'evidence', positionals: ['evidence', action], options: {}
    });
    assert.equal(operation.id, `evidence.${action}`);
    assert.equal(operation.classification, classification);
    assert.equal(operation.modelPolicy, 'never');
    assert.deepEqual(operation.externalDependencies, []);
  }

  const exported = flowResult(
    fixture.root, 'evidence', 'export', fixture.process.processId,
    '--out', 'exports/process-evidence.json', '--json', '--no-model'
  );
  assert.equal(exported.status, 0, exported.stderr);
  const envelope = JSON.parse(exported.stdout);
  assert.equal(envelope.operation.id, 'evidence.export');
  assert.equal(envelope.effects.filesChanged, true);
  assert.equal(envelope.effects.stateChanged, false);
  assert.equal(envelope.data.result.assurance.signature, 'not-provided');
  assert.equal(envelope.data.result.assurance.authority, 'not-provided');
  assert.equal(envelope.data.result.gaps.some((entry) =>
    entry.code === 'approved-authority-bundle-not-exported'), true);
  const exportedFile = path.join(fixture.root, 'exports', 'process-evidence.json');
  const originalBytes = await readFile(exportedFile);
  assert.equal(parseSgosProcessEvidence(originalBytes).report.integrity, 'valid');
  assert.deepEqual(await readdir(path.dirname(exportedFile)), ['process-evidence.json']);

  const repeated = flowResult(
    fixture.root, 'evidence', 'export', fixture.process.processId,
    '--out', 'exports/process-evidence.json', '--json', '--no-model'
  );
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /already exists/);
  assert.deepEqual(await readFile(exportedFile), originalBytes, 'overwrite refusal preserves exact bytes');

  const traversal = flowResult(
    fixture.root, 'evidence', 'export', fixture.process.processId,
    '--out', '../outside-process-evidence.json', '--json', '--no-model'
  );
  assert.equal(traversal.status, 1);
  assert.match(traversal.stderr, /outside the repository/);

  if (process.platform !== 'win32') {
    await symlink(outside, path.join(fixture.root, 'outside-link'));
    const escaped = flowResult(
      fixture.root, 'evidence', 'export', fixture.process.processId,
      '--out', 'outside-link/process-evidence.json', '--json', '--no-model'
    );
    assert.equal(escaped.status, 1);
    assert.match(escaped.stderr, /resolves outside the repository|symbolic link/);
    assert.deepEqual(await readdir(outside), []);
  }

  const unknown = flowResult(
    fixture.root, 'evidence', 'export', fixture.process.processId,
    '--out', 'exports/other.json', '--overwrite', '--json', '--no-model'
  );
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option '--overwrite'/);

  const portable = path.join(fresh, 'process-evidence.json');
  await writeFile(portable, originalBytes);
  const verified = flowResult(fresh, 'evidence', 'verify', 'process-evidence.json', '--json', '--no-model');
  assert.equal(verified.status, 0, verified.stderr);
  const verifiedEnvelope = JSON.parse(verified.stdout);
  assert.equal(verifiedEnvelope.operation.id, 'evidence.verify');
  assert.equal(verifiedEnvelope.data.result.integrity, 'valid');
  assert.equal(verifiedEnvelope.data.result.status, 'incomplete');
  assert.equal(verifiedEnvelope.data.result.assurance.freshAuthorityVerification, 'not-performed');

  const tampered = JSON.parse(originalBytes.toString('utf8'));
  tampered.process.status = tampered.process.status === 'succeeded' ? 'failed' : 'succeeded';
  await writeFile(path.join(fresh, 'tampered.json'), JSON.stringify(tampered));
  const invalid = flowResult(fresh, 'evidence', 'verify', 'tampered.json', '--json', '--no-model');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /verification failed/i);

  const verifyUnknown = flowResult(
    fresh, 'evidence', 'verify', 'process-evidence.json', '--trust-me', '--json', '--no-model'
  );
  assert.equal(verifyUnknown.status, 1);
  assert.match(verifyUnknown.stderr, /Unknown option '--trust-me'/);
});
