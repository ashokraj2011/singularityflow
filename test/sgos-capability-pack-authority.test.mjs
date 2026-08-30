import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';
import {
  SGOS_BUILTIN_CORE_CAPABILITY_PACK_AUTHORITY,
  SGOS_CAPABILITY_PACK_TRUST_FORMAT,
  SGOS_CAPABILITY_PACK_TRUST_PATH,
  capabilityPackAuthoritiesForCompilation,
  sgosCapabilityPackRepositoryBinding,
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
  assert.equal(await sgosCapabilityPackRepositoryBinding(first),
    await sgosCapabilityPackRepositoryBinding(second));
  assert.notEqual(await sgosCapabilityPackRepositoryBinding(first),
    await sgosCapabilityPackRepositoryBinding(other));
  assert.doesNotMatch(await sgosCapabilityPackRepositoryBinding(first), /example|acme|service/);
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
