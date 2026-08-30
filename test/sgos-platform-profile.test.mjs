import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAcceptedTrace,
  createCapabilityPack,
  createCapabilityPackRegistry,
  createMemoryCandidate,
  createMemoryRef,
  createMetaToolCandidate,
  createMetaToolEvaluation,
  createMetaToolService,
  createPackReview,
  createPlatformEnvelope,
  createPlatformMemoryService,
  createReadOnlyLessonCatalog,
  createSecretBrokerAttestation,
  createSecretHandle,
  createSecretBrokerRegistry,
  loadApprovedPlatformMutationAuthority,
  openFilesystemAuthorityStore,
  platformPrincipalId,
  platformSha256,
  signPlatformRecord,
  validatePlatformEnvelope,
  verifyPortableAuthorityExport
} from '../src/sgos/platform/index.mjs';

const at = '2026-08-30T10:00:00.000Z';
const d = (value) => platformSha256(`fixture:${value}`);

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' })
  };
}

async function temporaryDirectory(t, prefix = 'sflow-sgos-platform-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function cas(store) {
  const state = await store.read();
  return { expectedRevision: state.revision, expectedStateSha256: state.recordSha256 };
}

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

async function platformRepository(root) {
  const actorEmail = 'platform.actor@example.test';
  const reviewerEmail = 'platform.reviewer@example.test';
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Platform Actor');
  git(root, 'config', 'user.email', actorEmail);
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  const members = [actorEmail, reviewerEmail]
    .map((email) => `      - { email: ${email} }`).join('\n');
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), [
    'version: 2',
    'approvalAuthorities:',
    '  architecture-reviewers:',
    '    members:', members,
    '  engineering-reviewers:',
    '    members:', members,
    '  quality-reviewers:',
    '    members:', members,
    ''
  ].join('\n'));
  git(root, 'add', 'singularity/workflow.yml');
  git(root, 'commit', '-m', 'approved platform authority');
  git(root, 'branch', 'sflow/config');
  return {
    actorEmail,
    actorId: platformPrincipalId({ email: actorEmail }),
    reviewerEmail,
    reviewerId: platformPrincipalId({ email: reviewerEmail })
  };
}

function authorityLockFixture({
  storeId,
  lockVersion = 1,
  token = '00000000-0000-4000-8000-000000000001',
  host = os.hostname(),
  pid = 2_147_483_647,
  acquiredAt = '2000-01-01T00:00:00.000Z',
  expiresAt = '2000-01-01T00:01:00.000Z'
}) {
  const core = {
    lockFormat: 'sflow.sgos.authority-store-lock',
    lockVersion,
    storeId,
    token,
    host,
    pid,
    acquiredAt,
    expiresAt
  };
  return { ...core, ownerSha256: platformSha256(core) };
}

test('platform mutations derive one configured Git identity and refuse spoofed, dirty, or stale authority', async (t) => {
  const directory = await temporaryDirectory(t, 'sflow-sgos-platform-authority-');
  const expected = await platformRepository(directory);
  const authorized = await loadApprovedPlatformMutationAuthority(directory, 'pack.activate');
  assert.equal(authorized.actorId, expected.actorId);
  assert.equal(authorized.authorityGroup, 'architecture-reviewers');
  assert.equal(authorized.configurationRef, 'refs/heads/sflow/config');

  git(directory, 'config', 'user.email', 'platform.outsider@example.test');
  await assert.rejects(
    () => loadApprovedPlatformMutationAuthority(directory, 'pack.activate'),
    (error) => error.code === 'SGOS_PLATFORM_MUTATION_UNAUTHORIZED'
  );
  git(directory, 'config', 'user.email', expected.actorEmail);

  const workflowPath = path.join(directory, 'singularity', 'workflow.yml');
  const approvedBytes = await readFile(workflowPath, 'utf8');
  await writeFile(workflowPath, `${approvedBytes}# unapproved local edit\n`);
  await assert.rejects(
    () => loadApprovedPlatformMutationAuthority(directory, 'pack.activate'),
    (error) => error.code === 'SGOS_PLATFORM_CONFIGURATION_DIRTY'
  );
  await writeFile(workflowPath, approvedBytes);

  const worktreeParent = await temporaryDirectory(t, 'sflow-sgos-platform-config-worktree-');
  const authorityCheckout = path.join(worktreeParent, 'config');
  git(directory, 'worktree', 'add', authorityCheckout, 'sflow/config');
  await writeFile(path.join(authorityCheckout, 'singularity', 'workflow.yml'),
    `${approvedBytes}# newer approved authority\n`);
  git(authorityCheckout, 'add', 'singularity/workflow.yml');
  git(authorityCheckout, 'commit', '-m', 'advance approved platform authority');
  git(directory, 'worktree', 'remove', '--force', authorityCheckout);
  await assert.rejects(
    () => loadApprovedPlatformMutationAuthority(directory, 'pack.activate'),
    (error) => error.code === 'SGOS_PLATFORM_CONFIGURATION_UNAPPROVED'
  );
});

