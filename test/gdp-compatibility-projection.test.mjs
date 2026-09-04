import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  GDP_COMPATIBILITY_SOURCE_KINDS,
  GDP_FEATURE_DEFAULTS,
  projectLegacyGdpCompatibility
} from '../src/delivery-modes/compatibility-projection.mjs';
import { recordSha256 } from '../src/records.mjs';
import { migrationRegistrySnapshot } from '../src/schema-migrations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = path.join(root, 'src/delivery-modes/compatibility-projection.mjs');

async function json(relative) {
  return JSON.parse(await readFile(path.join(root, relative), 'utf8'));
}

function pointer(document, reference) {
  return reference.slice(2).split('/').reduce((value, key) => (
    value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')]
  ), document);
}

function typeMatches(type, value) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  return typeof value === type;
}

function validate(schema, shape, value, location = '$') {
  const errors = [];
  const check = (current, candidate, at) => {
    if (current.$ref) {
      const resolved = pointer(schema, current.$ref);
      if (!resolved) errors.push(`${at}: unresolved ${current.$ref}`);
      else check(resolved, candidate, at);
      return;
    }
    if (current.oneOf) {
      const matching = current.oneOf.filter((branch) => validate(schema, branch, candidate, at).length === 0);
      if (matching.length !== 1) errors.push(`${at}: expected one branch, found ${matching.length}`);
      return;
    }
    if (current.const !== undefined && !Object.is(candidate, current.const)) {
      errors.push(`${at}: expected ${JSON.stringify(current.const)}`);
    }
    if (current.enum && !current.enum.some((item) => Object.is(item, candidate))) {
      errors.push(`${at}: outside closed vocabulary`);
    }
    if (current.type && !typeMatches(current.type, candidate)) {
      errors.push(`${at}: expected ${current.type}`);
      return;
    }
    if (typeof candidate === 'string') {
      if (current.minLength != null && candidate.length < current.minLength) errors.push(`${at}: too short`);
      if (current.maxLength != null && candidate.length > current.maxLength) errors.push(`${at}: too long`);
      if (current.pattern && !(new RegExp(current.pattern, 'u')).test(candidate)) errors.push(`${at}: pattern mismatch`);
    }
    if (Array.isArray(candidate)) {
      if (current.minItems != null && candidate.length < current.minItems) errors.push(`${at}: too few items`);
      if (current.maxItems != null && candidate.length > current.maxItems) errors.push(`${at}: too many items`);
      if (current.items) candidate.forEach((item, index) => check(current.items, item, `${at}[${index}]`));
    }
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      for (const required of current.required ?? []) {
        if (!Object.hasOwn(candidate, required)) errors.push(`${at}: missing ${required}`);
      }
      for (const [key, child] of Object.entries(candidate)) {
        if (current.properties?.[key]) check(current.properties[key], child, `${at}.${key}`);
        else if (current.additionalProperties === false) errors.push(`${at}: unknown ${key}`);
      }
    }
  };
  check(shape, value, location);
  return errors;
}

test('GDP M1 projects every representative legacy lifecycle without changing its source', async () => {
  const corpus = await json('test/fixtures/gdp-compatibility/legacy-subjects.json');
  const schema = await json('schemas/gdp-compatibility-projection.schema.json');
  const covered = new Set();
  for (const fixture of corpus.cases) {
    const before = JSON.stringify(fixture.record);
    const first = projectLegacyGdpCompatibility({
      sourceKind: fixture.sourceKind, record: fixture.record, recovery: fixture.recovery
    });
    const second = projectLegacyGdpCompatibility({
      sourceKind: fixture.sourceKind, record: structuredClone(fixture.record), recovery: fixture.recovery
    });
    covered.add(fixture.sourceKind);
    assert.equal(JSON.stringify(fixture.record), before, `${fixture.id} source was mutated`);
    assert.deepEqual(first, second, `${fixture.id} is not deterministic`);
    assert.deepEqual(validate(schema, schema, first), [], fixture.id);
    assert.equal(first.subject.kind, fixture.expected.subjectKind, fixture.id);
    assert.equal(first.subject.id, fixture.expected.subjectId, fixture.id);
    assert.equal(first.lifecycle.normalizedStatus, fixture.expected.normalizedStatus, fixture.id);
    assert.equal(first.lifecycle.requiresRecovery, fixture.expected.requiresRecovery, fixture.id);
    assert.equal(first.publication.status, fixture.expected.publicationStatus, fixture.id);
    const identity = structuredClone(first);
    delete identity.projectionSha256;
    assert.equal(first.projectionSha256, `sha256:${recordSha256(identity)}`,
      `${fixture.id} projection identity changed`);
    assert.equal(first.classification, 'legacy');
    assert.equal(first.delivery.selectionStatus, 'legacy');
    assert.equal(first.guarantees.noEvidenceUpgraded, true);
    assert.equal(first.guarantees.noWrites, true);
    assert.equal(first.guarantees.noModel, true);
    assert.equal(first.guarantees.astRequired, false);
    assert.equal(first.guarantees.worldModelRequired, false);
    assert.equal(first.worldModel.blocks, false);
    assert.deepEqual(new Set(first.gaps.map((entry) => entry.status)),
      new Set(['legacy', 'unavailable', 'sunset-blocked']));
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.lifecycle));
    assert.ok(Object.isFrozen(first.gaps));
  }
  assert.deepEqual(covered, new Set(GDP_COMPATIBILITY_SOURCE_KINDS));
});

