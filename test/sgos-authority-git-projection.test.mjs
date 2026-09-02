import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createPlatformMutationAuthorization, openFilesystemAuthorityStore,
  PLATFORM_AUTHORITY_GIT_PROJECTION_PROFILE, platformSha256,
  validatePlatformEnvelope, verifyAuthorityGitProjection
} from '../src/sgos/platform/index.mjs';

const at = '2026-09-02T08:00:00.000Z';
const stateBranch = 'state';
const stateCommit = 'b'.repeat(40);

async function directory(t, prefix) {
  const result = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(result, { recursive: true, force: true }));
  return result;
}

function authorization(operation) {
  return createPlatformMutationAuthorization({
    operation,
    authorityGroup: 'architecture-reviewers',
    actorId: 'git-email:git-projection-actor',
    identityAssurance: 'configured-local',
    configurationKind: 'approved-configuration-ref',
    configurationRef: 'refs/heads/sflow/config',
    configurationCommit: 'a'.repeat(40),
    workflowSha256: platformSha256('git-projection-workflow'),
    authoritySha256: platformSha256(`git-projection-authority:${operation}`),
    authorizedAt: at
  });
}

async function append(store, key, value) {
  const before = await store.read();
  return store.transact({
    expectedRevision: before.revision,
    expectedStateSha256: before.recordSha256,
    actorId: 'git-email:git-projection-actor',
    authorization: authorization('pack.propose'),
    changes: [{ op: 'put', key, value }]
  });
}

function projectionOptions(repositoryBindingSha256, policySha256) {
  return {
    expectedRepositoryBindingSha256: repositoryBindingSha256,
    expectedPolicySha256: policySha256,
    expectedStateBranch: stateBranch,
    stateBranch,
    stateCommit,
    validateEntries: (entries, events) => ({
      entryCount: Object.keys(entries).length,
      eventCount: events.length
    })
  };
}

