import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireFileLeaseWithin } from '../file-lease.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import { checkoutScope } from './history-cursor.mjs';

const FAMILY = 'ask-conversation';
const ID = /^ask-[a-f0-9]{32}$/u;
const AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 128 * 1024;
const MAX_RECORDS = 16;

const error = (code, message, details) => new SingularityFlowError(message, { code, details });
const unavailable = () => error('ASK_CONVERSATION_UNAVAILABLE', 'No saved Ask conversation is available in this checkout and audience.');
const unsafe = () => error('ASK_CONVERSATION_STORE_UNSAFE', 'Ask conversation storage must be private to the local user.');

function isPrivate(info) {
  return process.platform === 'win32' || (info.uid === process.getuid() && (info.mode & 0o077) === 0);
}

async function privateDirectory(directory, create) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory).catch(cause => {
    if (cause.code === 'ENOENT') return null;
    throw cause;
  });
  if (!info) return false;
  if (!info.isDirectory() || !isPrivate(info)) throw unsafe();
  return true;
}

async function load(directory, id, scope, { family, idPattern, validate }) {
  if (!idPattern.test(id ?? '')) throw unavailable();
  if (process.platform === 'win32') {
    const info = await lstat(path.join(directory, id + '.json')).catch(cause => {
      if (cause.code === 'ENOENT') return null;
      throw cause;
    });
    if (!info) return null;
    if (!info.isFile()) throw unsafe();
  }
  let handle;
  try { handle = await open(path.join(directory, id + '.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (cause) {
    if (cause.code === 'ENOENT') return null;
    if (cause.code === 'ELOOP') throw unsafe();
    throw cause;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || !isPrivate(info) || info.size > MAX_BYTES) throw unsafe();
    const { record } = readRecord(family, await handle.readFile());
    if (record.id !== id || record.scope !== scope || !Number.isSafeInteger(record.revision) || record.revision < 1 ||
        !Number.isFinite(record.updatedAt) || !Array.isArray(record.result?.refs) || record.result.refs.length > 100) throw unsafe();
    return validate ? validate(record) : record;
  } finally {
    await handle.close();
  }
}

async function save(directory, record) {
  const file = path.join(directory, record.id + '.json');
  const bytes = JSON.stringify(record);
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw error('ASK_CONVERSATION_LIMIT', 'This result is too large to save in the Ask conversation.');
  const temporary = file + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function locked(directory, operation) {
  const lease = await acquireFileLeaseWithin(path.join(directory, '.lock'), 2_000);
  if (!lease) throw error('ASK_CONVERSATION_BUSY', 'Another Ask update is in progress. Resume to see the latest result.');
  try { return await operation(); }
  finally { await lease.release(); }
}

export function conversationHome(env = process.env) {
  return path.resolve(env.SINGULARITY_FLOW_ASK_CONVERSATIONS || path.join(os.homedir(), '.singularity-flow', 'ask-conversations'));
}

/** A single filesystem authority serializes expected-version writes on its own persistent disk. */
export function conversationDirectory({ base, scope, family = FAMILY, idPattern = ID, validate = null, validateUpdate = null, authorize = async () => {}, now = Date.now }) {
  const version = path.join(base, 'v1');
  const directory = path.join(version, scope);
  const readEntry = id => load(directory, id, scope, { family, idPattern, validate });
  async function ready(create) {
    for (const part of [base, version, directory]) {
      if (!await privateDirectory(part, create)) return false;
    }
    return true;
  }
  async function entries() {
    const files = (await readdir(directory)).filter(file => file.endsWith('.json') && idPattern.test(file.slice(0, -5)));
    const records = await Promise.all(files.map(file => readEntry(file.slice(0, -5))));
    return records.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const active = record => record && now() - record.updatedAt <= AGE_MS;
  async function exact(id) {
    const found = await readEntry(id);
    if (!active(found)) throw unavailable();
    return found;
  }
  function match(record, expected) {
    if (record.revision !== expected) {
      throw error('ASK_CONVERSATION_CONFLICT', 'This Ask conversation has a newer answer. Resume it before applying another change.',
        { conversationId: record.id, contextRevision: record.revision });
    }
  }
  return {
    async read(id = null, expected) {
      await authorize();
      if (!await ready(false)) throw unavailable();
      const record = id ? await exact(id) : (await entries()).find(active);
      if (!record) throw unavailable();
      if (expected != null) match(record, expected);
      return record;
    },
    async create(fields, id = 'ask-' + randomUUID().replaceAll('-', '')) {
      if (!idPattern.test(id)) throw unavailable();
      await ready(true);
      return locked(directory, async () => {
        await authorize();
        const owned = await entries();
        if (owned.some(record => record.id === id)) throw error('ASK_CONVERSATION_EXISTS', 'That Ask conversation ID is already recorded. Resume it to continue.');
        const record = { ...fields, schemaVersion: currentSchemaVersion(family), scope, id, revision: 1, updatedAt: now() };
        await save(directory, record);
        await Promise.all(owned.filter((item, index) => !active(item) || index >= MAX_RECORDS - 1)
          .map(item => unlink(path.join(directory, item.id + '.json')).catch(cause => {
            if (cause.code !== 'ENOENT') throw cause;
          })));
        return record;
      });
    },
    async update(id, expected, fields) {
      if (!await ready(false)) throw unavailable();
      return locked(directory, async () => {
        await authorize();
        const before = await exact(id);
        match(before, expected);
        validateUpdate?.(before, fields);
        const record = { ...before, ...fields, revision: before.revision + 1, updatedAt: now() };
        await save(directory, record);
        return record;
      });
    },
    async forget(id, expected) {
      if (!await ready(false)) throw unavailable();
      await locked(directory, async () => {
        await authorize();
        const before = await exact(id);
        match(before, expected);
        await unlink(path.join(directory, before.id + '.json'));
      });
    },
    async prune() {
      if (!await ready(false)) return;
      await locked(directory, async () => {
        for (const record of await entries()) {
          if (!active(record)) await unlink(path.join(directory, record.id + '.json'));
        }
      });
    }
  };
}

export async function conversationStore({ root, context, audience, env = process.env, portable = false }) {
  if (!root) throw unavailable();
  if (portable) return (await import('./shared-conversations.mjs')).sharedConversations({ root, context, audience, env });
  return conversationDirectory({ base: conversationHome(env), scope: await checkoutScope(root, context, audience) });
}
