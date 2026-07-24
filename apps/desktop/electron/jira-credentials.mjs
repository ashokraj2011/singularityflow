import { readFile, unlink } from 'node:fs/promises';
import { atomicPrivateJson, withLocalStoreMutation } from './local-store.mjs';

const JIRA_CREDENTIAL_SCHEMA_VERSION = 1;

function safeConnectionName(value) {
  const name = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
    throw new Error('Jira connection name must be a safe identifier containing letters, numbers, dots, underscores, or hyphens.');
  }
  return name;
}

function credentialStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The Jira credential store is not an object.');
  if (value.schemaVersion !== JIRA_CREDENTIAL_SCHEMA_VERSION) {
    throw new Error(`Unsupported Jira credential store version ${value.schemaVersion}; expected version ${JIRA_CREDENTIAL_SCHEMA_VERSION}.`);
  }
  if (!value.connections || typeof value.connections !== 'object' || Array.isArray(value.connections)) {
    throw new Error('The Jira credential store connections are invalid.');
  }
  const connections = Object.create(null);
  for (const [rawName, connection] of Object.entries(value.connections)) {
    const name = safeConnectionName(rawName);
    if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
      throw new Error(`Jira connection '${name}' is invalid.`);
    }
    connections[name] = { ...connection, name };
  }
  const active = value.active == null ? null : safeConnectionName(value.active);
  if (active && !connections[active]) throw new Error(`Active Jira connection '${active}' is missing.`);
  return { schemaVersion: JIRA_CREDENTIAL_SCHEMA_VERSION, active, connections };
}

function assertEncryption(safeStorage) {
  if (!safeStorage?.isEncryptionAvailable?.()) throw new Error('Secure credential storage is unavailable on this operating-system account.');
  const backend = safeStorage.getSelectedStorageBackend?.();
  if (backend === 'basic_text') throw new Error('The operating-system keychain is unavailable; Jira credentials will not be stored insecurely.');
}

function publicConnection(connection) {
  return {
    name: connection.name,
    deployment: connection.deployment,
    baseUrl: connection.baseUrl,
    cloudId: connection.cloudId ?? null,
    authMode: connection.auth?.mode,
    email: connection.auth?.email ?? null,
    connectedAt: connection.connectedAt ?? null,
    account: connection.account ?? null,
    server: connection.server ?? null
  };
}

export class JiraCredentialStore {
  constructor(file, safeStorage) {
    this.file = file;
    this.safeStorage = safeStorage;
  }

  async #read() {
    try {
      const envelope = JSON.parse(await readFile(this.file, 'utf8'));
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('The Jira credential envelope is invalid.');
      if (envelope.schemaVersion !== JIRA_CREDENTIAL_SCHEMA_VERSION) {
        throw new Error(`Unsupported Jira credential envelope version ${envelope.schemaVersion}; expected version ${JIRA_CREDENTIAL_SCHEMA_VERSION}.`);
      }
      if (typeof envelope.sealed !== 'string' || !envelope.sealed) throw new Error('The Jira credential envelope has no encrypted payload.');
      assertEncryption(this.safeStorage);
      const clear = this.safeStorage.decryptString(Buffer.from(envelope.sealed, 'base64'));
      return credentialStore(JSON.parse(clear));
    } catch (error) {
      if (error?.code === 'ENOENT') return credentialStore({
        schemaVersion: JIRA_CREDENTIAL_SCHEMA_VERSION,
        active: null,
        connections: {}
      });
      throw error;
    }
  }

  async #write(value) {
    assertEncryption(this.safeStorage);
    const sealed = this.safeStorage.encryptString(JSON.stringify(credentialStore(value))).toString('base64');
    await atomicPrivateJson(this.file, { schemaVersion: JIRA_CREDENTIAL_SCHEMA_VERSION, sealed });
  }

  async save(connection) {
    const name = safeConnectionName(connection.name || 'corporate-jira');
    return withLocalStoreMutation(this.file, async () => {
      const store = await this.#read();
      store.connections[name] = { ...structuredClone(connection), name, connectedAt: new Date().toISOString() };
      store.active = name;
      await this.#write(store);
      return { connected: true, active: name, connection: publicConnection(store.connections[name]) };
    });
  }

  async load(name = null) {
    const store = await this.#read();
    const selected = name ?? store.active;
    if (!selected || !store.connections[selected]) throw new Error('No Jira connection is configured in this desktop profile.');
    return store.connections[selected];
  }

  async status(name = null) {
    const store = await this.#read();
    const selected = name ?? store.active;
    return {
      connected: Boolean(selected && store.connections[selected]),
      active: store.active,
      selected,
      connection: selected && store.connections[selected] ? publicConnection(store.connections[selected]) : null,
      connections: Object.values(store.connections).map(publicConnection)
    };
  }

  async safeStatus(name = null) {
    try {
      return await this.status(name);
    } catch {
      return {
        connected: false,
        active: null,
        selected: name,
        connection: null,
        connections: [],
        recovery: {
          required: true,
          message: 'The encrypted Jira credential store could not be read. Reset it, then reconnect Jira.'
        }
      };
    }
  }

  async reset() {
    return withLocalStoreMutation(this.file, async () => {
      await unlink(this.file).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      return { connected: false, active: null, connection: null, connections: [] };
    });
  }

  async disconnect(name = null) {
    return withLocalStoreMutation(this.file, async () => {
      const store = await this.#read();
      const selected = name == null ? store.active : safeConnectionName(name);
      if (selected) delete store.connections[selected];
      if (store.active === selected) store.active = Object.keys(store.connections)[0] ?? null;
      if (!Object.keys(store.connections).length) {
        await unlink(this.file).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
        return { connected: false, active: null, selected, connection: null, connections: [] };
      }
      await this.#write(store);
      return this.status(selected);
    });
  }
}

export { assertEncryption as assertJiraCredentialEncryption, publicConnection };
