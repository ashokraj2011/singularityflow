import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { withApprovedConfigurationRead } from '../src/approved-configuration-reader.mjs';
import { initializeDefinition } from '../src/config.mjs';
import {
  SGOS_BUILTIN_CORE_CAPABILITY_PACK_AUTHORITY,
  SGOS_CAPABILITY_PACK_TRUST_FORMAT,
  SGOS_CAPABILITY_PACK_TRUST_FORMAT_V2,
  SGOS_CAPABILITY_PACK_TRUST_FORMAT_V3,
  SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED,
  SGOS_CAPABILITY_PACK_TRANSPORT_MODE_SIGNED,
  SGOS_CAPABILITY_PACK_TRUST_PATH,
  capabilityPackAuthoritiesForCompilation,
  createSgosCapabilityPackGitTrustedTrustScaffold,
  loadApprovedSgosCapabilityPackTransportTrust,
  sgosCapabilityPackTransportMode,
  sgosCapabilityPackRepositoryBinding,
  validateSgosCapabilityPackTrustManifest,
  verifySgosCapabilityPackAuthorities
} from '../src/sgos/capability-pack-authority.mjs';
import {
  compileSgosProgram, compileSgosProgramWithApprovedCapabilityPack,
  registrySnapshotDigest
} from '../src/sgos/compiler.mjs';
import {
  createIntentIr, createPolicySnapshot, createWorkflowIr, createWorkflowRatification
} from '../src/sgos/contracts.mjs';
import { gitCommonDir } from '../src/git.mjs';
import {
  createCapabilityPack, createCapabilityPackRegistry, createPackReview,
  openFilesystemAuthorityStore, platformPrincipalId, platformSha256,
  signPlatformRecord
} from '../src/sgos/platform/index.mjs';
import { loadApprovedSgosProgramAuthority } from '../src/sgos/program-trust.mjs';
import { startSgosProcess } from '../src/sgos/public-runtime.mjs';
import { publishSgosProgramAuthority } from './helpers/sgos-authority.mjs';

const POLICY = platformSha256('pack-policy');
const STORAGE = platformSha256('pack-storage');
const RUN_MANIFEST = platformSha256('finance-run');
const VERIFY_MANIFEST = platformSha256('finance-verify');
const EXTRA_MANIFEST = platformSha256('finance-extra');
const ACTOR_EMAIL = 'pack.actor@example.test';
const AT = '2026-08-30T12:00:00.000Z';
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'singularity-flow.mjs');

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
}

function flowResult(root, ...args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' }
  });
}

function keyPair() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' })
  };
}