test('platform records use a strict self-hashed versioned envelope without claiming a registered schema family', () => {
  const ref = createMemoryRef({
    memoryId: 'memory-a', version: 1, class: 'input', scope: 'repository',
    contentSha256: d('content'), authorityStoreId: 'authority-a', sensitivity: 'internal',
    dependencies: [], createdAt: at
  });
  const envelope = createPlatformEnvelope(ref);
  assert.equal(envelope.platformVersion, 1);
  assert.equal(envelope.platformFormat, 'sflow.sgos.platform-envelope');
  assert.equal(Object.hasOwn(envelope, 'schemaVersion'), false);
  assert.equal(validatePlatformEnvelope(envelope, 'platform-memory-ref').record.recordSha256, ref.recordSha256);

  const unknown = structuredClone(ref);
  unknown.ambientAuthority = true;
  delete unknown.recordSha256;
  unknown.recordSha256 = platformSha256(unknown);
  assert.throws(() => createPlatformEnvelope(unknown), /unknown field/);

  const tampered = structuredClone(envelope);
  tampered.record.contentSha256 = d('different');
  assert.throws(() => validatePlatformEnvelope(tampered), (error) =>
    ['SGOS_PLATFORM_RECORD_TAMPERED', 'SGOS_PLATFORM_ENVELOPE_TAMPERED'].includes(error.code));
});

