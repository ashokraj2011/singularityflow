import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, utimes, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/records.mjs';
import {
  authorityTransportEntryValidator, authorityTransportRollbackValidator,
  parseAuthorityTransport, serializeAuthorityTransport
} from '../src/sgos/authority-transport.mjs';
import {
  createAuthorityRollback, createAuthorityState, createAuthorityTransactionEvent, createCapabilityPack,
  createPackActivation, createPackReview, createPackRevocation, createPlatformEnvelope,
  createPlatformMutationAuthorization, openFilesystemAuthorityStore,
  planPortableAuthorityImport, platformSha256, signPlatformRecord,
  validateCapabilityPackTransportRollback,
  verifyPortableAuthorityTransport
} from '../src/sgos/platform/index.mjs';

const at = '2026-09-01T10:00:00.000Z';

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' })
  };
}

function authorization(operation, actorId = 'git-email:transport-actor') {
  return createPlatformMutationAuthorization({
    operation,
    authorityGroup: 'architecture-reviewers',
    actorId,
    identityAssurance: 'configured-local',
    configurationKind: 'approved-configuration-ref',
    configurationRef: 'refs/heads/sflow/config',
    configurationCommit: 'a'.repeat(40),
    workflowSha256: platformSha256('transport-workflow'),
    authoritySha256: platformSha256(`transport-authority:${operation}`),
    authorizedAt: at
  });
}

async function directory(t, prefix) {
  const result = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(result, { recursive: true, force: true }));
  return result;
}

