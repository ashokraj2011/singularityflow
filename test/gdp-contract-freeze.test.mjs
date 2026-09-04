import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { recordSha256 } from '../src/records.mjs';
import { migrationRegistrySnapshot } from '../src/schema-migrations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = path.join(root, 'schemas', 'gdp-contract-freeze.schema.json');
const fixtureRoot = path.join(root, 'test', 'fixtures', 'gdp-contract-freeze');
const contractRoot = path.join(root, 'docs', 'contracts', 'gdp');

async function json(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function pointer(document, reference) {
  assert.match(reference, /^#\//);
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

function validate(document, shape, value, location = '$') {
  const errors = [];
  const check = (current, candidate, at) => {
    if (current.$ref) {
      const resolved = pointer(document, current.$ref);
      if (!resolved) errors.push(`${at}: unresolved ${current.$ref}`);
      else check(resolved, candidate, at);
      return;
    }
    if (current.oneOf) {
      const matches = current.oneOf.filter((branch) => validate(document, branch, candidate, at).length === 0);
      if (matches.length !== 1) errors.push(`${at}: expected exactly one matching branch, found ${matches.length}`);
      return;
    }
    if (current.const !== undefined && !Object.is(candidate, current.const)) {
      errors.push(`${at}: expected ${JSON.stringify(current.const)}`);
    }
    if (current.enum && !current.enum.some((item) => Object.is(item, candidate))) {
      errors.push(`${at}: value is outside the closed vocabulary`);
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
    if (typeof candidate === 'number') {
      if (current.minimum != null && candidate < current.minimum) errors.push(`${at}: below minimum`);
      if (current.maximum != null && candidate > current.maximum) errors.push(`${at}: above maximum`);
    }
    if (Array.isArray(candidate)) {
      if (current.minItems != null && candidate.length < current.minItems) errors.push(`${at}: too few items`);
      if (current.maxItems != null && candidate.length > current.maxItems) errors.push(`${at}: too many items`);
      if (current.uniqueItems && new Set(candidate.map((item) => JSON.stringify(item))).size !== candidate.length) {
        errors.push(`${at}: duplicate items`);
      }
      if (current.items) candidate.forEach((item, index) => check(current.items, item, `${at}[${index}]`));
    }
    if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
      for (const required of current.required ?? []) {
        if (!Object.hasOwn(candidate, required)) errors.push(`${at}: missing ${required}`);
      }
      for (const [key, child] of Object.entries(candidate)) {
        if (current.properties?.[key]) check(current.properties[key], child, `${at}.${key}`);
        else if (current.additionalProperties === false) errors.push(`${at}: unknown ${key}`);
      }
    }
    for (const conjunct of current.allOf ?? []) check(conjunct, candidate, at);
    if (current.if) {
      const condition = validate(document, current.if, candidate, at).length === 0;
      if (condition && current.then) check(current.then, candidate, at);
      if (!condition && current.else) check(current.else, candidate, at);
    }
  };
  check(shape, value, location);
  return errors;
}

function definitionByKind(schema) {
  return new Map(Object.values(schema.$defs)
    .filter((definition) => definition?.properties?.kind?.const)
    .map((definition) => [definition.properties.kind.const, definition]));
}

function semanticHash(definition, record) {
  const semantic = Object.fromEntries(
    definition['x-sflow-semanticFields'].map((field) => [field, record[field]])
  );
  return `sha256:${recordSha256(semantic)}`;
}

function mutate(record, dottedPath, value) {
  const copy = structuredClone(record);
  const parts = dottedPath.split('.');
  const parent = parts.slice(0, -1).reduce((current, part) => current[part], copy);
  parent[parts.at(-1)] = value;
  return copy;
}

test('GDP M0 frozen shapes remain closed as later milestones activate only admitted identities', async () => {
  const schema = await json(schemaPath);
  const chain = await json(path.join(fixtureRoot, 'valid-chain.json'));
  const definitions = definitionByKind(schema);
  const productionFamilies = new Set(migrationRegistrySnapshot().map((family) => family.id));

  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.match(schema.$comment, /not registered runtime schemas/);
  assert.deepEqual([...definitions.keys()].sort(), [
    'change-passport', 'delivery-selection', 'proof-predicate-result', 'proof-subject', 'proof-summary'
  ]);

  for (const record of Object.values(chain)) {
    assert.deepEqual(validate(schema, schema, record), [], record.kind);
    const definition = definitions.get(record.kind);
    assert.equal(definition.additionalProperties, false, record.kind);
    assert.equal(record[definition['x-sflow-selfHash']], semanticHash(definition, record), record.kind);
    assert.equal(productionFamilies.has(record.kind),
      ['proof-subject', 'change-passport', 'proof-predicate-result', 'proof-summary', 'delivery-selection'].includes(record.kind),
      `${record.kind} has the wrong runtime registration state`);
  }

  assert.equal(chain.predicateResult.proofSubjectSha256, chain.proofSubject.proofSubjectSha256);
  assert.equal(chain.proofSummary.proofSubjectSha256, chain.proofSubject.proofSubjectSha256);
  assert.deepEqual(chain.proofSummary.predicateResults.passed, [chain.predicateResult.resultSha256]);
  assert.equal(chain.passport.proofSubjectSha256, chain.proofSubject.proofSubjectSha256);
  assert.equal(chain.passport.proofSummarySha256, chain.proofSummary.summarySha256);
  assert.equal(chain.passport.selectionSha256, chain.selection.selectionSha256);

  for (const kind of ['proof-predicate-result', 'proof-summary']) {
    const serialized = JSON.stringify(definitions.get(kind));
    assert.doesNotMatch(serialized, /passportSha256/, `${kind} reintroduced the Passport cycle`);
  }
});

test('GDP M0 negative fixtures reject category errors, circular references, clocks, and agent authority', async () => {
  const schema = await json(schemaPath);
  const chain = await json(path.join(fixtureRoot, 'valid-chain.json'));
  const cases = await json(path.join(fixtureRoot, 'rejected-contracts.json'));

  for (const invalid of cases) {
    const record = mutate(chain[invalid.record], invalid.path, invalid.value);
    assert.notDeepEqual(validate(schema, schema, record), [], invalid.id);
  }
});

test('every proposed GDP family has exactly one planned writer, owner, plane, and migration boundary', async () => {
  const catalog = await json(path.join(contractRoot, 'record-family-catalog.json'));
  const expected = [
    'delivery-selection', 'delivery-recommendation', 'delivery-mode-transition',
    'completion-contract', 'effect-policy', 'effect-policy-compilation', 'change-risk-assessment',
    'autonomy-decision', 'proof-subject', 'change-passport', 'workflow-checkpoint-satisfaction',
    'agent-execution-binding', 'agent-steering-decision', 'agent-execution-checkpoint',
    'proof-profile-selection', 'proof-predicate-specification', 'proof-predicate-result',
    'proof-evaluation-receipt', 'proof-signal-observation', 'proof-summary',
    'proof-evidence-invalidation', 'proof-gap-item', 'proof-gap-register', 'proof-gap-acceptance',
    'impact-should-set', 'impact-disposition', 'executable-change-map', 'changed-region-coverage',
    'witness-independence', 'mutation-observation', 'environment-profile',
    'environment-attestation', 'nondeterminism-profile', 'build-attestation',
    'deployment-attestation'
  ].sort();
  const actual = catalog.families.map((family) => family.id).sort();

  assert.equal(catalog.status, 'm6-workflow-families-mig-registered');
  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, actual.length);
  assert.equal(catalog.migrationOwner, 'MIG');
  assert.match(catalog.readerPolicy, /^N-1/);

  const classifications = new Set([
    'semantic-content', 'operational-receipt', 'signal', 'gap', 'decision', 'projection'
  ]);
  const productionFamilies = new Set(migrationRegistrySnapshot().map((family) => family.id));
  assert.deepEqual([...catalog.runtimeRegisteredFamilies].sort(), [
    'autonomy-decision', 'change-passport', 'change-risk-assessment',
    'completion-contract', 'delivery-recommendation', 'delivery-selection',
    'effect-policy', 'effect-policy-compilation',
    'environment-attestation', 'environment-profile',
    'impact-disposition', 'impact-should-set', 'nondeterminism-profile',
    'proof-evaluation-receipt', 'proof-evidence-invalidation', 'proof-gap-item',
    'proof-gap-register', 'proof-predicate-result', 'proof-predicate-specification',
    'proof-profile-selection', 'proof-signal-observation', 'proof-subject', 'proof-summary',
    'workflow-checkpoint-satisfaction'
  ]);
  for (const family of catalog.families) {
    assert.match(family.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(classifications.has(family.classification), family.id);
    assert.match(family.authorityOwner, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.match(family.writer, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(Object.hasOwn(catalog.pathTemplates, family.storagePlane), family.id);
    assert.match(family.firstMilestone, /^GDP-M(?:[2-9]|10)$/);
    assert.equal(family.immutable, true, family.id);
    assert.equal(productionFamilies.has(family.id), catalog.runtimeRegisteredFamilies.includes(family.id),
      `${family.id} has the wrong MIG registration state`);
  }
});

test('the GDP companion lock pins exact existing authorities and fails on unreviewed drift', async () => {
  const lock = await json(path.join(contractRoot, 'companion-lock.json'));
  assert.equal(lock.status, 'contract-only');
  assert.match(lock.baselineCommit, /^[a-f0-9]{40}$/);
  assert.ok(lock.companions.length >= 15);
  assert.equal(new Set(lock.companions.map((entry) => entry.id)).size, lock.companions.length);

  for (const companion of lock.companions) {
    assert.match(companion.path, /^(?:docs|schemas|src|templates)\//);
    assert.doesNotMatch(companion.path, /(?:^|\/)\.\.(?:\/|$)/);
    const bytes = await readFile(path.join(root, companion.path));
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    assert.equal(companion.sha256, digest, companion.id);
  }
});

test('the corrected contract separates recommendation, mode, profile, confirmation, and recovery', async () => {
  const contract = await readFile(path.join(root, 'docs', 'GDP-CONTRACT-VNEXT.md'), 'utf8');
  assert.match(contract, /selectionStrategy: recommend/);
  assert.match(contract, /defaultMode: outcome/);
  assert.match(contract, /defaultWorkflowProfile: feature/);
  assert.match(contract, /`defaultMode` is always one of `workflow \| outcome`/);
  assert.match(contract, /--plan sha256:<64-hex> --confirm-plan sha256:<64-hex>/);
  assert.match(contract, /Recovery may push or reconcile only\s+that commit; it cannot use ambient `HEAD`/);
  assert.match(contract, /Starting, resuming, changing phase, or opening a Passport never triggers a full WMM rebuild/);
  assert.match(contract, /M0 deliberately asserts that none of the 34 new families is production-registered/);
});