async function temporaryDirectory(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function cas(store) {
  const state = await store.read();
  return { expectedRevision: state.revision, expectedStateSha256: state.recordSha256 };
}

async function repository(t, {
  approvedPublisher = null,
  actualPublisher = null,
  storeId = 'pack-authority'
} = {}) {
  const root = await temporaryDirectory(t, 'sflow-pack-authority-');
  const publisher = actualPublisher ?? keyPair();
  const trusted = approvedPublisher ?? publisher;
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Pack Actor');
  git(root, 'config', 'user.email', ACTOR_EMAIL);
  await initializeDefinition(root);
  const workflowPath = path.join(root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  for (const authority of Object.values(workflow.approvalAuthorities)) {
    authority.members = [{ name: 'Pack Actor', email: ACTOR_EMAIL }];
  }
  await writeFile(workflowPath, YAML.stringify(workflow));
  await mkdir(path.join(root, 'singularity', 'sgos'), { recursive: true });
  await writeFile(path.join(root, SGOS_CAPABILITY_PACK_TRUST_PATH), JSON.stringify({
    format: SGOS_CAPABILITY_PACK_TRUST_FORMAT,
    storeId,
    publishers: { 'publisher-a': trusted.publicKeyPem }
  }));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'approved Pack trust');
  git(root, 'branch', 'sflow/config');
  const store = await openFilesystemAuthorityStore({
    root: path.join(gitCommonDir(root), 'singularity-flow', 'sgos', 'platform-authority', storeId),
    storeId
  });
  const registry = createCapabilityPackRegistry({
    authorityStore: store,
    trustedPublishers: { 'publisher-a': publisher.publicKeyPem },
    repositoryRoot: root
  });
  return { root, store, registry, publisher, storeId };
}

function rawRemoteFingerprint(remote) {
  return `sha256:${createHash('sha256').update(remote).digest('hex')}`;
}

function offlineRootCommitsSha256(root) {
  const commits = git(root, 'rev-list', '--max-parents=0', '--all')
    .split(/\r?\n/u).filter(Boolean).sort();
  return platformSha256(commits);
}

async function approveTransportTrust(fixture, {
  repositoryBinding,
  exporter = keyPair(),
  minimumAuthority = null
}) {
  const manifest = {
    format: SGOS_CAPABILITY_PACK_TRUST_FORMAT_V2,
    storeId: fixture.storeId,
    publishers: { 'publisher-a': fixture.publisher.publicKeyPem },
    transport: {
      repositoryBinding,
      exporterAuthority: 'full-authority-store-snapshot',
      exporters: { 'exporter-a': exporter.publicKeyPem },
      minimumAuthority
    }
  };
  await writeFile(path.join(fixture.root, SGOS_CAPABILITY_PACK_TRUST_PATH),
    `${JSON.stringify(manifest)}\n`);
  git(fixture.root, 'add', SGOS_CAPABILITY_PACK_TRUST_PATH);
  git(fixture.root, 'commit', '-m', 'approve portable Pack authority');
  git(fixture.root, 'branch', '-f', 'sflow/config', 'HEAD');
  return { manifest, exporter };
}

async function approveGitTrustedTransport(fixture, {
  repositoryBinding,
  minimumAuthority = null,
  publishers = { 'publisher-a': fixture.publisher.publicKeyPem }
}) {
  const manifest = createSgosCapabilityPackGitTrustedTrustScaffold({
    root: fixture.root,
    storeId: fixture.storeId,
    publishers,
    repositoryBinding,
    minimumAuthority
  });
  await writeFile(path.join(fixture.root, SGOS_CAPABILITY_PACK_TRUST_PATH),
    `${JSON.stringify(manifest)}\n`);
  git(fixture.root, 'add', SGOS_CAPABILITY_PACK_TRUST_PATH);
  git(fixture.root, 'commit', '-m', 'approve Git-trusted Pack authority');
  git(fixture.root, 'branch', '-f', 'sflow/config', 'HEAD');
  return manifest;
}

async function activatePack(fixture, {
  packId = 'finance-core', version = '1.0.0', domain = 'finance',
  operations = ['finance.run', 'finance.verify'], createdAt = AT
} = {}) {
  const pack = createCapabilityPack({
    packId, version, domain, operations: [...operations].sort(), permissions: [], files: [], lessons: [],
    provenanceSha256: platformSha256(`${packId}:provenance`),
    sbomSha256: platformSha256(`${packId}:sbom`),
    publisherKeyId: 'publisher-a', createdAt
  });
  const signed = signPlatformRecord(pack, {
    privateKeyPem: fixture.publisher.privateKeyPem,
    keyId: 'publisher-a'
  });
  await fixture.registry.propose(signed, await cas(fixture.store));
  const review = createPackReview({
    packSha256: pack.recordSha256,
    reviewerId: platformPrincipalId({ email: ACTOR_EMAIL }),
    decision: 'approved', reason: 'reviewed exact declarative Pack', reviewedAt: createdAt
  });
  await fixture.registry.recordReview(review, await cas(fixture.store));
  const activation = await fixture.registry.activate({
    domain, packSha256: pack.recordSha256, reviewSha256: review.recordSha256,
    confirmPackSha256: pack.recordSha256, ...await cas(fixture.store)
  });
  return { pack, review, activation };
}

function compilerRequest(pack, {
  operation = 'finance.run', verificationOperation = 'finance.verify',
  policySnapshotSha256 = POLICY
} = {}) {
  const registryCore = {
    kind: 'registry-snapshot',
    operations: [
      { id: 'finance.extra', version: '1', status: 'active', manifestSha256: EXTRA_MANIFEST },
      { id: 'finance.run', version: '1', status: 'active', manifestSha256: RUN_MANIFEST },
      { id: 'finance.verify', version: '1', status: 'active', manifestSha256: VERIFY_MANIFEST }
    ],
    taskKinds: [], devices: []
  };
  const registrySnapshot = {
    ...registryCore,
    registrySnapshotSha256: registrySnapshotDigest(registryCore)
  };
  const intentIr = createIntentIr({
    generation: 1,
    objective: { statement: 'Run the exact finance operation.', provenance: 'human-confirmed' },
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
    apiVersion: 'sflow/v1', version: '1', intentIrSha256: intentIr.intentIrSha256,
    policySnapshotSha256,
    metadata: {
      id: 'finance-pack-workflow', version: '1', domainPack: pack.domain,
      domainPackSha256: pack.recordSha256
    },
    spec: {
      inputs: {},
      tasks: {
        run: {
          kind: 'task', opcode: 'KERNEL', operation, dependsOn: [],
          resources: { reads: [], writes: ['artifact:finance'], devices: [], externalEffects: [] },
          evidence: { required: ['candidate-snapshot', 'verification-result'] }, authority: {}, recovery: {},
          intentClauseIds: [clauseId], material: true,
          metadata: { verification: { kind: 'kernel', operation: verificationOperation } },
          inputs: [], outputs: [{ ref: 'artifact:finance' }], retry: { maximumAttempts: 1 },
          policySnapshotSha256
        },
        end: { kind: 'end', opcode: 'END', dependsOn: ['run'], material: false }
      },
      joins: {}, terminalConditions: [{ taskTemplateId: 'end', state: 'succeeded' }],
      budgets: { maximumTasks: 2, maximumAttempts: 1 }, recovery: {}, evidence: {}, authority: {},
      storageRequirements: { profileSha256: STORAGE }, intentWorkflowMap: coverage
    }
  });
  const ratification = createWorkflowRatification({
    intentIrSha256: intentIr.intentIrSha256, workflowSha256: workflow.workflowSha256,
    policySnapshotSha256, registrySnapshotSha256: registrySnapshot.registrySnapshotSha256,
    storageProfileSha256: STORAGE, packetSha256: platformSha256('pack-ratification'),
    decision: 'ratified', principal: { kind: 'human', id: 'reviewer' }, coverage,
    decidedAt: AT
  });
  return {
    intentIr, workflow, ratification, policySnapshotSha256,
    registrySnapshotSha256: registrySnapshot.registrySnapshotSha256,
    registrySnapshot, storageProfileSha256: STORAGE
  };
}

test('versioned core authority is deterministic and never consumes ambient Pack state', () => {
  // Existing compiler tests exercise full core compilation. This assertion holds the new authority
  // contract explicitly so compatibility is not a hidden no-store bypass.
  assert.equal(SGOS_BUILTIN_CORE_CAPABILITY_PACK_AUTHORITY.kind, 'built-in-core');
  assert.equal(SGOS_BUILTIN_CORE_CAPABILITY_PACK_AUTHORITY.operationsPolicy, 'exact-registry-bound');
  assert.match(SGOS_BUILTIN_CORE_CAPABILITY_PACK_AUTHORITY.packSha256, /^sha256:[a-f0-9]{64}$/);
});

test('signed active Pack is the only deterministic compiler authority and unrelated active Packs are ignored', async (t) => {
  const fixture = await repository(t);
  const selected = await activatePack(fixture);
  await activatePack(fixture, {
    packId: 'testing-core', domain: 'testing', version: '1.0.0',
    operations: ['testing.run'], createdAt: '2026-08-30T12:01:00.000Z'
  });
  const request = compilerRequest(selected.pack);
  const first = await compileSgosProgramWithApprovedCapabilityPack(fixture.root, request, {
    refreshAuthority: false
  });
  const second = await compileSgosProgramWithApprovedCapabilityPack(fixture.root, request, {
    refreshAuthority: false
  });
  assert.deepEqual(first.program, second.program);
  assert.deepEqual(first.capabilityPackAuthorities, second.capabilityPackAuthorities);
  assert.equal(first.capabilityPackAuthorities.length, 1);
  assert.equal(first.capabilityPackAuthorities[0].packSha256, selected.pack.recordSha256);
  assert.equal(first.capabilityPackAuthorities[0].domain, 'finance');
  assert.equal(first.program.compiler.sourceSha256,
    second.program.compiler.sourceSha256);

  assert.throws(() => compileSgosProgram({
    ...request,
    capabilityPackAuthority: structuredClone(first.capabilityPackAuthorities[0])
  }), (error) => error.code === 'SGOS_CAPABILITY_PACK_AUTHORITY_REQUIRED');

  const denied = compilerRequest(selected.pack, { operation: 'finance.extra' });
  await assert.rejects(
    () => compileSgosProgramWithApprovedCapabilityPack(fixture.root, denied, { refreshAuthority: false }),
    (error) => error.code === 'SGOS_CAPABILITY_PACK_OPERATION_NOT_ALLOWED'
  );

  const otherRoot = await temporaryDirectory(t, 'sflow-pack-other-repository-');
  git(otherRoot, 'init', '-b', 'main');
  git(otherRoot, 'config', 'user.name', 'Other');
  git(otherRoot, 'config', 'user.email', 'other@example.test');
  git(otherRoot, 'commit', '--allow-empty', '-m', 'different repository');
  const otherBinding = await sgosCapabilityPackRepositoryBinding(otherRoot);
  assert.throws(() => capabilityPackAuthoritiesForCompilation(
    request.workflow,
    first.capabilityPackAuthorities[0],
    { repositoryBindingSha256: otherBinding }
  ), (error) => error.code === 'SGOS_CAPABILITY_PACK_AUTHORITY_REQUIRED'
      || error.code === 'SGOS_CAPABILITY_PACK_REPOSITORY_MISMATCH');
});

test('CLI signed-Pack compile emits the exact authority envelope accepted by approval preview', async (t) => {
  const fixture = await repository(t);
  const selected = await activatePack(fixture);
  const policy = createPolicySnapshot({
    authorityRevision: 'refs/heads/sflow/config@pack-authority',
    lawSha256: platformSha256('law'),
    registrySha256: platformSha256('registry'),
    executionUnitPolicySha256: platformSha256('execution-unit-policy'),
    devicePolicySha256: platformSha256('device-policy'),
    storagePolicySha256: platformSha256('storage-policy'),
    memoryPolicySha256: platformSha256('memory-policy'),
    humanAuthoritySha256: platformSha256('human-authority'),
    governedRootsSha256: platformSha256('governed-roots'),
    verificationPolicySha256: platformSha256('verification-policy'),
    publicationPolicySha256: platformSha256('publication-policy')
  });
  const request = compilerRequest(selected.pack, {
    policySnapshotSha256: policy.snapshotSha256
  });
  const records = {
    'intent.json': request.intentIr,
    'workflow.json': request.workflow,
    'ratification.json': request.ratification,
    'policy.json': policy,
    'registry.json': request.registrySnapshot
  };
  for (const [file, value] of Object.entries(records)) {
    await writeFile(path.join(fixture.root, file), `${JSON.stringify(value)}\n`);
  }
  const result = flowResult(fixture.root,
    'intent', 'compile', 'intent.json',
    '--workflow', 'workflow.json', '--ratification', 'ratification.json',
    '--policy', 'policy.json', '--registry', 'registry.json',
    '--out', 'signed-program.json', '--json');
  assert.equal(result.status, 0, result.stderr);
  const compiled = JSON.parse(result.stdout).data.result;
  assert.equal(compiled.program.kind, 'gvm-program');
  assert.equal(compiled.capabilityPackAuthorities[0].packSha256, selected.pack.recordSha256);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(fixture.root, 'signed-program.json'), 'utf8')),
    compiled
  );

  const shown = flowResult(fixture.root, 'program', 'show', 'signed-program.json', '--json');
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).data.result.programSha256, compiled.program.programSha256);
  const validated = flowResult(fixture.root, 'program', 'validate', 'signed-program.json', '--json');
  assert.equal(validated.status, 0, validated.stderr);
  assert.deepEqual(JSON.parse(validated.stdout).data.result, {
    valid: true,
    programId: compiled.program.programId,
    programSha256: compiled.program.programSha256
  });

  const preview = flowResult(fixture.root, 'program', 'approve', 'signed-program.json', '--json');
  assert.equal(preview.status, 0, preview.stderr);
  const proposal = JSON.parse(preview.stdout).data.result;
  assert.equal(proposal.programSha256, compiled.program.programSha256);
  assert.match(proposal.proposalSha256, /^sha256:[a-f0-9]{64}$/);
});