function lockOwner(storeId, {
  host = os.hostname(), pid = process.pid,
  acquiredAt = Date.now() - 120_000, expiresAt = Date.now() - 90_000
} = {}) {
  const core = {
    lockFormat: 'sflow.sgos.authority-store-lock',
    lockVersion: 1,
    storeId,
    token: randomUUID(),
    host,
    pid,
    acquiredAt: new Date(acquiredAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString()
  };
  return { ...core, ownerSha256: platformSha256(core) };
}

async function installCutoverLock(parent, storeId, owner, { heartbeatAt = Date.now() } = {}) {
  const lock = path.join(parent, `.authority-cutover-lock-${storeId}`);
  await mkdir(lock, { mode: 0o700 });
  await writeFile(path.join(lock, 'owner.json'), canonicalJson(owner), { mode: 0o600 });
  const heartbeat = path.join(lock, `heartbeat-${owner.token}`);
  await writeFile(heartbeat, canonicalJson({
    lockFormat: 'sflow.sgos.authority-store-lock.heartbeat',
    lockVersion: 1,
    token: owner.token
  }), { mode: 0o600 });
  const timestamp = new Date(heartbeatAt);
  await utimes(heartbeat, timestamp, timestamp);
  return lock;
}

async function pause(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeCutoverJournal(parent, storeId, input) {
  const core = {
    journalFormat: 'sflow.sgos.authority-transport-cutover',
    journalVersion: 1,
    ...input,
    storeId
  };
  const journalSha256 = platformSha256(core);
  const unsealed = { ...core, journalSha256 };
  const keyText = await readFile(
    path.join(parent, `.authority-cutover-integrity-${storeId}.key`), 'utf8'
  );
  const key = Buffer.from(keyText.trim(), 'base64');
  const mac = createHmac('sha256', key).update(canonicalJson({
    purpose: 'sgos-authority-cutover-journal',
    journal: unsealed
  })).digest('hex');
  const journal = {
    ...unsealed,
    integrity: {
      scheme: 'machine-local-hmac-sha256-v1',
      keyId: platformSha256(key).slice(7, 23),
      mac: `sha256:${mac}`
    }
  };
  const journalFile = path.join(parent, `.authority-cutover-${storeId}.json`);
  await writeFile(journalFile, canonicalJson(journal), { mode: 0o600 });
  return journalFile;
}

async function importedStoreFixture(t, prefix, storeId) {
  const parent = await directory(t, prefix);
  const sourceRoot = path.join(parent, 'source');
  const destinationRoot = path.join(parent, 'destination');
  const source = await openFilesystemAuthorityStore({ root: sourceRoot, storeId });
  const destination = await openFilesystemAuthorityStore({ root: destinationRoot, storeId });
  const before = await source.read();
  await source.transact({
    expectedRevision: before.revision,
    expectedStateSha256: before.recordSha256,
    actorId: 'git-email:transport-actor',
    authorization: authorization('pack.propose'),
    changes: [{ op: 'put', key: 'portable:fixture', value: { status: 'portable' } }]
  });
  const exporter = keys();
  const repositoryBindingSha256 = platformSha256(`${prefix}:repository`);
  const policySha256 = platformSha256(`${prefix}:policy`);
  const validateEntries = () => ({ profile: 'test-only' });
  const signedTransport = await source.exportTransport({
    privateKeyPem: exporter.privateKeyPem,
    keyId: 'fixture-exporter',
    repositoryBindingSha256,
    policySha256,
    authorization: authorization('authority-store.export'),
    validateEntries
  });
  const options = {
    signedTransport,
    trustedPublicKeyPem: exporter.publicKeyPem,
    expectedKeyId: 'fixture-exporter',
    expectedRepositoryBindingSha256: repositoryBindingSha256,
    expectedPolicySha256: policySha256,
    validateEntries
  };
  const preview = await destination.planImport(options);
  const imported = await destination.importTransport({
    ...options,
    confirmationSha256: preview.plan.confirmationSha256,
    authorization: authorization('authority-store.import')
  });
  return {
    parent, sourceRoot, destinationRoot, destination, imported,
    validateRollback: () => undefined
  };
}

async function packState(store, publisher) {
  const pack = createCapabilityPack({
    packId: 'portable-finance', version: '1.0.0', domain: 'finance',
    operations: ['finance.read'], permissions: [], files: [], lessons: [],
    provenanceSha256: platformSha256('portable-provenance'),
    sbomSha256: platformSha256('portable-sbom'),
    publisherKeyId: 'publisher-a', createdAt: at
  });
  const signedPack = signPlatformRecord(pack, {
    privateKeyPem: publisher.privateKeyPem, keyId: 'publisher-a'
  });
  const review = createPackReview({
    packSha256: pack.recordSha256,
    reviewerId: 'git-email:transport-actor',
    decision: 'approved', reason: 'portable review', reviewedAt: at
  });
  const activation = createPackActivation({
    domain: pack.domain, packSha256: pack.recordSha256,
    reviewSha256: review.recordSha256,
    activatedBy: 'git-email:transport-actor', activatedAt: at
  });
  const hash = (value) => platformSha256(value).slice(7);
  let before = await store.read();
  await store.transact({
    expectedRevision: before.revision,
    expectedStateSha256: before.recordSha256,
    actorId: 'git-email:transport-actor',
    authorization: authorization('pack.propose'),
    changes: [{ op: 'put', key: `pack:${hash(pack.recordSha256)}`, value: signedPack }]
  });
  before = await store.read();
  await store.transact({
    expectedRevision: before.revision,
    expectedStateSha256: before.recordSha256,
    actorId: 'git-email:transport-actor',
    authorization: authorization('pack.review'),
    changes: [{ op: 'put', key: `pack-review:${hash(review.recordSha256)}`, value: review }]
  });
  before = await store.read();
  await store.transact({
    expectedRevision: before.revision,
    expectedStateSha256: before.recordSha256,
    actorId: 'git-email:transport-actor',
    authorization: authorization('pack.activate'),
    changes: [
      { op: 'put', key: `pack-activation:${hash(pack.domain)}`, value: activation },
      { op: 'put', key: `pack-active:${hash(pack.domain)}`, value: {
        domain: pack.domain, packSha256: pack.recordSha256
      } }
    ]
  });
  return pack;
}

async function appendPackLifecycle(store, publisher, {
  packId, version, domain = 'finance', activate = true
}) {
  const pack = createCapabilityPack({
    packId, version, domain,
    operations: [`${domain}.read`], permissions: [], files: [], lessons: [],
    provenanceSha256: platformSha256(`${packId}:${version}:provenance`),
    sbomSha256: platformSha256(`${packId}:${version}:sbom`),
    publisherKeyId: 'publisher-a', createdAt: at
  });
  const signedPack = signPlatformRecord(pack, {
    privateKeyPem: publisher.privateKeyPem, keyId: 'publisher-a'
  });
  const review = createPackReview({
    packSha256: pack.recordSha256,
    reviewerId: 'git-email:transport-actor',
    decision: 'approved', reason: `approve ${packId}`, reviewedAt: at
  });
  const activation = createPackActivation({
    domain, packSha256: pack.recordSha256, reviewSha256: review.recordSha256,
    activatedBy: 'git-email:transport-actor', activatedAt: at
  });
  const hash = (value) => platformSha256(value).slice(7);
  let before = await store.read();
  await store.transact({
    expectedRevision: before.revision,
    expectedStateSha256: before.recordSha256,
    actorId: 'git-email:transport-actor',
    authorization: authorization('pack.propose'),
    changes: [{ op: 'put', key: `pack:${hash(pack.recordSha256)}`, value: signedPack }]
  });
  before = await store.read();
  await store.transact({
    expectedRevision: before.revision,
    expectedStateSha256: before.recordSha256,
    actorId: 'git-email:transport-actor',
    authorization: authorization('pack.review'),
    changes: [{ op: 'put', key: `pack-review:${hash(review.recordSha256)}`, value: review }]
  });
  if (activate) {
    before = await store.read();
    await store.transact({
      expectedRevision: before.revision,
      expectedStateSha256: before.recordSha256,
      actorId: 'git-email:transport-actor',
      authorization: authorization('pack.activate'),
      changes: [
        { op: 'put', key: `pack-activation:${hash(domain)}`, value: activation },
        { op: 'put', key: `pack-active:${hash(domain)}`, value: {
          domain, packSha256: pack.recordSha256
        } }
      ]
    });
  }
  return { pack, activation };
}

function authorityLineage(storeId, selections) {
  let entries = {};
  let priorEventSha256 = null;
  const events = [];
  const states = [createAuthorityState({
    storeId, revision: 0, eventSha256: null,
    entriesSha256: platformSha256(entries), entries
  })];
  for (const [index, selection] of selections.entries()) {
    const beforeEntriesSha256 = platformSha256(entries);
    entries = { 'fixture:selection': selection };
    const event = createAuthorityTransactionEvent({
      storeId, revision: index + 1, priorEventSha256,
      beforeEntriesSha256, afterEntriesSha256: platformSha256(entries),
      actorId: 'fixture-actor', committedAt: at,
      changes: [{ op: 'put', key: 'fixture:selection', value: selection }]
    });
    events.push(event);
    priorEventSha256 = event.recordSha256;
    states.push(createAuthorityState({
      storeId, revision: index + 1, eventSha256: event.recordSha256,
      entriesSha256: platformSha256(entries), entries
    }));
  }
  return { events, states };
}

function plannedTransport(fixture, revision) {
  const core = {
    storeId: fixture.states[revision].storeId,
    repositoryBindingSha256: platformSha256('plan-repository'),
    policySha256: platformSha256('plan-policy'),
    head: fixture.states[revision],
    events: fixture.events.slice(0, revision)
  };
  return { record: { ...core, recordSha256: platformSha256(core) } };
}

test('Authority import planning permits only install, exact no-op, or strict fast-forward', () => {
  const linear = authorityLineage('plan-store', ['A', 'B']);
  const genesis = linear.states[0];
  const revisionOne = plannedTransport(linear, 1);
  const revisionTwo = plannedTransport(linear, 2);

  assert.equal(planPortableAuthorityImport(genesis, [], revisionTwo).mode, 'install');
  assert.equal(planPortableAuthorityImport(
    linear.states[2], linear.events, revisionTwo
  ).mode, 'noop');
  assert.equal(planPortableAuthorityImport(
    linear.states[1], linear.events.slice(0, 1), revisionTwo
  ).mode, 'fast-forward');
  assert.throws(() => planPortableAuthorityImport(
    linear.states[2], linear.events, revisionOne
  ), (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_ROLLBACK_REFUSED');

  const divergent = authorityLineage('plan-store', ['counterfeit-A']);
  assert.throws(() => planPortableAuthorityImport(
    linear.states[1], linear.events.slice(0, 1), plannedTransport(divergent, 1)
  ), (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_DIVERGED');
});

test('signed Authority transport round-trips exact Pack authority and rolls back by receipt', async (t) => {
  const sourceRoot = await directory(t, 'sflow-authority-source-');
  const destinationRoot = await directory(t, 'sflow-authority-destination-');
  const source = await openFilesystemAuthorityStore({ root: sourceRoot, storeId: 'portable-store' });
  const destination = await openFilesystemAuthorityStore({
    root: destinationRoot, storeId: 'portable-store'
  });
  const publisher = keys();
  await packState(source, publisher);
  const exporter = keys();
  const repositoryBindingSha256 = platformSha256('portable-repository');
  const policySha256 = platformSha256('portable-policy');
  const validateEntries = authorityTransportEntryValidator({
    'publisher-a': publisher.publicKeyPem
  });
  const validateRollback = authorityTransportRollbackValidator({
    'publisher-a': publisher.publicKeyPem
  });
  const signed = await source.exportTransport({
    privateKeyPem: exporter.privateKeyPem,
    keyId: 'exporter-a',
    repositoryBindingSha256,
    policySha256,
    authorization: authorization('authority-store.export'),
    validateEntries
  });
  assert.equal(signed.record.attestationAuthority, 'full-authority-store-snapshot');
  const serialized = serializeAuthorityTransport(signed);
  assert.deepEqual(parseAuthorityTransport(Buffer.from(serialized)), JSON.parse(serialized));
  const verified = await verifyPortableAuthorityTransport(signed, {
    trustedPublicKeyPem: exporter.publicKeyPem,
    expectedKeyId: 'exporter-a',
    expectedStoreId: 'portable-store',
    expectedRepositoryBindingSha256: repositoryBindingSha256,
    expectedPolicySha256: policySha256,
    validateEntries
  });
  assert.equal(verified.semantic.active.length, 1);
  const preview = await destination.planImport({
    signedTransport: signed,
    trustedPublicKeyPem: exporter.publicKeyPem,
    expectedKeyId: 'exporter-a',
    expectedRepositoryBindingSha256: repositoryBindingSha256,
    expectedPolicySha256: policySha256,
    validateEntries
  });
  assert.equal(preview.plan.mode, 'install');
  const staleRoot = await directory(t, 'sflow-authority-stale-context-');
  const staleDestination = await openFilesystemAuthorityStore({
    root: staleRoot, storeId: 'portable-store'
  });
  const firstContext = platformSha256('authority-context-a');
  const stalePreview = await staleDestination.planImport({
    signedTransport: signed,
    trustedPublicKeyPem: exporter.publicKeyPem,
    expectedKeyId: 'exporter-a',
    expectedRepositoryBindingSha256: repositoryBindingSha256,
    expectedPolicySha256: policySha256,
    authorityContextSha256: firstContext,
    validateEntries
  });
  await assert.rejects(() => staleDestination.importTransport({
    signedTransport: signed,
    trustedPublicKeyPem: exporter.publicKeyPem,
    expectedKeyId: 'exporter-a',
    expectedRepositoryBindingSha256: repositoryBindingSha256,
    expectedPolicySha256: policySha256,
    authorityContextSha256: platformSha256('authority-context-b'),
    validateEntries,
    confirmationSha256: stalePreview.plan.confirmationSha256,
    authorization: authorization('authority-store.import')
  }), (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_PLAN_STALE');
  const imported = await destination.importTransport({
    signedTransport: signed,
    trustedPublicKeyPem: exporter.publicKeyPem,
    expectedKeyId: 'exporter-a',
    expectedRepositoryBindingSha256: repositoryBindingSha256,
    expectedPolicySha256: policySha256,
    validateEntries,
    confirmationSha256: preview.plan.confirmationSha256,
    authorization: authorization('authority-store.import')
  });
  assert.equal(imported.status, 'imported');
  const importProofs = await readdir(path.join(destinationRoot, 'transport', 'imports'));
  assert.equal(importProofs.length, 1);
  assert.equal(importProofs[0], `${imported.signedTransportSha256.slice(7)}.json`);
  assert.equal(
    platformSha256(JSON.parse(await readFile(path.join(
      destinationRoot, 'transport', 'imports', importProofs[0]
    ), 'utf8'))),
    imported.signedTransportSha256
  );
  const importedStore = await openFilesystemAuthorityStore({
    root: destinationRoot, storeId: 'portable-store'
  });
  assert.equal((await importedStore.read()).recordSha256, signed.record.head.recordSha256);
  const backupRoot = path.join(path.dirname(destinationRoot),
    `.authority-backup-portable-store-${imported.cutoverSha256.slice(7)}`);
  const heldBackup = `${backupRoot}.test-held`;
  await rename(backupRoot, heldBackup);
  try {
    await assert.rejects(() => importedStore.planRollback({
      cutoverSha256: imported.cutoverSha256, validateRollback
    }), (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_ROLLBACK_REFUSED');
    await assert.rejects(() => lstat(backupRoot), (error) => error.code === 'ENOENT');
  } finally {
    await rename(heldBackup, backupRoot);
  }
  const forgedCore = {
    journalFormat: 'sflow.sgos.authority-transport-cutover',
    journalVersion: 1,
    operation: 'import',
    storeId: 'portable-store',
    stageName: '.authority-import-portable-store-forged1',
    backupName: '.authority-backup-portable-store-forged1',
    beforeStateSha256: signed.record.head.recordSha256,
    afterStateSha256: signed.record.head.recordSha256,
    receiptSha256: imported.cutoverSha256
  };
  const forgedJournal = {
    ...forgedCore,
    journalSha256: platformSha256(forgedCore),
    integrity: {
      scheme: 'machine-local-hmac-sha256-v1',
      keyId: '0000000000000000',
      mac: `sha256:${'0'.repeat(64)}`
    }
  };
  const forgedJournalPath = path.join(
    path.dirname(destinationRoot), '.authority-cutover-portable-store.json'
  );
  await writeFile(forgedJournalPath, canonicalJson(forgedJournal));
  await assert.rejects(() => openFilesystemAuthorityStore({
    root: destinationRoot, storeId: 'portable-store'
  }), (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  await rm(forgedJournalPath, { force: true });
  const reopened = await openFilesystemAuthorityStore({
    root: destinationRoot, storeId: 'portable-store'
  });
  const rollbackPreview = await reopened.planRollback({
    cutoverSha256: imported.cutoverSha256, validateRollback
  });
  const rolledBack = await reopened.rollbackTransport({
    cutoverSha256: imported.cutoverSha256,
    confirmationSha256: rollbackPreview.plan.confirmationSha256,
    authorization: authorization('authority-store.rollback'),
    validateRollback
  });
  assert.equal(rolledBack.current.revision, 0);
  const afterRollback = await openFilesystemAuthorityStore({
    root: destinationRoot, storeId: 'portable-store'
  });
  assert.equal((await afterRollback.read()).revision, 0);
});

test('stable cutover leases honor owner publication grace and token heartbeat', async (t) => {
  const parent = await directory(t, 'sflow-authority-cutover-live-');

  const graceStoreId = 'grace-store';
  const graceRoot = path.join(parent, graceStoreId);
  const graceLock = path.join(parent, `.authority-cutover-lock-${graceStoreId}`);
  await mkdir(graceLock, { mode: 0o700 });
  let graceSettled = false;
  const graceOpen = openFilesystemAuthorityStore({
    root: graceRoot, storeId: graceStoreId
  }).then((value) => {
    graceSettled = true;
    return value;
  });
  await pause(75);
  assert.equal(graceSettled, false, 'a fresh ownerless lock must retain its 30-second grace');
  await rm(graceLock, { recursive: true });
  await graceOpen;

  const liveStoreId = 'live-store';
  const liveRoot = path.join(parent, liveStoreId);
  const liveOwner = lockOwner(liveStoreId);
  const liveLock = await installCutoverLock(parent, liveStoreId, liveOwner);
  let liveSettled = false;
  const liveOpen = openFilesystemAuthorityStore({
    root: liveRoot, storeId: liveStoreId
  }).then((value) => {
    liveSettled = true;
    return value;
  });
  await pause(75);
  assert.equal(liveSettled, false, 'a fresh token heartbeat must extend an expired owner lease');
  assert.equal(JSON.parse(await readFile(path.join(liveLock, 'owner.json'), 'utf8')).token,
    liveOwner.token);
  assert.deepEqual((await readdir(parent)).filter((name) =>
    name.startsWith(`.authority-cutover-lock-abandoned-${liveStoreId}-`)), []);
  await rm(liveLock, { recursive: true });
  await liveOpen;
});

test('stable cutover leases reclaim stale remote and dead local owners into quarantine', async (t) => {
  const parent = await directory(t, 'sflow-authority-cutover-stale-');
  const ownerlessStoreId = 'stale-ownerless-store';
  const ownerlessLock = path.join(parent, `.authority-cutover-lock-${ownerlessStoreId}`);
  await mkdir(ownerlessLock, { mode: 0o700 });
  const beforeGrace = new Date(Date.now() - 31_000);
  await utimes(ownerlessLock, beforeGrace, beforeGrace);
  await openFilesystemAuthorityStore({
    root: path.join(parent, ownerlessStoreId), storeId: ownerlessStoreId
  });
  assert.equal((await readdir(parent)).filter((name) =>
    name.startsWith(`.authority-cutover-lock-abandoned-${ownerlessStoreId}-`)).length, 1);

  const cases = [
    {
      storeId: 'stale-remote-store',
      owner: lockOwner('stale-remote-store', { host: 'remote-host.example', pid: 17 }),
      heartbeatAt: Date.now() - 120_000
    },
    {
      storeId: 'dead-local-store',
      owner: lockOwner('dead-local-store', {
        pid: 2_147_483_647,
        acquiredAt: Date.now() - 1_000,
        expiresAt: Date.now() + 29_000
      }),
      heartbeatAt: Date.now()
    }
  ];
  for (const fixture of cases) {
    await installCutoverLock(parent, fixture.storeId, fixture.owner, {
      heartbeatAt: fixture.heartbeatAt
    });
    await openFilesystemAuthorityStore({
      root: path.join(parent, fixture.storeId), storeId: fixture.storeId
    });
    const abandoned = (await readdir(parent)).filter((name) =>
      name.startsWith(`.authority-cutover-lock-abandoned-${fixture.storeId}-`));
    assert.equal(abandoned.length, 1);
    const quarantinedOwner = JSON.parse(await readFile(
      path.join(parent, abandoned[0], 'owner.json'), 'utf8'
    ));
    assert.equal(quarantinedOwner.token, fixture.owner.token);
  }
});

test('rollback preview refuses a missing backup without recreating it', async (t) => {
  const parent = await directory(t, 'sflow-authority-rollback-preview-');
  const sourceRoot = path.join(parent, 'source');
  const destinationRoot = path.join(parent, 'destination');
  const storeId = 'preview-store';
  const source = await openFilesystemAuthorityStore({ root: sourceRoot, storeId });
  const destination = await openFilesystemAuthorityStore({ root: destinationRoot, storeId });
  const before = await source.read();
  await source.transact({
    expectedRevision: before.revision,
    expectedStateSha256: before.recordSha256,
    actorId: 'git-email:transport-actor',
    authorization: authorization('pack.propose'),
    changes: [{ op: 'put', key: 'portable:fixture', value: { status: 'portable' } }]
  });
  const exporter = keys();
  const repositoryBindingSha256 = platformSha256('preview-repository');
  const policySha256 = platformSha256('preview-policy');
  const validateEntries = () => ({ profile: 'test-only' });
  const signedTransport = await source.exportTransport({
    privateKeyPem: exporter.privateKeyPem,
    keyId: 'preview-exporter',
    repositoryBindingSha256,
    policySha256,
    authorization: authorization('authority-store.export'),
    validateEntries
  });
  const transportOptions = {
    signedTransport,
    trustedPublicKeyPem: exporter.publicKeyPem,
    expectedKeyId: 'preview-exporter',
    expectedRepositoryBindingSha256: repositoryBindingSha256,
    expectedPolicySha256: policySha256,
    validateEntries
  };
  const preview = await destination.planImport(transportOptions);
  const imported = await destination.importTransport({
    ...transportOptions,
    confirmationSha256: preview.plan.confirmationSha256,
    authorization: authorization('authority-store.import')
  });
  const backupRoot = path.join(parent,
    `.authority-backup-${storeId}-${imported.cutoverSha256.slice(7)}`);
  const orphan = signedTransport.record.events[0];
  const orphanFile = path.join(
    backupRoot, 'events', `${orphan.recordSha256.slice(7)}.json`
  );
  await writeFile(orphanFile, canonicalJson(createPlatformEnvelope(orphan)));
  await assert.rejects(() => destination.planRollback({
    cutoverSha256: imported.cutoverSha256,
    validateRollback: () => undefined
  }), (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  await rm(orphanFile);
  await rm(backupRoot, { recursive: true });
  await assert.rejects(() => destination.planRollback({
    cutoverSha256: imported.cutoverSha256,
    validateRollback: () => undefined
  }), (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_ROLLBACK_REFUSED');
  await assert.rejects(() => lstat(backupRoot), (error) => error.code === 'ENOENT');
});

test('rollback crash recovery preserves the deterministic pre-import backup for retry', async (t) => {
  const storeId = 'rollback-crash-store';
  const fixture = await importedStoreFixture(
    t, 'sflow-authority-rollback-crash-', storeId
  );
  const current = await fixture.destination.read();
  const stageRoot = path.join(fixture.parent,
    `.authority-backup-${storeId}-${fixture.imported.cutoverSha256.slice(7)}`);
  const rollbackHead = JSON.parse(await readFile(
    path.join(stageRoot, 'state.json'), 'utf8'
  )).record;
  const rollback = createAuthorityRollback({
    repositoryBindingSha256: platformSha256(
      'sflow-authority-rollback-crash-:repository'
    ),
    storeId,
    cutoverSha256: fixture.imported.cutoverSha256,
    beforeStateSha256: current.recordSha256,
    afterStateSha256: rollbackHead.recordSha256,
    authorization: authorization('authority-store.rollback'),
    rolledBackAt: at
  });
  const rollbackDirectory = path.join(stageRoot, 'transport', 'rollbacks');
  await mkdir(rollbackDirectory, { recursive: true, mode: 0o700 });
  const provisionalReceipt = path.join(
    rollbackDirectory, `${rollback.recordSha256.slice(7)}.json`
  );
  await writeFile(provisionalReceipt, canonicalJson(createPlatformEnvelope(rollback)));
  const provisionalLock = path.join(stageRoot, '.transaction-lock');
  await mkdir(provisionalLock, { mode: 0o700 });
  const retiredRoot = path.join(fixture.parent,
    `.authority-rolled-back-${storeId}-${rollback.recordSha256.slice(7)}`);
  const journalFile = await writeCutoverJournal(fixture.parent, storeId, {
    operation: 'rollback',
    stageName: path.basename(stageRoot),
    backupName: path.basename(retiredRoot),
    beforeStateSha256: current.recordSha256,
    afterStateSha256: rollbackHead.recordSha256,
    receiptSha256: rollback.recordSha256
  });

  // Reproduce a process death after canonical -> retired but before backup -> canonical.
  await rename(fixture.destinationRoot, retiredRoot);
  const recovered = await openFilesystemAuthorityStore({
    root: fixture.destinationRoot, storeId
  });
  assert.equal((await recovered.read()).recordSha256, current.recordSha256);
  assert.equal(JSON.parse(await readFile(path.join(stageRoot, 'state.json'), 'utf8'))
    .record.recordSha256, rollbackHead.recordSha256);
  await assert.rejects(() => lstat(provisionalReceipt), (error) => error.code === 'ENOENT');
  await assert.rejects(() => lstat(provisionalLock), (error) => error.code === 'ENOENT');
  await assert.rejects(() => lstat(journalFile), (error) => error.code === 'ENOENT');

  const preview = await recovered.planRollback({
    cutoverSha256: fixture.imported.cutoverSha256,
    validateRollback: fixture.validateRollback
  });
  const retried = await recovered.rollbackTransport({
    cutoverSha256: fixture.imported.cutoverSha256,
    confirmationSha256: preview.plan.confirmationSha256,
    authorization: authorization('authority-store.rollback'),
    validateRollback: fixture.validateRollback
  });
  assert.equal(retried.status, 'rolled-back');
  assert.equal(retried.current.stateSha256, rollbackHead.recordSha256);
});

test('cutover recovery rejects a symlinked journal backup and retains forensic state', async (t) => {
  const storeId = 'symlink-recovery-store';
  const fixture = await importedStoreFixture(
    t, 'sflow-authority-symlink-recovery-', storeId
  );
  const current = await fixture.destination.read();
  const backupRoot = path.join(fixture.parent,
    `.authority-backup-${storeId}-${fixture.imported.cutoverSha256.slice(7)}`);
  const heldBackup = `${backupRoot}.held`;
  const beforeStateSha256 = JSON.parse(await readFile(
    path.join(backupRoot, 'state.json'), 'utf8'
  )).record.recordSha256;
  const protectedLock = path.join(backupRoot, '.transaction-lock');
  await mkdir(protectedLock, { mode: 0o700 });
  const sentinel = path.join(protectedLock, 'sentinel.txt');
  await writeFile(sentinel, 'must survive refused recovery');
  await rename(backupRoot, heldBackup);
  await symlink(heldBackup, backupRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const journalFile = await writeCutoverJournal(fixture.parent, storeId, {
    operation: 'import',
    stageName: `.authority-import-${storeId}-recovery-test`,
    backupName: path.basename(backupRoot),
    beforeStateSha256,
    afterStateSha256: current.recordSha256,
    receiptSha256: fixture.imported.cutoverSha256
  });

  await assert.rejects(() => openFilesystemAuthorityStore({
    root: fixture.destinationRoot, storeId
  }), (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_IMPORT_INTERRUPTED');
  assert.equal(await readFile(path.join(heldBackup, '.transaction-lock', 'sentinel.txt'), 'utf8'),
    'must survive refused recovery');
  assert.equal((await lstat(journalFile)).isFile(), true,
    'unsafe recovery must retain its authenticated journal');
  assert.equal((await lstat(backupRoot)).isSymbolicLink(), true);
});

test('rollback refuses A after later B activation even when B was subsequently revoked', async (t) => {
  const root = await directory(t, 'sflow-authority-superseded-rollback-');
  const store = await openFilesystemAuthorityStore({ root, storeId: 'portable-store' });
  const publisher = keys();
  const packA = await appendPackLifecycle(store, publisher, {
    packId: 'finance-a', version: '1.0.0'
  });
  const snapshotSigner = keys();
  const rollbackBoundary = (await store.exportPortable({
    privateKeyPem: snapshotSigner.privateKeyPem, keyId: 'snapshot-a'
  })).record;

  const packB = await appendPackLifecycle(store, publisher, {
    packId: 'finance-b', version: '2.0.0'
  });
  const hash = (value) => platformSha256(value).slice(7);
  const beforeRevoke = await store.read();
  const revocation = createPackRevocation({
    packSha256: packB.pack.recordSha256,
    revokedBy: 'git-email:transport-actor',
    reason: 'withdraw B after activation',
    revokedAt: at
  });
  await store.transact({
    expectedRevision: beforeRevoke.revision,
    expectedStateSha256: beforeRevoke.recordSha256,
    actorId: 'git-email:transport-actor',
    authorization: authorization('pack.revoke'),
    changes: [
      {
        op: 'put',
        key: `pack-revocation:${hash(packB.pack.recordSha256)}`,
        value: revocation
      },
      { op: 'delete', key: `pack-active:${hash(packB.pack.domain)}` },
      { op: 'delete', key: `pack-activation:${hash(packB.pack.domain)}` }
    ]
  });
  const current = (await store.exportPortable({
    privateKeyPem: snapshotSigner.privateKeyPem, keyId: 'snapshot-a'
  })).record;

  assert.equal(
    current.head.entries[`pack-active:${hash(packA.pack.domain)}`],
    undefined,
    'revoking B removes the final selector which used to hide this supersession from rollback'
  );
  assert.throws(() => validateCapabilityPackTransportRollback(
    rollbackBoundary.head.entries,
    current.head.entries,
    rollbackBoundary.events,
    current.events,
    { 'publisher-a': publisher.publicKeyPem }
  ), (error) => error.code === 'SGOS_CAPABILITY_PACK_SUPERSEDED');
});

test('transport rejects another repository, stale trust, tamper, truncation, and secrets', async (t) => {
  const root = await directory(t, 'sflow-authority-adversarial-');
  const store = await openFilesystemAuthorityStore({ root, storeId: 'portable-store' });
  const publisher = keys();
  await packState(store, publisher);
  const exporter = keys();
  const repositoryBindingSha256 = platformSha256('repository-a');
  const policySha256 = platformSha256('policy-a');
  const validateEntries = authorityTransportEntryValidator({
    'publisher-a': publisher.publicKeyPem
  });
  const signed = await store.exportTransport({
    privateKeyPem: exporter.privateKeyPem, keyId: 'exporter-a',
    repositoryBindingSha256, policySha256,
    authorization: authorization('authority-store.export'), validateEntries
  });
  await assert.rejects(() => verifyPortableAuthorityTransport(signed, {
    trustedPublicKeyPem: exporter.publicKeyPem,
    expectedKeyId: 'exporter-a',
    expectedRepositoryBindingSha256: platformSha256('repository-b'),
    expectedPolicySha256: policySha256, validateEntries
  }), (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_REPOSITORY_MISMATCH');
  await assert.rejects(() => verifyPortableAuthorityTransport(signed, {
    trustedPublicKeyPem: exporter.publicKeyPem,
    expectedKeyId: 'exporter-a',
    expectedRepositoryBindingSha256: repositoryBindingSha256,
    expectedPolicySha256: platformSha256('policy-b'), validateEntries
  }), (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_CONFIGURATION_STALE');
  const tampered = structuredClone(signed);
  tampered.record.head.entries = {};
  await assert.rejects(() => verifyPortableAuthorityTransport(tampered, {
    trustedPublicKeyPem: exporter.publicKeyPem,
    expectedKeyId: 'exporter-a',
    expectedRepositoryBindingSha256: repositoryBindingSha256,
    expectedPolicySha256: policySha256, validateEntries
  }), (error) => ['SGOS_PLATFORM_RECORD_TAMPERED', 'SGOS_PLATFORM_SIGNATURE_INVALID'].includes(error.code));
  assert.throws(() => parseAuthorityTransport(Buffer.from('{')), (error) =>
    error.code === 'SGOS_AUTHORITY_TRANSPORT_PARTIAL_COPY');
  const replacement = Buffer.from(canonicalJson({ value: '\ufffd' }), 'utf8');
  const marker = Buffer.from('\ufffd', 'utf8');
  const offset = replacement.indexOf(marker);
  const invalidUtf8 = Buffer.concat([
    replacement.subarray(0, offset),
    Buffer.from([0xff]),
    replacement.subarray(offset + marker.length)
  ]);
  assert.throws(() => parseAuthorityTransport(invalidUtf8), (error) =>
    error.code === 'SGOS_AUTHORITY_TRANSPORT_BUNDLE_INVALID');

  const before = await store.read();
  await store.transact({
    expectedRevision: before.revision,
    expectedStateSha256: before.recordSha256,
    actorId: 'git-email:transport-actor',
    authorization: authorization('pack.activate'),
    changes: [{ op: 'put', key: 'policy:credential', value: {
      password: 'plain-text-password-forbidden'
    } }]
  });
  await assert.rejects(() => store.exportTransport({
    privateKeyPem: exporter.privateKeyPem, keyId: 'exporter-a',
    repositoryBindingSha256, policySha256,
    authorization: authorization('authority-store.export'), validateEntries
  }), (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_CREDENTIAL_REFUSED');
});

test('transport refuses a final Pack graph produced by a counterfeit combined mutation', async (t) => {
  const root = await directory(t, 'sflow-authority-counterfeit-history-');
  const store = await openFilesystemAuthorityStore({ root, storeId: 'portable-store' });
  const publisher = keys();
  const pack = createCapabilityPack({
    packId: 'counterfeit-history', version: '1.0.0', domain: 'finance',
    operations: ['finance.read'], permissions: [], files: [], lessons: [],
    provenanceSha256: platformSha256('counterfeit-provenance'),
    sbomSha256: platformSha256('counterfeit-sbom'),
    publisherKeyId: 'publisher-a', createdAt: at
  });
  const signedPack = signPlatformRecord(pack, {
    privateKeyPem: publisher.privateKeyPem, keyId: 'publisher-a'
  });
  const review = createPackReview({
    packSha256: pack.recordSha256,
    reviewerId: 'git-email:transport-actor',
    decision: 'approved', reason: 'fabricated combined review', reviewedAt: at
  });
  const activation = createPackActivation({
    domain: pack.domain, packSha256: pack.recordSha256,
    reviewSha256: review.recordSha256,
    activatedBy: 'git-email:transport-actor', activatedAt: at
  });
  const hash = (value) => platformSha256(value).slice(7);
  const before = await store.read();
  await store.transact({
    expectedRevision: before.revision,
    expectedStateSha256: before.recordSha256,
    actorId: 'git-email:transport-actor',
    authorization: authorization('pack.activate'),
    changes: [
      { op: 'put', key: `pack:${hash(pack.recordSha256)}`, value: signedPack },
      { op: 'put', key: `pack-review:${hash(review.recordSha256)}`, value: review },
      { op: 'put', key: `pack-activation:${hash(pack.domain)}`, value: activation },
      { op: 'put', key: `pack-active:${hash(pack.domain)}`, value: {
        domain: pack.domain, packSha256: pack.recordSha256
      } }
    ]
  });
  const exporter = keys();
  await assert.rejects(() => store.exportTransport({
    privateKeyPem: exporter.privateKeyPem,
    keyId: 'exporter-a',
    repositoryBindingSha256: platformSha256('repository'),
    policySha256: platformSha256('policy'),
    authorization: authorization('authority-store.export'),
    validateEntries: authorityTransportEntryValidator({
      'publisher-a': publisher.publicKeyPem
    })
  }), (error) => error.code === 'SGOS_CAPABILITY_PACK_TRANSPORT_INVALID');
});

test('transport scans historical authorization fields for machine-local paths', async (t) => {
  const root = await directory(t, 'sflow-authority-path-history-');
  const store = await openFilesystemAuthorityStore({ root, storeId: 'portable-store' });
  const publisher = keys();
  const pack = createCapabilityPack({
    packId: 'path-history', version: '1.0.0', domain: 'finance',
    operations: ['finance.read'], permissions: [], files: [], lessons: [],
    provenanceSha256: platformSha256('path-history-provenance'),
    sbomSha256: platformSha256('path-history-sbom'),
    publisherKeyId: 'publisher-a', createdAt: at
  });
  const signedPack = signPlatformRecord(pack, {
    privateKeyPem: publisher.privateKeyPem, keyId: 'publisher-a'
  });
  const before = await store.read();
  await store.transact({
    expectedRevision: before.revision,
    expectedStateSha256: before.recordSha256,
    actorId: 'git-email:transport-actor',
    authorization: createPlatformMutationAuthorization({
      operation: 'pack.propose', authorityGroup: 'engineering-reviewers',
      actorId: 'git-email:transport-actor', identityAssurance: 'configured-local',
      configurationKind: 'approved-configuration-ref',
      configurationRef: '/Users/alice/private/config',
      configurationCommit: 'a'.repeat(40),
      workflowSha256: platformSha256('workflow'),
      authoritySha256: platformSha256('authority'), authorizedAt: at
    }),
    changes: [{
      op: 'put',
      key: `pack:${platformSha256(pack.recordSha256).slice(7)}`,
      value: signedPack
    }]
  });
  const exporter = keys();
  await assert.rejects(() => store.exportTransport({
    privateKeyPem: exporter.privateKeyPem,
    keyId: 'exporter-a',
    repositoryBindingSha256: platformSha256('repository'),
    policySha256: platformSha256('policy'),
    authorization: authorization('authority-store.export'),
    validateEntries: authorityTransportEntryValidator({
      'publisher-a': publisher.publicKeyPem
    })
  }), (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_PATH_UNSAFE');
});

test('transport serialization is canonical and contains no source path or private key', async (t) => {
  const root = await directory(t, 'sflow-authority-private-');
  const store = await openFilesystemAuthorityStore({ root, storeId: 'portable-store' });
  const exporter = keys();
  const signed = await store.exportTransport({
    privateKeyPem: exporter.privateKeyPem, keyId: 'exporter-a',
    repositoryBindingSha256: platformSha256('repository'),
    policySha256: platformSha256('policy'),
    authorization: authorization('authority-store.export'),
    validateEntries: authorityTransportEntryValidator({})
  });
  const bytes = serializeAuthorityTransport(signed);
  assert.equal(bytes, canonicalJson(JSON.parse(bytes)));
  assert.doesNotMatch(bytes, /PRIVATE KEY|sflow-authority-private|\/var\/|[A-Z]:\\/u);
  const file = path.join(root, 'bundle.json');
  await writeFile(file, bytes);
  assert.equal((await readFile(file, 'utf8')).length, bytes.length);
});

test('a valid Ed25519 signature beginning with a slash is not mistaken for a local path', () => {
  const pack = createCapabilityPack({
    packId: 'slash-signature', version: '1.0.0', domain: 'testing',
    operations: ['testing.read'], permissions: [], files: [], lessons: [],
    provenanceSha256: platformSha256('slash-signature-provenance'),
    sbomSha256: platformSha256('slash-signature-sbom'),
    publisherKeyId: 'publisher-slash',
    createdAt: at
  });
  let publisher;
  let signedPack;
  for (let attempt = 0; attempt < 2048; attempt += 1) {
    publisher = keys();
    signedPack = signPlatformRecord(pack, {
      privateKeyPem: publisher.privateKeyPem,
      keyId: 'publisher-slash'
    });
    if (signedPack.signature.value.startsWith('/')) break;
  }
  assert.equal(signedPack.signature.value.startsWith('/'), true,
    'fixture could not produce a slash-prefixed Ed25519 signature');
  const result = authorityTransportEntryValidator({
    'publisher-slash': publisher.publicKeyPem
  })({
    [`pack:${platformSha256(pack.recordSha256).slice(7)}`]: signedPack
  });
  assert.equal(result.total, 1);
});

test('legacy local Store IDs require explicit compatibility mode and can never enter transport', async (t) => {
  const root = await directory(t, 'sflow-authority-legacy-id-');
  await assert.rejects(() => openFilesystemAuthorityStore({
    root, storeId: 'legacy:store'
  }), (error) => error.code === 'SGOS_AUTHORITY_STORE_ID_INVALID');
  if (process.platform === 'win32') return;
  const legacy = await openFilesystemAuthorityStore({
    root, storeId: 'legacy:store', allowLegacyStoreId: true
  });
  assert.equal((await legacy.read()).revision, 0);
  await assert.rejects(() => legacy.planImport({}),
    (error) => error.code === 'SGOS_AUTHORITY_STORE_ID_INVALID');
});
