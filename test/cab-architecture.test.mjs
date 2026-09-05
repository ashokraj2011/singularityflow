import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { migrationRegistrySnapshot } from '../src/schema-migrations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(root, 'docs', 'contracts', 'cab', 'architecture-v0.2.json');
const schemaPath = path.join(root, 'schemas', 'cab-architecture-v0.2.schema.json');
const rejectedPath = path.join(root, 'test', 'fixtures', 'cab-architecture', 'rejected-designs.json');

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));

function pointer(document, reference) {
  assert.match(reference, /^#\//);
  return reference.slice(2).split('/').reduce((value, key) => (
    value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')]
  ), document);
}

function typeMatches(type, value) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

function validate(schema, shape, value, location = '$') {
  const errors = [];
  const check = (current, candidate, at) => {
    if (current.$ref) {
      const referenced = pointer(schema, current.$ref);
      if (!referenced) errors.push(`${at}: unresolved ${current.$ref}`);
      else check(referenced, candidate, at);
      return;
    }
    if (current.const !== undefined && !Object.is(current.const, candidate)) {
      errors.push(`${at}: expected ${JSON.stringify(current.const)}`);
    }
    if (current.enum && !current.enum.some((entry) => Object.is(entry, candidate))) {
      errors.push(`${at}: outside closed vocabulary`);
    }
    if (current.type && !typeMatches(current.type, candidate)) {
      errors.push(`${at}: expected ${current.type}`);
      return;
    }
    if (typeof candidate === 'string') {
      if (current.minLength != null && candidate.length < current.minLength) errors.push(`${at}: too short`);
      if (current.maxLength != null && candidate.length > current.maxLength) errors.push(`${at}: too long`);
      if (current.pattern && !(new RegExp(current.pattern, 'u')).test(candidate)) errors.push(`${at}: pattern`);
    }
    if (Array.isArray(candidate)) {
      if (current.minItems != null && candidate.length < current.minItems) errors.push(`${at}: too few`);
      if (current.maxItems != null && candidate.length > current.maxItems) errors.push(`${at}: too many`);
      if (current.uniqueItems
          && new Set(candidate.map((entry) => JSON.stringify(entry))).size !== candidate.length) {
        errors.push(`${at}: duplicate`);
      }
      candidate.forEach((entry, index) => current.items && check(current.items, entry, `${at}[${index}]`));
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
  };
  check(shape, value, location);
  return errors;
}

function mutate(document, dottedPath, replacement) {
  const copy = structuredClone(document);
  const parts = dottedPath.split('.');
  const parent = parts.slice(0, -1).reduce((value, part) => value[part], copy);
  parent[parts.at(-1)] = replacement;
  return copy;
}

function validateCabInvariants(contract) {
  const errors = [];
  const bindings = new Map(contract.authorityBindings.map((binding) => [binding.fact, binding]));
  const expectedFacts = [
    'candidate', 'execution-plan', 'operation-registry', 'task-attempt', 'task-receipt',
    'test-execution', 'human-decision', 'publication'
  ];
  if (bindings.size !== contract.authorityBindings.length) errors.push('duplicate authority fact');
  for (const fact of expectedFacts) if (!bindings.has(fact)) errors.push(`missing ${fact}`);
  if (contract.authorityBindings.some((binding) => binding.cabMayAuthorize)) {
    errors.push('CAB introduced an authority');
  }
  const trust = new Map(contract.trustMatrix.map((entry) => [entry.claim, entry]));
  if (trust.size !== contract.trustMatrix.length) errors.push('duplicate trust claim');
  if (trust.get('local-observation')?.maySatisfyEnforcedObligation !== false) {
    errors.push('local observation became enforcement evidence');
  }
  if (trust.get('checker-attestation')?.mayPublish !== false) errors.push('checker became publisher');
  if (trust.get('publication')?.mayPublish !== true) errors.push('publication authority unavailable');
  if (contract.waiverContract.modelMayDecide !== false) errors.push('model can decide waiver');
  if (contract.sandboxContract.candidateMount !== 'read-only') errors.push('candidate is writable');
  if (contract.sandboxContract.network !== 'deny-by-default') errors.push('network defaults open');
  if (contract.rollout.enforceAvailable !== false) errors.push('enforce became available');
  if (contract.rollout.legacyStoriesAutoEnroll || contract.rollout.inFlightStoriesAutoEnroll) {
    errors.push('existing Stories auto-enroll');
  }
  if (contract.rollout.remoteEnforcementAvailable !== false) errors.push('remote enforcement available');
  const attempt = new Set(contract.identityProjections.checkerAttempt);
  for (const field of [
    'candidateSha256', 'programSha256', 'taskAttemptSha256', 'operationManifestSha256',
    'verifierManifestSha256', 'toolchainSha256', 'effectiveConfigurationSha256',
    'resultArtifactSha256', 'attemptNonceSha256'
  ]) if (!attempt.has(field)) errors.push(`attempt missing ${field}`);
  return errors;
}

test('CAB v0.2 architecture is a closed design-only contract over existing authorities', async () => {
  const [schema, contract] = await Promise.all([json(schemaPath), json(contractPath)]);
  assert.deepEqual(validate(schema, schema, contract), []);
  assert.deepEqual(validateCabInvariants(contract), []);
  assert.equal(migrationRegistrySnapshot().some((family) => family.id === contract.kind), false,
    'design contract accidentally became a durable runtime family');

  for (const binding of contract.authorityBindings) {
    const absolute = path.join(root, binding.module);
    assert.equal((await stat(absolute)).isFile(), true, binding.module);
    const source = await readFile(absolute, 'utf8');
    assert.match(source, new RegExp(`export (?:async )?(?:function|class) ${binding.symbol}\\b`),
      `${binding.fact} does not resolve to ${binding.module}#${binding.symbol}`);
  }
});

test('CAB identity projections cannot omit the Candidate or create a publication cycle', async () => {
  const contract = await json(contractPath);
  for (const [projection, fields] of Object.entries(contract.identityProjections)) {
    assert.equal(fields[0], 'candidateSha256', projection);
    assert.equal(new Set(fields).size, fields.length, projection);
  }
  assert.doesNotMatch(JSON.stringify(contract.identityProjections.checkerAttempt), /bundle|approval|published/i);
  assert.doesNotMatch(JSON.stringify(contract.identityProjections.assuranceBundle), /approval|published/i);
  assert.doesNotMatch(JSON.stringify(contract.identityProjections.approvalSnapshot), /published/i);
});

test('CAB adversarial design mutations fail schema or invariant review', async () => {
  const [schema, contract, rejected] = await Promise.all([
    json(schemaPath), json(contractPath), json(rejectedPath)
  ]);
  for (const fixture of rejected) {
    const changed = mutate(contract, fixture.path, fixture.value);
    assert.ok(validate(schema, schema, changed).length > 0 || validateCabInvariants(changed).length > 0,
      fixture.id);
  }
});

test('CAB result vocabulary keeps absence, uncertainty, staleness, and exceptions distinct', async () => {
  const contract = await json(contractPath);
  assert.deepEqual(contract.outcomes, [
    'pass', 'fail', 'unavailable', 'inconclusive', 'not-run', 'stale', 'tampered',
    'verified-with-exceptions'
  ]);
  assert.equal(contract.waiverContract.decision, 'exception');
  assert.equal(contract.waiverContract.requiresReason, true);
  assert.equal(contract.waiverContract.requiresExpiry, true);
  assert.equal(contract.waiverContract.requiresExactScope, true);
});
