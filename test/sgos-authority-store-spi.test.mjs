import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AUTHORITY_STORE_SPI_CAPABILITIES,
  AUTHORITY_STORE_SPI_METHODS,
  AUTHORITY_STORE_SPI_VERSION,
  INSTALLED_AUTHORITY_STORE_PROFILES,
  assertAuthorityStoreAdapter,
  assertAuthorityStoreAdapterContract,
  openFilesystemAuthorityStore
} from '../src/sgos/platform/authority-store.mjs';

async function filesystemStore(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-authority-spi-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  return openFilesystemAuthorityStore({
    root: path.join(parent, 'authority'),
    storeId: 'spi-store'
  });
}

test('the filesystem Authority Store implements the versioned stable SPI', async (t) => {
  const store = await filesystemStore(t);

  assert.equal(store.spiVersion, AUTHORITY_STORE_SPI_VERSION);
  assert.equal(store.profile, 'experimental-filesystem-v1');
  assert.deepEqual(store.capabilities, AUTHORITY_STORE_SPI_CAPABILITIES);
  assert.deepEqual(INSTALLED_AUTHORITY_STORE_PROFILES, ['experimental-filesystem-v1']);
  for (const method of AUTHORITY_STORE_SPI_METHODS) assert.equal(typeof store[method], 'function');
  assert.equal(assertAuthorityStoreAdapterContract(store), store);
  assert.equal(assertAuthorityStoreAdapter(store), store);
});

test('SPI conformance never grants an uninstalled Authority Store profile', async (t) => {
  const store = await filesystemStore(t);
  const alternate = { ...store, profile: 'reviewed-remote-v1' };

  assert.equal(assertAuthorityStoreAdapterContract(alternate), alternate,
    'structural conformance is intentionally distinct from installation authority');
  assert.throws(() => assertAuthorityStoreAdapter(alternate), (error) => {
    assert.equal(error.code, 'SGOS_AUTHORITY_PROFILE_UNSUPPORTED');
    assert.deepEqual(error.details.installedProfiles, ['experimental-filesystem-v1']);
    return true;
  });
});

test('the Authority Store SPI fails closed for missing safety capabilities and methods', async (t) => {
  const store = await filesystemStore(t);
  const weakCapabilities = {
    ...store,
    capabilities: { ...store.capabilities, appendOnlyLineage: false }
  };
  assert.throws(() => assertAuthorityStoreAdapterContract(weakCapabilities), (error) => {
    assert.equal(error.code, 'SGOS_AUTHORITY_ADAPTER_CAPABILITY_MISSING');
    assert.equal(error.details.capability, 'appendOnlyLineage');
    return true;
  });

  const missingMethod = { ...store };
  delete missingMethod.rollbackTransport;
  assert.throws(() => assertAuthorityStoreAdapterContract(missingMethod), (error) => {
    assert.equal(error.code, 'SGOS_AUTHORITY_ADAPTER_METHOD_MISSING');
    assert.equal(error.details.method, 'rollbackTransport');
    return true;
  });

  const newer = { ...store, spiVersion: AUTHORITY_STORE_SPI_VERSION + 1 };
  assert.throws(() => assertAuthorityStoreAdapterContract(newer), (error) => {
    assert.equal(error.code, 'SGOS_AUTHORITY_SPI_UNSUPPORTED');
    return true;
  });
});