test('experimental filesystem Authority Store enforces CAS, append-only lineage, symlink safety, and trusted exports', async (t) => {
  const directory = await temporaryDirectory(t);
  const store = await openFilesystemAuthorityStore({ root: path.join(directory, 'authority'), storeId: 'authority-local' });
  const genesis = await store.read();
  assert.equal(genesis.revision, 0);

  const first = await store.transact({
    expectedRevision: 0,
    expectedStateSha256: genesis.recordSha256,
    actorId: 'operator-a',
    changes: [{ op: 'put', key: 'policy:alpha', value: { enabled: true } }]
  });
  assert.equal(first.revision, 1);
  await assert.rejects(() => store.transact({
    expectedRevision: 0,
    expectedStateSha256: genesis.recordSha256,
    actorId: 'operator-b',
    changes: [{ op: 'put', key: 'policy:beta', value: { enabled: true } }]
  }), (error) => error.code === 'SGOS_AUTHORITY_CAS_MISMATCH');

  const second = await store.transact({
    expectedRevision: first.revision,
    expectedStateSha256: first.recordSha256,
    actorId: 'operator-a',
    changes: [{ op: 'put', key: 'policy:beta', value: { enabled: false } }]
  });
  assert.equal(second.revision, 2);
  assert.equal((await store.verify()).valid, true);
  assert.equal((await readdir(path.join(store.root, 'events'))).length, 2);

  const signer = keys();
  const signedExport = await store.exportPortable({ privateKeyPem: signer.privateKeyPem, keyId: 'authority-export-key' });
  assert.deepEqual(verifyPortableAuthorityExport(signedExport, {
    trustedPublicKeyPem: signer.publicKeyPem,
    expectedKeyId: 'authority-export-key',
    expectedStoreId: 'authority-local'
  }), {
    valid: true,
    storeId: 'authority-local',
    revision: 2,
    stateSha256: second.recordSha256,
    exportSha256: signedExport.record.recordSha256
  });
  const stranger = keys();
  assert.throws(() => verifyPortableAuthorityExport(signedExport, {
    trustedPublicKeyPem: stranger.publicKeyPem,
    expectedKeyId: 'authority-export-key'
  }), (error) => error.code === 'SGOS_PLATFORM_SIGNATURE_UNTRUSTED');

  const eventFile = path.join(store.root, 'events', `${second.eventSha256.slice(7)}.json`);
  const originalEvent = await readFile(eventFile, 'utf8');
  const corrupted = JSON.parse(originalEvent);
  corrupted.record.actorId = 'attacker';
  await writeFile(eventFile, JSON.stringify(corrupted));
  await assert.rejects(() => store.verify(), (error) =>
    ['SGOS_PLATFORM_RECORD_TAMPERED', 'SGOS_PLATFORM_ENVELOPE_TAMPERED'].includes(error.code));
  await writeFile(eventFile, originalEvent);

  await writeFile(path.join(store.root, 'state.json'), JSON.stringify(createPlatformEnvelope(first)));
  await assert.rejects(() => store.verify(), (error) =>
    error.code === 'SGOS_AUTHORITY_ROLLBACK_OR_PARTIAL_WRITE');
  const recovery = await store.planRecovery();
  assert.equal(recovery.required, true);
  assert.equal(recovery.orphanEventCount, 1);
  assert.equal(recovery.recoveryPlan.beforeStateSha256, first.recordSha256);
  assert.equal(recovery.recoveryPlan.afterStateSha256, second.recordSha256);
  await assert.rejects(() => store.recover({ confirmationSha256: d('stale-authority-plan') }),
    (error) => error.code === 'SGOS_AUTHORITY_RECOVERY_CONFIRMATION_MISMATCH');
  assert.deepEqual(await store.recover({
    confirmationSha256: recovery.recoveryPlan.confirmationSha256
  }), {
    recovered: true,
    storeId: 'authority-local',
    revision: 2,
    stateSha256: second.recordSha256,
    recoveredEventCount: 1,
    recoveryPlanSha256: recovery.recoveryPlan.confirmationSha256
  });
  assert.equal((await store.verify()).revision, 2);

  const real = path.join(directory, 'real-store');
  const linked = path.join(directory, 'linked-store');
  await openFilesystemAuthorityStore({ root: real, storeId: 'authority-real' });
  await symlink(real, linked, 'dir');
  await assert.rejects(() => openFilesystemAuthorityStore({ root: linked, storeId: 'authority-real' }),
    (error) => error.code === 'SGOS_AUTHORITY_PATH_UNSAFE');
});