test('signed Pack execution can reproduce only the exact pinned compiler request after durable revalidation', async (t) => {
  const fixture = await repository(t);
  const selected = await activatePack(fixture);
  const request = compilerRequest(selected.pack);
  const compiled = await compileSgosProgramWithApprovedCapabilityPack(
    fixture.root, request, { refreshAuthority: false }
  );
  await publishSgosProgramAuthority(fixture.root, compiled);

  await writeFile(
    path.join(fixture.root, 'signed-program-runtime.json'), `${JSON.stringify(compiled)}\n`
  );
  await writeFile(
    path.join(fixture.root, 'signed-compiler-request.json'), `${JSON.stringify(request)}\n`
  );
  const cliStart = flowResult(
    fixture.root, 'process', 'start', 'signed-program-runtime.json',
    '--compiler-request', 'signed-compiler-request.json', '--process-id', 'PROC-PACK-CLI',
    '--subject', 'pack-repository-cli', '--json'
  );
  assert.equal(cliStart.status, 0, cliStart.stderr);
  assert.equal(JSON.parse(cliStart.stdout).data.result.process.processId, 'PROC-PACK-CLI');

  const started = await startSgosProcess(fixture.root, {
    program: compiled.program,
    compilerRequest: request,
    taskContractSha256: platformSha256('pack-task-contract'),
    processId: 'PROC-PACK-RECOMPILE',
    subject: { kind: 'repository', id: 'pack-repository' }
  });
  assert.equal(
    started.process.authorityBinding.executionAdmission.provenance.method,
    'approved-authority+deterministic-recompilation'
  );

  const tampered = structuredClone(request);
  tampered.workflow.metadata.id = 'tampered-after-ratification';
  const tamperedProcessRoot = path.join(
    gitCommonDir(fixture.root), 'singularity-flow', 'sgos', 'processes', 'PROC-PACK-TAMPERED'
  );
  await assert.rejects(() => startSgosProcess(fixture.root, {
    program: compiled.program,
    compilerRequest: tampered,
    taskContractSha256: platformSha256('pack-task-contract'),
    processId: 'PROC-PACK-TAMPERED',
    subject: { kind: 'repository', id: 'pack-repository' }
  }), (error) => error.code === 'SGOS_PROGRAM_RECOMPILATION_FAILED'
      || error.code === 'SGOS_PROGRAM_RECOMPILATION_MISMATCH');
  assert.equal(await lstat(tamperedProcessRoot).catch((error) =>
    error.code === 'ENOENT' ? null : Promise.reject(error)), null);
});

