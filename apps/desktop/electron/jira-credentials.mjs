import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
      assertEncryption(this.safeStorage);
      const clear = this.safeStorage.decryptString(Buffer.from(envelope.sealed, 'base64'));
      const value = JSON.parse(clear);
      return { schemaVersion: 1, active: value.active ?? null, connections: value.connections ?? {} };
    } catch (error) {
      if (error?.code === 'ENOENT') return { schemaVersion: 1, active: null, connections: {} };
      throw error;
    }
  }

  async #write(value) {
    assertEncryption(this.safeStorage);
    await mkdir(path.dirname(this.file), { recursive: true });
    const sealed = this.safeStorage.encryptString(JSON.stringify(value)).toString('base64');
    const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, `${JSON.stringify({ schemaVersion: 1, sealed })}\n`, { mode: 0o600 });
    await chmod(temp, 0o600).catch(() => {});
    await rename(temp, this.file);
    await chmod(this.file, 0o600).catch(() => {});
  }

  async save(connection) {
    const store = await this.#read();
    const name = connection.name || 'corporate-jira';
    store.connections[name] = { ...connection, name, connectedAt: new Date().toISOString() };
    store.active = name;
    await this.#write(store);
    return { connected: true, active: name, connection: publicConnection(store.connections[name]) };
  }

  async load(name = null) {
    const store = await this.#read();
    const selected = name ?? store.active;
    if (!selected || !store.connections[selected]) throw new Error('No Jira connection is configured in this desktop profile.');
    return store.connections[selected];
  }

  async status() {
    const store = await this.#read();
    return {
      connected: Boolean(store.active && store.connections[store.active]),
      active: store.active,
      connection: store.active && store.connections[store.active] ? publicConnection(store.connections[store.active]) : null,
      connections: Object.values(store.connections).map(publicConnection)
    };
  }

  async safeStatus() {
    try {
      return await this.status();
    } catch {
      return {
        connected: false,
        active: null,
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
    await unlink(this.file).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    return { connected: false, active: null, connection: null, connections: [] };
  }

  async disconnect(name = null) {
    const store = await this.#read();
    const selected = name ?? store.active;
    if (selected) delete store.connections[selected];
    if (store.active === selected) store.active = Object.keys(store.connections)[0] ?? null;
    if (!Object.keys(store.connections).length) {
      await unlink(this.file).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
      return { connected: false, active: null, connections: [] };
    }
    await this.#write(store);
    return this.status();
  }
}

export { assertEncryption as assertJiraCredentialEncryption, publicConnection };