test('Authority Store honors liveness and TTL while refusing acquiring and future-version locks', async (t) => {
  const directory = await temporaryDirectory(t);
  const store = await openFilesystemAuthorityStore({
    root: path.join(directory, 'authority-locks'), storeId: 'authority-locks'
  });
  const lock = path.join(store.root, '.transaction-lock');

  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify(authorityLockFixture({
    storeId: store.storeId
  })));
  const before = await store.read();
  const after = await store.transact({
    expectedRevision: before.revision,
    expectedStateSha256: before.recordSha256,
    actorId: 'operator-lock-recovery',
    changes: [{ op: 'put', key: 'policy:recovered', value: { enabled: true } }]
  });
  assert.equal(after.revision, 1);
  const reclaimed = (await readdir(store.root)).filter((name) =>
    name.startsWith('.transaction-lock.reclaimed-'));
  assert.equal(reclaimed.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(store.root, reclaimed[0], 'owner.json'), 'utf8')).pid,
    2_147_483_647);

  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify(authorityLockFixture({
    storeId: store.storeId,
    token: '00000000-0000-4000-8000-000000000002',
    pid: process.pid,
    acquiredAt: '2020-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:01:00.000Z'
  })));
  await assert.rejects(() => store.transact({
    expectedRevision: after.revision,
    expectedStateSha256: after.recordSha256,
    actorId: 'operator-live-refusal',
    changes: [{ op: 'put', key: 'policy:unsafe', value: true }]
  }), (error) => error.code === 'SGOS_AUTHORITY_STORE_BUSY');
  assert.equal(JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')).pid, process.pid);

  await rm(lock, { recursive: true });
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify(authorityLockFixture({
    storeId: store.storeId,
    token: '00000000-0000-4000-8000-000000000004',
    pid: process.pid
  })));
  const afterReusedPid = await store.transact({
    expectedRevision: after.revision,
    expectedStateSha256: after.recordSha256,
    actorId: 'operator-expired-pid-recovery',
    changes: [{ op: 'put', key: 'policy:pid-reused', value: { recovered: true } }]
  });
  assert.equal(afterReusedPid.revision, 2);
  assert.equal((await readdir(store.root)).filter((name) =>
    name.startsWith('.transaction-lock.reclaimed-')).length, 2);

  await mkdir(lock, { mode: 0o700 });
  await assert.rejects(() => store.transact({
    expectedRevision: afterReusedPid.revision,
    expectedStateSha256: afterReusedPid.recordSha256,
    actorId: 'operator-acquiring-refusal',
    changes: [{ op: 'put', key: 'policy:unsafe', value: true }]
  }), (error) => error.code === 'SGOS_AUTHORITY_STORE_BUSY');

  await rm(lock, { recursive: true });
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), JSON.stringify(authorityLockFixture({
    storeId: store.storeId,
    lockVersion: 2,
    token: '00000000-0000-4000-8000-000000000003'
  })));
  await assert.rejects(() => store.transact({
    expectedRevision: afterReusedPid.revision,
    expectedStateSha256: afterReusedPid.recordSha256,
    actorId: 'operator-future-refusal',
    changes: [{ op: 'put', key: 'policy:unsafe', value: true }]
  }), (error) => error.code === 'SGOS_AUTHORITY_LOCK_VERSION_UNSUPPORTED');
  assert.equal(JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')).lockVersion, 2);
});