test('runtime authority revalidation refuses stale activation, supersession, revocation, and counterfeit trust', async (t) => {
  await t.test('stale activation', async (st) => {
    const fixture = await repository(st);
    const selected = await activatePack(fixture);
    const compiled = await compileSgosProgramWithApprovedCapabilityPack(
      fixture.root, compilerRequest(selected.pack), { refreshAuthority: false }
    );
    await publishSgosProgramAuthority(fixture.root, compiled);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fixture.registry.activate({
      domain: selected.pack.domain, packSha256: selected.pack.recordSha256,
      reviewSha256: selected.review.recordSha256,
      confirmPackSha256: selected.pack.recordSha256, ...await cas(fixture.store)
    });
    await assert.rejects(
      () => loadApprovedSgosProgramAuthority(fixture.root, compiled.program, { refreshAuthority: false }),
      (error) => error.code === 'SGOS_CAPABILITY_PACK_ACTIVATION_STALE'
    );
  });

  await t.test('superseded', async (st) => {
    const fixture = await repository(st);
    const selected = await activatePack(fixture);
    const compiled = await compileSgosProgramWithApprovedCapabilityPack(
      fixture.root, compilerRequest(selected.pack), { refreshAuthority: false }
    );
    await publishSgosProgramAuthority(fixture.root, compiled);
    await activatePack(fixture, {
      packId: 'finance-next', version: '2.0.0', domain: 'finance',
      operations: ['finance.run', 'finance.verify'], createdAt: '2026-08-30T12:02:00.000Z'
    });
    await assert.rejects(
      () => loadApprovedSgosProgramAuthority(fixture.root, compiled.program, { refreshAuthority: false }),
      (error) => error.code === 'SGOS_CAPABILITY_PACK_SUPERSEDED'
    );
  });

  await t.test('revoked before any Process mutation', async (st) => {
    const fixture = await repository(st);
    const selected = await activatePack(fixture);
    const compiled = await compileSgosProgramWithApprovedCapabilityPack(
      fixture.root, compilerRequest(selected.pack), { refreshAuthority: false }
    );
    await publishSgosProgramAuthority(fixture.root, compiled);
    await fixture.registry.revoke({
      packSha256: selected.pack.recordSha256, reason: 'publisher retired', ...await cas(fixture.store)
    });
    const processRoot = path.join(gitCommonDir(fixture.root), 'singularity-flow', 'sgos', 'processes');
    await assert.rejects(() => startSgosProcess(fixture.root, {
      program: compiled.program,
      taskContractSha256: platformSha256('pack-task-contract'),
      processId: 'PROC-PACK-REVOKED',
      subject: { kind: 'repository', id: 'pack-repository' }
    }), (error) => error.code === 'SGOS_CAPABILITY_PACK_REVOKED');
    assert.equal(await lstat(processRoot).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)), null);
  });

  await t.test('counterfeit approved publisher', async (st) => {
    const publisher = keyPair();
    const impostor = keyPair();
    const fixture = await repository(st, { actualPublisher: publisher, approvedPublisher: impostor });
    const selected = await activatePack(fixture);
    await assert.rejects(
      () => compileSgosProgramWithApprovedCapabilityPack(
        fixture.root, compilerRequest(selected.pack), { refreshAuthority: false }
      ),
      (error) => error.code === 'SGOS_PLATFORM_SIGNATURE_UNTRUSTED'
    );
  });
});

test('repository binding is path-independent, credential-free, and rejects another remote', async (t) => {
  const make = async (remote) => {
    const root = await temporaryDirectory(t, 'sflow-pack-binding-');
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.name', 'Binding');
    git(root, 'config', 'user.email', 'binding@example.test');
    git(root, 'commit', '--allow-empty', '-m', 'root');
    git(root, 'remote', 'add', 'origin', remote);
    return root;
  };
  const first = await make('https://example.test/acme/service.git');
  const second = await make('https://example.test/acme/service.git');
  const other = await make('https://example.test/acme/other.git');
  git(first, 'config', '--local',
    'url.https://mirror.example.test/cache/.insteadOf', 'https://example.test/acme/');
  assert.equal(git(first, 'remote', 'get-url', 'origin'),
    'https://mirror.example.test/cache/service.git');
  assert.equal(await sgosCapabilityPackRepositoryBinding(first),
    await sgosCapabilityPackRepositoryBinding(second),
    'ambient URL rewrites cannot change a durable Program repository binding');
  assert.notEqual(await sgosCapabilityPackRepositoryBinding(first),
    await sgosCapabilityPackRepositoryBinding(other));
  assert.doesNotMatch(await sgosCapabilityPackRepositoryBinding(first), /example|acme|service/);
});

