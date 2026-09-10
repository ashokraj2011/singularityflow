import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import { RDS_DEFAULTS, RDS_ERROR_CODES } from './constants.mjs';

const SESSION_FAMILY = 'repository-catalog-cursor';
const CACHE_FAMILY = 'repository-catalog-cache-entry';
const EPOCH_FAMILY = 'repository-catalog-epoch';
const SELECTION_FAMILY = 'repository-catalog-selection';
const AUDIT_FAMILY = 'repository-discovery-audit';
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const ADVANCE_LEASE_TIMEOUT_MS = RDS_DEFAULTS.maximumAggregateTimeoutMs + 5_000;
const RDS_ERROR_CODE_SET = new Set(RDS_ERROR_CODES);

function fail(message, code = 'REPOSITORY_CATALOG_STORAGE_UNAVAILABLE', details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

export function repositoryCatalogRoot({ env = process.env, home = os.homedir() } = {}) {
  return path.resolve(env.SINGULARITY_FLOW_REPOSITORY_CATALOG
    || path.join(home, '.singularity-flow', 'repository-catalog', 'v1'));
}

function paths(options = {}) {
  const root = repositoryCatalogRoot(options);
  return {
    root,
    sessions: path.join(root, 'sessions'),
    selections: path.join(root, 'selections'),
    cache: path.join(root, 'cache'),
    audit: path.join(root, 'audit'),
    auditEvents: path.join(root, 'audit', 'events.jsonl'),
    key: path.join(root, 'machine.key'),
    epoch: path.join(root, 'epoch.json'),
    lock: path.join(root, '.lock')
  };
}

async function privateDirectory(directory) {
  const existing = await lstat(directory).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
    fail('Repository catalog storage must be a private user-private ordinary directory.');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
}

async function ensureStore(options = {}) {
  const resolved = paths(options);
  for (const directory of [resolved.root, resolved.sessions, resolved.selections, resolved.cache, resolved.audit]) {
    await privateDirectory(directory);
  }
  return resolved;
}

async function atomicJson(file, value) {
  const directory = path.dirname(file);
  await privateDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > RDS_DEFAULTS.maximumStoreBytes) {
    fail('Repository catalog state exceeds the reviewed storage budget.', 'REPOSITORY_CATALOG_LIMIT_REACHED');
  }
  await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, file);
}

async function atomicText(file, bytes, maximumBytes = RDS_DEFAULTS.maximumStoreBytes) {
  const directory = path.dirname(file);
  await privateDirectory(directory);
  if (Buffer.byteLength(bytes) > maximumBytes) {
    fail('Repository catalog state exceeds the reviewed storage budget.', 'REPOSITORY_CATALOG_LIMIT_REACHED');
  }
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, file);
}