test('typed memory promotion is immutable, confirmation-bound, and invalidates derived dependencies', async (t) => {
  const directory = await temporaryDirectory(t);
  const authority = await platformRepository(directory);
  const store = await openFilesystemAuthorityStore({ root: path.join(directory, 'authority'), storeId: 'memory-authority' });
  const memory = createPlatformMemoryService({
    authorityStore: store, repositoryRoot: directory
  });
  const baseV1 = createMemoryRef({
    memoryId: 'base-memory', version: 1, class: 'approved-guidance', scope: 'repository',
    contentSha256: d('base-v1'), authorityStoreId: store.storeId, sensitivity: 'internal',
    dependencies: [], createdAt: at
  });
  const baseCandidate = createMemoryCandidate({
    candidateId: 'candidate-base-v1', proposedRef: baseV1,
    sourceRefs: [d('base-source')], evidenceRefs: [d('base-evidence')],
    proposerId: 'proposer-a', createdAt: at
  });
  await memory.registerCandidate(baseCandidate, await cas(store));
  const beforeBasePromotion = await cas(store);
  await assert.rejects(() => memory.promote({
    candidateId: baseCandidate.candidateId,
    confirmCandidateSha256: d('stale-candidate'),
    reason: 'reviewed', ...beforeBasePromotion
  }), (error) => error.code === 'SGOS_MEMORY_CONFIRMATION_MISMATCH');
  const basePromotion = await memory.promote({
    candidateId: baseCandidate.candidateId,
    confirmCandidateSha256: baseCandidate.recordSha256,
    reason: 'reviewed', ...beforeBasePromotion
  });
  assert.equal(basePromotion.promotion.reviewerId, authority.actorId);

  const derived = createMemoryRef({
    memoryId: 'derived-memory', version: 1, class: 'derived', scope: 'repository',
    contentSha256: d('derived-v1'), authorityStoreId: store.storeId, sensitivity: 'internal',
    dependencies: [{ memoryId: baseV1.memoryId, version: 1, refSha256: baseV1.recordSha256 }],
    createdAt: at
  });
  const derivedCandidate = createMemoryCandidate({
    candidateId: 'candidate-derived-v1', proposedRef: derived,
    sourceRefs: [d('derived-source')], evidenceRefs: [d('derived-evidence')],
    proposerId: 'proposer-a', createdAt: at
  });
  await memory.registerCandidate(derivedCandidate, await cas(store));
  await memory.promote({
    candidateId: derivedCandidate.candidateId,
    confirmCandidateSha256: derivedCandidate.recordSha256,
    reason: 'dependency reviewed', ...await cas(store)
  });
  assert.equal((await memory.resolve(derived)).recordSha256, derived.recordSha256);

  const cyclicBaseV2 = createMemoryRef({
    memoryId: baseV1.memoryId, version: 2, class: baseV1.class, scope: baseV1.scope,
    contentSha256: d('base-v2-cycle'), authorityStoreId: baseV1.authorityStoreId,
    sensitivity: baseV1.sensitivity,
    dependencies: [{
      memoryId: derived.memoryId, version: derived.version, refSha256: derived.recordSha256
    }],
    createdAt: '2026-08-30T10:30:00.000Z'
  });
  const cyclicCandidate = createMemoryCandidate({
    candidateId: 'candidate-base-v2-cycle', proposedRef: cyclicBaseV2,
    sourceRefs: [d('cycle-source')], evidenceRefs: [d('cycle-evidence')],
    proposerId: 'proposer-cycle', createdAt: '2026-08-30T10:30:00.000Z'
  });
  await memory.registerCandidate(cyclicCandidate, await cas(store));
  const beforeCyclicPromotion = await cas(store);
  await assert.rejects(() => memory.promote({
    candidateId: cyclicCandidate.candidateId,
    confirmCandidateSha256: cyclicCandidate.recordSha256,
    reason: 'would create an immediately invalid graph',
    ...beforeCyclicPromotion
  }), (error) => ['SGOS_MEMORY_DEPENDENCY_INVALIDATED', 'SGOS_MEMORY_DEPENDENCY_INVALID'].includes(error.code));

  const baseV2 = createMemoryRef({
    memoryId: baseV1.memoryId, version: 2, class: baseV1.class, scope: baseV1.scope,
    contentSha256: d('base-v2'), authorityStoreId: baseV1.authorityStoreId,
    sensitivity: baseV1.sensitivity, dependencies: [],
    createdAt: '2026-08-30T11:00:00.000Z'
  });
  const baseCandidateV2 = createMemoryCandidate({
    candidateId: 'candidate-base-v2', proposedRef: baseV2,
    sourceRefs: [d('base-source-v2')], evidenceRefs: [d('base-evidence-v2')],
    proposerId: 'proposer-b', createdAt: '2026-08-30T11:00:00.000Z'
  });
  await memory.registerCandidate(baseCandidateV2, await cas(store));
  await memory.promote({
    candidateId: baseCandidateV2.candidateId,
    confirmCandidateSha256: baseCandidateV2.recordSha256,
    reason: 'new approved version', ...await cas(store)
  });
  await assert.rejects(() => memory.resolve(derived), (error) => error.code === 'SGOS_MEMORY_DEPENDENCY_INVALIDATED');
  const inspection = await memory.inspect(derived.memoryId);
  assert.equal(inspection.valid, false);
  assert.equal(inspection.error.code, 'SGOS_MEMORY_DEPENDENCY_INVALIDATED');

  const cacheRef = createMemoryRef({
    memoryId: 'cache-memory', version: 1, class: 'cache', scope: 'repository',
    contentSha256: d('cache'), authorityStoreId: store.storeId, sensitivity: 'internal',
    dependencies: [], createdAt: '2026-08-30T12:00:00.000Z'
  });
  const cacheCandidate = createMemoryCandidate({
    candidateId: 'candidate-cache-v1', proposedRef: cacheRef,
    sourceRefs: [d('cache-source')], evidenceRefs: [d('cache-evidence')],
    proposerId: 'proposer-cache', createdAt: '2026-08-30T12:00:00.000Z'
  });
  await memory.registerCandidate(cacheCandidate, await cas(store));
  const beforeCachePromotion = await cas(store);
  await assert.rejects(() => memory.promote({
    candidateId: cacheCandidate.candidateId,
    confirmCandidateSha256: cacheCandidate.recordSha256,
    reason: 'must remain local', ...beforeCachePromotion
  }), (error) => error.code === 'SGOS_MEMORY_CLASS_FORBIDDEN');
});