test('v2 transport trust loads from approved offline authority with exact policy and minimum state', async (t) => {
  const fixture = await repository(t);
  const minimumAuthority = {
    revision: 7,
    stateSha256: platformSha256('minimum-state'),
    exportSha256: platformSha256('minimum-export')
  };
  const approved = await approveTransportTrust(fixture, {
    repositoryBinding: {
      remoteFingerprints: [],
      offlineRootCommitsSha256: offlineRootCommitsSha256(fixture.root)
    },
    minimumAuthority
  });
  const loaded = await loadApprovedSgosCapabilityPackTransportTrust(fixture.root, {
    refreshAuthority: false
  });
  assert.equal(loaded.mode, SGOS_CAPABILITY_PACK_TRANSPORT_MODE_SIGNED);
  assert.equal(sgosCapabilityPackTransportMode(approved.manifest),
    SGOS_CAPABILITY_PACK_TRANSPORT_MODE_SIGNED);
  assert.equal(loaded.storeId, fixture.storeId);
  assert.deepEqual(loaded.publishers, approved.manifest.publishers);
  assert.deepEqual(loaded.exporters, approved.manifest.transport.exporters);
  assert.equal(loaded.exporterAuthority, 'full-authority-store-snapshot');
  assert.deepEqual(loaded.minimumAuthority, minimumAuthority);
  assert.equal(loaded.policySha256, platformSha256({
    format: approved.manifest.format,
    storeId: approved.manifest.storeId,
    publishers: approved.manifest.publishers,
    repositoryBinding: approved.manifest.transport.repositoryBinding,
    exporterAuthority: approved.manifest.transport.exporterAuthority,
    exporters: approved.manifest.transport.exporters
  }));
  assert.equal(loaded.repositoryBindingSha256, platformSha256({
    format: 'singularity-flow-sgos-capability-pack-repository-binding/v2',
    identity: {
      kind: 'offline-root-commits',
      sha256: approved.manifest.transport.repositoryBinding.offlineRootCommitsSha256
    }
  }));
  assert.match(loaded.authorityContextSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(loaded.configurationAuthority, {
    kind: 'approved-configuration-ref',
    ref: 'refs/heads/sflow/config',
    commit: git(fixture.root, 'rev-parse', 'sflow/config'),
    sourceCommit: git(fixture.root, 'rev-parse', 'sflow/config'),
    trustMode: 'offline-local-head-authority',
    workspaceId: null,
    repositoryId: null
  });
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.exporters), true);
  assert.doesNotMatch(JSON.stringify({
    repositoryBindingSha256: loaded.repositoryBindingSha256,
    policySha256: loaded.policySha256
  }), new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
});

test('v3 Git-trusted policy is key-free, strict, and binds mode plus approved state target', async (t) => {
  const fixture = await repository(t);
  const remote = 'https://example.test/acme/git-trusted-policy.git';
  git(fixture.root, 'remote', 'add', 'origin', remote);
  const minimumAuthority = {
    revision: 9,
    stateSha256: platformSha256('git-trusted-minimum-state'),
    projectionSha256: platformSha256('git-trusted-minimum-projection')
  };
  const repositoryBinding = {
    remoteFingerprints: [rawRemoteFingerprint(remote)],
    offlineRootCommitsSha256: null
  };
  const manifest = await approveGitTrustedTransport(fixture, {
    repositoryBinding, minimumAuthority
  });
  git(fixture.root, 'update-ref', 'refs/remotes/origin/sflow/config', 'HEAD');

  // A mutable working-tree workflow cannot redirect the already-approved state authority.
  const workflowPath = path.join(fixture.root, 'singularity', 'workflow.yml');
  const workingWorkflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workingWorkflow.ledger.branch = 'unreviewed-state';
  workingWorkflow.ledger.remote = 'unreviewed-remote';
  await writeFile(workflowPath, YAML.stringify(workingWorkflow));

  const loaded = await loadApprovedSgosCapabilityPackTransportTrust(fixture.root, {
    refreshAuthority: false
  });
  const stateAuthority = {
    remote: 'origin',
    branch: 'state',
    targetRef: 'refs/heads/state',
    trackingRef: 'refs/remotes/origin/state'
  };
  assert.equal(loaded.mode, SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED);
  assert.equal(sgosCapabilityPackTransportMode(manifest),
    SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED);
  assert.deepEqual(loaded.stateAuthority, stateAuthority);
  assert.deepEqual(loaded.minimumAuthority, minimumAuthority);
  assert.equal('exporters' in loaded, false);
  assert.equal('exporterAuthority' in loaded, false);
  assert.equal(loaded.policySha256, platformSha256({
    format: SGOS_CAPABILITY_PACK_TRUST_FORMAT_V3,
    mode: SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED,
    storeId: fixture.storeId,
    repositoryBinding,
    stateAuthority
  }));
  assert.equal(loaded.authorityContextSha256, platformSha256({
    format: SGOS_CAPABILITY_PACK_TRUST_FORMAT_V3,
    mode: SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED,
    storeId: fixture.storeId,
    publishers: manifest.publishers,
    repositoryBindingSha256: loaded.repositoryBindingSha256,
    minimumAuthority,
    stateAuthority,
    configurationAuthority: loaded.configurationAuthority
  }));
  assert.notEqual(loaded.policySha256, platformSha256({
    format: SGOS_CAPABILITY_PACK_TRUST_FORMAT_V3,
    storeId: fixture.storeId,
    publishers: manifest.publishers,
    repositoryBinding,
    stateAuthority
  }));
  assert.equal(Object.isFrozen(loaded.stateAuthority), true);
});

