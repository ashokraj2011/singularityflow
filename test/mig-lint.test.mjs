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

test('only the registered frozen v1 world-model view contract may use its shared durable constant', () => {
  const file = 'src/world-model/view-contract-schema-version.mjs';
  const declaration = 'export const WORLD_MODEL_VIEW_CONTRACT_SCHEMA_VERSION = 1;\n';
  const migration = [
    "import { WORLD_MODEL_VIEW_CONTRACT_SCHEMA_VERSION } from './world-model/view-contract-schema-version.mjs';",
    "family({ id: 'world-model-view-contract', currentVersion: WORLD_MODEL_VIEW_CONTRACT_SCHEMA_VERSION, immutable: true, migrationPolicy: 'frozen-identity' });"
  ].join('\n');
  const sources = (name = file, text = declaration, registry = migration) => new Map([
    ['src/schema-migrations.mjs', registry], [name, text]
  ]);

  assert.deepEqual(schemaMigrationLint(sources()), []);
  for (const [name, text, registry] of [
    ['src/other-view-contract-schema-version.mjs', declaration, migration],
    [file, 'export const OTHER_FAMILY_SCHEMA_VERSION = 1;\n', migration],
    [file, 'export const WORLD_MODEL_VIEW_CONTRACT_SCHEMA_VERSION = 2;\n', migration],
    [file, declaration, migration.replace("'frozen-identity'", "'migrate-on-read'")],
    [file, declaration, migration.replace("'world-model-view-contract'", "'other-family'")]
  ]) {
    const violations = schemaMigrationLint(sources(name, text, registry));
    assert.equal(violations.length, 1, `${name}: ${text.trim()}`);
    assert.match(violations[0].message, /durable schema constants/);
  }

  const ordinary = schemaMigrationLint(new Map([
    ...sources(),
    ['src/ordinary-family.mjs', 'export const ORDINARY_SCHEMA_VERSION = 1;\n'],
    ['src/ordinary-writer.mjs', 'await writeJson(file, { schemaVersion: 1 });\n']
  ]));
  assert.equal(ordinary.length, 2);
  assert.ok(ordinary.some((violation) => violation.file === 'src/ordinary-family.mjs'));
  assert.ok(ordinary.some((violation) => violation.file === 'src/ordinary-writer.mjs'));
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

test('an explicitly registered immutable historical reader may enforce its frozen version', () => {
  assert.deepEqual(schemaMigrationLint(new Map([
    [
      'src/world-model/materialize/persisted-overview-renderer-v1.mjs',
      'if (record.schemaVersion !== 1) throw new Error("not historical v1");\n'
    ]
  ])), []);
});

test('registered workflow records cannot bypass migration reads through an indirect path', () => {
  const violations = schemaMigrationLint(new Map([
    ['src/unsafe-workflow-reader.mjs', [
      "const statePath = path.join(root, 'singularity/work-items', id, 'workflow.json');",
      "const state = JSON.parse(await readFile(statePath, 'utf8'));"
    ].join('\n')]
  ]));
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /loaded through readRecord/);
});

test('the migration module cannot acquire model, clock, or I/O dependencies', () => {
  const violations = schemaMigrationLint(new Map([
    ['src/schema-migrations.mjs', "import { invokeModel } from './model-runner.mjs';\n"]
  ]));
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /must remain pure/);
});