test('secret broker registry retains only signed opaque-reference digests and fails closed on scope or revocation', () => {
  const issuer = keys();
  const attestation = createSecretBrokerAttestation({
    brokerId: 'broker-local', purposes: ['database-read'], audiences: ['task-runner'],
    validFrom: '2026-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z',
    issuerKeyId: 'broker-issuer'
  });
  const signedAttestation = signPlatformRecord(attestation, {
    privateKeyPem: issuer.privateKeyPem, keyId: 'broker-issuer'
  });
  const registry = createSecretBrokerRegistry({ trustedIssuers: { 'broker-issuer': issuer.publicKeyPem } });
  registry.registerBroker(signedAttestation);
  const rawSecretHandle = 'vault://production/a-super-secret-handle';
  const handleRecord = createSecretHandle({
    handleId: 'handle-production-database', brokerId: 'broker-local',
    brokerAttestationSha256: attestation.recordSha256,
    opaqueReferenceSha256: platformSha256(rawSecretHandle), purpose: 'database-read',
    audience: 'task-runner', expiresAt: '2029-01-01T00:00:00.000Z',
    attestedAt: '2026-01-02T00:00:00.000Z'
  });
  const signedHandle = signPlatformRecord(handleRecord, {
    privateKeyPem: issuer.privateKeyPem, keyId: 'broker-issuer'
  });
  const handle = registry.registerHandle(signedHandle);
  assert.equal(handle.opaqueReferenceSha256, platformSha256(rawSecretHandle));
  assert.doesNotMatch(JSON.stringify(registry.snapshot()), /a-super-secret-handle|vault:\/\/production/);
  assert.equal(registry.verifyHandle(handle.recordSha256, {
    purpose: 'database-read', audience: 'task-runner'
  }).retrievable, false);
  assert.throws(() => registry.verifyHandle(handle.recordSha256, {
    purpose: 'database-write', audience: 'task-runner'
  }), (error) => error.code === 'SGOS_SECRET_SCOPE_DENIED');
  registry.revokeHandle(handle.recordSha256);
  assert.throws(() => registry.verifyHandle(handle.recordSha256, {
    purpose: 'database-read', audience: 'task-runner'
  }), (error) => error.code === 'SGOS_SECRET_HANDLE_REVOKED');
  assert.equal(Object.hasOwn(registry, 'attestHandle'), false);
  assert.throws(() => registry.registerHandle({ ...signedHandle, secret: 'raw-value' }),
    /unknown field 'secret'/);
});

