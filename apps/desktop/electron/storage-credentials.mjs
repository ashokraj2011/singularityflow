import { readFile, unlink } from 'node:fs/promises';
import { atomicPrivateJson, withLocalStoreMutation } from './local-store.mjs';

const VERSION = 1;

function safeId(value) {
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error('Storage provider ID is invalid.');
  return id;
}

function assertEncryption(safeStorage) {
  if (!safeStorage?.isEncryptionAvailable?.()) throw new Error('Secure credential storage is unavailable on this operating-system account.');
  if (safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('The operating-system keychain is unavailable; storage credentials will not be saved insecurely.');
}

function normalize(value) {
  if (!value || value.schemaVersion !== VERSION || !value.providers || typeof value.providers !== 'object' || Array.isArray(value.providers)) {
    throw new Error('The encrypted storage credential store is invalid.');
  }
  return {
    schemaVersion: VERSION,
    providers: Object.fromEntries(Object.entries(value.providers).map(([id, record]) => [
      safeId(id),
      {
        token: String(record?.token ?? ''),
        refreshToken: record?.refreshToken ? String(record.refreshToken) : null,
        tokenType: record?.tokenType ? String(record.tokenType) : null,
        expiresAt: record?.expiresAt ? String(record.expiresAt) : null,
        scope: record?.scope ? String(record.scope) : null,
        authMode: record?.authMode ? String(record.authMode) : 'manual-token',
        updatedAt: record?.updatedAt ?? null
      }
    ]))
  };
}

export class StorageCredentialStore {
  constructor(file, safeStorage) {
    this.file = file;
    this.safeStorage = safeStorage;
  }

  async #read() {
    try {
      const envelope = JSON.parse(await readFile(this.file, 'utf8'));
      if (envelope?.schemaVersion !== VERSION || !envelope.sealed) throw new Error('The encrypted storage credential envelope is invalid.');
      assertEncryption(this.safeStorage);
      return normalize(JSON.parse(this.safeStorage.decryptString(Buffer.from(envelope.sealed, 'base64'))));
    } catch (error) {
      if (error?.code === 'ENOENT') return { schemaVersion: VERSION, providers: {} };
      throw error;
    }
  }

  async #write(store) {
    assertEncryption(this.safeStorage);
    const sealed = this.safeStorage.encryptString(JSON.stringify(normalize(store))).toString('base64');
    await atomicPrivateJson(this.file, { schemaVersion: VERSION, sealed });
  }

  async save(providerId, token) {
    const id = safeId(providerId);
    if (!String(token ?? '').trim()) throw new Error('Storage credential token is required.');
    return withLocalStoreMutation(this.file, async () => {
      const store = await this.#read();
      store.providers[id] = {
        token: String(token),
        refreshToken: null,
        tokenType: null,
        expiresAt: null,
        scope: null,
        authMode: 'manual-token',
        updatedAt: new Date().toISOString()
      };
      await this.#write(store);
      return { providerId: id, connected: true, updatedAt: store.providers[id].updatedAt };
    });
  }

  async saveOAuth(providerId, credential) {
    const id = safeId(providerId);
    if (!String(credential?.token ?? '').trim()) throw new Error('OAuth access token is required.');
    return withLocalStoreMutation(this.file, async () => {
      const store = await this.#read();
      store.providers[id] = {
        token: String(credential.token),
        refreshToken: credential.refreshToken ? String(credential.refreshToken) : null,
        tokenType: String(credential.tokenType ?? 'Bearer'),
        expiresAt: credential.expiresAt ? String(credential.expiresAt) : null,
        scope: credential.scope ? String(credential.scope) : null,
        authMode: 'oauth-pkce',
        updatedAt: new Date().toISOString()
      };
      await this.#write(store);
      return {
        providerId: id,
        connected: true,
        authMode: 'oauth-pkce',
        expiresAt: store.providers[id].expiresAt,
        updatedAt: store.providers[id].updatedAt
      };
    });
  }

  async load(providerId) {
    const id = safeId(providerId);
    const store = await this.#read();
    if (!store.providers[id]?.token) throw new Error(`No secure credential is configured for storage provider '${id}'.`);
    return store.providers[id];
  }

  async status() {
    const store = await this.#read();
    return Object.entries(store.providers).map(([providerId, record]) => ({
      providerId,
      connected: Boolean(record.token),
      authMode: record.authMode,
      expiresAt: record.expiresAt,
      updatedAt: record.updatedAt
    }));
  }

  async disconnect(providerId) {
    const id = safeId(providerId);
    return withLocalStoreMutation(this.file, async () => {
      const store = await this.#read();
      delete store.providers[id];
      if (!Object.keys(store.providers).length) {
        await unlink(this.file).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
        return { providerId: id, connected: false };
      }
      await this.#write(store);
      return { providerId: id, connected: false };
    });
  }
}
