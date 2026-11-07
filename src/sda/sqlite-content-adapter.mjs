/** Application-owned SQLite connection; immutable content never grants lifecycle authority. */
import { createHash, randomUUID } from 'node:crypto';
import { CONTENT_STORAGE_SCHEMA, admitRecordSchemaVersion } from '../foundation/record-schema.mjs';
import { exactObject } from './namespace/values.mjs';
import { assertContentBinding, contentError, contentReadOptions, contentReference, contentStoreDescriptor,
  CONTENT_LIMITS } from './content/contract.mjs';

const FORMAT = 'sflow-sqlite-content/v1';
const SCHEMAS = Object.freeze({
  sflow_content_manifest: 'CREATE TABLE sflow_content_manifest (slot INTEGER PRIMARY KEY CHECK(slot=1), value TEXT NOT NULL) STRICT',
  sflow_content_objects: `CREATE TABLE sflow_content_objects (project_id TEXT NOT NULL, namespace TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=0 AND bytes<=${CONTENT_LIMITS.maximumBytes}), chunks INTEGER NOT NULL CHECK(chunks=(bytes+65535)/65536), PRIMARY KEY(project_id,namespace,sha256)) STRICT`,
  sflow_content_chunks: 'CREATE TABLE sflow_content_chunks (project_id TEXT NOT NULL, namespace TEXT NOT NULL, sha256 TEXT NOT NULL, chunk_index INTEGER NOT NULL CHECK(chunk_index>=0), content BLOB NOT NULL CHECK(length(content)>0 AND length(content)<=65536), PRIMARY KEY(project_id,namespace,sha256,chunk_index), FOREIGN KEY(project_id,namespace,sha256) REFERENCES sflow_content_objects(project_id,namespace,sha256)) STRICT'
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const isContentError = error => typeof error?.code === 'string' && error.code.startsWith('SDA_CONTENT_');
function failure(error, stage) {
  if (isContentError(error)) return error;
  const corrupt = [11, 26].includes(error?.errcode);
  return contentError(corrupt ? 'The SQLite content store is corrupt.' : 'The SQLite content operation did not complete.',
    corrupt ? 'SDA_CONTENT_CORRUPT' : 'SDA_CONTENT_UNAVAILABLE', { stage, timedOut: error?.code === 'ETIMEDOUT' }, error);
}

/** The connection/its file lifecycle and bounded busy policy belong to the application. */
export function createSqliteContentStore(options) {
  exactObject(options, ['database', 'binding'], ['create', 'maximumBytes'], 'SQLite content binding');
  const { database, binding, create = false, maximumBytes = CONTENT_LIMITS.maximumBytes } = options;
  const descriptor = contentStoreDescriptor({ id: 'sqlite-content', binding, maximumBytes });
  if (typeof create !== 'boolean' || typeof database?.exec !== 'function' || typeof database?.prepare !== 'function') {
    throw contentError('An explicit SQLite connection and initialization policy are required.');
  }
  const exec = database.exec.bind(database), prepare = database.prepare.bind(database);
  const statement = sql => {
    const value = prepare(sql);
    return Object.freeze(Object.fromEntries(['get', 'all', 'run'].map(method => [method, value[method].bind(value)])));
  };
  let manifest;
  const catalog = () => statement("SELECT name, type, tbl_name, sql FROM sqlite_master WHERE name IN ('sflow_content_manifest','sflow_content_objects','sflow_content_chunks') OR (type='trigger' AND tbl_name IN ('sflow_content_manifest','sflow_content_objects','sflow_content_chunks')) OR name IN ('sflow_ns_meta','sflow_ns_entries','sflow_ns_heads')").all();
  function validateCatalog(rows) {
    if (rows.length !== 3 || rows.some(row => row.type !== 'table' || row.sql !== SCHEMAS[row.name])) {
      throw contentError('Content tables have another owner, shape or trigger. Use a separate application database, not the namespace journal file.', 'SDA_CONTENT_UNSUPPORTED');
    }
  }
  function admit(value) {
    try { admitRecordSchemaVersion(CONTENT_STORAGE_SCHEMA, value); }
    catch (cause) {
      const unsupported = ['SCHEMA_VERSION_FUTURE', 'SCHEMA_VERSION_ARCHIVED'].includes(cause.code);
      throw contentError(cause.message, unsupported ? 'SDA_CONTENT_UNSUPPORTED' : 'SDA_CONTENT_CORRUPT', { ...cause.details, stage: 'manifest' }, cause);
    }
  }
  function readManifest() {
    validateCatalog(catalog());
    const row = statement('SELECT value FROM sflow_content_manifest WHERE slot=1').get();
    let value;
    try { value = JSON.parse(row?.value); }
    catch (cause) { throw contentError('The content manifest is missing or malformed.', 'SDA_CONTENT_CORRUPT', { stage: 'manifest' }, cause); }
    admit(value);
    try { exactObject(value, ['schemaVersion', 'format', 'storeId', 'binding', 'maximumBytes']); }
    catch (cause) { throw contentError('The content manifest has undeclared fields.', 'SDA_CONTENT_CORRUPT', { stage: 'manifest' }, cause); }
    if (value.format !== FORMAT || !UUID.test(value.storeId)
      || JSON.stringify(value.binding) !== JSON.stringify(descriptor.binding) || value.maximumBytes !== maximumBytes
      || manifest && value.storeId !== manifest.storeId) {
      throw contentError('The content database has another identity, binding or size policy.', 'SDA_CONTENT_CORRUPT', { stage: 'manifest' });
    }
    return value;
  }
  function durable() {
    const synchronous = Object.values(statement('PRAGMA synchronous').get() ?? {})[0];
    const mode = Object.values(statement('PRAGMA journal_mode').get() ?? {})[0];
    if (![2, 3].includes(synchronous) || !['wal', 'delete', 'truncate', 'persist'].includes(mode)) {
      throw contentError('The application content connection needs durable SQLite journaling and FULL or EXTRA synchronous writes.', 'SDA_CONTENT_UNSUPPORTED');
    }
  }
  function rollback() { try { exec('ROLLBACK'); } catch {} }
  let initializedTransaction = false, initializingCommit = false;
  try {
    durable(); exec(create ? 'BEGIN IMMEDIATE' : 'BEGIN'); initializedTransaction = true;
    const rows = catalog();
    if (!rows.length && create) {
      for (const sql of Object.values(SCHEMAS)) exec(sql);
      const value = { schemaVersion: CONTENT_STORAGE_SCHEMA.currentVersion, format: FORMAT,
        storeId: randomUUID(), binding: descriptor.binding, maximumBytes };
      statement('INSERT INTO sflow_content_manifest(slot,value) VALUES(1,?)').run(JSON.stringify(value));
    } else if (!rows.length) throw contentError('The application has not initialized this content store.', 'SDA_CONTENT_UNAVAILABLE', { stage: 'initialization' });
    manifest = readManifest(); initializingCommit = !rows.length && create; exec('COMMIT');
  } catch (cause) {
    if (initializedTransaction) rollback();
    if (initializingCommit) throw contentError('Content-store initialization may have completed; reopen the same application database without recreating it.',
      'SDA_CONTENT_OUTCOME_UNKNOWN', { stage: 'initialization', storeId: manifest.storeId }, cause);
    throw failure(cause, 'initialization');
  }

  const row = statement('SELECT bytes,chunks FROM sflow_content_objects WHERE project_id=? AND namespace=? AND sha256=?');
  const chunkCount = statement('SELECT count(*) AS chunks FROM sflow_content_chunks WHERE project_id=? AND namespace=? AND sha256=?');
  const chunk = statement('SELECT content FROM sflow_content_chunks WHERE project_id=? AND namespace=? AND sha256=? AND chunk_index=?');
  const insert = statement('INSERT INTO sflow_content_objects(project_id,namespace,sha256,bytes,chunks) VALUES(?,?,?,?,?)');
  const insertChunk = statement('INSERT INTO sflow_content_chunks(project_id,namespace,sha256,chunk_index,content) VALUES(?,?,?,?,?)');
  function readBytes(scope, reference, limit, signal) {
    const args = [scope.projectId, reference.namespace, reference.sha256], current = row.get(...args);
    if (!current) return null;
    if (current.bytes !== reference.bytes || current.chunks !== Math.ceil(reference.bytes / 65_536)
      || chunkCount.get(...args)?.chunks !== current.chunks) throw contentError('Content length or membership does not match its retained reference.', 'SDA_CONTENT_CORRUPT');
    const result = Buffer.alloc(Math.min(limit, reference.bytes)), digest = createHash('sha256');
    let observed = 0;
    for (let offset = 0; offset < reference.bytes; offset += 65_536) {
      assertContentBinding(descriptor, scope, reference.namespace, signal);
      const bytes = chunk.get(...args, offset / 65_536)?.content;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== Math.min(65_536, reference.bytes - offset)) {
        throw contentError('The retained content changed or is incomplete.', 'SDA_CONTENT_CORRUPT');
      }
      digest.update(bytes); observed += bytes.byteLength;
      if (offset < result.length) result.set(bytes.subarray(0, Math.min(bytes.length, result.length - offset)), offset);
    }
    if (observed !== reference.bytes || digest.digest('hex') !== reference.sha256) throw contentError('Content bytes do not match their retained digest.', 'SDA_CONTENT_CORRUPT');
    return result;
  }
  return Object.freeze({ descriptor,
    async put(scope, namespace, bytes, { signal = null } = {}) {
      scope = assertContentBinding(descriptor, scope, namespace, signal);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximumBytes) throw contentError('Content must be a bounded byte buffer.');
      const captured = Buffer.from(bytes), reference = contentReference({ namespace, sha256: hash(captured), bytes: captured.length }, maximumBytes);
      let committing = false, begun = false;
      try {
        exec('BEGIN IMMEDIATE'); begun = true; durable(); readManifest();
        const existing = readBytes(scope, reference, 0, signal);
        if (existing !== null) { exec('COMMIT'); return { reference, reused: true }; }
        insert.run(scope.projectId, namespace, reference.sha256, reference.bytes, Math.ceil(reference.bytes / 65_536));
        for (let offset = 0; offset < captured.length; offset += 65_536) {
          assertContentBinding(descriptor, scope, namespace, signal);
          insertChunk.run(scope.projectId, namespace, reference.sha256, offset / 65_536, captured.subarray(offset, offset + 65_536));
        }
        assertContentBinding(descriptor, scope, namespace, signal); committing = true; exec('COMMIT');
        return { reference, reused: false };
      } catch (cause) {
        if (begun) rollback();
        if (committing) throw contentError('Content acceptance may have completed; read this exact reference before retrying.', 'SDA_CONTENT_OUTCOME_UNKNOWN',
          { stage: 'commit', projectId: scope.projectId, reference }, cause);
        throw failure(cause, 'put');
      }
    },
    async read(scope, requested, options = {}) {
      const reference = contentReference(requested, maximumBytes), selected = contentReadOptions(options, maximumBytes);
      scope = assertContentBinding(descriptor, scope, reference.namespace, selected.signal);
      let begun = false;
      try {
        exec('BEGIN'); begun = true; durable(); readManifest();
        const data = readBytes(scope, reference, selected.maximumBytes, selected.signal);
        assertContentBinding(descriptor, scope, reference.namespace, selected.signal); exec('COMMIT');
        return data === null ? { status: 'missing', reference, data: null }
          : { status: 'present', reference, data, truncated: data.length < reference.bytes };
      } catch (cause) { if (begun) rollback(); throw failure(cause, 'read'); }
    }
  });
}
