import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { migrationRegistrySnapshot, readRecord } from '../src/schema-migrations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureFile = path.join(root, 'test', 'fixtures', 'schema-migrations', 'goldens.json');

test('all-goldens-read-to-current', async () => {
  const bytes = await readFile(fixtureFile);
  const before = Buffer.from(bytes);
  const fixtures = JSON.parse(bytes);
  const registry = migrationRegistrySnapshot();
  assert.deepEqual(Object.keys(fixtures).sort(), registry.map((entry) => entry.id).sort());
  for (const family of registry) {
    const records = fixtures[family.id];
    const versions = new Set(records.map((record) => record.schemaVersion));
    for (let version = family.minimumReadableVersion; version <= family.currentVersion; version += 1) {
      assert.ok(versions.has(version), `${family.id} is missing frozen v${version}`);
    }
    for (const record of records) {
      const source = JSON.stringify(record);
      const migrated = readRecord(family.id, source);
      assert.equal(migrated.record.schemaVersion, family.currentVersion, family.id);
      assert.equal(source, JSON.stringify(record), `${family.id} source changed`);
    }
  }
  assert.deepEqual(await readFile(fixtureFile), before);
});

test('previous-release durable corpus remains completely readable', async () => {
  const fixtures = JSON.parse(await readFile(fixtureFile, 'utf8'));
  for (const family of migrationRegistrySnapshot()) {
    const oldest = fixtures[family.id].find((record) => record.schemaVersion === family.minimumReadableVersion);
    assert.ok(oldest, family.id);
    assert.equal(readRecord(family.id, oldest).record.schemaVersion, family.currentVersion);
  }
});