test('v3 Git-trusted scaffold and validator forbid signer and exporter authority fields', async (t) => {
  const fixture = await repository(t);
  const offlineBinding = {
    remoteFingerprints: [],
    offlineRootCommitsSha256: offlineRootCommitsSha256(fixture.root)
  };
  assert.throws(() => createSgosCapabilityPackGitTrustedTrustScaffold({
    root: fixture.root,
    storeId: fixture.storeId,
    publishers: {},
    repositoryBinding: offlineBinding
  }), (error) => error.code === 'SGOS_CAPABILITY_PACK_TRUST_INVALID'
    && /requires at least one approved remote fingerprint/u.test(error.message));
  const remote = 'https://example.test/acme/git-trusted-scaffold.git';
  git(fixture.root, 'remote', 'add', 'origin', remote);
  const binding = {
    remoteFingerprints: [rawRemoteFingerprint(remote)],
    offlineRootCommitsSha256: null
  };
  const scaffold = createSgosCapabilityPackGitTrustedTrustScaffold({
    root: fixture.root,
    storeId: fixture.storeId,
    publishers: {},
    stateRemote: 'origin'
  });
  assert.deepEqual(scaffold, {
    format: SGOS_CAPABILITY_PACK_TRUST_FORMAT_V3,
    storeId: fixture.storeId,
    publishers: {},
    transport: {
      mode: SGOS_CAPABILITY_PACK_TRANSPORT_MODE_GIT_TRUSTED,
      repositoryBinding: binding,
      minimumAuthority: null
    }
  });
  assert.doesNotMatch(JSON.stringify(scaffold), /exporter|signer|privateKey/iu);

  for (const transport of [
    { ...scaffold.transport, mode: SGOS_CAPABILITY_PACK_TRANSPORT_MODE_SIGNED },
    { ...scaffold.transport, exporters: {} },
    { ...scaffold.transport, exporterAuthority: 'full-authority-store-snapshot' },
    { ...scaffold.transport, signerKeyId: 'signer-a' }
  ]) {
    assert.throws(() => validateSgosCapabilityPackTrustManifest({
      ...scaffold, transport
    }), (error) => error.code === 'SGOS_CAPABILITY_PACK_AUTHORITY_INVALID'
      || error.code === 'SGOS_CAPABILITY_PACK_TRUST_INVALID');
  }
  assert.throws(() => validateSgosCapabilityPackTrustManifest({
    ...scaffold, signer: 'signer-a'
  }), (error) => error.code === 'SGOS_CAPABILITY_PACK_AUTHORITY_INVALID');
  assert.throws(() => validateSgosCapabilityPackTrustManifest({
    ...scaffold,
    transport: {
      ...scaffold.transport,
      minimumAuthority: {
        revision: 1,
        stateSha256: platformSha256('state'),
        exportSha256: platformSha256('signed-export-is-not-a-git-projection')
      }
    }
  }), (error) => error.code === 'SGOS_CAPABILITY_PACK_AUTHORITY_INVALID');
  assert.throws(() => validateSgosCapabilityPackTrustManifest({
    ...scaffold,
    transport: {
      repositoryBinding: binding,
      minimumAuthority: null
    }
  }), (error) => error.code === 'SGOS_CAPABILITY_PACK_AUTHORITY_INVALID');

  const signed = keyPair();
  const v2 = {
    format: SGOS_CAPABILITY_PACK_TRUST_FORMAT_V2,
    storeId: fixture.storeId,
    publishers: {},
    transport: {
      repositoryBinding: binding,
      exporterAuthority: 'full-authority-store-snapshot',
      exporters: { 'exporter-a': signed.publicKeyPem },
      minimumAuthority: null
    }
  };
  assert.deepEqual(validateSgosCapabilityPackTrustManifest(v2), v2);
  assert.throws(() => validateSgosCapabilityPackTrustManifest({
    ...v2,
    transport: { ...v2.transport, mode: SGOS_CAPABILITY_PACK_TRANSPORT_MODE_SIGNED }
  }), (error) => error.code === 'SGOS_CAPABILITY_PACK_AUTHORITY_INVALID');
});