test('signed declarative packs require exact review, activate by domain digest, revoke immediately, and feed a read-only role catalog', async (t) => {
  const directory = await temporaryDirectory(t);
  const authority = await platformRepository(directory);
  const store = await openFilesystemAuthorityStore({ root: path.join(directory, 'authority'), storeId: 'pack-authority' });
  const publisher = keys();
  const registry = createCapabilityPackRegistry({
    authorityStore: store,
    repositoryRoot: directory,
    trustedPublishers: { 'publisher-a': publisher.publicKeyPem }
  });
  const pack = createCapabilityPack({
    packId: 'software-delivery', version: '1.0.0', domain: 'software-delivery',
    operations: ['code-verify'], permissions: ['repository-read'], files: [],
    lessons: [{
      lessonId: 'recovery-basics', roles: ['developer', 'reviewer'],
      title: 'Safe recovery', contentSha256: d('lesson')
    }],
    provenanceSha256: d('provenance'), sbomSha256: d('sbom'),
    publisherKeyId: 'publisher-a', createdAt: at
  });
  const signedPack = signPlatformRecord(pack, { privateKeyPem: publisher.privateKeyPem, keyId: 'publisher-a' });
  const impostor = keys();
  const forgedPack = signPlatformRecord(pack, { privateKeyPem: impostor.privateKeyPem, keyId: 'publisher-a' });
  const beforeForgedProposal = await cas(store);
  await assert.rejects(() => registry.propose(forgedPack, {
    ...beforeForgedProposal
  }), (error) => error.code === 'SGOS_PLATFORM_SIGNATURE_UNTRUSTED');
  await registry.propose(signedPack, await cas(store));
  const [proposalEventFile] = await readdir(path.join(directory, 'authority', 'events'));
  const proposalEvent = JSON.parse(await readFile(
    path.join(directory, 'authority', 'events', proposalEventFile), 'utf8'
  )).record;
  assert.equal(proposalEvent.actorId, authority.actorId);
  assert.equal(proposalEvent.authorization.operation, 'pack.propose');
  assert.equal(proposalEvent.authorization.authorityGroup, 'engineering-reviewers');
  assert.match(proposalEvent.authorization.configurationCommit, /^[a-f0-9]{40,64}$/);
  const beforeRefusedActivation = await cas(store);
  await assert.rejects(() => registry.activate({
    domain: pack.domain,
    packSha256: pack.recordSha256,
    reviewSha256: d('missing-review'),
    confirmPackSha256: pack.recordSha256,
    ...beforeRefusedActivation
  }), (error) => error.code === 'SGOS_CAPABILITY_PACK_REVIEW_REQUIRED');

  const spoofedReview = createPackReview({
    packSha256: pack.recordSha256, reviewerId: 'attacker', decision: 'approved',
    reason: 'forged identity', reviewedAt: at
  });
  const beforeSpoofedReview = await cas(store);
  await assert.rejects(
    () => registry.recordReview(spoofedReview, beforeSpoofedReview),
    (error) => error.code === 'SGOS_CAPABILITY_PACK_REVIEWER_MISMATCH'
  );
  assert.deepEqual(await cas(store), beforeSpoofedReview);

  const review = createPackReview({
    packSha256: pack.recordSha256, reviewerId: authority.actorId, decision: 'approved',
    reason: 'declarative contents reviewed', reviewedAt: at
  });
  await registry.recordReview(review, await cas(store));
  const activation = await registry.activate({
    domain: pack.domain,
    packSha256: pack.recordSha256,
    reviewSha256: review.recordSha256,
    confirmPackSha256: pack.recordSha256,
    ...await cas(store)
  });
  assert.equal(activation.packSha256, pack.recordSha256);
  assert.equal(activation.activatedBy, authority.actorId);
  assert.equal((await registry.resolveActive(pack.domain, pack.recordSha256)).recordSha256, pack.recordSha256);
  await assert.rejects(() => registry.resolveActive(pack.domain, d('other-pack')),
    (error) => error.code === 'SGOS_CAPABILITY_PACK_SELECTION_MISMATCH');

  const catalog = createReadOnlyLessonCatalog({ packRegistry: registry });
  assert.deepEqual((await catalog.list({ role: 'developer' })).map((lesson) => lesson.lessonId), ['recovery-basics']);
  assert.deepEqual(await catalog.list({ role: 'quality-reviewer' }), []);
  assert.equal(Object.hasOwn(catalog, 'complete'), false);
  await assert.rejects(() => catalog.list({ role: 'Playwright Test Engineer' }),
    (error) => error.code === 'SGOS_LEARN_ROLE_INVALID');

  await registry.revoke({
    packSha256: pack.recordSha256,
    reason: 'publisher key retired',
    ...await cas(store)
  });
  await assert.rejects(() => registry.resolveActive(pack.domain, pack.recordSha256),
    (error) => error.code === 'SGOS_CAPABILITY_PACK_NOT_ACTIVE');
  assert.deepEqual(await catalog.list({ role: 'developer' }), []);
});