test('Git projection export is deterministic and makes no signature or provenance claim', async (t) => {
  const root = await directory(t, 'sflow-authority-git-export-');
  const store = await openFilesystemAuthorityStore({ root, storeId: 'git-store' });
  await append(store, 'fixture:one', { enabled: true });
  const repositoryBindingSha256 = platformSha256('git-projection-repository');
  const policySha256 = platformSha256('git-projection-policy');
  const options = {
    repositoryBindingSha256,
    policySha256,
    validateEntries: () => ({ valid: true })
  };

  const first = await store.exportGitProjection(options);
  const second = await store.exportGitProjection(options);
  assert.deepEqual(second, first);
  assert.equal(first.kind, 'platform-authority-git-projection');
  assert.equal(first.projectionProfile, PLATFORM_AUTHORITY_GIT_PROJECTION_PROFILE);
  assert.equal(first.eventCount, 1);
  assert.equal(first.events.length, 1);
  assert.equal(Object.hasOwn(first, 'exportedAt'), false);
  assert.equal(Object.hasOwn(first, 'signature'), false);
  assert.equal(Object.hasOwn(first, 'signerKeyId'), false);
  assert.equal(Object.hasOwn(first, 'stateBranch'), false);
  assert.equal(Object.hasOwn(first, 'stateCommit'), false);

  const verified = await verifyAuthorityGitProjection(first, {
    ...projectionOptions(repositoryBindingSha256, policySha256),
    expectedStoreId: 'git-store'
  });
  assert.equal(verified.projectionSha256, first.recordSha256);
  assert.deepEqual(verified.gitProvenance, { stateBranch, stateCommit });
  assert.deepEqual(verified.semantic, { entryCount: 1, eventCount: 1 });

  const checkpoint = {
    revision: first.head.revision,
    stateSha256: first.head.recordSha256,
    projectionSha256: first.recordSha256
  };
  assert.equal((await verifyAuthorityGitProjection(first, {
    ...projectionOptions(repositoryBindingSha256, policySha256),
    minimumAuthority: checkpoint
  })).valid, true);
  await assert.rejects(() => verifyAuthorityGitProjection(first, {
    ...projectionOptions(repositoryBindingSha256, policySha256),
    minimumAuthority: {
      ...checkpoint, projectionSha256: platformSha256('different-projection')
    }
  }), (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_STALE');

  await assert.rejects(() => verifyAuthorityGitProjection(first, {
    ...projectionOptions(repositoryBindingSha256, policySha256),
    expectedStateBranch: 'authority-state'
  }), (error) => error.code === 'SGOS_AUTHORITY_GIT_PROVENANCE_MISMATCH');
  await assert.rejects(() => verifyAuthorityGitProjection(first, {
    ...projectionOptions(repositoryBindingSha256, policySha256),
    expectedRepositoryBindingSha256: platformSha256('another-repository')
  }), (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_REPOSITORY_MISMATCH');

  const tampered = JSON.parse(JSON.stringify(first));
  tampered.head.entries['fixture:one'].enabled = false;
  await assert.rejects(() => verifyAuthorityGitProjection(tampered, {
    ...projectionOptions(repositoryBindingSha256, policySha256)
  }), (error) => error.code === 'SGOS_PLATFORM_RECORD_TAMPERED');
});

test('Git projection import installs, no-ops, fast-forwards, and retains truthful provenance', async (t) => {
  const parent = await directory(t, 'sflow-authority-git-import-');
  const source = await openFilesystemAuthorityStore({
    root: path.join(parent, 'source'), storeId: 'git-store'
  });
  const destinationRoot = path.join(parent, 'destination');
  let destination = await openFilesystemAuthorityStore({
    root: destinationRoot, storeId: 'git-store'
  });
  await append(source, 'fixture:one', { enabled: true });
  const repositoryBindingSha256 = platformSha256('git-projection-repository');
  const policySha256 = platformSha256('git-projection-policy');
  const exportOptions = {
    repositoryBindingSha256,
    policySha256,
    validateEntries: () => ({ profile: 'test' })
  };
  const inputOptions = projectionOptions(repositoryBindingSha256, policySha256);
  const projectionOne = await source.exportGitProjection(exportOptions);
  const previewOne = await destination.planGitProjectionImport({
    ...inputOptions, projection: projectionOne
  });
  assert.equal(previewOne.plan.mode, 'install');
  assert.equal(previewOne.plan.projectionSha256, projectionOne.recordSha256);
  assert.equal(previewOne.plan.stateBranch, stateBranch);
  assert.equal(previewOne.plan.stateCommit, stateCommit);

  await assert.rejects(() => destination.importGitProjection({
    ...inputOptions,
    projection: projectionOne,
    confirmationSha256: previewOne.plan.confirmationSha256,
    authorization: authorization('authority-store.import')
  }), (error) => error.code === 'SGOS_PLATFORM_AUTHORIZATION_TAMPERED');

  const installed = await destination.importGitProjection({
    ...inputOptions,
    projection: projectionOne,
    confirmationSha256: previewOne.plan.confirmationSha256,
    authorization: authorization('authority-store.sync')
  });
  assert.equal(installed.mode, 'install');
  assert.equal(installed.changed, true);
  assert.equal(installed.projectionSha256, projectionOne.recordSha256);
  assert.deepEqual(installed.gitProvenance, { stateBranch, stateCommit });
  assert.equal(Object.hasOwn(installed, 'signedTransportSha256'), false);
  assert.equal(Object.hasOwn(installed, 'signerKeyId'), false);

  const receiptNames = await readdir(path.join(destinationRoot, 'transport', 'receipts'));
  assert.equal(receiptNames.length, 1);
  const receiptEnvelope = validatePlatformEnvelope(JSON.parse(await readFile(
    path.join(destinationRoot, 'transport', 'receipts', receiptNames[0]), 'utf8'
  )), 'platform-authority-git-cutover');
  assert.equal(receiptEnvelope.record.projectionSha256, projectionOne.recordSha256);
  assert.equal(receiptEnvelope.record.stateBranch, stateBranch);
  assert.equal(receiptEnvelope.record.stateCommit, stateCommit);
  assert.equal(Object.hasOwn(receiptEnvelope.record, 'signedTransportSha256'), false);
  assert.equal(Object.hasOwn(receiptEnvelope.record, 'signerKeyId'), false);

  destination = await openFilesystemAuthorityStore({
    root: destinationRoot, storeId: 'git-store'
  });
  const noopPreview = await destination.planGitProjectionImport({
    ...inputOptions, projection: projectionOne
  });
  assert.equal(noopPreview.plan.mode, 'noop');
  const noop = await destination.importGitProjection({
    ...inputOptions,
    projection: projectionOne,
    confirmationSha256: noopPreview.plan.confirmationSha256
  });
  assert.equal(noop.status, 'already-current');
  assert.equal(noop.changed, false);

  await append(source, 'fixture:two', { enabled: true });
  const projectionTwo = await source.exportGitProjection(exportOptions);
  const fastForwardPreview = await destination.planGitProjectionImport({
    ...inputOptions, projection: projectionTwo
  });
  assert.equal(fastForwardPreview.plan.mode, 'fast-forward');
  const fastForwarded = await destination.importGitProjection({
    ...inputOptions,
    projection: projectionTwo,
    confirmationSha256: fastForwardPreview.plan.confirmationSha256,
    authorization: authorization('authority-store.sync')
  });
  assert.equal(fastForwarded.mode, 'fast-forward');
  assert.equal(fastForwarded.importedEventCount, 1);
  assert.equal((await destination.read()).recordSha256, projectionTwo.head.recordSha256);

  await assert.rejects(() => destination.planRollback({
    cutoverSha256: fastForwarded.cutoverSha256,
    validateRollback: () => undefined,
    minimumAuthority: {
      revision: projectionTwo.head.revision,
      stateSha256: projectionTwo.head.recordSha256,
      projectionSha256: projectionTwo.recordSha256
    }
  }), (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_ROLLBACK_REFUSED'
    && /approved anti-rollback checkpoint/u.test(error.message));
  await assert.rejects(() => destination.planRollback({
    cutoverSha256: fastForwarded.cutoverSha256,
    validateRollback: () => undefined,
    minimumAuthority: {
      // The rollback target is revision 1, so a simple >= check would accept this counterfeit
      // revision-zero checkpoint. Exact lineage reconstruction must refuse it.
      revision: 0,
      stateSha256: platformSha256('checkpoint-from-another-lineage'),
      projectionSha256: platformSha256('projection-from-another-lineage')
    }
  }), (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_ROLLBACK_REFUSED'
    && /does not contain the approved anti-rollback checkpoint/u.test(error.message));

  const rollbackPreview = await destination.planRollback({
    cutoverSha256: fastForwarded.cutoverSha256,
    validateRollback: () => undefined
  });
  const rolledBack = await destination.rollbackTransport({
    cutoverSha256: fastForwarded.cutoverSha256,
    confirmationSha256: rollbackPreview.plan.confirmationSha256,
    authorization: authorization('authority-store.rollback'),
    validateRollback: () => undefined
  });
  assert.equal(rolledBack.status, 'rolled-back');
  assert.equal((await destination.read()).recordSha256, projectionOne.head.recordSha256);
});

test('Git projection planning refuses divergent authority lineage', async (t) => {
  const parent = await directory(t, 'sflow-authority-git-diverged-');
  const source = await openFilesystemAuthorityStore({
    root: path.join(parent, 'source'), storeId: 'git-store'
  });
  const destination = await openFilesystemAuthorityStore({
    root: path.join(parent, 'destination'), storeId: 'git-store'
  });
  await append(source, 'fixture:selection', { value: 'source' });
  await append(destination, 'fixture:selection', { value: 'destination' });
  const repositoryBindingSha256 = platformSha256('git-projection-repository');
  const policySha256 = platformSha256('git-projection-policy');
  const projection = await source.exportGitProjection({
    repositoryBindingSha256,
    policySha256,
    validateEntries: () => ({ valid: true })
  });
  await assert.rejects(() => destination.planGitProjectionImport({
    ...projectionOptions(repositoryBindingSha256, policySha256), projection
  }), (error) => error.code === 'SGOS_AUTHORITY_TRANSPORT_DIVERGED');
});
