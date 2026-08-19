import assert from 'node:assert/strict';
import test from 'node:test';

import { schemaMigrationLint } from '../scripts/schema-migration-lint.mjs';

test('version-branching-outside-registry-fails', () => {
  const violations = schemaMigrationLint(new Map([
    ['src/unsafe-reader.mjs', 'if (record.schemaVersion > 2) throw new Error("future");\n']
  ]));
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /branching belongs/);
});

test('durable writer literals outside the registry fail', () => {
  const violations = schemaMigrationLint(new Map([
    ['src/new-family.mjs', 'export const NEW_FAMILY_SCHEMA_VERSION = 1;\n']
  ]));
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /currentSchemaVersion/);
});

test('inline durable writes cannot stamp a numeric schema literal', () => {
  const violations = schemaMigrationLint(new Map([
    ['src/new-family.mjs', 'await writeJson(file, { schemaVersion: 1, value: true });\n']
  ]));
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /migration registry/);
});

test('durable writer literals cannot hide in a local record variable', () => {
  const violations = schemaMigrationLint(new Map([
    ['src/new-family.mjs', 'async function save(file) {\n  const record = { schemaVersion: 1 };\n  await writeJson(file, record);\n}\n']
  ]));
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /currentSchemaVersion/);
});

test('registry-owned version branching is accepted', () => {
  assert.deepEqual(schemaMigrationLint(new Map([
    ['src/schema-migrations.mjs', 'if (record.schemaVersion > family.currentVersion) refuse();\n']
  ])), []);
});

test('the migration module cannot acquire model, clock, or I/O dependencies', () => {
  const violations = schemaMigrationLint(new Map([
    ['src/schema-migrations.mjs', "import { invokeModel } from './model-runner.mjs';\n"]
  ]));
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /must remain pure/);
});
