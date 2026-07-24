import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StorageCredentialStore } from '../apps/desktop/electron/storage-credentials.mjs';

function safeStorage(available = true, backend = 'keychain') {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => Buffer.from(`sealed:${value}`),
    decryptString: (value) => value.toString().replace(/^sealed:/, '')
  };
}

test('desktop source credentials are encrypted, scoped by provider, and never exposed by status', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-storage-credentials-'));
  const file = path.join(root, 'storage.json');
  const store = new StorageCredentialStore(file, safeStorage());
  await store.save('artifactory', 'secret-token');
  assert.equal((await store.load('artifactory')).token, 'secret-token');
  const status = await store.status();
  assert.deepEqual(Object.keys(status[0]).sort(), ['authMode', 'connected', 'expiresAt', 'providerId', 'updatedAt']);
  assert.equal(status[0].authMode, 'manual-token');
  assert.doesNotMatch(await readFile(file, 'utf8'), /secret-token/);
  await store.disconnect('artifactory');
  await assert.rejects(() => store.load('artifactory'), /No secure credential/);
});

test('desktop encrypts OAuth access and refresh tokens while exposing only safe session metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-storage-oauth-'));
  const file = path.join(root, 'storage.json');
  const store = new StorageCredentialStore(file, safeStorage());
  await store.saveOAuth('sharepoint', {
    token: 'access-secret',
    refreshToken: 'refresh-secret',
    expiresAt: '2030-01-01T00:00:00.000Z',
    scope: 'offline_access Sites.ReadWrite.All'
  });
  const loaded = await store.load('sharepoint');
  assert.equal(loaded.refreshToken, 'refresh-secret');
  assert.equal(loaded.authMode, 'oauth-pkce');
  assert.deepEqual(await store.status(), [{
    providerId: 'sharepoint',
    connected: true,
    authMode: 'oauth-pkce',
    expiresAt: '2030-01-01T00:00:00.000Z',
    updatedAt: loaded.updatedAt
  }]);
  const bytes = await readFile(file, 'utf8');
  assert.doesNotMatch(bytes, /access-secret|refresh-secret/);
});

test('desktop refuses storage credentials when OS-backed encryption is unavailable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-storage-insecure-'));
  await assert.rejects(
    () => new StorageCredentialStore(path.join(root, 'storage.json'), safeStorage(false)).save('sharepoint', 'token'),
    /Secure credential storage is unavailable/
  );
  await assert.rejects(
    () => new StorageCredentialStore(path.join(root, 'storage.json'), safeStorage(true, 'basic_text')).save('sharepoint', 'token'),
    /keychain is unavailable/
  );
});