test('meta-tool review packets require trusted accepted traces, independent human confirmation, and all evaluation gates', async (t) => {
  const directory = await temporaryDirectory(t);
  const authority = await platformRepository(directory);
  const store = await openFilesystemAuthorityStore({ root: path.join(directory, 'authority'), storeId: 'meta-authority' });
  const traceIssuer = keys();
  const evaluator = keys();
  const service = createMetaToolService({
    authorityStore: store,
    repositoryRoot: directory,
    trustedTraceIssuers: { 'trace-issuer': traceIssuer.publicKeyPem },
    trustedEvaluators: { 'evaluator-a': evaluator.publicKeyPem }
  });
  assert.throws(() => createAcceptedTrace({
    traceSha256: d('bad-trace'), evidenceSha256: d('bad-evidence'),
    verificationReceiptSha256: d('bad-verification'), outcomeAcceptanceSha256: d('bad-outcome'),
    containsSecrets: true, unresolvedGaps: 0, issuerKeyId: 'trace-issuer', acceptedAt: at
  }), /no secrets/);

  const traces = ['one', 'two'].map((name) => createAcceptedTrace({
    traceSha256: d(`trace-${name}`), evidenceSha256: d(`evidence-${name}`),
    verificationReceiptSha256: d(`verification-${name}`), outcomeAcceptanceSha256: d(`outcome-${name}`),
    containsSecrets: false, unresolvedGaps: 0, issuerKeyId: 'trace-issuer', acceptedAt: at
  }));
  const signedTraces = traces.map((trace) => signPlatformRecord(trace, {
    privateKeyPem: traceIssuer.privateKeyPem, keyId: 'trace-issuer'
  }));
  const candidate = createMetaToolCandidate({
    candidateId: 'candidate-meta-one', operationId: 'operation-format-result',
    traceRefs: traces.map((trace) => trace.traceSha256).sort(),
    proposerId: authority.actorId, createdAt: at
  });
  await service.propose(candidate, signedTraces, await cas(store));

  const blockedEvaluation = createMetaToolEvaluation({
    candidateSha256: candidate.recordSha256,
    securityGate: 'passed', qualityGate: 'failed', costGate: 'passed',
    holdoutSha256: d('holdout-one'), evaluatorKeyId: 'evaluator-a', evaluatedAt: at
  });
  await service.recordEvaluation(signPlatformRecord(blockedEvaluation, {
    privateKeyPem: evaluator.privateKeyPem, keyId: 'evaluator-a'
  }), await cas(store));
  const beforeBlockedPromotion = await cas(store);
  await assert.rejects(() => service.promote({
    candidateSha256: candidate.recordSha256,
    evaluationSha256: blockedEvaluation.recordSha256,
    confirmCandidateSha256: candidate.recordSha256,
    confirmEvaluationSha256: blockedEvaluation.recordSha256,
    decision: 'approved', reason: 'reviewed',
    ...beforeBlockedPromotion
  }), (error) => error.code === 'SGOS_META_TOOL_EVALUATION_BLOCKED');

  const passingEvaluation = createMetaToolEvaluation({
    candidateSha256: candidate.recordSha256,
    securityGate: 'passed', qualityGate: 'passed', costGate: 'passed',
    holdoutSha256: d('holdout-two'), evaluatorKeyId: 'evaluator-a',
    evaluatedAt: '2026-08-30T11:00:00.000Z'
  });
  await service.recordEvaluation(signPlatformRecord(passingEvaluation, {
    privateKeyPem: evaluator.privateKeyPem, keyId: 'evaluator-a'
  }), await cas(store));
  const beforeSelfReview = await cas(store);
  await assert.rejects(() => service.promote({
    candidateSha256: candidate.recordSha256,
    evaluationSha256: passingEvaluation.recordSha256,
    confirmCandidateSha256: candidate.recordSha256,
    confirmEvaluationSha256: passingEvaluation.recordSha256,
    decision: 'approved', reason: 'self review',
    ...beforeSelfReview
  }), (error) => error.code === 'SGOS_META_TOOL_HUMAN_APPROVAL_REQUIRED');

  git(directory, 'config', 'user.name', 'Platform Reviewer');
  git(directory, 'config', 'user.email', authority.reviewerEmail);
  const promotion = await service.promote({
    candidateSha256: candidate.recordSha256,
    evaluationSha256: passingEvaluation.recordSha256,
    confirmCandidateSha256: candidate.recordSha256,
    confirmEvaluationSha256: passingEvaluation.recordSha256,
    decision: 'approved', reason: 'independent review completed',
    ...await cas(store)
  });
  assert.equal(promotion.status, 'pack-review-required');
  assert.equal(promotion.reviewerId, authority.reviewerId);
  assert.equal(service.profile, 'review-packet-only-v1');
  assert.equal(Object.hasOwn(service, 'activate'), false);
});