test('v3 Git-trusted loader returns the custom state target from the same remote-approved view', async (t) => {
  const fixture = await repository(t);
  const applicationRemote = 'https://example.test/acme/application.git';
  const stateRemote = 'https://example.test/acme/configuration-authority.git';
  git(fixture.root, 'remote', 'add', 'upstream', applicationRemote);
  git(fixture.root, 'remote', 'add', 'origin', stateRemote);
  const workflowPath = path.join(fixture.root, 'singularity', 'workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.ledger.branch = 'governed-authority';
  delete workflow.ledger.remote;
  workflow.worldModel.stateBranch = 'world-model-only';
  workflow.worldModel.remote = 'upstream';
  workflow.git.remote = 'upstream';
  await writeFile(workflowPath, YAML.stringify(workflow));
  git(fixture.root, 'add', 'singularity/workflow.yml');
  git(fixture.root, 'commit', '-m', 'approve custom state authority');
  await approveGitTrustedTransport(fixture, {
    repositoryBinding: {
      remoteFingerprints: [rawRemoteFingerprint(stateRemote)],
      offlineRootCommitsSha256: null
    }
  });
  git(fixture.root, 'update-ref', 'refs/remotes/origin/sflow/config', 'HEAD');

  const loaded = await loadApprovedSgosCapabilityPackTransportTrust(fixture.root, {
    refreshAuthority: false
  });
  assert.deepEqual(loaded.stateAuthority, {
    remote: 'origin',
    branch: 'governed-authority',
    targetRef: 'refs/heads/governed-authority',
    trackingRef: 'refs/remotes/origin/governed-authority'
  });
  assert.equal(loaded.configurationAuthority.ref,
    'refs/remotes/origin/sflow/config');
});

test('missing Git-trusted local Store returns only the exact state-sync remediation', async (t) => {
  const fixture = await repository(t);
  const selected = await activatePack(fixture);
  const remote = 'https://example.test/acme/git-trusted-sync-remediation.git';
  git(fixture.root, 'remote', 'add', 'origin', remote);
  await approveGitTrustedTransport(fixture, {
    repositoryBinding: {
      remoteFingerprints: [rawRemoteFingerprint(remote)],
      offlineRootCommitsSha256: null
    }
  });
  git(fixture.root, 'update-ref', 'refs/remotes/origin/sflow/config', 'HEAD');
  const authorityRoot = path.join(
    gitCommonDir(fixture.root), 'singularity-flow', 'sgos',
    'platform-authority', fixture.storeId
  );
  await rm(authorityRoot, { recursive: true, force: true });

  await assert.rejects(
    () => compileSgosProgramWithApprovedCapabilityPack(
      fixture.root, compilerRequest(selected.pack), { refreshAuthority: false }
    ),
    (error) => {
      assert.equal(error.code, 'SGOS_CAPABILITY_PACK_AUTHORITY_UNAVAILABLE');
      assert.match(error.message,
        /Preview and confirm 'singularity-flow authority-store sync'.*approved state branch/u);
      assert.deepEqual(error.details, {
        storeId: fixture.storeId,
        portability: 'git-trusted-authority-store-sync-required',
        remediation: [
          'singularity-flow authority-store sync --json',
          'singularity-flow authority-store sync --confirm sha256:<SYNC-PLAN> --json'
        ]
      });
      assert.doesNotMatch(`${error.message}\n${JSON.stringify(error.details)}`,
        /local-only|machine-local|not transported by approved configuration/iu);
      return true;
    }
  );
  assert.equal(await lstat(authorityRoot).catch((error) =>
    error.code === 'ENOENT' ? null : Promise.reject(error)), null);
});

test('v2 transport trust binds the raw configured remote and refuses another repository', async (t) => {
  const fixture = await repository(t);
  const remote = 'https://example.test/acme/portable-authority.git';
  await approveTransportTrust(fixture, {
    repositoryBinding: {
      remoteFingerprints: [rawRemoteFingerprint(remote)],
      offlineRootCommitsSha256: null
    }
  });
  git(fixture.root, 'remote', 'add', 'origin', remote);
  git(fixture.root, 'update-ref', 'refs/remotes/origin/sflow/config', 'HEAD');
  // A machine-local rewrite changes `git remote get-url`, but not the reviewed raw repository
  // identity. Transport authority must remain stable across that machine-local optimization.
  git(fixture.root, 'config', '--local',
    'url.https://mirror.example.test/cache/.insteadOf', 'https://example.test/acme/');
  const loaded = await loadApprovedSgosCapabilityPackTransportTrust(fixture.root, {
    refreshAuthority: false
  });
  assert.match(loaded.repositoryBindingSha256, /^sha256:[a-f0-9]{64}$/u);
  const selectedAuthority = await withApprovedConfigurationRead(
    fixture.root, async (authority) => authority, {
      preferAuthority: true, refreshAuthority: false, allowLocalHeads: false,
      canonicalRemote: 'origin'
    }
  );
  assert.equal(selectedAuthority.remote, remote,
    'approved configuration stamps the reviewed raw remote, not an ambient rewrite target');

  git(fixture.root, 'remote', 'set-url', 'origin',
    'https://example.test/acme/different-authority.git');
  await assert.rejects(
    () => loadApprovedSgosCapabilityPackTransportTrust(fixture.root, {
      refreshAuthority: false
    }),
    (error) => error.code === 'SGOS_CAPABILITY_PACK_TRANSPORT_REPOSITORY_MISMATCH'
  );
});

test('runtime Pack selection refuses a local Store below the approved minimum', async (t) => {
  const fixture = await repository(t);
  const selected = await activatePack(fixture);
  const remote = 'https://example.test/acme/git-trusted-minimum-runtime.git';
  git(fixture.root, 'remote', 'add', 'origin', remote);
  const local = await fixture.store.read();
  await approveGitTrustedTransport(fixture, {
    repositoryBinding: {
      remoteFingerprints: [rawRemoteFingerprint(remote)],
      offlineRootCommitsSha256: null
    },
    minimumAuthority: {
      revision: local.revision + 1,
      stateSha256: platformSha256('approved-newer-authority-state'),
      projectionSha256: platformSha256('approved-newer-authority-projection')
    }
  });
  git(fixture.root, 'update-ref', 'refs/remotes/origin/sflow/config', 'HEAD');

  await assert.rejects(
    () => compileSgosProgramWithApprovedCapabilityPack(
      fixture.root, compilerRequest(selected.pack), { refreshAuthority: false }
    ),
    (error) => error.code === 'SGOS_CAPABILITY_PACK_AUTHORITY_STALE'
      && /authority-store sync/u.test(error.message)
  );
});

test('runtime Pack selection refuses a v3 Git trust root for another repository', async (t) => {
  const fixture = await repository(t);
  const selected = await activatePack(fixture);
  const actualRemote = 'https://example.test/acme/runtime-authority.git';
  const counterfeitRemote = 'https://example.test/acme/other-authority.git';
  git(fixture.root, 'remote', 'add', 'origin', actualRemote);
  await approveGitTrustedTransport(fixture, {
    repositoryBinding: {
      remoteFingerprints: [rawRemoteFingerprint(counterfeitRemote)],
      offlineRootCommitsSha256: null
    }
  });
  git(fixture.root, 'update-ref', 'refs/remotes/origin/sflow/config', 'HEAD');

  await assert.rejects(
    () => compileSgosProgramWithApprovedCapabilityPack(
      fixture.root, compilerRequest(selected.pack), { refreshAuthority: false }
    ),
    (error) => error.code === 'SGOS_CAPABILITY_PACK_TRANSPORT_REPOSITORY_MISMATCH'
  );
});

test('v2 transport binding selects the observed repository from a shared approved allow-list', async (t) => {
  const first = await repository(t);
  const second = await repository(t);
  const exporter = keyPair();
  const firstRemote = 'https://example.test/acme/portable-first.git';
  const secondRemote = 'https://example.test/acme/portable-second.git';
  const remoteFingerprints = [
    rawRemoteFingerprint(firstRemote), rawRemoteFingerprint(secondRemote)
  ].sort();
  for (const [fixture, remote] of [[first, firstRemote], [second, secondRemote]]) {
    await approveTransportTrust(fixture, {
      exporter,
      repositoryBinding: { remoteFingerprints, offlineRootCommitsSha256: null }
    });
    git(fixture.root, 'remote', 'add', 'origin', remote);
    git(fixture.root, 'update-ref', 'refs/remotes/origin/sflow/config', 'HEAD');
  }
  const [firstTrust, secondTrust] = await Promise.all([
    loadApprovedSgosCapabilityPackTransportTrust(first.root, { refreshAuthority: false }),
    loadApprovedSgosCapabilityPackTransportTrust(second.root, { refreshAuthority: false })
  ]);
  assert.notEqual(firstTrust.repositoryBindingSha256, secondTrust.repositoryBindingSha256);
});

test('v2 transport trust rejects counterfeit exporters and malformed downgrade policies', async () => {
  const exporter = keyPair();
  const base = {
    format: SGOS_CAPABILITY_PACK_TRUST_FORMAT_V2,
    storeId: 'pack-authority',
    publishers: {},
    transport: {
      repositoryBinding: {
        remoteFingerprints: [platformSha256('repository')],
        offlineRootCommitsSha256: null
      },
      exporterAuthority: 'full-authority-store-snapshot',
      exporters: { 'exporter-a': exporter.publicKeyPem },
      minimumAuthority: null
    }
  };
  assert.deepEqual(validateSgosCapabilityPackTrustManifest(base), base);
  assert.deepEqual(validateSgosCapabilityPackTrustManifest({
    format: SGOS_CAPABILITY_PACK_TRUST_FORMAT,
    storeId: 'pack:authority',
    publishers: {}
  }), {
    format: SGOS_CAPABILITY_PACK_TRUST_FORMAT,
    storeId: 'pack:authority',
    publishers: {}
  });
  assert.throws(() => validateSgosCapabilityPackTrustManifest({
    ...base,
    storeId: 'pack:authority'
  }), (error) => error.code === 'SGOS_CAPABILITY_PACK_TRUST_INVALID');
  assert.throws(() => validateSgosCapabilityPackTrustManifest({
    ...base,
    transport: {
      repositoryBinding: base.transport.repositoryBinding,
      exporters: base.transport.exporters,
      minimumAuthority: null
    }
  }), (error) => error.code === 'SGOS_CAPABILITY_PACK_AUTHORITY_INVALID');
  assert.throws(() => validateSgosCapabilityPackTrustManifest({
    ...base,
    transport: { ...base.transport, exporterAuthority: 'transport-only' }
  }), (error) => error.code === 'SGOS_CAPABILITY_PACK_TRUST_INVALID');
  assert.throws(() => validateSgosCapabilityPackTrustManifest({
    ...base,
    transport: {
      ...base.transport,
      exporters: { 'exporter-a': exporter.privateKeyPem }
    }
  }), (error) => error.code === 'SGOS_CAPABILITY_PACK_TRUST_INVALID');
  assert.throws(() => validateSgosCapabilityPackTrustManifest({
    ...base,
    transport: {
      ...base.transport,
      repositoryBinding: { remoteFingerprints: [], offlineRootCommitsSha256: null }
    }
  }), (error) => error.code === 'SGOS_CAPABILITY_PACK_TRUST_INVALID');
  assert.throws(() => validateSgosCapabilityPackTrustManifest({
    ...base,
    transport: {
      ...base.transport,
      minimumAuthority: {
        revision: 1,
        stateSha256: platformSha256('state'),
        exportSha256: 'sha256:not-a-digest'
      }
    }
  }), (error) => error.code === 'SGOS_CAPABILITY_PACK_TRUST_INVALID');
});

test('trust manifest and local Authority Store paths fail closed without traversal or initialization', async (t) => {
  const fixture = await repository(t);
  const selected = await activatePack(fixture);
  const compiled = await compileSgosProgramWithApprovedCapabilityPack(
    fixture.root, compilerRequest(selected.pack), { refreshAuthority: false }
  );
  const cases = [
    ['malformed', '{'],
    ['oversized', 'x'.repeat(256 * 1024 + 1)]
  ];
  for (const [name, bytes] of cases) {
    const root = await temporaryDirectory(t, `sflow-pack-trust-${name}-`);
    await mkdir(path.join(root, 'singularity', 'sgos'), { recursive: true });
    await writeFile(path.join(root, SGOS_CAPABILITY_PACK_TRUST_PATH), bytes);
    await assert.rejects(
      () => verifySgosCapabilityPackAuthorities(
        fixture.root, compiled.program, compiled.capabilityPackAuthorities, { configurationRoot: root }
      ),
      (error) => ['SGOS_CAPABILITY_PACK_TRUST_INVALID'].includes(error.code)
    );
  }
  if (process.platform !== 'win32') {
    const root = await temporaryDirectory(t, 'sflow-pack-trust-link-');
    await mkdir(path.join(root, 'singularity', 'sgos'), { recursive: true });
    const outside = path.join(root, 'outside.json');
    await writeFile(outside, JSON.stringify({}));
    await symlink(outside, path.join(root, SGOS_CAPABILITY_PACK_TRUST_PATH));
    await assert.rejects(
      () => verifySgosCapabilityPackAuthorities(
        fixture.root, compiled.program, compiled.capabilityPackAuthorities, { configurationRoot: root }
      ),
      (error) => error.code === 'SGOS_CAPABILITY_PACK_TRUST_INVALID'
    );

    const parentRoot = await temporaryDirectory(t, 'sflow-pack-trust-parent-link-');
    const parentOutside = await temporaryDirectory(t, 'sflow-pack-trust-parent-outside-');
    await mkdir(path.join(parentOutside, 'sgos'), { recursive: true });
    await writeFile(
      path.join(parentOutside, 'sgos', 'capability-pack-trust.json'),
      JSON.stringify({})
    );
    await symlink(parentOutside, path.join(parentRoot, 'singularity'));
    await assert.rejects(
      () => verifySgosCapabilityPackAuthorities(
        fixture.root, compiled.program, compiled.capabilityPackAuthorities,
        { configurationRoot: parentRoot }
      ),
      (error) => error.code === 'SGOS_CAPABILITY_PACK_TRUST_INVALID'
    );
  }

  const unavailable = await repository(t, { storeId: 'empty-store' });
  // Remove the initialized store to prove an admission read never recreates it.
  const authorityRoot = path.join(
    gitCommonDir(unavailable.root), 'singularity-flow', 'sgos', 'platform-authority', unavailable.storeId
  );
  await rm(authorityRoot, { recursive: true, force: true });
  const selectorWorkflow = compilerRequest(selected.pack).workflow;
  await assert.rejects(
    () => compileSgosProgramWithApprovedCapabilityPack(unavailable.root, {
      ...compilerRequest(selected.pack), workflow: selectorWorkflow
    }, { refreshAuthority: false }),
    (error) => error.code === 'SGOS_CAPABILITY_PACK_AUTHORITY_UNAVAILABLE'
  );
  assert.equal(await lstat(authorityRoot).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)), null);
});
