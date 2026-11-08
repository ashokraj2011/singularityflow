import test from 'node:test';
import assert from 'node:assert/strict';
import { admitRecordSchemaVersion, COMMAND_TIMING_SCHEMA, CONTENT_STORAGE_SCHEMA, NAMESPACE_READER_SCHEMAS } from '../src/foundation/record-schema.mjs';
import { NAMESPACE_STORAGE_SCHEMAS, SQLITE_NAMESPACE_SCHEMAS,
  admitNamespaceStorageSchema, admitSqliteNamespaceSchema } from '../src/sda/namespace/storage-schemas.mjs';
import { readRecord, schemaFamily } from '../src/schema-migrations.mjs';
import { WORLD_MODEL_VIEW_CONTRACT_SCHEMA_VERSION as legacyViewVersion } from '../src/world-model/view-contract-schema-version.mjs';

test('shared version admission preserves current records and the registered missing/future/archived diagnostics', () => {
  const entry = { id: 'sample', currentVersion: 3, minimumReadableVersion: 2, maximumReadableVersion: 3, unversionedAs: null };
  const input = Object.freeze({ schemaVersion: 3, data: 'original' });
  assert.equal(admitRecordSchemaVersion(entry, input).record, input);
  for (const [value, code] of [[undefined, 'MISSING'], [1, 'ARCHIVED'], [4, 'FUTURE']]) {
    assert.throws(() => admitRecordSchemaVersion(entry, { schemaVersion: value }), error =>
      error.code === `SCHEMA_VERSION_${code}` && error.details.family === 'sample');
  }
  const unversioned = { data: 'legacy' };
  assert.deepEqual(admitRecordSchemaVersion({ ...entry, unversionedAs: 2 }, unversioned), {
    record: { data: 'legacy', schemaVersion: 2 }, storedVersion: 2
  });
  assert.deepEqual(unversioned, { data: 'legacy' });
});

test('filesystem durable families have one frozen registry owner and never migrate accepted history', () => {
  assert.equal(legacyViewVersion, 1);
  assert.equal(schemaFamily('world-model-view-contract').currentVersion, legacyViewVersion);
  assert.equal(schemaFamily(COMMAND_TIMING_SCHEMA.id).currentVersion, COMMAND_TIMING_SCHEMA.currentVersion);
  for (const [definitions, admit] of [[NAMESPACE_STORAGE_SCHEMAS, admitNamespaceStorageSchema],
    [SQLITE_NAMESPACE_SCHEMAS, admitSqliteNamespaceSchema]]) for (const [kind, definition] of Object.entries(definitions)) {
    const registered = schemaFamily(definition.id);
    for (const key of ['currentVersion', 'minimumReadableVersion', 'maximumReadableVersion', 'migrationPolicy', 'immutable']) {
      assert.equal(registered[key], definition[key]);
    }
    const value = { schemaVersion: 1, kind };
    assert.deepEqual(admit(kind, value), { record: value, storedVersion: 1 });
    assert.deepEqual(readRecord(definition.id, value), { record: value, storedVersion: 1, migratedThrough: [] });
    assert.throws(() => admit(kind, { schemaVersion: 2 }), error =>
      error.code === 'SDA_NAMESPACE_UNSUPPORTED' && error.cause.code === 'SCHEMA_VERSION_FUTURE');
  }
});

test('content and namespace read projections share registered schema metadata without changing stored versions', () => {
  for (const entry of [CONTENT_STORAGE_SCHEMA, ...Object.values(NAMESPACE_READER_SCHEMAS)]) {
    const registered = schemaFamily(entry.id);
    for (const key of ['currentVersion','minimumReadableVersion','maximumReadableVersion','migrationPolicy','immutable']) assert.equal(registered[key], entry[key]);
    const value = { schemaVersion: entry.currentVersion };
    assert.deepEqual(readRecord(entry.id, value), { record: value, storedVersion: entry.currentVersion, migratedThrough: [] });
    assert.throws(() => admitRecordSchemaVersion(entry, { schemaVersion: entry.maximumReadableVersion+1 }), { code: 'SCHEMA_VERSION_FUTURE' });
    const original={schemaVersion:1,format:'original',data:'unchanged'};
    assert.deepEqual(readRecord(entry.id,original),{record:original,storedVersion:1,migratedThrough:[]});
  }
});