async function withLock(options, operation) {
  const store = await ensureStore(options);
  const started = Date.now();
  let handle;
  while (!handle) {
    try {
      handle = await open(store.lock, 'wx', 0o600);
      await handle.writeFile(`${process.pid}\n`);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const age = await stat(store.lock).then((entry) => Date.now() - entry.mtimeMs).catch(() => 0);
      if (age > LOCK_TIMEOUT_MS * 4) await rm(store.lock, { force: true }).catch(() => {});
      if (Date.now() - started >= LOCK_TIMEOUT_MS) {
        fail('Repository catalog state is busy in another process. Retry the same read.');
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
  try { return await operation(store); }
  finally {
    await handle.close().catch(() => {});
    await rm(store.lock, { force: true }).catch(() => {});
  }
}

async function machineKey(store) {
  const existing = await lstat(store.key).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile() || existing.size !== 32) {
      fail('Repository catalog machine key is invalid. Clear only the RDS cache and retry.');
    }
    return readFile(store.key);
  }
  const bytes = randomBytes(32);
  await writeFile(store.key, bytes, { mode: 0o600, flag: 'wx' }).catch(async (error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
  await chmod(store.key, 0o600).catch(() => {});
  return readFile(store.key);
}

export async function localFingerprint(namespace, value, options = {}) {
  const store = await ensureStore(options);
  const key = await machineKey(store);
  return `local-hmac:${createHmac('sha256', key).update(`${namespace}\0${String(value)}`).digest('hex')}`;
}

function token(prefix) { return `${prefix}_${randomBytes(18).toString('base64url')}`; }
function tokenFile(directory, value) {
  return path.join(directory, `${createHash('sha256').update(value).digest('hex')}.json`);
}

async function sealSelections(store, session, result) {
  if (!Array.isArray(result.repositories) || !result.repositories.length) return result;
  const repositories = [];
  for (const repository of result.repositories) {
    const selectionRef = token('rdssel');
    await atomicJson(tokenFile(store.selections, selectionRef), {
      schemaVersion: currentSchemaVersion(SELECTION_FAMILY),
      kind: 'repository-catalog-selection',
      selectionRef,
      epoch: session.epoch,
      sessionRef: session.sessionRef,
      expiresAt: session.expiresAt,
      audience: session.state.audience,
      allowedActions: ['inspect', 'copy-url'],
      recordRef: repository.recordRef,
      recordRevision: repository.recordRevision,
      repositoryIdentity: repository.repositoryIdentity,
      observedLocator: repository.locators?.https ?? repository.locators?.ssh ?? null,
      providerHost: session.state.host ?? null,
      expectedViewerId: session.state.viewerId ?? null,
      sourceRefs: repository.sourceRefs ?? []
    });
    repositories.push({ ...repository, selectionRef });
  }
  return { ...result, repositories };
}

async function readTyped(file, family, { optional = false } = {}) {
  let bytes;
  try { bytes = await readFile(file); }
  catch (error) {
    if (optional && error?.code === 'ENOENT') return null;
    throw error;
  }
  if (bytes.byteLength > RDS_DEFAULTS.maximumStoreBytes) fail('Repository catalog state exceeds the reviewed storage budget.');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { fail('Repository catalog state is corrupt.'); }
  try { return readRecord(family, parsed).record; } catch { fail('Repository catalog state uses an unsupported schema.'); }
}

async function cursorRecord(store, cursor, context) {
  const file = tokenFile(store.sessions, cursor);
  const record = await readTyped(file, SESSION_FAMILY, { optional: true });
  if (!record || record.cursor !== cursor || Date.parse(record.expiresAt) <= Date.now()) {
    fail('Repository catalog cursor is expired or unavailable. Start a fresh scoped traversal.', 'REPOSITORY_CATALOG_CURSOR_STALE');
  }
  if (record.epoch !== await currentEpoch(store)) {
    fail('Repository catalog cursor was invalidated by a cache clear. Start a fresh scoped traversal.', 'REPOSITORY_CATALOG_CURSOR_STALE');
  }
  const expected = record.state?.contextBinding;
  if (!expected || expected !== context.contextBinding) {
    fail('Repository catalog cursor does not match this host, account, query, audience, or policy.', 'REPOSITORY_CATALOG_CURSOR_STALE');
  }
  return { file, record };
}

async function removeExpired(directory, family) {
  const names = await readdir(directory).catch(() => []);
  let retained = 0;
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = path.join(directory, name);
    try {
      const record = await readTyped(file, family);
      if (Date.parse(record.expiresAt) <= Date.now()) await rm(file, { force: true });
      else retained += 1;
    } catch {
      // Corrupt derived cursor/selection state has no authority. Remove only that RDS record.
      await rm(file, { force: true }).catch(() => {});
    }
  }
  return retained;
}

async function currentEpoch(store) {
  const record = await readTyped(store.epoch, EPOCH_FAMILY, { optional: true });
  return Number.isSafeInteger(record?.epoch) && record.epoch >= 0 ? record.epoch : 0;
}

export async function createCatalogSession(state, options = {}) {
  return withLock(options, async (store) => {
    const active = await removeExpired(store.sessions, SESSION_FAMILY);
    if (active >= RDS_DEFAULTS.maximumActiveCursors) {
      fail('Repository catalog has reached its bounded active-cursor limit. Clear expired RDS state or retry after current cursors expire.', 'REPOSITORY_CATALOG_LIMIT_REACHED');
    }
    const sessionRef = token('rdss');
    const cursor = token('rdsc');
    const epoch = await currentEpoch(store);
    const createdAt = new Date().toISOString();
    const record = {
      schemaVersion: currentSchemaVersion(SESSION_FAMILY),
      kind: 'repository-catalog-cursor', sessionRef, cursor, epoch, createdAt,
      expiresAt: new Date(Date.now() + RDS_DEFAULTS.cursorTtlMs).toISOString(),
      inputCursor: null,
      state,
      sealedResult: null,
      successorCursor: null
    };
    await atomicJson(tokenFile(store.sessions, cursor), record);
    return { sessionRef, cursor, epoch, createdAt, expiresAt: record.expiresAt };
  });
}

export async function consumeCatalogCursor(cursor, context, advance, options = {}) {
  if (!/^rdsc_[A-Za-z0-9_-]{20,80}$/.test(String(cursor ?? ''))) {
    fail('Repository catalog cursor is invalid or stale.', 'REPOSITORY_CATALOG_CURSOR_STALE');
  }
  const waitingSince = Date.now();
  let claim;
  while (!claim) {
    const candidate = await withLock(options, async (store) => {
      const { file, record } = await cursorRecord(store, cursor, context);
      if (record.sealedResult) return { result: structuredClone(record.sealedResult) };
      const claimedAt = Date.parse(record.advanceLease?.claimedAt ?? '');
      if (record.advanceLease && Number.isFinite(claimedAt)
          && Date.now() - claimedAt < ADVANCE_LEASE_TIMEOUT_MS) return { waiting: true };
      const advanceLease = { id: token('rdsl'), claimedAt: new Date().toISOString() };
      const claimed = { ...record, advanceLease };
      await atomicJson(file, claimed);
      return { file, record: claimed, advanceLease };
    });
    if (candidate.result) return candidate.result;
    if (!candidate.waiting) claim = candidate;
    else {
      if (Date.now() - waitingSince >= ADVANCE_LEASE_TIMEOUT_MS) {
        fail('Repository catalog cursor is busy in another bounded read. Retry the same cursor.', 'REPOSITORY_CATALOG_STORAGE_UNAVAILABLE');
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }

  // Provider work is deliberately outside the inter-process state lease. The cursor carries a
  // short claim so another process can wait for and replay the exact sealed page without starting
  // a duplicate provider traversal.
  let advanced;
  try {
    advanced = await advance(structuredClone(claim.record.state), claim.record);
    if (!advanced || typeof advanced !== 'object' || !advanced.result) {
      fail('Repository catalog cursor could not produce a valid next step.');
    }
  } catch (error) {
    await withLock(options, async (store) => {
      const current = await readTyped(claim.file, SESSION_FAMILY, { optional: true });
      if (current?.advanceLease?.id === claim.advanceLease.id) {
        const { advanceLease: _discarded, ...released } = current;
        await atomicJson(claim.file, released);
      }
    }).catch(() => {});
    throw error;
  }

  return withLock(options, async (store) => {
    const { file, record } = await cursorRecord(store, cursor, context);
    if (record.sealedResult) return structuredClone(record.sealedResult);
    if (record.advanceLease?.id !== claim.advanceLease.id) {
      fail('Repository catalog cursor changed while its page was being read. Retry from a fresh scoped traversal.', 'REPOSITORY_CATALOG_CURSOR_STALE');
    }
    let successorCursor = null;
    if (advanced.nextState) {
      const active = await removeExpired(store.sessions, SESSION_FAMILY);
      if (active >= RDS_DEFAULTS.maximumActiveCursors) {
        fail('Repository catalog has reached its bounded active-cursor limit.', 'REPOSITORY_CATALOG_LIMIT_REACHED');
      }
      successorCursor = token('rdsc');
      await atomicJson(tokenFile(store.sessions, successorCursor), {
        schemaVersion: currentSchemaVersion(SESSION_FAMILY),
        kind: 'repository-catalog-cursor', sessionRef: record.sessionRef,
        cursor: successorCursor, inputCursor: cursor, epoch: record.epoch,
        createdAt: record.createdAt, expiresAt: record.expiresAt,
        state: advanced.nextState, sealedResult: null, successorCursor: null
      });
    }
    const result = await sealSelections(store, record, {
      ...advanced.result, nextCursor: successorCursor
    });
    const { advanceLease: _discarded, ...withoutLease } = record;
    await atomicJson(file, { ...withoutLease, sealedResult: result, successorCursor });
    return structuredClone(result);
  });
}

export async function resolveCatalogSelection(selectionRef, action = 'inspect', options = {}) {
  if (!/^rdssel_[A-Za-z0-9_-]{20,80}$/.test(String(selectionRef ?? ''))) {
    fail('Repository selection is invalid or stale.', 'REPOSITORY_SELECTION_STALE');
  }
  return withLock(options, async (store) => {
    const record = await readTyped(tokenFile(store.selections, selectionRef), SELECTION_FAMILY, { optional: true });
    if (!record || record.selectionRef !== selectionRef
        || record.epoch !== await currentEpoch(store)
        || Date.parse(record.expiresAt) <= Date.now()
        || !record.allowedActions?.includes(action)) {
      fail('Repository selection is invalid or stale.', 'REPOSITORY_SELECTION_STALE');
    }
    return structuredClone(record);
  });
}

export async function readProviderCache(key, options = {}) {
  return withLock(options, async (store) => {
    const file = tokenFile(store.cache, key);
    let record;
    try { record = await readTyped(file, CACHE_FAMILY, { optional: true }); }
    catch {
      // Cache bytes are derived observations, never authority. A corrupt entry is a safe miss and
      // only that entry is removed; provider authentication and all governed state are untouched.
      await rm(file, { force: true }).catch(() => {});
      return null;
    }
    if (!record || record.cacheKey !== key || Date.parse(record.expiresAt) <= Date.now()
        || record.epoch !== await currentEpoch(store)) {
      if (record) await rm(file, { force: true }).catch(() => {});
      return null;
    }
    const refreshed = { ...record, lastAccessedAt: new Date().toISOString() };
    await atomicJson(file, refreshed);
    return refreshed;
  });
}

export async function writeProviderCache(key, value, { expectedEpoch = null, ...options } = {}) {
  return withLock(options, async (store) => {
    const epoch = await currentEpoch(store);
    if (expectedEpoch != null && expectedEpoch !== epoch) {
      fail('Repository catalog cache changed while a provider read was running.', 'REPOSITORY_CATALOG_CURSOR_STALE');
    }
    const records = Array.isArray(value.records)
      ? value.records.slice(0, RDS_DEFAULTS.maximumStoredRecords) : [];
    const record = {
      schemaVersion: currentSchemaVersion(CACHE_FAMILY),
      kind: 'repository-catalog-cache-entry', cacheKey: key, epoch,
      provider: value.provider,
      accountBinding: value.accountBinding,
      observedAt: value.observedAt,
      lastAccessedAt: new Date().toISOString(),
      complete: value.complete === true,
      expiresAt: new Date(Date.now() + RDS_DEFAULTS.cacheTtlMs).toISOString(),
      records
    };
    const target = tokenFile(store.cache, key);
    const existing = [];
    for (const name of await readdir(store.cache).catch(() => [])) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = path.join(store.cache, name);
      if (file === target) continue;
      try {
        const cached = await readTyped(file, CACHE_FAMILY);
        if (Date.parse(cached.expiresAt) <= Date.now() || cached.epoch !== epoch) {
          await rm(file, { force: true });
          continue;
        }
        const info = await stat(file);
        existing.push({
          file, bytes: info.size,
          records: Array.isArray(cached.records) ? cached.records.length : 0,
          lastAccessedAt: Date.parse(cached.lastAccessedAt ?? cached.observedAt ?? '') || 0
        });
      } catch { await rm(file, { force: true }).catch(() => {}); }
    }
    const recordBytes = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`);
    let totalBytes = recordBytes + existing.reduce((sum, entry) => sum + entry.bytes, 0);
    let totalRecords = records.length + existing.reduce((sum, entry) => sum + entry.records, 0);
    for (const entry of existing.sort((left, right) => left.lastAccessedAt - right.lastAccessedAt)) {
      if (totalBytes <= RDS_DEFAULTS.maximumStoreBytes
          && totalRecords <= RDS_DEFAULTS.maximumStoredRecords) break;
      await rm(entry.file, { force: true });
      totalBytes -= entry.bytes;
      totalRecords -= entry.records;
    }
    if (totalBytes > RDS_DEFAULTS.maximumStoreBytes
        || totalRecords > RDS_DEFAULTS.maximumStoredRecords) {
      fail('Repository catalog cache exceeds its reviewed record or byte budget.', 'REPOSITORY_CATALOG_LIMIT_REACHED');
    }
    await atomicJson(target, record);
    return record;
  });
}

export async function repositoryCatalogCacheStatus(options = {}) {
  const store = await ensureStore(options);
  const entries = await readdir(store.cache).catch(() => []);
  let records = 0; let bytes = 0; let corrupt = 0;
  for (const name of entries.slice(0, 10_000)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) { corrupt += 1; continue; }
    const file = path.join(store.cache, name);
    try {
      const info = await stat(file); bytes += info.size;
      const record = await readTyped(file, CACHE_FAMILY);
      records += Array.isArray(record.records) ? record.records.length : 0;
    } catch { corrupt += 1; }
  }
  return {
    schemaVersion: 1, status: corrupt ? 'attention' : 'ready', entries: entries.length,
    records, bytes, corrupt, private: true, repositoryStateTouched: false
  };
}

export async function clearRepositoryCatalogCache(options = {}) {
  return withLock(options, async (store) => {
    const previous = await currentEpoch(store);
    const entries = await readdir(store.cache).catch(() => []);
    const sessions = await readdir(store.sessions).catch(() => []);
    const selections = await readdir(store.selections).catch(() => []);
    await rm(store.cache, { recursive: true, force: true });
    await rm(store.sessions, { recursive: true, force: true });
    await rm(store.selections, { recursive: true, force: true });
    await privateDirectory(store.cache);
    await privateDirectory(store.sessions);
    await privateDirectory(store.selections);
    await atomicJson(store.epoch, {
      schemaVersion: currentSchemaVersion(EPOCH_FAMILY),
      kind: 'repository-catalog-epoch', epoch: previous + 1
    });
    return {
      schemaVersion: 1, status: 'cleared', removedCacheEntries: entries.length,
      invalidatedSessions: sessions.length, epoch: previous + 1,
      invalidatedSelections: selections.length,
      preserved: ['workspaces', 'capabilities', 'state-branches', 'provider-authentication', 'repositories']
    };
  });
}

export async function repositoryCatalogEpoch(options = {}) {
  const store = await ensureStore(options);
  return currentEpoch(store);
}

/** Append one content-free local observation; repository, query, account, and URL text is absent. */
export async function recordRepositoryDiscoveryAudit(event, options = {}) {
  const surfaces = new Set(['cli', 'copilot', 'vscode']);
  const surface = surfaces.has(event.surface) ? event.surface : 'cli';
  const hostFingerprint = event.host
    ? await localFingerprint('repository-provider-host', event.host, options) : null;
  const record = {
    schemaVersion: currentSchemaVersion(AUDIT_FAMILY),
    kind: 'repository-discovery-audit',
    timestamp: new Date().toISOString(),
    surface,
    operation: String(event.operation ?? 'list').slice(0, 32),
    scope: ['known', 'provider', 'all'].includes(event.scope) ? event.scope : 'known',
    provider: event.provider === 'github' ? 'github' : null,
    hostFingerprint,
    cacheOutcome: ['hit', 'miss', 'not-used'].includes(event.cacheOutcome)
      ? event.cacheOutcome : 'not-used',
    enumeration: ['exhausted', 'more', 'limited', 'failed', 'cancelled']
      .includes(event.enumeration) ? event.enumeration : 'failed',
    resultCount: Math.max(0, Math.min(RDS_DEFAULTS.maximumRows, Number(event.resultCount) || 0)),
    providerRequestCount: Math.max(0, Math.min(
      RDS_DEFAULTS.maximumProviderQueries, Number(event.providerRequestCount) || 0
    )),
    latencyMs: Math.max(0, Math.min(
      RDS_DEFAULTS.maximumAggregateTimeoutMs + 5_000, Number(event.latencyMs) || 0
    )),
    failureCode: event.failureCode && RDS_ERROR_CODE_SET.has(event.failureCode)
      ? event.failureCode : null,
    selectedAction: ['none', 'inspect', 'copy-url'].includes(event.selectedAction)
      ? event.selectedAction : 'none'
  };
  return withLock(options, async (store) => {
    let existing = [];
    const snapshot = await lstat(store.auditEvents).catch((error) =>
      error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (snapshot) {
      if (snapshot.isSymbolicLink() || !snapshot.isFile()
          || snapshot.size > RDS_DEFAULTS.maximumAuditBytes) {
        fail('Repository discovery audit storage is invalid. Clear only the RDS audit before retrying.');
      }
      const bytes = await readFile(store.auditEvents, 'utf8');
      existing = bytes.split('\n').filter(Boolean).flatMap((line) => {
        try { return [readRecord(AUDIT_FAMILY, JSON.parse(line)).record]; }
        catch { return []; }
      });
    }
    const records = [...existing, record].slice(-RDS_DEFAULTS.maximumAuditRecords);
    let text = `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    while (Buffer.byteLength(text) > RDS_DEFAULTS.maximumAuditBytes && records.length > 1) {
      records.shift();
      text = `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    }
    await atomicText(store.auditEvents, text, RDS_DEFAULTS.maximumAuditBytes);
    return record;
  });
}
