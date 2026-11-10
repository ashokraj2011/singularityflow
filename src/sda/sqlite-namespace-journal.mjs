/** SQLite owns conditional commit and crash durability. No Git, lifecycle or model dependencies. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { exactObject, namespaceError, namespaceRevision, namespaceScope } from './namespace/values.mjs';
import { namespaceBinding, namespaceLimits, assertNamespaceBinding, assertNamespaceNotCancelled } from './namespace/contract.mjs';
import { namespaceTransaction, namespaceTransactionIdentity } from './namespace/transaction.mjs';
import { applyNamespaceTransaction, emptyNamespaceState } from './namespace/state-transition.mjs';
import { SQLITE_NAMESPACE_SCHEMAS, admitSqliteNamespaceSchema } from './namespace/storage-schemas.mjs';
import { NAMESPACE_JOURNAL_PORT } from './namespace/journal-contract.mjs';
import { createValidatedNamespaceViewCache } from './namespace/validated-view-cache.mjs';
import { openNativeSqliteDatabase } from './sqlite-native.mjs';

const FORMAT = 'sflow-sqlite-namespace/v1';
const MAX_ENTRY_BYTES = 1_048_576;
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const corrupt = (message, cause) => namespaceError(message, 'SDA_NAMESPACE_CORRUPT', { stage: 'database-read' }, cause);
const META = 'CREATE TABLE sflow_ns_meta (slot INTEGER PRIMARY KEY CHECK (slot = 1), body TEXT NOT NULL) STRICT';
const ENTRIES = 'CREATE TABLE sflow_ns_entries (scope_key TEXT NOT NULL, seq INTEGER NOT NULL CHECK (seq > 0 AND seq <= 9007199254740991), body TEXT NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY (scope_key, seq)) STRICT';
const HEADS = 'CREATE TABLE sflow_ns_heads (scope_key TEXT PRIMARY KEY, seq INTEGER NOT NULL CHECK (seq > 0 AND seq <= 9007199254740991), sha256 TEXT NOT NULL) STRICT';
const normalizeSql = value => String(value).replace(/\s+/gu, ' ').trim().replace(/;$/u, '');

function unavailable(stage, cause) {
  if (typeof cause?.code === 'string' && cause.code.startsWith('SDA_NAMESPACE_')) return cause;
  if ([11, 26].includes(cause?.errcode & 255)) return corrupt('The SQLite namespace database is corrupt or has an invalid format.', cause);
  return namespaceError('The namespace database did not complete the operation.', 'SDA_NAMESPACE_UNAVAILABLE', {
    stage, timedOut: cause?.code === 'ETIMEDOUT', ...(cause?.errcode === undefined ? {} : { sqliteCode: cause.errcode })
  }, cause);
}

function parseJson(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_ENTRY_BYTES) throw corrupt('A database namespace record exceeds its storage bound.');
  try { return JSON.parse(value); } catch (cause) { throw corrupt('A database namespace record contains invalid JSON.', cause); }
}

function manifestValue(value, binding, limits) {
  let storedLimits, storedBinding;
  try {
    exactObject(value, ['schemaVersion', 'format', 'storeId', 'binding', 'limits', 'cursorKey']);
    admitSqliteNamespaceSchema('manifest', value);
    storedLimits = namespaceLimits(value.limits); storedBinding = namespaceBinding(value.binding);
    if (value.format !== FORMAT || typeof value.storeId !== 'string'
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.storeId)
      || typeof value.cursorKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value.cursorKey)) {
      throw new Error('Database manifest identity is invalid.');
    }
  } catch (cause) {
    if (cause.code === 'SDA_NAMESPACE_UNSUPPORTED') throw cause;
    throw corrupt('The SQLite namespace manifest is invalid.', cause);
  }
  if (!same(storedBinding, binding) || Object.keys(storedLimits).some(key => key !== 'maxPage' && storedLimits[key] !== limits[key])) {
    throw namespaceError('The requested binding or record/transaction limits do not match this database.');
  }
  return value;
}

/** An ordinary open never initializes an absent or unrelated database. */
export async function openSqliteNamespaceJournal({ filename, binding, limits, create = false, busyTimeoutMs = 1000 }) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0') || typeof create !== 'boolean'
    || !Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 300_000) {
    throw namespaceError('SQLite namespace storage requires an absolute filename and bounded creation/lock policy.');
  }
  const normalizedBinding = namespaceBinding(binding), normalizedLimits = namespaceLimits(limits);
  let database, originalFile, manifest;
  const rollback = () => { try { database.exec('ROLLBACK'); } catch { /* Preserve the original result and native cause. */ } };
  const initialize = async timeout => {
    const observedFile = await lstat(filename);
    if (!observedFile.isFile() || observedFile.isSymbolicLink()
      || observedFile.ino !== originalFile.ino || observedFile.dev !== originalFile.dev) {
      throw namespaceError('The namespace database file changed while it was being opened.', 'SDA_NAMESPACE_UNAVAILABLE');
    }
    database = await openNativeSqliteDatabase(filename);
    database.exec(`PRAGMA busy_timeout = ${timeout}`);
    database.exec('PRAGMA synchronous = FULL');
    const tables = () => database.prepare("SELECT name, type, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all();
    const checkTables = observed => {
      if (observed.length !== 3 || observed[0].name !== 'sflow_ns_entries' || observed[1].name !== 'sflow_ns_heads' || observed[2].name !== 'sflow_ns_meta'
        || observed.some(value => value.type !== 'table')
        || normalizeSql(observed[0].sql) !== normalizeSql(ENTRIES) || normalizeSql(observed[1].sql) !== normalizeSql(HEADS)
        || normalizeSql(observed[2].sql) !== normalizeSql(META)) {
        throw corrupt('The namespace database has an unrecognized table layout.');
      }
    };
    let observed = tables();
    if (observed.length === 0 && create) {
      database.exec('BEGIN IMMEDIATE');
      try {
        observed = tables();
        if (!observed.length) {
          database.exec(META); database.exec(ENTRIES); database.exec(HEADS);
          const candidate = { schemaVersion: SQLITE_NAMESPACE_SCHEMAS.manifest.currentVersion, format: FORMAT,
            storeId: randomUUID(), binding: normalizedBinding, limits: normalizedLimits,
            cursorKey: randomBytes(32).toString('base64url') };
          database.prepare('INSERT INTO sflow_ns_meta (slot, body) VALUES (1, ?)').run(JSON.stringify(candidate));
        } else checkTables(observed);
        database.exec('COMMIT');
      } catch (cause) { rollback(); throw cause; }
    } else {
      if (!observed.length) throw namespaceError('The database has no completed namespace initialization; explicitly create the authorized store to resume.',
        'SDA_NAMESPACE_UNAVAILABLE', { stage: 'database-initialization' });
      checkTables(observed);
    }
    const rows = database.prepare('SELECT slot, body FROM sflow_ns_meta').all();
    if (rows.length !== 1 || rows[0].slot !== 1) throw corrupt('The namespace database has no single store identity.');
    manifest = manifestValue(parseJson(rows[0].body), normalizedBinding, normalizedLimits);
    const mode = database.prepare('PRAGMA journal_mode = WAL').get();
    if (mode.journal_mode !== 'wal') throw namespaceError('The database could not enable the required WAL mode.', 'SDA_NAMESPACE_UNSUPPORTED');
    database.exec('PRAGMA synchronous = FULL');
    if (database.prepare('PRAGMA synchronous').get().synchronous !== 2) {
      throw namespaceError('The database could not enable full commit durability.', 'SDA_NAMESPACE_UNSUPPORTED');
    }
    const acceptedFile = await lstat(filename);
    if (acceptedFile.ino !== originalFile.ino || acceptedFile.dev !== originalFile.dev || acceptedFile.isSymbolicLink()) {
      throw namespaceError('The namespace database file changed while it was being opened.', 'SDA_NAMESPACE_UNAVAILABLE');
    }
  };
  try {
    if (create) {
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      try { const reservation = await open(filename, 'wx', 0o600); await reservation.close(); }
      catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    }
    originalFile = await lstat(filename);
    if (!originalFile.isFile() || originalFile.isSymbolicLink()) throw namespaceError('The database binding must be an ordinary file.');
    const deadline = process.hrtime.bigint() + BigInt(busyTimeoutMs) * 1_000_000n;
    const remaining = () => Math.max(0, Number((deadline - process.hrtime.bigint()) / 1_000_000n));
    for (;;) {
      try { await initialize(Math.max(1, remaining())); break; }
      catch (cause) {
        try { database?.close(); } catch { /* Preserve the original initialization error. */ }
        database = undefined;
        // SQLite can return BUSY during mode negotiation without invoking its busy handler.
        // Only opening is retried; no application transaction has been issued by this journal yet.
        const wait = remaining();
        if (!Number.isSafeInteger(cause?.errcode) || (cause.errcode & 255) !== 5 || !wait) throw cause;
        await new Promise(resolve => setTimeout(resolve, Math.min(10, wait)));
      }
    }
  } catch (cause) { try { database?.close(); } catch {} throw unavailable('database-open', cause); }

  const manifestBytes = JSON.stringify(manifest), key = scope => hash(JSON.stringify(namespaceScope(scope)));
  const views=createValidatedNamespaceViewCache(),observedVersions=new WeakMap();
  let closed = false;
  function checkLocation() {
    if (closed) throw namespaceError('The namespace database connection is closed.', 'SDA_NAMESPACE_UNAVAILABLE', { stage: 'database-closed' });
    const observed = lstatSync(filename);
    if (!observed.isFile() || observed.isSymbolicLink() || observed.ino !== originalFile.ino || observed.dev !== originalFile.dev) {
      throw namespaceError('The namespace database file was moved or replaced.', 'SDA_NAMESPACE_UNAVAILABLE', { stage: 'database-location' });
    }
  }
  function checkManifest() {
    const observed = database.prepare('SELECT slot, body FROM sflow_ns_meta').all();
    if (observed.length !== 1 || observed[0].slot !== 1) throw corrupt('The namespace database identity changed.');
    const value = manifestValue(parseJson(observed[0].body), normalizedBinding, normalizedLimits);
    if (JSON.stringify(value) !== manifestBytes) throw corrupt('The namespace database identity changed while it was open.');
  }
  function dataVersion(){const value=database.prepare('PRAGMA data_version').get().data_version;
    if(!Number.isSafeInteger(value)||value<1)throw corrupt('The database returned an invalid change token.');return value;}
  async function read(scope, { through = null } = {}, force=false) {
    const normalizedScope = namespaceScope(scope);
    let rows, acceptedHead,cached,versionBefore,versionAfter,token;
    try {
      checkLocation();versionBefore=dataVersion();database.exec('BEGIN');
      try {
        checkManifest();
        acceptedHead = database.prepare('SELECT seq, sha256 FROM sflow_ns_heads WHERE scope_key = ?').get(key(normalizedScope));
        token={version:versionBefore,sequence:acceptedHead?.seq??0,sha256:acceptedHead?.sha256??null};
        cached=force?null:views.get(key(normalizedScope)+':'+String(through),token);
        rows = cached?null:through === null
          ? database.prepare('SELECT seq, body, sha256 FROM sflow_ns_entries WHERE scope_key = ? ORDER BY seq').all(key(normalizedScope))
          : database.prepare('SELECT seq, body, sha256 FROM sflow_ns_entries WHERE scope_key = ? AND seq <= ? ORDER BY seq').all(key(normalizedScope), through);
        database.exec('COMMIT');
      } catch (cause) { rollback(); throw cause; }
      versionAfter=dataVersion();
      // An external commit between the token and the snapshot must never hide a changed prefix.
      if(cached){if(versionBefore!==versionAfter)return read(normalizedScope,{through},true);
        observedVersions.set(cached,{scope:key(normalizedScope),version:versionAfter});return cached;}
      let state = emptyNamespaceState(), sequence = 0, sha256 = null;
      const revisions = new Set();
      for (const row of rows) {
        try {
          const body = parseJson(row.body);
          exactObject(body, ['schemaVersion', 'storeId', 'binding', 'scope', 'sequence', 'previousSha256', 'revision', 'transaction']);
          if (hash(row.body) !== row.sha256) throw new Error('Database entry digest mismatch.');
          admitSqliteNamespaceSchema('entry', body);
          if (row.seq !== sequence + 1 || body.sequence !== row.seq || body.storeId !== manifest.storeId
            || !same(namespaceBinding(body.binding), normalizedBinding) || !same(namespaceScope(body.scope), normalizedScope)
            || body.previousSha256 !== sha256 || namespaceRevision(body.revision) === null || revisions.has(body.revision)) {
            throw new Error('Database journal identity or sequence mismatch.');
          }
          const transaction = namespaceTransaction(body.transaction, normalizedLimits);
          for (const value of [...transaction.preconditions, ...transaction.changes, ...transaction.events]) {
            assertNamespaceBinding({ binding: normalizedBinding }, value.namespace);
          }
          const applied = applyNamespaceTransaction(state, normalizedScope, transaction, {
            revision: body.revision, requestDigest: hash(namespaceTransactionIdentity(normalizedScope, transaction, normalizedLimits)), limits: normalizedLimits
          });
          if (applied.replayed) throw new Error('A duplicate operation was appended to the database journal.');
          state = applied.state; sequence += 1; sha256 = row.sha256; revisions.add(body.revision);
        } catch (cause) {
          if (cause.code === 'SDA_NAMESPACE_UNSUPPORTED') throw cause;
          throw corrupt('The namespace database failed journal integrity or transaction validation.', cause);
        }
      }
      if (through !== null && sequence !== through) throw corrupt('The retained database snapshot is missing.');
      if (acceptedHead && (!Number.isSafeInteger(acceptedHead.seq) || acceptedHead.seq < 1
        || typeof acceptedHead.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(acceptedHead.sha256))) {
        throw corrupt('The namespace database head is invalid.');
      }
      if (through === null && ((acceptedHead?.seq ?? 0) !== sequence || (acceptedHead?.sha256 ?? null) !== sha256)) {
        throw corrupt('The accepted namespace database prefix is missing or has another digest.');
      }
      if (through !== null && ((acceptedHead?.seq ?? 0) < through
        || (acceptedHead?.seq === through && acceptedHead.sha256 !== sha256))) {
        throw corrupt('The retained namespace database prefix lost its accepted binding.');
      }
      const value={scope:normalizedScope,state,sequence,sha256};
      if(versionBefore===versionAfter)views.put(key(normalizedScope)+':'+String(through),token,value);
      observedVersions.set(value,{scope:key(normalizedScope),version:versionBefore});return value;
    } catch (cause) { throw unavailable('database-read', cause); }
  }

  async function append(scope, observed, input, { signal } = {}) {
    const normalizedScope = namespaceScope(scope), transaction = namespaceTransaction(input, normalizedLimits);
    const observation=observedVersions.get(observed);views.clear();
    if(observation&&observation.scope!==key(normalizedScope))throw namespaceError('The observed prefix belongs to another project scope.');
    for (const value of [...transaction.preconditions, ...transaction.changes, ...transaction.events]) {
      assertNamespaceBinding({ binding: normalizedBinding }, value.namespace);
    }
    const revision = `sql:${randomUUID()}`;
    const applied = applyNamespaceTransaction(observed.state, normalizedScope, transaction, {
      revision, requestDigest: hash(namespaceTransactionIdentity(normalizedScope, transaction, normalizedLimits)), limits: normalizedLimits
    });
    if (applied.replayed) return { accepted: true, ...applied };
    let commitAttempted = false;
    try {
      assertNamespaceNotCancelled(signal); checkLocation(); database.exec('BEGIN IMMEDIATE');
      try {
        checkManifest();
        if(observation&&observation.version!==dataVersion()){
          database.exec('ROLLBACK');return {accepted:false};}
        const head = database.prepare('SELECT seq, sha256 FROM sflow_ns_heads WHERE scope_key = ?').get(key(normalizedScope));
        if ((head?.seq ?? 0) !== observed.sequence || (head?.sha256 ?? null) !== observed.sha256) {
          database.exec('ROLLBACK'); return { accepted: false };
        }
        const sequence = observed.sequence + 1;
        if (!Number.isSafeInteger(sequence)) throw namespaceError('The database journal exhausted its sequence range.', 'SDA_NAMESPACE_UNAVAILABLE');
        const body = { schemaVersion: SQLITE_NAMESPACE_SCHEMAS.entry.currentVersion, storeId: manifest.storeId,
          binding: normalizedBinding, scope: normalizedScope, sequence, previousSha256: observed.sha256, revision, transaction };
        const bytes = JSON.stringify(body);
        database.prepare('INSERT INTO sflow_ns_entries (scope_key, seq, body, sha256) VALUES (?, ?, ?, ?)')
          .run(key(normalizedScope), sequence, bytes, hash(bytes));
        database.prepare('INSERT INTO sflow_ns_heads (scope_key, seq, sha256) VALUES (?, ?, ?) ON CONFLICT(scope_key) DO UPDATE SET seq = excluded.seq, sha256 = excluded.sha256')
          .run(key(normalizedScope), sequence, hash(bytes));
        assertNamespaceNotCancelled(signal);
        commitAttempted = true; database.exec('COMMIT');
        return { accepted: true, ...applied };
      } catch (cause) { rollback(); throw cause; }
    } catch (cause) {
      if (commitAttempted) throw namespaceError('The database commit may have completed; inspect this operation before retrying.',
        'SDA_NAMESPACE_OUTCOME_UNKNOWN', { operationId: transaction.operationId, stage: 'database-commit', timedOut: cause?.code === 'ETIMEDOUT' }, cause);
      throw unavailable('database-commit', cause);
    }
  }
  return Object.freeze({ contract: NAMESPACE_JOURNAL_PORT,
    manifest: Object.freeze({ storeId: manifest.storeId, binding: normalizedBinding, cursorKey: manifest.cursorKey }), read, append,
    async confirm(scope) {
      try {
        await read(scope); checkLocation();
        const result = database.prepare('PRAGMA wal_checkpoint(FULL)').get();
        if (result.busy !== 0) throw namespaceError('Database durability confirmation is waiting for another connection.',
          'SDA_NAMESPACE_UNAVAILABLE', { stage: 'database-confirmation', busy: result.busy });
      } catch (cause) { throw unavailable('database-confirmation', cause); }
    },
    close() { if (!closed) { views.clear();database.close(); closed = true; } }
  });
}