test('GDP M1 never upgrades observed Candidate or World Model references into proof', async () => {
  const corpus = await json('test/fixtures/gdp-compatibility/legacy-subjects.json');
  const fixture = corpus.cases.find((entry) => entry.id === 'interrupted-auto');
  const projected = projectLegacyGdpCompatibility({ sourceKind: fixture.sourceKind, record: fixture.record });
  assert.deepEqual(projected.candidate, {
    status: 'legacy',
    sha256: fixture.record.candidate.candidateSha256,
    assurance: 'legacy'
  });
  assert.equal(projected.worldModel.status, 'legacy');
  assert.deepEqual(projected.availability, {
    proofSubject: { status: 'unavailable', reasonCode: 'GDP_RUNTIME_NOT_INSTALLED' },
    changePassport: { status: 'unavailable', reasonCode: 'GDP_RUNTIME_NOT_INSTALLED' },
    proofSummary: { status: 'unavailable', reasonCode: 'GDP_RUNTIME_NOT_INSTALLED' }
  });
});

test('GDP M1 rejects unknown sources and malformed recovery instead of inventing compatibility data', () => {
  assert.throws(() => projectLegacyGdpCompatibility({ sourceKind: 'unknown', record: {} }),
    /unsupported source kind/);
  assert.throws(() => projectLegacyGdpCompatibility({
    sourceKind: 'workflow-story', record: { workItem: {} }
  }), /workItem\.id/);
  assert.throws(() => projectLegacyGdpCompatibility({
    sourceKind: 'adhoc-session', record: { sessionId: 'ADH-1', status: 'working' },
    recovery: { status: 'pending', commit: 'HEAD' }
  }), /full Git object ID/);
  const unknownStatus = projectLegacyGdpCompatibility({
    sourceKind: 'adhoc-session', record: { sessionId: 'ADH-1', status: 'future-state' }
  });
  assert.equal(unknownStatus.lifecycle.normalizedStatus, 'unavailable');
  assert.equal(unknownStatus.lifecycle.active, false);
  assert.ok(unknownStatus.gaps.some((entry) => entry.code === 'GDP_LIFECYCLE_STATUS_UNAVAILABLE'));
});

test('GDP feature defaults remain off while M3 registers only admitted shadow and proof identities', async () => {
  assert.ok(Object.isFrozen(GDP_FEATURE_DEFAULTS));
  assert.ok(Object.values(GDP_FEATURE_DEFAULTS).every((value) => value === false));
  const inventory = await json('docs/contracts/gdp/compatibility-inventory.json');
  assert.deepEqual(inventory.featureDefaults, GDP_FEATURE_DEFAULTS);
  const GDP_FAMILIES = (await json('docs/contracts/gdp/record-family-catalog.json')).families
    .map((entry) => entry.id);
  const registered = new Set(migrationRegistrySnapshot().map((entry) => entry.id));
  assert.deepEqual(GDP_FAMILIES.filter((family) => registered.has(family)).sort(), [
    'change-passport', 'proof-evaluation-receipt', 'proof-evidence-invalidation',
    'proof-gap-item', 'proof-gap-register', 'proof-predicate-result',
    'proof-predicate-specification', 'proof-profile-selection', 'proof-signal-observation',
    'proof-subject', 'proof-summary'
  ]);
});

test('GDP M1 inventory resolves every owner path and covers every projection adapter once', async () => {
  const inventory = await json('docs/contracts/gdp/compatibility-inventory.json');
  assert.equal(inventory.projection.durable, false);
  assert.equal(inventory.projection.migrationRegistered, false);
  assert.equal(inventory.rollback.durableRecordsToMigrate, 0);
  assert.deepEqual(inventory.systems.map((entry) => entry.sourceKind).sort(),
    [...GDP_COMPATIBILITY_SOURCE_KINDS].sort());
  const referencedPaths = new Set([
    inventory.projection.module,
    inventory.projection.schema,
    ...inventory.systems.flatMap((entry) => [
      entry.readerWriter, entry.candidateAuthority, entry.landingAuthority
    ].filter(Boolean)),
    ...inventory.crossCuttingAuthorities.flatMap((entry) => entry.paths)
  ]);
  for (const relative of referencedPaths) {
    assert.ok((await readFile(path.join(root, relative))).length > 0, relative);
  }
});

test('GDP M1 projection has a pure dependency boundary and no production surface imports it', async () => {
  const source = await readFile(modulePath, 'utf8');
  const imports = [...source.matchAll(/^import .* from ['"]([^'"]+)['"];$/gmu)].map((match) => match[1]);
  assert.deepEqual(imports, ['../records.mjs']);
  assert.doesNotMatch(source, /\b(?:export\s+async|await|Date\.now|process\.)\b/u);
  for (const relative of [
    'src/cli.mjs', 'src/command-registry.mjs', 'src/api.mjs', 'apps/vscode/src/extension.ts'
  ]) {
    assert.doesNotMatch(await readFile(path.join(root, relative), 'utf8'),
      /gdp-compatibility-projection|compatibility-projection\.mjs/u, relative);
  }
});
